// Post-boot music render orchestration (M3+ worker offload + retry). Replaces the old
// onboarding-time renderMusic(): that ran synchronously on the main thread during
// ingest (~3s/track freeze, once, best-effort — any failure silently left the user
// permanently music-less with only a console.warn) with a design that is:
//  - Off the main thread: rendering runs in a Web Worker (music-render.js, adapted to
//    a dual worker/same-thread bundle — see its own header comment) so the UI never
//    freezes, with a same-thread fallback if Worker construction fails.
//  - Lazy: NOT run during ingest at all. finishIngest (onboarding.ts) reloads
//    immediately after validating the asset set: no ~3s/track wait before the engine
//    boots. Instead, resumeMusicRendering() is called from startShell() (main.ts)
//    on every successful boot; it runs in the background WHILE/AFTER the engine is
//    already up. The rendered files land in IndexedDB but are only picked up by
//    ensureMusicDir's MEMFS check on the *next* boot's preRun — the UX consequence
//    (documented, not hidden) is: ingest -> reload #1 boots without music and starts
//    rendering in the background -> once done, the notice offers a manual
//    "reload to enable music" -> reload #2 has music. This never auto-reloads out
//    from under a session in progress.
//  - Retriable: every track's outcome is persisted (idb.ts's render-status store) as
//    'pending' | 'rendering' | 'done' | 'error'. Anything not 'done' (including a
//    stale 'rendering' left by a crash/closed-tab mid-render, and a 'done' whose
//    MUSIC/ file has since gone missing) is retried on the next resumeMusicRendering()
//    call — whether that's the next boot or a manual click on the notice's Retry
//    button (main.ts wires that button back to this same function).
import {
  listAssetPaths, getAsset, putAsset, listRenderStatuses, setRenderStatus,
  type MusicRenderStatus,
} from './idb';

export type MusicNoticeState =
  | { kind: 'hidden' }
  | { kind: 'rendering'; done: number; total: number }
  | { kind: 'failed'; failedCount: number }
  | { kind: 'ready-reload' };

export type RenderResult = { bytes: Uint8Array; ext: 'OGG' | 'WAV' };

export interface RenderClient {
  renderXmiToAudio(xmi: Uint8Array): Promise<RenderResult>;
  terminate(): void;
}

// Thrown only when the WORKER ITSELF is broken (failed to load/parse, crashed) — as
// opposed to a normal per-track render failure (bad XMI, encoder error) that a healthy
// worker reports cleanly via { ok: false }. resumeMusicRendering only abandons the
// worker and switches to the same-thread fallback for THIS specific error; a plain
// per-track failure just records that one track as 'error' and continues with the same
// client for the rest of the batch.
export class WorkerFatalError extends Error {}

// Pure: given the discovered XMI tracks, the current MUSIC/ file listing, and each
// track's last known status, decide which tracks still need a render attempt. No
// IDB/Worker/DOM dependency — unit-tested directly in music-orchestrator.test.ts.
export function computeTracksNeedingRender(
  xmiPaths: readonly string[],
  musicPaths: ReadonlySet<string>,
  statuses: ReadonlyMap<string, MusicRenderStatus>,
): string[] {
  const todo: string[] = [];
  for (const p of xmiPaths) {
    const status = statuses.get(p);
    const name = p.slice(p.lastIndexOf('/') + 1).replace(/\.XMI$/i, '');
    const renderedPresent = musicPaths.has(`MUSIC/${name}.OGG`) || musicPaths.has(`MUSIC/${name}.WAV`);
    // No status yet, an explicit 'pending'/'error', OR a stale 'rendering' (crash/closed
    // tab mid-attempt — never actually finished) all need a fresh attempt. A 'done'
    // status is only trusted if the rendered file is still actually present (defensive
    // recovery if MUSIC/ was edited/evicted out from under the status store).
    if (!status || status.state !== 'done' || !renderedPresent) todo.push(p);
  }
  return todo;
}

function outputName(xmiPath: string, ext: 'OGG' | 'WAV'): string {
  return `MUSIC/${xmiPath.slice(xmiPath.lastIndexOf('/') + 1).replace(/\.XMI$/i, `.${ext}`)}`;
}

