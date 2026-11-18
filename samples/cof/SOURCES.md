# COF samples

COF (Character Open File) is an open ZIP container for AI characters: https://github.com/yannsouetre/cof
(spec CC BY 4.0, tools MIT). Both samples are the project's own example characters, packed with its
reference tool (`cof pack <folder> -o <file>`, cof-cli 1.2.2) from the published repository at commit
`22fd775` (2026-11-15). Each file declares CC BY 4.0 in its manifest (`metadata.dc:rights`), allows
redistribution and modification, and asks for credit: Yann Souetre.

- `characters/clara-text-only.cof` - from `spec/examples/01-clara-text-only`. One preset whose
  personality is a Character Card V3, plus a `psyche.json` trait sheet the canonical model has no
  slot for. The smallest file that exercises the card path and the "everything else survives" rule.
- `characters/agent-skills.cof` - from `spec/examples/08-agent-skills`. The same card with two
  entries in the `files` category (a skill and a memory file): proves unknown-to-us categories and
  their files are re-emitted untouched.

Larger files with media, dated memories and a psyche graph are not committed. The project's full
example is at `viewer/samples/clara-mercier.cof` in the same repository (15.5 MB, format 1.2); the
adapter was also run against it and against a single-preset slice of it during development.
