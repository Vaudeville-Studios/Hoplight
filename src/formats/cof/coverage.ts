/**
 * COF (.cof) character coverage. A .cof carries a complete Character Card V3 as a personality
 * variant, so the card's own fields are carried exactly as the generic Tavern reader carries them.
 * Everything else a .cof can hold (dated memories, psyche graph, voice, images, 3D, rights and
 * consent, presets) has no canonical slot yet: it rides the original and is re-emitted untouched.
 */
import type { CoverageDecl } from "../../core/coverage";

const coverage: CoverageDecl = {
  carries: [
    "identity.name",
    "identity.nickname",
    "identity.description",
    "identity.characterVersion",
    "persona.personality",
    "persona.scenario",
    "greetings",
    "examples",
    "prompts.systemPrompt",
    "prompts.postHistoryInstructions",
    "prompts.depthInjections",
    "attribution.creator",
    "attribution.creatorNotes",
    "attribution.creatorNotesMultilingual",
    "attribution.source",
    "attribution.createdAt",
    "attribution.updatedAt",
    "discovery.tags",
    "settings.talkativeness",
    "worldName",
    "knowledgeRefs",
  ],
  notes: {
    "media.portrait":
      "read from the file's thumbnail for display only, when it shows the preset being read and, for a real person, the file's consent covers images; a face image in a .cof must declare the depicted age, given by the user, which the canonical model does not hold, so a new portrait is not written",
    "media.assets": "a .cof keeps its images as declared assets with licence and hash; they ride the original",
    "attribution.license": "a .cof carries structured permissions (commercial use, redistribution, voice cloning, training), not one licence string; they ride the original",
    "identity.description": "for a preset whose personality is free text rather than a card, the text is carried here and the preset's greeting as the first message; nothing else",
    "attribution.creator":
      "a .cof written for a character from another format states what the format requires and a converter cannot know: fictional (unverified), origin unknown (not marked as an original creation), restrictive permissions; its author changes them with the COF tools",
  },
};

export default coverage;
