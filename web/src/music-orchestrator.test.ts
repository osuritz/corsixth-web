import test from 'node:test';
import assert from 'node:assert';
import {
  computeTracksNeedingRender, resumeMusicRendering, WorkerFatalError,
  type MusicOrchestratorDeps, type MusicNoticeState, type RenderClient, type RenderResult,
} from './music-orchestrator';
import type { MusicRenderStatus } from './idb';

// --- computeTracksNeedingRender: pure, no IDB/Worker/DOM --------------------------

test('computeTracksNeedingRender: no status yet -> needs render', () => {
  const todo = computeTracksNeedingRender(['SOUND/MIDI/TRACK1.XMI'], new Set(), new Map());
  assert.deepEqual(todo, ['SOUND/MIDI/TRACK1.XMI']);
});

test('computeTracksNeedingRender: done + rendered file present -> no work', () => {
  const statuses = new Map<string, MusicRenderStatus>([
    ['SOUND/MIDI/TRACK1.XMI', { state: 'done', updatedAt: 1 }],
  ]);
  const music = new Set(['MUSIC/TRACK1.OGG']);
  assert.deepEqual(computeTracksNeedingRender(['SOUND/MIDI/TRACK1.XMI'], music, statuses), []);
});

test('computeTracksNeedingRender: done but WAV fallback extension also counts as present', () => {
  const statuses = new Map<string, MusicRenderStatus>([
    ['SOUND/MIDI/TRACK1.XMI', { state: 'done', updatedAt: 1 }],
  ]);
  const music = new Set(['MUSIC/TRACK1.WAV']);
  assert.deepEqual(computeTracksNeedingRender(['SOUND/MIDI/TRACK1.XMI'], music, statuses), []);
});

test('computeTracksNeedingRender: done status but file missing (defensive recovery) -> needs render', () => {
  const statuses = new Map<string, MusicRenderStatus>([
    ['SOUND/MIDI/TRACK1.XMI', { state: 'done', updatedAt: 1 }],
  ]);
  assert.deepEqual(computeTracksNeedingRender(['SOUND/MIDI/TRACK1.XMI'], new Set(), statuses), ['SOUND/MIDI/TRACK1.XMI']);
});

test('computeTracksNeedingRender: pending, error, and stale rendering statuses all need (re)render', () => {
  const statuses = new Map<string, MusicRenderStatus>([
    ['SOUND/MIDI/A.XMI', { state: 'pending', updatedAt: 1 }],
    ['SOUND/MIDI/B.XMI', { state: 'error', error: 'boom', updatedAt: 1 }],
    ['SOUND/MIDI/C.XMI', { state: 'rendering', updatedAt: 1 }], // crash/closed-tab mid-attempt
  ]);
  const todo = computeTracksNeedingRender(
    ['SOUND/MIDI/A.XMI', 'SOUND/MIDI/B.XMI', 'SOUND/MIDI/C.XMI'], new Set(), statuses,
  );
  assert.deepEqual(todo, ['SOUND/MIDI/A.XMI', 'SOUND/MIDI/B.XMI', 'SOUND/MIDI/C.XMI']);
});

// --- resumeMusicRendering: retry/status orchestration, via injected fakes ---------

function makeFakeDeps(overrides: Partial<MusicOrchestratorDeps> & {
  assets?: Record<string, Uint8Array>;
  musicWrites?: Record<string, Uint8Array>;
  statuses?: Map<string, MusicRenderStatus>;
} = {}): MusicOrchestratorDeps & { musicWrites: Record<string, Uint8Array>; statuses: Map<string, MusicRenderStatus> } {
  const assets = overrides.assets ?? {};
  const musicWrites: Record<string, Uint8Array> = overrides.musicWrites ?? {};
  const statuses = overrides.statuses ?? new Map<string, MusicRenderStatus>();
  const base: MusicOrchestratorDeps & { musicWrites: Record<string, Uint8Array>; statuses: Map<string, MusicRenderStatus> } = {
    listAssetPaths: async () => Object.keys(assets),
    getAsset: async (p) => assets[p],
    putAsset: async (p, d) => { musicWrites[p] = d; },
    listRenderStatuses: async () => new Map(statuses),
    setRenderStatus: async (p, s) => { statuses.set(p, s); },
    createClient: () => null,
    createFallbackClient: async () => { throw new Error('no fallback client configured for this test'); },
    musicWrites,
    statuses,
  };
  return Object.assign(base, overrides);
}

function fakeClient(renderXmiToAudio: (xmi: Uint8Array) => Promise<RenderResult>): RenderClient {
  return { renderXmiToAudio, terminate() {} };
}

test('resumeMusicRendering: no XMI tracks -> no-op, notice never called', async () => {
  const deps = makeFakeDeps({ assets: { 'DATA/VBLK-0.TAB': new Uint8Array([1]) } });
  const notices: MusicNoticeState[] = [];
  await resumeMusicRendering((n) => notices.push(n), deps);
  assert.deepEqual(notices, []);
});

test('resumeMusicRendering: everything already done and present -> no-op', async () => {
  const deps = makeFakeDeps({
    assets: { 'SOUND/MIDI/TRACK1.XMI': new Uint8Array([1]), 'MUSIC/TRACK1.OGG': new Uint8Array([2]) },
    statuses: new Map([['SOUND/MIDI/TRACK1.XMI', { state: 'done', updatedAt: 1 }]]),
  });
  const notices: MusicNoticeState[] = [];
  await resumeMusicRendering((n) => notices.push(n), deps);
  assert.deepEqual(notices, []);
});

