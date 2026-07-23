import test from 'node:test';
import assert from 'node:assert';
import { normalizeAssetPath, MAX_INFLIGHT_PUTS } from './onboarding';
import { validateAssetPaths } from './idb';

test('normalizeAssetPath strips wrapper dirs and uppercases', () => {
  assert.equal(normalizeAssetPath('HOSP/DATA/VBlk-0.tab'), 'DATA/VBLK-0.TAB');
  assert.equal(normalizeAssetPath('data/foo.dat'), 'DATA/FOO.DAT');
  assert.equal(normalizeAssetPath('Theme Hospital/game/QDATA/SPointer.dat'), 'QDATA/SPOINTER.DAT');
});
test('normalizeAssetPath rejects paths outside allowed dirs', () => {
  assert.equal(normalizeAssetPath('SAVE/slot1.sav'), null);
  assert.equal(normalizeAssetPath('README.TXT'), null);
  assert.equal(normalizeAssetPath('DATA/'), null); // directory entry, not a file
});
test('validateAssetPaths requires the three engine-check files', () => {
  assert.deepEqual(validateAssetPaths(['DATA/VBLK-0.TAB', 'LEVELS/LEVEL.L1', 'QDATA/SPOINTER.DAT']), { ok: true, missing: [] });
  const r = validateAssetPaths(['DATA/VBLK-0.TAB']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['LEVELS/LEVEL.L1', 'QDATA/SPOINTER.DAT']);
});
// M3 Task 5: ingestZip must bound concurrently in-flight putAsset promises (each holds
// one assembled file buffer live until IndexedDB commits it) rather than accumulating
// all of them for a final Promise.all — that would keep every file's bytes in memory
// at once for a GOG-scale (hundreds-of-MB) install. This unit test pins the bound's
// existence/shape; the in-browser measurement harness (measure-ingest-memory.mjs)
// proves the resulting memory effect at full zip size.
test('MAX_INFLIGHT_PUTS is a small, finite bound', () => {
  assert.ok(Number.isInteger(MAX_INFLIGHT_PUTS) && MAX_INFLIGHT_PUTS > 0 && MAX_INFLIGHT_PUTS <= 64);
});
