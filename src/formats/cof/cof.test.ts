/**
 * COF (.cof) adapter tests: detection, reading the default preset, byte-exact round-trip, edits that
 * touch only the card, survival of everything the canonical model has no slot for, and fresh export.
 * Real samples: samples/cof/characters (see samples/cof/SOURCES.md).
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { characterAdapter as adapter } from "./index";
import { COF_MIMETYPE, packCof, resolveDefaultPreset, sniffCof, type Rec } from "./container";
import { ulid } from "./fresh";
import { characterAdapter as sillytavern } from "../sillytavern/index";
import { loadFormats } from "../../core";
import type { CanonicalCharacter } from "../../entities/character/schema";

const sample = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(import.meta.dir, "../../../samples/cof/characters", name)));

const CLARA = sample("clara-text-only.cof");
const AGENT = sample("agent-skills.cof");

const json = (bytes: Uint8Array | undefined): Rec => JSON.parse(strFromU8(bytes!)) as Rec;

function card(name = "Mira") {
  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name,
      description: "A quiet cartographer who inks maps by lamplight.",
      personality: "Patient, exact, dry.",
      scenario: "A rain-soaked port city, late evening.",
      first_mes: "You found the attic again.",
      mes_example: "{{user}}: Hi\n{{char}}: Hello.",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: ["The lamp is still warm."],
      group_only_greetings: [],
      tags: ["Cartographer", "slow burn"],
      creator: "tester",
      character_version: "1.0",
      extensions: { vendor: { keep: true }, chat_history: [{ role: "user", content: "private" }] },
    },
  };
}

/** A hand-built 1.2 file: one card preset, one free-text preset, memories, psyche, unknown entries. */
function richCof(): Uint8Array {
  const manifest: Rec = {
    cof: "1.2",
    id: ulid(),
    name: "Mira",
    fictional: true,
    morphology: { class: "human", species: "human" },
    tags: { auto: [], manual: [], content: ["none"], ip: { original: true, franchise: null, based_on: null } },
    identities: { id1: { name: "Mira Voss", default_preset: "main" } },
    default_identity: "id1",
    elements: {
      personality: {
        variants: {
          p1: { kind: "card", language: "en", card: "elements/personality/p1/card.json" },
          p2: { kind: "description", language: "en", text: "Mira, in plain words." },
        },
      },
      memories: { variants: { ev1: { kind: "moment", memory: "elements/memories/ev1/memory.json" } } },
      psyche: { variants: { val1: { kind: "value", node: "elements/psyche/val1/psyche-node.json" } } },
      "x-acme": { variants: { z1: { kind: "anything" } } },
    },
    presets: {
      main: { identity: "id1", slots: { personality: ["p1"], memories: ["ev1"], psyche: ["val1"] } },
      plain: { identity: "id1", extends: "main", slots: { personality: ["p2"] } },
      heir: { identity: "id1", extends: "plain", slots: { psyche: [] } },
    },
    default_preset: "main",
    assets: [],
    rights: { permissions: { avatarPermission: "onlyAuthor", commercialUsage: "personalNonProfit", modification: "prohibited", aiDisclosure: true } },
    provenance: { created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z" },
    vendorKey: { survives: 1.0 },
  };
  return packCof(manifest, {
    "elements/personality/p1/card.json": strToU8(JSON.stringify(card("Mira Voss"), null, 2)),
    "elements/memories/ev1/memory.json": strToU8(JSON.stringify({ gist: { en: "The first map." }, when: { age: 9 } })),
    "elements/psyche/val1/psyche-node.json": strToU8(JSON.stringify({ gist: { en: "Accuracy is a kindness." }, strength: 80 })),
    "extensions/acme/notes.txt": strToU8("kept"),
  });
}

test("detects a .cof from its first entry alone, and nothing else", () => {
  expect(adapter.detect({ bytes: CLARA })).toBe(1);
  expect(adapter.detect({ bytes: richCof() })).toBe(1);
  expect(adapter.detect({ text: JSON.stringify(card()) })).toBe(0);
  // a zip that merely contains a manifest.json or a card.json is not a .cof
  expect(adapter.detect({ bytes: zipSync({ "manifest.json": strToU8("{}"), "card.json": strToU8("{}") }) })).toBe(0);
  // right first entry, wrong media type
  expect(sniffCof(zipSync({ mimetype: [strToU8("application/epub+zip"), { level: 0 }] }))).toBe(false);
  // right media type, but compressed: the spec requires the entry stored
  expect(sniffCof(zipSync({ mimetype: [strToU8(COF_MIMETYPE), { level: 9 }] }))).toBe(false);
});

test("no other adapter claims a .cof with full confidence", async () => {
  const formats = await loadFormats();
  for (const bytes of [CLARA, AGENT, richCof()]) {
    const claims = formats
      .map((f) => ({ id: f.id, score: f.detect({ bytes, filename: "x.cof" }) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
    expect(claims[0]?.id).toBe("cof");
    expect(claims.filter((c) => c.score >= 1).map((c) => c.id)).toEqual(["cof"]);
  }
});

test("reads the default preset's card through the shared Tavern mapping", () => {
  const entity = adapter.toCanonical({ bytes: CLARA });
  expect(entity.kind).toBe("character");
  expect(entity.body.identity.name).toBe("Clara Mercier");
  expect(entity.body.greetings.firstMessage?.length).toBeGreaterThan(0);
  const escrow = entity.original?.cof?.unmapped as Rec;
  expect(escrow.kind).toBe("card");
  expect(escrow.preset).toBe("default");
  expect(Object.keys(escrow.files as Rec)).toContain("elements/personality/p1/psyche.json");
  // raw is the card, so the shared character_book extractor can find an embedded lorebook
  expect((entity.original?.cof?.raw as Rec).spec).toBe("chara_card_v3");
});

test("an unedited file round-trips byte for byte, entry by entry", () => {
  for (const source of [CLARA, AGENT, richCof()]) {
    const out = adapter.fromCanonical(adapter.toCanonical({ bytes: source }));
    expect(out.suggestedExtension).toBe("cof");
    const before = unzipSync(source);
    const after = unzipSync(out.bytes!);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const path of Object.keys(before)) expect(after[path]).toEqual(before[path]!);
    expect(sniffCof(out.bytes)).toBe(true);
  }
});

test("an edit rewrites the card and nothing else", () => {
  const entity = adapter.toCanonical({ bytes: AGENT });
  entity.body.identity.description = "Rewritten in the studio.";
  const before = unzipSync(AGENT);
  const after = unzipSync(adapter.fromCanonical(entity).bytes!);
  const cardPath = "elements/personality/p1/card.json";
  expect((json(after[cardPath]).data as Rec).description).toBe("Rewritten in the studio.");
  for (const path of Object.keys(before)) {
    if (path !== cardPath) expect(after[path]).toEqual(before[path]!);
  }
  // unknown card extensions survive the rewrite
  const again = adapter.toCanonical({ bytes: adapter.fromCanonical(entity).bytes! });
  expect(again.body.identity.description).toBe("Rewritten in the studio.");
});

test("memories, psyche, x- categories and unknown keys survive an edit", () => {
  const entity = adapter.toCanonical({ bytes: richCof() });
  expect(entity.body.identity.name).toBe("Mira Voss");
  entity.body.persona.scenario = "A dry archive, noon.";
  const after = unzipSync(adapter.fromCanonical(entity).bytes!);
  expect(json(after["elements/memories/ev1/memory.json"]).when).toEqual({ age: 9 });
  expect(json(after["elements/psyche/val1/psyche-node.json"]).strength).toBe(80);
  expect(strFromU8(after["extensions/acme/notes.txt"]!)).toBe("kept");
  const manifest = json(after["manifest.json"]);
  expect(manifest.vendorKey).toEqual({ survives: 1 });
  expect((manifest.elements as Rec)["x-acme"]).toBeDefined();
  const data = json(after["elements/personality/p1/card.json"]).data as Rec;
  expect(data.scenario).toBe("A dry archive, noon.");
  expect((data.extensions as Rec).vendor).toEqual({ keep: true });
});

test("preset resolution follows extends chains and the character's own default", () => {
  const manifest = json(unzipSync(richCof())["manifest.json"]);
  expect(resolveDefaultPreset(manifest)?.presetId).toBe("main");
  expect(resolveDefaultPreset(manifest)?.name).toBe("Mira Voss");
  // a grandchild inherits the personality its parent replaced
  (manifest.identities as Rec).id1 = { name: "Mira Voss", default_preset: "heir" };
  const heir = resolveDefaultPreset(manifest);
  expect(heir?.presetId).toBe("heir");
  expect(heir?.personality).toMatchObject({ id: "p2", kind: "description", text: "Mira, in plain words." });
  // an extends loop terminates
  (manifest.presets as Rec).main = { identity: "id1", extends: "heir", slots: {} };
  expect(resolveDefaultPreset(manifest)?.personality?.id).toBe("p2");
});

test("a free-text personality fills the description and is written back to the manifest", () => {
  const manifest = json(unzipSync(richCof())["manifest.json"]);
  (manifest.identities as Rec).id1 = { name: "Mira Voss", default_preset: "plain" };
  const files = unzipSync(richCof());
  delete files.mimetype;
  delete files["manifest.json"];
  const entity = adapter.toCanonical({ bytes: packCof(manifest, files) });
  expect(entity.body.identity.name).toBe("Mira Voss");
  expect(entity.body.identity.description).toBe("Mira, in plain words.");
  entity.body.identity.description = "Mira, edited.";
  const after = unzipSync(adapter.fromCanonical(entity).bytes!);
  const variants = ((json(after["manifest.json"]).elements as Rec).personality as Rec).variants as Rec;
  expect((variants.p2 as Rec).text).toBe("Mira, edited.");
  expect(after["elements/personality/p1/card.json"]).toEqual(files["elements/personality/p1/card.json"]!);
});

test("a free-text preset's greeting is the first message, in the personality's language, and edits go back", () => {
  const manifest = json(unzipSync(richCof())["manifest.json"]);
  (manifest.identities as Rec).id1 = { name: "Mira Voss", default_preset: "heir" };
  const presets = manifest.presets as Rec;
  // the greeting sits on the parent preset: `heir` extends `plain`
  (presets.plain as Rec).prompts = { greeting: { fr: "Vous revoilà.", en: "You again." } };
  const source = packCof(manifest, {});
  const entity = adapter.toCanonical({ bytes: source });
  expect(entity.body.greetings.firstMessage).toBe("You again.");
  // unedited: the manifest text is re-emitted as it was
  expect(unzipSync(adapter.fromCanonical(entity).bytes!)["manifest.json"]).toEqual(unzipSync(source)["manifest.json"]!);
  entity.body.greetings.firstMessage = "Back so soon?";
  const written = json(unzipSync(adapter.fromCanonical(entity).bytes!)["manifest.json"]).presets as Rec;
  expect(((written.heir as Rec).prompts as Rec).greeting).toEqual({ en: "Back so soon?" });
  expect(((written.plain as Rec).prompts as Rec).greeting).toEqual({ fr: "Vous revoilà.", en: "You again." });
});

test("the thumbnail is shown only for the preset it depicts, and for a real person only with consent", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const build = (change: (manifest: Rec) => void): CanonicalCharacter => {
    const manifest = json(unzipSync(richCof())["manifest.json"]);
    (manifest.elements as Rec).appearance = { variants: { a1: { kind: "face", images: ["img-a1"], age: { value: 30, unit: "years", basis: "declared" } } } };
    ((manifest.presets as Rec).main as Rec).slots = { personality: ["p2"], appearance: ["a1"] };
    manifest.assets = [
      { id: "img-a1", path: "elements/appearance/a1/face.png" },
      { id: "thumbnail", path: "Thumbnails/thumbnail.png", role: "derived", source: "img-a1" },
    ];
    change(manifest);
    return adapter.toCanonical({ bytes: packCof(manifest, { "Thumbnails/thumbnail.png": png, "elements/appearance/a1/face.png": png }) });
  };
  expect(build(() => {}).body.media.portrait?.mime).toBe("image/png");
  // derived from an image the preset does not apply: not this preset's picture
  expect(build((m) => { ((m.presets as Rec).main as Rec).slots = { personality: ["p2"] }; }).body.media.portrait).toBeUndefined();
  // not declared as derived from anything
  expect(build((m) => { m.assets = []; }).body.media.portrait).toBeUndefined();
  // a real person, or a file that does not say: no image without a consent record that covers it
  expect(build((m) => { m.fictional = false; }).body.media.portrait).toBeUndefined();
  expect(build((m) => { delete m.fictional; }).body.media.portrait).toBeUndefined();
  expect(build((m) => { m.fictional = false; m.rights = { consent: { scope: ["conversational-persona"] } }; }).body.media.portrait).toBeUndefined();
  expect(build((m) => { m.fictional = false; m.rights = { consent: { scope: ["likeness-image"], expires: "2020-01-01" } }; }).body.media.portrait).toBeUndefined();
  expect(build((m) => { m.fictional = false; m.rights = { consent: { scope: ["likeness-image"] } }; }).body.media.portrait?.primary).toBe(true);
});

test("refuses a later major version and unsafe paths instead of half-reading them", () => {
  const manifest = json(unzipSync(richCof())["manifest.json"]);
  expect(() => adapter.toCanonical({ bytes: packCof({ ...manifest, cof: "2.0" }, {}) })).toThrow("cof:");
  expect(() => adapter.toCanonical({ bytes: packCof(manifest, { "../escape.txt": strToU8("x") }) })).toThrow("cof:");
  expect(() => adapter.toCanonical({ bytes: strToU8("not a zip") })).toThrow("cof:");
});

test("a character from another format exports as a valid one-card .cof", () => {
  const source = sillytavern.toCanonical({ text: JSON.stringify(card()) });
  const foreign: CanonicalCharacter = { ...source, original: undefined };
  const out = adapter.fromCanonical(foreign);
  expect(sniffCof(out.bytes)).toBe(true);
  const files = unzipSync(out.bytes!);
  expect(Object.keys(files).slice(0, 2)).toEqual(["mimetype", "manifest.json"]);
  expect(strFromU8(files.mimetype!)).toBe(COF_MIMETYPE);

  const manifest = json(files["manifest.json"]);
  for (const key of ["cof", "id", "name", "fictional", "morphology", "tags", "elements", "assets", "rights", "provenance", "presets", "default_preset"]) {
    expect(manifest[key]).toBeDefined();
  }
  expect(manifest.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(manifest.name).toBe("Mira");
  expect((manifest.tags as Rec).manual).toEqual(["cartographer", "slow-burn"]);
  // statements only an author can make get the cautious value; computed tags are left to validators
  expect(manifest.fictional).toBe(true);
  expect(((manifest.tags as Rec).ip as Rec).original).toBe(false);
  expect((manifest.tags as Rec).auto).toBeUndefined();
  // a converter grants nothing on the author's behalf
  const permissions = (manifest.rights as Rec).permissions as Rec;
  expect(permissions.allowRedistribution).toBe(false);
  expect(permissions.allowTraining).toBe("none");

  const written = json(files["elements/personality/p1/card.json"]);
  expect(written.spec).toBe("chara_card_v3");
  const data = written.data as Rec;
  expect(data.first_mes).toBe("You found the attic again.");
  expect(data.group_only_greetings).toEqual([]);
  expect(data.assets).toBeUndefined();
  // a user's conversation is not part of the character and does not travel
  expect((data.extensions as Rec).chat_history).toBeUndefined();

  const back = adapter.toCanonical({ bytes: out.bytes! });
  expect(back.body.identity.name).toBe("Mira");
  expect(back.body.greetings.firstMessage).toBe(source.body.greetings.firstMessage);
  expect(back.body.persona.scenario).toBe(source.body.persona.scenario);
});

test("a .cof converts to a SillyTavern card that keeps the core text and none of the container", () => {
  const entity = adapter.toCanonical({ bytes: CLARA });
  // only the canonical body crosses formats: the .cof original stays behind
  const out = sillytavern.fromCanonical({ ...entity, original: undefined });
  const written = JSON.parse(out.text!) as Rec;
  const data = written.data as Rec;
  expect(data.name).toBe("Clara Mercier");
  expect(data.first_mes).toBe(entity.body.greetings.firstMessage);
  expect(data.description).toBe(entity.body.identity.description);
  expect(JSON.stringify(written)).not.toContain("manifest");
});