test('resumeMusicRendering: happy path renders every pending track and reports ready-reload', async () => {
  const xmi1 = new Uint8Array([1, 2, 3]);
  const xmi2 = new Uint8Array([4, 5, 6]);
  const deps = makeFakeDeps({
    assets: { 'SOUND/MIDI/A.XMI': xmi1, 'SOUND/MIDI/B.XMI': xmi2 },
    createClient: () => fakeClient(async (xmi) => ({ bytes: new Uint8Array([...xmi, 9]), ext: 'OGG' })),
  });
  const notices: MusicNoticeState[] = [];
  await resumeMusicRendering((n) => notices.push(n), deps);

  assert.deepEqual(notices[0], { kind: 'rendering', done: 0, total: 2 });
  assert.deepEqual(notices.at(-1), { kind: 'ready-reload' });
  assert.equal(deps.statuses.get('SOUND/MIDI/A.XMI')?.state, 'done');
  assert.equal(deps.statuses.get('SOUND/MIDI/B.XMI')?.state, 'done');
  assert.deepEqual([...deps.musicWrites['MUSIC/A.OGG']], [1, 2, 3, 9]);
  assert.deepEqual([...deps.musicWrites['MUSIC/B.OGG']], [4, 5, 6, 9]);
});

test('resumeMusicRendering: a per-track failure records status error and keeps using the same client for the rest', async () => {
  let calls = 0;
  const deps = makeFakeDeps({
    assets: { 'SOUND/MIDI/A.XMI': new Uint8Array([1]), 'SOUND/MIDI/B.XMI': new Uint8Array([2]) },
    createClient: () => fakeClient(async () => {
      calls++;
      if (calls === 1) throw new Error('bad XMI'); // a normal, non-fatal per-track failure
      return { bytes: new Uint8Array([9]), ext: 'WAV' };
    }),
  });
  const notices: MusicNoticeState[] = [];
  await resumeMusicRendering((n) => notices.push(n), deps);

  assert.equal(calls, 2, 'the worker client must still be used for the second track, not abandoned');
  assert.equal(deps.statuses.get('SOUND/MIDI/A.XMI')?.state, 'error');
  assert.equal(deps.statuses.get('SOUND/MIDI/A.XMI')?.error, 'bad XMI');
  assert.equal(deps.statuses.get('SOUND/MIDI/B.XMI')?.state, 'done');
  assert.deepEqual(notices.at(-1), { kind: 'failed', failedCount: 1 });
});

test('resumeMusicRendering: WorkerFatalError switches to the same-thread fallback mid-batch and completes', async () => {
  let terminated = false;
  const workerClient = fakeClient(async () => { throw new WorkerFatalError('worker crashed'); });
  workerClient.terminate = () => { terminated = true; };
  let fallbackCalls = 0;
  const deps = makeFakeDeps({
    assets: { 'SOUND/MIDI/A.XMI': new Uint8Array([1]), 'SOUND/MIDI/B.XMI': new Uint8Array([2]) },
    createClient: () => workerClient,
    createFallbackClient: async () => fakeClient(async (xmi) => {
      fallbackCalls++;
      return { bytes: new Uint8Array([...xmi, 42]), ext: 'OGG' };
    }),
  });
  const notices: MusicNoticeState[] = [];
  await resumeMusicRendering((n) => notices.push(n), deps);

  assert.ok(terminated, 'the broken worker client must be terminated once a fatal error is detected');
  // Both tracks end up rendered via the fallback: track A retried immediately after the
  // fatal error, track B goes straight to the (now-active) fallback client.
  assert.equal(fallbackCalls, 2);
  assert.equal(deps.statuses.get('SOUND/MIDI/A.XMI')?.state, 'done');
  assert.equal(deps.statuses.get('SOUND/MIDI/B.XMI')?.state, 'done');
  assert.deepEqual(notices.at(-1), { kind: 'ready-reload' });
});

test('resumeMusicRendering: Worker construction failing synchronously goes straight to the fallback for the whole batch', async () => {
  let fallbackCalls = 0;
  const deps = makeFakeDeps({
    assets: { 'SOUND/MIDI/A.XMI': new Uint8Array([1]) },
    createClient: () => null, // simulates `new Worker(...)` throwing
    createFallbackClient: async () => fakeClient(async () => { fallbackCalls++; return { bytes: new Uint8Array([7]), ext: 'WAV' }; }),
  });
  const notices: MusicNoticeState[] = [];
  await resumeMusicRendering((n) => notices.push(n), deps);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(notices.at(-1), { kind: 'ready-reload' });
});

test('resumeMusicRendering: concurrent calls — a pass already in flight makes the second call a no-op', async () => {
  let started = 0;
  let releaseFirst: (() => void) | undefined;
  let notifyStarted: (() => void) | undefined;
  // Synchronize deterministically instead of racing on microtask timing: only call
  // `second` once we KNOW `first` has set `running = true` and actually begun a render.
  const startedPromise = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const deps = makeFakeDeps({
    assets: { 'SOUND/MIDI/A.XMI': new Uint8Array([1]) },
    createClient: () => fakeClient(async () => { started++; notifyStarted!(); await gate; return { bytes: new Uint8Array([1]), ext: 'OGG' }; }),
  });
  const first = resumeMusicRendering(() => {}, deps);
  await startedPromise;
  const second = resumeMusicRendering(() => {}, deps); // should observe `running` and return immediately
  await second;
  assert.equal(started, 1, 'only one pass should actually be driving renders while the first is in flight');
  releaseFirst!();
  await first;
});
