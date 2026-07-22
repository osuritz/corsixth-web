import { buildModuleConfig, type EmFS } from './fs-setup';

declare const Module: (config: object) => Promise<unknown>;

export function setStatus(text: string, isError = false): void {
  const el = document.getElementById('overlay-status')!;
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
  try { await Module(config); } catch (e) { setStatus(`Engine failed to start: ${String(e)}`, true); }
  finally { clearTimeout(watchdog); }
}

// Task 3 replaces this bootstrap with the assets-present check + onboarding branch.
void bootEngine(async () => 0);