// Worker-mode client: posts 'render' requests to dist/music-render.js running as a
// dedicated Worker (see that file's isWorkerContext branch). Returns null (rather than
// throwing) if Worker construction itself fails synchronously — the caller falls back
// to the same-thread client for the whole batch in that case, per the task's explicit
// "keep a same-thread fallback if Worker construction fails".
export function createWorkerClient(): RenderClient | null {
  let worker: Worker;
  try {
    worker = new Worker('music-render.js');
  } catch (e) {
    console.warn('[music] Worker construction failed, using same-thread fallback:', e);
    return null;
  }
  type Resp = { type: 'result'; id: string; ok: true; bytes: Uint8Array; ext: 'OGG' | 'WAV' } |
    { type: 'result'; id: string; ok: false; error: string };
  const pending = new Map<string, { resolve: (r: RenderResult) => void; reject: (e: unknown) => void }>();
  worker.onerror = (ev) => {
    const err = new WorkerFatalError(`music worker failed: ${ev.message || 'unknown error'}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  worker.onmessage = (ev: MessageEvent<Resp>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve({ bytes: msg.bytes, ext: msg.ext });
    else p.reject(new Error(msg.error));
  };
  return {
    renderXmiToAudio(xmi: Uint8Array): Promise<RenderResult> {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        // No transfer here (unlike the worker's reply): `xmi` must stay valid on this
        // side in case a WorkerFatalError forces a same-thread-fallback retry of the
        // SAME xmi value (see the retry branch in resumeMusicRendering).
        worker.postMessage({ type: 'render', id, xmi });
      });
    },
    terminate() { worker.terminate(); },
  };
}

type MainThreadRenderer = { renderXmiToAudio: (xmi: Uint8Array, sf: Uint8Array) => Promise<RenderResult> };

// Same-thread fallback: loads dist/music-render.js via a plain <script> tag (as the
// pre-worker code always did) and calls its exposed global directly — synchronous,
// blocking the calling thread for the render's duration, but a zero-risk safety net.
function loadMainThreadRenderer(): Promise<MainThreadRenderer> {
  const g = self as unknown as { __corsixthRenderMusic?: MainThreadRenderer };
  if (g.__corsixthRenderMusic) return Promise.resolve(g.__corsixthRenderMusic);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'music-render.js';
    s.onload = () => g.__corsixthRenderMusic ? resolve(g.__corsixthRenderMusic) : reject(new Error('music-render loaded but global missing'));
    s.onerror = () => reject(new Error('failed to load music-render.js'));
    document.head.appendChild(s);
  });
}

let cachedSoundfont: Uint8Array | undefined;
async function fetchSoundfont(): Promise<Uint8Array> {
  if (cachedSoundfont) return cachedSoundfont;
  const res = await fetch('FluidR3.sf3');
  if (!res.ok) throw new Error(`soundfont fetch ${res.status}`);
  cachedSoundfont = new Uint8Array(await res.arrayBuffer());
  return cachedSoundfont;
}

export async function createFallbackClient(): Promise<RenderClient> {
  const soundfont = await fetchSoundfont();
  const renderer = await loadMainThreadRenderer();
  return {
    renderXmiToAudio: (xmi) => renderer.renderXmiToAudio(xmi, soundfont),
    terminate() { /* no worker to tear down */ },
  };
}

// Dependencies as an overridable bag purely for unit testing (music-orchestrator.test.ts
// injects fakes for IDB + the render client so the retry/status logic — the actual
// point of this redesign — is testable without a real Worker or IndexedDB).
export interface MusicOrchestratorDeps {
  listAssetPaths: () => Promise<string[]>;
  getAsset: (p: string) => Promise<Uint8Array | undefined>;
  putAsset: (p: string, d: Uint8Array) => Promise<void>;
  listRenderStatuses: () => Promise<Map<string, MusicRenderStatus>>;
  setRenderStatus: (p: string, s: MusicRenderStatus) => Promise<void>;
  createClient: () => RenderClient | null;
  createFallbackClient: () => Promise<RenderClient>;
}

const defaultDeps: MusicOrchestratorDeps = {
  listAssetPaths, getAsset, putAsset, listRenderStatuses, setRenderStatus,
  createClient: createWorkerClient, createFallbackClient,
};

let running = false;

// Entry point: called from startShell() on every successful boot (fresh-ingest reload
// and every subsequent normal load alike), and again from the notice's Retry button.
// No-op (besides the notice callback never firing) if there's nothing to do: no XMI
// tracks at all, or every track is already 'done' with its file still present.
export async function resumeMusicRendering(
  onNotice: (state: MusicNoticeState) => void,
  deps: MusicOrchestratorDeps = defaultDeps,
): Promise<void> {
  if (running) return; // a pass is already in flight (boot + a fast manual retry click)
  running = true;
  try {
    await runPass(onNotice, deps);
  } finally {
    running = false;
  }
}

async function runPass(onNotice: (state: MusicNoticeState) => void, deps: MusicOrchestratorDeps): Promise<void> {
  let paths: string[];
  try {
    paths = await deps.listAssetPaths();
  } catch (e) {
    console.warn('[music] could not list assets, skipping:', e); // best-effort
    return;
  }
  const xmis = paths.filter((p) => /^SOUND\/MIDI\/[^/]+\.XMI$/.test(p));
  if (xmis.length === 0) return;

  const musicPaths = new Set(paths.filter((p) => /^MUSIC\//.test(p)));
  const statuses = await deps.listRenderStatuses().catch(() => new Map<string, MusicRenderStatus>());
  const todo = computeTracksNeedingRender(xmis, musicPaths, statuses);
  if (todo.length === 0) return; // everything already rendered and present

  onNotice({ kind: 'rendering', done: 0, total: todo.length });

  let client = deps.createClient();
  let usingFallback = client === null;
  let failed = 0;

  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    await deps.setRenderStatus(p, { state: 'rendering', updatedAt: Date.now() }).catch(() => {});
    try {
      if (!client) client = await deps.createFallbackClient();
      const xmi = await deps.getAsset(p);
      if (!xmi) throw new Error('asset missing from storage');
      let result: RenderResult;
      try {
        result = await client.renderXmiToAudio(xmi);
      } catch (e) {
        if (e instanceof WorkerFatalError && !usingFallback) {
          console.warn('[music] worker unavailable mid-render, switching to same-thread fallback:', e);
          usingFallback = true;
          client.terminate();
          client = await deps.createFallbackClient();
          result = await client.renderXmiToAudio(xmi);
        } else {
          throw e;
        }
      }
      await deps.putAsset(outputName(p, result.ext), result.bytes);
      await deps.setRenderStatus(p, { state: 'done', updatedAt: Date.now() });
    } catch (e) {
      failed++;
      const message = String(e instanceof Error ? e.message : e);
      console.warn(`[music] render failed for ${p}:`, e); // per-track suppress — status carries the message for the UI
      await deps.setRenderStatus(p, { state: 'error', error: message, updatedAt: Date.now() }).catch(() => {});
    }
    onNotice({ kind: 'rendering', done: i + 1, total: todo.length });
  }
  client?.terminate();

  // Preserve track titles: copy any track-list TXT (e.g. MIDIDEM.TXT) into MUSIC/ so
  // audio.lua's midi_txt detection still names tracks. Cosmetic, cheap, best-effort —
  // never allowed to turn a successful render pass into a reported failure.
  try {
    for (const q of paths.filter((x) => /^SOUND\/MIDI\/[^/]+\.TXT$/.test(x))) {
      const txt = await deps.getAsset(q);
      if (txt) await deps.putAsset(`MUSIC/${q.slice(q.lastIndexOf('/') + 1)}`, txt);
    }
  } catch (e) {
    console.warn('[music] track-title copy failed, skipping:', e); // best-effort
  }

  onNotice(failed > 0 ? { kind: 'failed', failedCount: failed } : { kind: 'ready-reload' });
}
