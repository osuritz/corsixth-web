import test from 'node:test';
import assert from 'node:assert';
import { normalizeAssetPath } from './onboarding';
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
