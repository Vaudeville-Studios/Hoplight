/**
 * A fresh .cof manifest for a character that did not come from a .cof: one Character Card V3 as the
 * personality variant, one preset. Mirrors what the reference importer writes for a bare card
 * (`cof import card.json` in the COF repo). The format requires three statements only an author can
 * make, and has no "unknown" for them, so a converter writes the cautious value and grants nothing:
 * `fictional: true` (unverified), `tags.ip.original: false` (origin unknown) and restrictive
 * permissions. With these, the COF reference player declines to play the character until its
 * author says it is theirs (`cof rights`, or the COF builder). `tags.auto` is left out: validators
 * compute it.
 */
import type { Rec } from "./container";

export const FRESH_CARD_PATH = "elements/personality/p1/card.json";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26-character Crockford base32 ULID: 10 characters of time, 16 of randomness. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  let tail = "";
  for (const byte of random) tail += CROCKFORD[byte % 32];
  return time + tail;
}

/** The permissions the reference importer writes when the source says nothing. */
function defaultPermissions(): Rec {
  return {
    avatarPermission: "onlyAuthor",
    commercialUsage: "personalNonProfit",
    modification: "prohibited",
    allowRedistribution: false,
    creditNotation: "required",
    allowExcessivelyViolentUsage: false,
    allowSexualUsage: false,
    allowPoliticalOrReligiousUsage: false,
    allowAntisocialOrHateUsage: false,
    allowVoiceCloning: false,
    allowTraining: "none",
    allowImpersonationOfRealPerson: false,
    aiDisclosure: true,
  };
}

const slugTag = (tag: string): string => tag.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");

/** Build the manifest of a one-card, one-preset .cof. `data` is the card's CCv3 `data` object. */
export function freshManifest(data: Rec, now: Date = new Date()): Rec {
  const name = typeof data.name === "string" && data.name ? data.name : "Unnamed";
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const tags = Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === "string") : [];
  const description = typeof data.description === "string" ? data.description : "";
  return {
    cof: "1.0",
    id: ulid(now.getTime()),
    name,
    nickname: typeof data.nickname === "string" ? data.nickname : "",
    languages: ["en"],
    summary: Array.from(description).slice(0, 300).join(""),
    fictional: true,
    morphology: { class: "human", species: "human" },
    tags: {
      manual: tags.map(slugTag).filter(Boolean).slice(0, 30),
      content: ["none"],
      ip: { original: false, franchise: null, based_on: null },
    },
    elements: {
      personality: {
        variants: { p1: { kind: "card", label: name, language: "en", card: FRESH_CARD_PATH } },
      },
    },
    presets: { default: { label: "Default", slots: { personality: ["p1"] } } },
    default_preset: "default",
    priorities: { visual: ["identity_weights", "images", "avatar", "descriptive"], voice: ["samples", "described"] },
    mapping_vocabularies: {},
    assets: [],
    size_class: "lite",
    container: { aligned: 0, executableContent: "none" },
    rights: { permissions: defaultPermissions(), consent: null },
    provenance: { created: stamp, modified: stamp, generator: "hoplight", source: [], c2pa: null, signatures: [] },
    metadata: {
      "@context": { dc: "http://purl.org/dc/elements/1.1/" },
      "dc:creator": [typeof data.creator === "string" ? data.creator : ""],
    },
    extensions: {},
  };
}
