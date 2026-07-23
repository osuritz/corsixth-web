import test from 'node:test';
import assert from 'node:assert';
import { normalizeAssetPath, MAX_INFLIGHT_PUTS, BoundedQueue } from './onboarding';
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

// BoundedQueue is ingestZip's true per-file backpressure primitive (generic over the
// write function specifically so it's testable here without IndexedDB — see
// onboarding.ts's comment on the class). These pin the properties that actually matter
// for the memory bound: concurrency never exceeds `limit`, whenBelow(1) only resolves
// once fully drained, and a failure is captured rather than silently dropped/deadlocked.
test('BoundedQueue never runs more than `limit` writes concurrently', async () => {
  let active = 0;
  let maxActive = 0;
  // setTimeout (a real event-loop tick, not a same-turn microtask) lets pump()'s natural
  // refill behavior play out across multiple rounds instead of us having to hand-drive
  // exact microtask interleaving.
  const write = () => new Promise<void>((resolve) => {
    active++;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => { active--; resolve(); }, 0);
  });
  const q = new BoundedQueue<number>(3, write, () => {});
  for (let i = 0; i < 10; i++) q.push(i);
  // All 10 items are queued synchronously by the loop above, but only `limit` (3)
  // should actually have started (pump() stops once inflight reaches the limit).
  assert.equal(active, 3, 'only `limit` writes should start immediately, even though 10 were queued synchronously');
  await q.whenBelow(1);
  assert.equal(maxActive, 3, 'peak concurrency must never exceed the limit');
  assert.equal(q.count, 10);
});

test('BoundedQueue.whenBelow(1) resolves only once the queue is fully drained', async () => {
  const write = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  const q = new BoundedQueue<number>(2, write, () => {});
  q.push(1); q.push(2); q.push(3);
  let drained = false;
  const wait = q.whenBelow(1).then(() => { drained = true; });
  assert.equal(drained, false, 'must not resolve synchronously while writes are still pending');
  await wait;
  assert.equal(drained, true);
  assert.equal(q.count, 3);
});

test('BoundedQueue captures the first write failure without deadlocking whenBelow', async () => {
  const boom = new Error('write failed');
  const q = new BoundedQueue<number>(2, async (n) => { if (n === 1) throw boom; }, () => {});
  q.push(0); q.push(1); q.push(2);
  await q.whenBelow(1);
  assert.equal(q.firstError, boom);
  assert.equal(q.count, 2, 'the two successful writes still complete and count');
});
