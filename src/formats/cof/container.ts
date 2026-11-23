/**
 * COF (.cof) container: sniff, open, resolve the preset a reader applies, repack. No body mapping.
 * A .cof is a ZIP whose first entry is `mimetype` (stored) and whose second is `manifest.json`.
 * Reading follows the spec's minimal reader algorithm (docs/IMPLEMENTING.md section 4 in the COF repo).
 */
import { zipSync, strToU8, strFromU8, type Zippable } from "fflate";
import { CARD_ARCHIVE_BOUNDS, unzipBounded } from "../../core/archive";

export const COF_MIMETYPE = "application/vnd.cof.character+zip";
export const MANIFEST_PATH = "manifest.json";
export const THUMBNAIL_PATH = "Thumbnails/thumbnail.png";

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Paths a .cof may carry: relative, no "..", a narrow ASCII set (the format's own rule). */
const SAFE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** Media that gains nothing from deflate is stored, as the reference packer does. */
const STORED_EXT = new Set([
  "jpg", "jpeg", "webp", "avif", "png", "gif", "opus", "ogg", "mp3", "flac", "m4a", "mp4", "webm",
  "mkv", "glb", "vrm", "spz", "ply", "3mf", "safetensors", "onnx", "pt", "npz", "zip",
]);

const u16 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);

/**
 * Identify a COF file from its first local header alone: entry 0 is `mimetype`, stored, and holds the
 * exact media type. Cheap enough to run on every import without unzipping.
 */
export function sniffCof(bytes: Uint8Array | undefined): boolean {
  if (!bytes || bytes.length < 30 + 8 + COF_MIMETYPE.length) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return false;
  if (u16(bytes, 8) !== 0) return false; // compression method: stored
  const nameLength = u16(bytes, 26);
  const extraLength = u16(bytes, 28);
  if (nameLength !== 8) return false;
  if (strFromU8(bytes.subarray(30, 38)) !== "mimetype") return false;
  const start = 38 + extraLength;
  return strFromU8(bytes.subarray(start, start + COF_MIMETYPE.length)) === COF_MIMETYPE;
}

export interface OpenedCof {
  manifest: Rec;
  /** manifest.json exactly as stored, so an unedited file is re-emitted byte for byte */
  manifestText: string;
  /** every entry except `mimetype` and `manifest.json`, in archive order */
  files: Record<string, Uint8Array>;
}

/** Open a .cof defensively. Returns null when the bytes are not a COF file this build can read. */
export function openCof(bytes: Uint8Array | undefined): OpenedCof | null {
  if (!sniffCof(bytes) || !bytes) return null;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipBounded(bytes, { bounds: CARD_ARCHIVE_BOUNDS });
  } catch {
    return null;
  }
  const manifestBytes = entries[MANIFEST_PATH];
  if (!manifestBytes) return null;
  const manifestText = strFromU8(manifestBytes);
  let manifest: Rec;
  try {
    const parsed: unknown = JSON.parse(manifestText);
    if (!isRec(parsed)) return null;
    manifest = parsed;
  } catch {
    return null;
  }
  // 1.x readers accept any 1.x minor; a later major is refused rather than half-read.
  if (!/^1\.\d+$/.test(str(manifest.cof) ?? "")) return null;
  const files: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(entries)) {
    if (path === "mimetype" || path === MANIFEST_PATH) continue;
    if (!SAFE_PATH.test(path)) return null;
    files[path] = data;
  }
  return { manifest, manifestText, files };
}

export interface AppliedPersonality {
  /** variant id under elements.personality.variants */
  id: string;
  kind: string;
  /** archive path of the Character Card V3, when kind is "card" */
  cardPath?: string;
  /** inline text, when kind is "description" */
  text?: string;
  /** language tag of the variant; the file's language maps are read in it */
  language?: string;
}

export interface ResolvedPreset {
  identityId?: string;
  presetId: string;
  /** display name of the character the preset belongs to */
  name: string;
  personality: AppliedPersonality | null;
  /** the preset's opening line (`prompts.greeting`), in the personality's language */
  greeting?: string;
  /** language key the greeting was read under, so an edit goes back to the same entry */
  greetingLanguage?: string;
  /** true when the file's thumbnail may be shown for this preset; see thumbnailAllowed */
  thumbnail: boolean;
}

/** slots of a preset, merged over the presets it `extends` (a child replaces a whole category list). */
function presetSlots(presets: Rec, id: string, seen: readonly string[] = []): Rec {
  const preset = presets[id];
  if (!isRec(preset)) return {};
  const parent = str(preset.extends);
  const base = parent && !seen.includes(id) ? presetSlots(presets, parent, [...seen, id]) : {};
  return { ...base, ...(isRec(preset.slots) ? preset.slots : {}) };
}

/** A variant merged over its `derives_from` parent. */
function variantOf(variants: Rec, id: string, seen: readonly string[] = []): Rec {
  const variant = variants[id];
  if (!isRec(variant)) return {};
  const parent = str(variant.derives_from);
  const base = parent && !seen.includes(id) ? variantOf(variants, parent, [...seen, id]) : {};
  return { ...base, ...variant };
}

/**
 * The preset a reader applies when the user picked none: the default character's default preset,
 * else its first one. Only the personality slot is resolved here; everything else stays in the file.
 */
