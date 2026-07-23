# M3 Task 5 — Ingest Memory: Bounded Put-Drain + Full-Size Measurement

Branch: `wasm`. All synthetic zip content is **random bytes only** (`node:crypto`
`randomFillSync`), generated and staged under `$TMPDIR`, never committed, and never
real GOG/Theme Hospital data. Nothing audio/game-derived is included in this task.

## The problem (M2 close-out finding)

`ingestZip` streamed the zip through `fflate`'s `Unzip`, assembling each file's bytes
into a single `Uint8Array` (`total`) and calling `putAsset(norm, total)`, but pushed
every returned promise into a `pending` array and only `await Promise.all(pending)`
once at the very end of the whole zip. Because IndexedDB's `put()` needs its argument
alive until the browser structured-clones/commits it, and JS keeps each `total` buffer
reachable via the still-pending promise chain, every file's assembled bytes stayed live
until the *entire zip* finished ingesting. The existing comment ("one file's bytes in
memory at a time") overstated the actual bound — for a GOG-scale (hundreds-of-MB) full
install, this meant peak memory could approach the full uncompressed install size.

`onfile`/`ondata` are synchronous fflate callbacks — you cannot `await` inside them — so
the fix drains the `pending` array between `unzip.push()` calls in the outer reader
loop instead.

## Fix

`web/src/onboarding.ts`:

```ts
// Cap on putAsset promises in flight at once. Each holds one assembled file buffer alive
// until IndexedDB commits it, so this bounds ingest peak memory regardless of zip size
// (GOG installs are hundreds of MB). fflate's onfile/ondata are synchronous, so we drain
// between reader chunks rather than inside the callbacks.
export const MAX_INFLIGHT_PUTS = 8;
```

In the reader loop, after each `unzip.push(value, false)`:

```ts
if (pending.length >= MAX_INFLIGHT_PUTS) { await Promise.all(pending); pending = []; }
```

`finishIngest` (validation, best-effort music render, `location.reload()`) is unchanged
and still runs only after the final `await Promise.all(pending)` — the drain is entirely
internal to the reader loop and does not touch the recovery/music-render flow.

## TDD

Added to `web/src/onboarding.test.ts`:

```ts
test('MAX_INFLIGHT_PUTS is a small, finite bound', () => {
  assert.ok(Number.isInteger(MAX_INFLIGHT_PUTS) && MAX_INFLIGHT_PUTS > 0 && MAX_INFLIGHT_PUTS <= 64);
});
```

Confirmed red first (`No matching export in "src/onboarding.ts" for import "MAX_INFLIGHT_PUTS"`)
before adding the export. This is a pure-Node unit test — it pins the bound's existence
and shape (a pure/testable constant), not the runtime concurrency effect, since a Node
test has no IndexedDB. The in-browser measurement harness below is what proves the
memory effect at full zip size. `npm test` (in `web/`): **12/12 pass** (8 pre-existing +
this new one; the other 3 "new" lines in the run are pre-existing tests from work
already on this branch, not part of this task).

## Full-size synthetic measurement

`web/measure-ingest-memory.mjs` builds a GOG-scale zip from **random bytes only**
(never real game data), laid out across `DATA/DATAM/LEVELS/QDATA/QDATAM/ANIMS/INTRO/SOUND`
(the engine's allowed top-level dirs, so `normalizeAssetPath` accepts every entry), serves
it alongside the built shell via a small local static server, and ingests it through the
`?test=1` product-shell hook (`window.__corsixthTest.ingestZip`, gated in `web/src/main.ts`
— never present outside `?test=1`). Peak `performance.memory.usedJSHeapSize` is sampled
every 100ms plus on every `onProgress` tick.

The synthetic entries are deliberately named to **not** include the three
engine-required paths (`DATA/VBLK-0.TAB`, `LEVELS/LEVEL.L1`, `QDATA/SPOINTER.DAT`), so
`validateAssetPaths()` fails by design and `finishIngest`'s recovery branch
(`clearAssets()` + throw) runs instead of `location.reload()`. That's intentional here:
the memory of interest is produced during the streaming-unzip + `putAsset` storage phase,
which completes in full before validation ever inspects the result, and skipping the
reload means the measurement doesn't have to race a page navigation. The
`clearAssets()` in the recovery branch is also a convenient cleanup of the ~320MB we
just wrote into the test browser's IndexedDB.

**Caveat (stated up front, not just a footnote): `performance.memory` is Chromium-only,
coarse, rounded, and GC-timing-dependent — this is a directional check that the bound
holds at size, not a precise allocator readout.** Both runs below used the identical
harness/corpus-generation code — only `web/src/onboarding.ts` differed (bounded vs.
unbounded), isolated via `git stash`/`git stash pop` around two `npm run build` +
measurement passes.

### Corpus

- ~320 MB raw, uncompressed (`zipSync(files, { level: 0 })` — STORE method; the bytes are
  random so DEFLATE wouldn't help), 264–276 entries per run (file count varies run to run
  because entry sizes are randomized between 0.4–2 MB; total is held to the ~320MB target)
- Built and served from `$TMPDIR`, never staged into the repo or `web/dist/`

### Results

| Run | `onboarding.ts` state | Entries | Raw size | Peak `usedJSHeapSize` |
|---|---|---|---|---|
| BEFORE | unbounded (`Promise.all(pending)` only at the end) | 272 | 320.0 MB | **270.3 MB** |
| AFTER (run 1) | bounded (`MAX_INFLIGHT_PUTS = 8`, drained per reader chunk) | 276 | 320.2 MB | **159.8 MB** |
| AFTER (run 2) | bounded, same code, re-run for variance | 265 | 320.7 MB | **110.7 MB** |

The bound cuts peak heap by ~41–59% on this corpus (270.3 MB → 159.8/110.7 MB across two
AFTER runs) and stays well under the ~320MB raw corpus size on both, unlike the unbounded
BEFORE run, which approached it (270.3 / 320.0 MB — the vast majority of the corpus was
live in the JS heap simultaneously, matching the theoretical failure mode this task set
out to fix). The 160→111 MB spread between the two identical-code AFTER runs is itself
evidence of `performance.memory`'s GC-timing sensitivity — only one BEFORE run was
taken (each run requires a full stash/build/measure cycle), but the gap to either AFTER
sample is large enough that run-to-run variance doesn't threaten the conclusion.

**Honest caveat on the AFTER number**: it does *not* land at the naive "small multiple
of `MAX_INFLIGHT_PUTS × max-file-size`" estimate (8 × 2MB ≈ 16MB) — it's ~10x higher.
The drain checkpoint (`if (pending.length >= MAX_INFLIGHT_PUTS)`) is evaluated once per
outer `reader.read()` iteration, not once per completed file. For a `Blob`-backed `File`
(as `?test=1`'s `fetch(...).blob()` produces, and as a real drag-and-drop `File` also
is), Chrome's `ReadableStream` from `.stream()` can yield several MB per `read()` call —
enough, at our ~0.4–2MB average entry size, to complete more than 8 files inside a
single reader iteration before the drain point is ever reached. So the effective
in-flight ceiling in practice is coarser than a literal 8, plus baseline shell/JS-engine
overhead. The fix is still directionally correct and substantial (a ~41% reduction, and
materially sub-linear in corpus size rather than tracking it), but a tighter bound would
require draining at the granularity of completed files (e.g. inside `ondata`'s `final`
branch, immediately after each `pending.push(...)`, awaiting once the count exceeds the
cap and only *then* continuing to feed the reader) rather than once per raw-byte chunk.
That refinement is out of scope for this task's brief (which specified per-reader-chunk
draining) and is left as a follow-up if a tighter bound is later required.

### Reproducing

```bash
cd web
npm run build         # needs build-wasm/**/corsix-th.{js,wasm,data} (ARTIFACTS_DIR override supported)
node measure-ingest-memory.mjs   # sandbox-disabled: launches Chrome + a local HTTP server
```

Chrome path resolution follows the existing `e2e-playable.mjs`/`boot-smoke.mjs`
convention (`$CHROME_PATH` env override, else `which google-chrome-stable` etc., else
the macOS default path).
