/**
 * COF (Character Open File, .cof) character adapter. A .cof is a ZIP container for one or several
 * characters: `mimetype` first, `manifest.json` second, then elements (personality, appearance,
 * voice, memories, psyche...) and rights. Spec: https://github.com/yannsouetre/cof (CC BY 4.0).
 *
 * Reading follows the spec's minimal reader: default character, default preset, its personality.
 * A `card` personality is a complete Character Card V3 and maps through the shared Tavern mapping;
 * a `description` personality is free text: it fills the description, and the preset's greeting the
 * first message. The reader never switches to another preset on its own.
 * Lossless: the whole archive rides the original and is re-emitted with only the card rewritten, so
 * memories, psyche, voice, images, presets, rights and unknown entries survive a round-trip.
 * Images are never written from the canonical side: see ./coverage for why.
 */
import { strToU8, strFromU8 } from "fflate";
import type { CharacterAdapter, AdapterInput, AdapterOutput, EmitContext } from "../../core/adapter";
import type { CanonicalCharacter, CharacterBody } from "../../entities/character/schema";
import { CANONICAL_SCHEMA_VERSION, canonicalId } from "../../core/canonical";
import { base64ToBytes, bytesToBase64 } from "../../core/base64";
import { embedCharacterBook } from "../_shared/character-book";
import { assetsToMedia } from "../_shared/assets";
import { type TavernData, dataToBody, applyBodyToData, wrapV3 } from "../_shared/tavern-fields";
import coverage from "./coverage";
import { type Rec, THUMBNAIL_PATH, isRec, openCof, packCof, resolveDefaultPreset, sniffCof, str } from "./container";
import { FRESH_CARD_PATH, freshManifest } from "./fresh";

interface Card extends Rec {
  spec: string;
  spec_version: string;
  data: TavernData;
}

/** What the original keeps beside the card: the manifest, every other entry, and what was read. */
interface CofEscrow {
  manifest: Rec;
  /** manifest.json as stored; re-emitted verbatim while the manifest is unchanged */
  manifestText?: string;
  /** archive path -> base64, every entry except mimetype and manifest.json */
  files: Record<string, string>;
  preset: string;
  identity?: string;
  /** personality variant id the body was read from */
  personality?: string;
  /** "card" | "description" | "" when the preset applies no personality */
  kind: string;
  cardPath?: string;
  /** the preset greeting as read, and its language key (free-text presets only) */
  greeting?: string;
  greetingLanguage?: string;
}

/** Card payloads that are a user's data, not the character: never written into a .cof. */
const CARD_PAYLOADS = ["chat_history", "avatar_data_url"] as const;

const cardJson = (card: unknown): Uint8Array => strToU8(`${JSON.stringify(card, null, 2)}\n`);

function emptyBody(name: string, description?: string): CharacterBody {
  return {
    identity: { name, description },
    persona: {},
    prompts: {},
    greetings: {},
    examples: {},
    media: {},
    attribution: {},
    discovery: {},
  };
}

function parseCard(bytes: Uint8Array | undefined): Card | null {
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(strFromU8(bytes));
    return isRec(parsed) && isRec(parsed.data) ? (parsed as Card) : null;
  } catch {
    return null;
  }
}

function readEscrow(entity: CanonicalCharacter): CofEscrow | null {
  const unmapped = entity.original?.cof?.unmapped;
  if (!unmapped || !isRec(unmapped.manifest) || !isRec(unmapped.files)) return null;
  return unmapped as unknown as CofEscrow;
}

/** Re-emit the source archive with the card (or the free text) updated from the canonical body. */
function emitFromOriginal(entity: CanonicalCharacter, escrow: CofEscrow, context?: EmitContext): Uint8Array {
  const manifest = structuredClone(escrow.manifest);
  let manifestChanged = false;
  const files: Record<string, Uint8Array> = {};
  for (const [path, encoded] of Object.entries(escrow.files)) files[path] = base64ToBytes(encoded);

  if (escrow.kind === "card" && escrow.cardPath) {
    const source = parseCard(files[escrow.cardPath]);
    const card = (source ? structuredClone(source) : wrapV3({})) as Card;
    applyBodyToData(card.data, entity.body);
    if (context?.lorebooks !== undefined) embedCharacterBook(card.data as Rec, context.lorebooks);
    // Unedited: keep the original bytes. Edited: rewrite the card and nothing else.
    if (!source || JSON.stringify(card) !== JSON.stringify(source)) files[escrow.cardPath] = cardJson(card);
  } else if (escrow.kind === "description" && escrow.personality) {
    const elements = isRec(manifest.elements) ? manifest.elements : {};
    const category = isRec(elements.personality) ? elements.personality : {};
    const variants = isRec(category.variants) ? category.variants : {};
    const variant = variants[escrow.personality];
    const text = entity.body.identity.description;
    if (isRec(variant) && typeof text === "string" && variant.text !== text) {
      variant.text = text;
      manifestChanged = true;
    }
    // An edited greeting goes back to the preset, under the language it was read in.
    const greeting = entity.body.greetings.firstMessage;
    const presets = isRec(manifest.presets) ? manifest.presets : {};
    const preset = presets[escrow.preset];
    if (isRec(preset) && typeof greeting === "string" && greeting !== escrow.greeting) {
      const prompts = isRec(preset.prompts) ? preset.prompts : {};
      const map = isRec(prompts.greeting) ? prompts.greeting : {};
      map[escrow.greetingLanguage ?? "en"] = greeting;
      preset.prompts = { ...prompts, greeting: map };
      manifestChanged = true;
    }
  }
  return packCof(manifestChanged || escrow.manifestText === undefined ? manifest : escrow.manifestText, files);
}