export function resolveDefaultPreset(manifest: Rec): ResolvedPreset | null {
  const presets = isRec(manifest.presets) ? manifest.presets : {};
  const identities = isRec(manifest.identities) ? manifest.identities : {};
  const identityId = str(manifest.default_identity) ?? Object.keys(identities)[0];
  const identity = identityId && isRec(identities[identityId]) ? (identities[identityId] as Rec) : undefined;
  const own = Object.keys(presets).filter((id) => {
    const owner = isRec(presets[id]) ? str((presets[id] as Rec).identity) : undefined;
    return !identityId || owner === undefined || owner === identityId;
  });
  const wanted = str(identity?.default_preset) ?? str(manifest.default_preset);
  const presetId = wanted && own.includes(wanted) ? wanted : own[0];
  if (!presetId) return null;

  const elements = isRec(manifest.elements) ? manifest.elements : {};
  const category = isRec(elements.personality) ? elements.personality : {};
  const variants = isRec(category.variants) ? category.variants : {};
  const applied = presetSlots(presets, presetId).personality;
  const id = Array.isArray(applied) ? applied.find((v): v is string => typeof v === "string") : undefined;
  let personality: AppliedPersonality | null = null;
  if (id) {
    const variant = variantOf(variants, id);
    personality = {
      id,
      kind: str(variant.kind) ?? "",
      cardPath: str(variant.card),
      text: str(variant.text),
      language: str(variant.language),
    };
  }
  const [greetingLanguage, greeting] = presetGreeting(presets, presetId, personality?.language);
  const slots = presetSlots(presets, presetId);
  const thumbnail = thumbnailAllowed(manifest, identity, elements, slots);
  return {
    identityId,
    presetId,
    name: str(identity?.name) ?? str(manifest.name) ?? "",
    personality,
    greeting,
    greetingLanguage,
    thumbnail,
  };
}

/** `prompts.greeting` of a preset or of the nearest preset it extends: a map of language -> text. */
function presetGreeting(presets: Rec, id: string, language = "en"): [string?, string?] {
  const seen: string[] = [];
  for (let at: string | undefined = id; at && !seen.includes(at); ) {
    seen.push(at);
    const preset: unknown = presets[at];
    if (!isRec(preset)) break;
    const greeting = isRec(preset.prompts) ? preset.prompts.greeting : undefined;
    if (isRec(greeting)) {
      const base = language.split("-")[0] ?? language;
      const key = [language, base, "en", ...Object.keys(greeting)].find((k) => str(greeting[k]));
      return key ? [key, str(greeting[key])] : [];
    }
    at = str(preset.extends);
  }
  return [];
}

const hasString = (value: unknown, wanted: string): boolean =>
  value === wanted ||
  (Array.isArray(value) && value.some((v) => hasString(v, wanted))) ||
  (isRec(value) && Object.values(value).some((v) => hasString(v, wanted)));

/**
 * Whether a reader may show the file's thumbnail for the preset it reads. Two rules of the format's
 * reader obligations: only images of the variants the preset applies are shown (the thumbnail is
 * derived from one of them, named by its asset's `source`), and a real person's image needs a
 * consent record whose scope covers it. `fictional` is the author's statement: absent or not a
 * boolean, the character is treated as a real person without consent.
 */
function thumbnailAllowed(manifest: Rec, identity: Rec | undefined, elements: Rec, slots: Rec): boolean {
  const holder = identity && "fictional" in identity ? identity : manifest;
  if (holder.fictional !== true) {
    const rights = isRec(manifest.rights) ? manifest.rights : {};
    const consent = isRec(identity?.consent) ? identity.consent : rights.consent;
    const scope = isRec(consent) && Array.isArray(consent.scope) ? consent.scope : [];
    const expires = isRec(consent) ? str(consent.expires) : undefined;
    if (!scope.includes("likeness-image") || (expires !== undefined && Date.parse(expires) < Date.now())) return false;
  }
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const entry = assets.find((a) => isRec(a) && a.path === THUMBNAIL_PATH);
  const source = isRec(entry) ? str(entry.source) : undefined;
  if (!source) return false;
  const category = isRec(elements.appearance) ? elements.appearance : {};
  const variants = isRec(category.variants) ? category.variants : {};
  const applied = Array.isArray(slots.appearance) ? slots.appearance : [];
  return applied.some((id) => typeof id === "string" && hasString(variantOf(variants, id), source));
}

/**
 * Pack a manifest and its files back into a .cof: `mimetype` first and stored, `manifest.json` second.
 * A string manifest is written as given (the unedited source text); an object is serialized.
 */
export function packCof(manifest: Rec | string, files: Record<string, Uint8Array>): Uint8Array {
  const manifestText = typeof manifest === "string" ? manifest : `${JSON.stringify(manifest, null, 2)}\n`;
  const zip: Zippable = {
    mimetype: [strToU8(COF_MIMETYPE), { level: 0 }],
    [MANIFEST_PATH]: [strToU8(manifestText), { level: 6 }],
  };
  for (const [path, data] of Object.entries(files)) {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    zip[path] = [data, { level: STORED_EXT.has(ext) ? 0 : 6 }];
  }
  return zipSync(zip);
}
