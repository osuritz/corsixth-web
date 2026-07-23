import { buildModuleConfig, type EmFS } from './fs-setup';
import { listAssetPaths, clearAssets, populateThData, validateAssetPaths } from './idb';
import { showOnboarding, ingestZip } from './onboarding';

declare const Module: (config: object) => Promise<{ FS?: EmFS }>;

// Captured after a successful boot so the ?test=1 hook can assert on the engine FS
// (e.g. quicksave.qs existence). Never read in production paths.
let engineModule: { FS?: EmFS } | undefined;

export function setStatus(text: string, isError = false): void {
  // Fallback to #ingest-status: onboarding.ts's finishIngest() calls this after a
  // successful ingest, by which point showOnboarding() has already replaced
  // #overlay-status with the onboarding markup (#overlay-status no longer exists).
  const el = document.getElementById('overlay-status') ?? document.getElementById('ingest-status');
  if (!el) { console[isError ? 'error' : 'log']('[shell status]', text); return; }
  el.textContent = text;
  el.classList.toggle('error', isError);
}
export function hideOverlay(): void { document.getElementById('overlay')!.classList.add('hidden'); }
export function showSaveBanner(): void { document.getElementById('save-banner')!.classList.remove('hidden'); }

export async function bootEngine(populateData: (FS: EmFS) => Promise<number>): Promise<void> {
  setStatus('Starting engine…');
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const config = buildModuleConfig(canvas, {
    onGameReady: () => hideOverlay(),
    onSaveSyncError: (detail) => { console.error('[shell] save sync failed:', detail); showSaveBanner(); },
    onFatal: (detail) => setStatus(detail, true),
  }, populateData);
  const watchdog = setTimeout(() => setStatus('Still loading… (15MB of engine data on first visit)'), 10_000);
  try { engineModule = await Module(config); }
  catch (e) { setStatus(`Engine failed to start: ${String(e)}`, true); }
  finally { clearTimeout(watchdog); }
}

// Reuses setStatus's null-safe DOM lookup: by the time this runs, showOnboarding()
// has replaced #overlay-status with the onboarding markup, so setStatus falls
// through to #ingest-status (see setStatus's own comment above).
function showOnboardingWithMessage(message?: string): void {
  showOnboarding();
  if (message) setStatus(message, true);
}

export async function startShell(): Promise<void> {
  const paths = await listAssetPaths().catch(() => [] as string[]);
  if (paths.length > 0) {
    const { ok, missing } = validateAssetPaths(paths);
    if (ok) return bootEngine(populateThData);
    // Stored set is damaged (partial write, quota eviction) — recover to onboarding
    // instead of booting the engine into an invisible installer UI.
    console.error('[shell] stored assets invalid, missing:', missing);
    await clearAssets().catch(() => undefined);
    showOnboardingWithMessage('Stored game data was incomplete — please load it again.');
    return;
  }
  showOnboardingWithMessage();
}
// Guarded: onboarding.ts imports setStatus from here, so bundling onboarding.test.ts
// (Node, no DOM/IndexedDB) pulls in this module's top-level code too — only
// auto-start in a real browser document.
if (typeof document !== 'undefined') void startShell();

// Product-shell E2E hook: gated on ?test=1 so it never exists in the shipped
// product flow. Exposes the ingest entry point (the IIFE bundle otherwise hides
// it) and the booted engine FS for post-boot assertions. See web/e2e-playable.mjs.
if (typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('test')) {
  (window as unknown as { __corsixthTest: unknown }).__corsixthTest = {
    ingestZip,
    getFS: (): EmFS | undefined => engineModule?.FS,
  };
}