/** A new one-card .cof for a character that came from another format. */
function emitFresh(entity: CanonicalCharacter, context?: EmitContext): Uint8Array {
  const data = applyBodyToData({}, entity.body);
  if (context?.lorebooks !== undefined) embedCharacterBook(data as Rec, context.lorebooks);
  if (!Array.isArray(data.group_only_greetings)) data.group_only_greetings = [];
  delete data.assets; // images need a declared depicted age in a .cof; see ./coverage
  const extensions = isRec(data.extensions) ? { ...data.extensions } : {};
  for (const key of CARD_PAYLOADS) delete extensions[key];
  data.extensions = extensions;
  return packCof(freshManifest(data), { [FRESH_CARD_PATH]: cardJson(wrapV3(data)) });
}

const adapter: CharacterAdapter = {
  id: "cof",
  label: "COF character file (.cof)",
  outputExtensions: ["cof"],
  kind: "character",
  coverage,
  // An interchange container, not a host product: export/import only, no editor lens tab.
  lens: false,

  /** The first ZIP entry is `mimetype`, stored, with the exact media type: no other format has it. */
  detect(input: AdapterInput): number {
    return sniffCof(input.bytes) ? 1 : 0;
  },

  toCanonical(input: AdapterInput): CanonicalCharacter {
    const opened = openCof(input.bytes);
    if (!opened) throw new Error("cof: not a readable COF 1.x file");
    const resolved = resolveDefaultPreset(opened.manifest);
    if (!resolved) throw new Error("cof: the file has no preset");

    const personality = resolved.personality;
    const card = personality?.kind === "card" && personality.cardPath ? parseCard(opened.files[personality.cardPath]) : null;
    let body: CharacterBody;
    if (card) {
      body = dataToBody(card.data);
      body.media = assetsToMedia(card.data.assets);
    } else {
      const freeText = personality?.kind === "description";
      body = emptyBody(resolved.name, freeText ? personality.text : undefined);
      if (freeText && resolved.greeting) body.greetings.firstMessage = resolved.greeting;
    }
    const thumbnail = resolved.thumbnail ? opened.files[THUMBNAIL_PATH] : undefined;
    if (!body.media.portrait && thumbnail) {
      body.media.portrait = {
        role: "portrait",
        ref: `data:image/png;base64,${bytesToBase64(thumbnail)}`,
        mime: "image/png",
        primary: true,
      };
    }

    const files: Record<string, string> = {};
    for (const [path, data] of Object.entries(opened.files)) files[path] = bytesToBase64(data);
    const escrow: CofEscrow = {
      manifest: opened.manifest,
      manifestText: opened.manifestText,
      files,
      preset: resolved.presetId,
      identity: resolved.identityId,
      personality: personality?.id,
      kind: card ? "card" : personality?.kind === "description" ? "description" : "",
      cardPath: card ? personality?.cardPath : undefined,
      greeting: card ? undefined : body.greetings.firstMessage,
      greetingLanguage: card ? undefined : resolved.greetingLanguage,
    };
    const name = card ? (str(card.data.name) ?? resolved.name) : resolved.name;
    return {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      kind: "character",
      id: canonicalId(name),
      body,
      original: {
        // raw is the card when there is one, so the shared character_book extractor finds its lorebook
        cof: { raw: card ?? { name, description: body.identity.description }, unmapped: { ...escrow } },
      },
    };
  },

  fromCanonical(entity: CanonicalCharacter, context?: EmitContext): AdapterOutput {
    const escrow = readEscrow(entity);
    const bytes = escrow ? emitFromOriginal(entity, escrow, context) : emitFresh(entity, context);
    return { bytes, suggestedExtension: "cof" };
  },
};

/** The COF character codec, exported by name for direct importers (tests, bundle). */
export { adapter as characterAdapter };
export default adapter;
