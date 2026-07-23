# XMIDI Render Kit — Extraction Notes (Lane B, M1.x parallel effort)

Provenance: `docs/superpowers/research/2026-07-23-xmidi-options.md` (sponsor research + the
controller's Architecture-A resolution — the parser derives from CorsixTH's own MIT
`Src/xmi2mid.cpp`, not the GPL Exult/ScummVM parsers that research note also surveyed).

This note documents what was extracted, what's still pending sponsor sign-off, the dedup
follow-up, and the publish checklist. It lives outside `packages/` (the one documented
exception to this lane's file-ownership boundary) so it survives merge review even though the
package itself is not modified by it.

## What was built

`packages/xmidi-render-kit/` — a standalone, MIT-licensed npm package (working name; see below)
extracted from `web/src/`'s `xmi2mid.ts`, `synth.ts`, `wav.ts`, and the render-glue previously
inlined in `music-render.ts` (now a clean `renderXmiToAudio()` library entry point in
`src/render.ts`). `web/src/` was **copied from, not moved** — the original files there are
untouched and still power the shipping onboarding flow; this package is a parallel, dedup-able
extraction, not a replacement (yet).

Public API (`src/index.ts`):
- `transcodeXmiToMid(xmi: Uint8Array): Uint8Array | null`
- `renderMidiToPcm(mid, soundfont, sampleRate): Promise<{ pcm: Float32Array; channels: number }>`
- `renderXmiToAudio(xmi, soundfont, opts?: { format?, vbrQuality?, sampleRate? }): Promise<{ bytes, format }>`
- `encodeWav(pcm, sampleRate, channels): Uint8Array`

Verified green: `npm install && npm test && npm run build` (5 tests, including an end-to-end
smoke test that renders a synthetic in-test XMI fixture through the real
`spessasynth_core` + `wasm-media-encoders` pipeline to a genuine OGG file and checks its
`OggS` magic + nonzero length — no real game/copyrighted bytes involved anywhere in the test
suite). `dist/` ships a single bundled ESM file (`spessasynth_core` and `wasm-media-encoders`
stay external as regular `dependencies`) plus per-module `.d.ts` via `tsc`.

One correctness note surfaced while building the smoke test: a *maximally minimal* synthetic
XMI fixture (every event packed back-to-back with zero trailing delay before the end-of-track
marker — which is what `xmi2mid.test.ts`'s existing structural-byte-layout fixture does) causes
the transcoded MIDI's end-of-track marker to sort *before* the generated note-off event,
producing a MIDI with a duration of exactly 0 seconds. `spessasynth_core`'s sequencer then
silently declines to load such a MIDI at all (logs a warning, plays nothing). This isn't a bug
in the ported parser — it faithfully reproduces the original C++ control flow, and real XMI
files always carry enough trailing delta-time to let their last note ring out — but it's worth
knowing if anyone else builds a "minimal" XMI fixture by hand: add a trailing delay byte before
`FF 2F` if you want the result to actually be non-degenerate.

## Dedup follow-up (post-merge)

Not done in this lane (out of scope: `packages/**` only, per the file-ownership boundary).
Proposed follow-up ticket once this package lands and the controller merges all four v1.x
lanes:

1. Add `packages/xmidi-render-kit` as a `file:` (or workspace, if the repo adopts npm/pnpm
   workspaces at that point) dependency of `web/package.json`.
2. Delete `web/src/xmi2mid.ts`, `synth.ts`, `wav.ts`, and the render-glue portion of
   `music-render.ts`; replace with `import { transcodeXmiToMid, renderXmiToAudio } from
   'xmidi-render-kit'` (or the published name — see below).
3. Delete the now-duplicate `web/src/xmi2mid.test.ts` and `wav.test.ts` (superseded by the
   package's own tests) — `web`'s own test suite then only needs to cover `web`-specific glue
   (asset discovery, ingest orchestration), not the XMI/synth/encode internals.
4. Point `web/scripts/fetch-soundfont.mjs` at the package's copy (or keep both — they're
   identical files, harmless duplication either way) until/unless the two are unified.
5. Re-run `web`'s full test + e2e-playable + boot-smoke suite to confirm no behavior change
   (the extracted code is byte-for-byte identical logic; only import paths and the `music-
   render.ts`-inlined glue vs. the new `renderXmiToAudio()` wrapper differ).

This is a mechanical, low-risk follow-up — the actual algorithm code is unchanged, just its
package boundary — but it's real work (touching `web/`, outside this lane's boundary) and
should be its own reviewed PR rather than bundled into this extraction.

## Name candidates

`xmidi-render-kit` is a placeholder pending sponsor sign-off. Alternatives considered:

| Name | Notes |
|---|---|
| `xmidi-render-kit` | Current placeholder. Clear, a bit long. |
| `xmi2audio` | Short, punchy; mirrors the `xmi2mid.cpp` naming lineage. |
| `xmidi-to-audio` | Very literal/discoverable; matches common "x-to-y" npm naming conventions. |
| `mss-xmidi-render` | Leads with "Miles Sound System" for searchers who know the format by that name rather than "XMIDI". |
| `xmi-render-kit` | Drops the "d" — matches the `.xmi` file extension exactly; `xmidi` is the format name, `.xmi` the extension, both are in common use. |
| `@corsixth/xmidi-render-kit` | Scoped under a `corsixth` npm org, if the sponsor wants to signal project affiliation despite the package being game-agnostic. |

Recommendation: `xmi2audio` or `xmidi-to-audio` for discoverability (both read clearly as
"convert this format to audio"); `xmidi-render-kit` if a more toolkit-flavored name is
preferred. Whichever is picked, update `package.json`'s `name` field, the README title, and
the `renderXmiToAudio` import example before publishing — none of the code depends on the
package's own name.

## Publish checklist (for the sponsor — not done in this lane)

This lane intentionally stops short of publishing (per the mission: "prepare, NOT publish").
When ready:

1. **Decide the final name** from the candidates above (or a new one) and update
   `package.json`.
2. **Check name availability**:
   ```sh
   npm view <candidate-name>          # 404 / "npm ERR! 404 Not Found" means it's free
   ```
   Repeat for each candidate before committing to one.
3. **npm account**: sponsor needs an npm account with publish rights (2FA recommended). If
   publishing under an org scope (e.g. `@corsixth`), create/reuse that org first:
   ```sh
   npm login
   npm whoami                          # confirm logged in as the right account
   ```
4. **Final pre-publish sanity pass** (from `packages/xmidi-render-kit/`):
   ```sh
   npm install
   npm test
   npm run build
   npm pack --dry-run                  # inspect exactly what `files` would ship
   ```
5. **Version**: `0.1.0` is already set; bump only if the sponsor wants to start elsewhere
   (e.g. `0.1.0` is reasonable for a first-ever publish of a documented-partial-scope package).
6. **Publish**:
   ```sh
   npm publish --access public         # required for scoped (@org/name) packages; harmless no-op flag for unscoped names
   ```
7. **Post-publish**: tag the commit (`git tag xmidi-render-kit@0.1.0`), update
   `CHANGELOG.md`'s `[Unreleased]` section to a dated `[0.1.0]` release header, and open the
   dedup follow-up ticket described above.
