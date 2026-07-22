export function setStatus(text: string, isError = false): void {
  const el = document.getElementById('overlay-status')!;
  el.textContent = text;
  el.classList.toggle('error', isError);
}
export function hideOverlay(): void { document.getElementById('overlay')!.classList.add('hidden'); }
export function showSaveBanner(): void { document.getElementById('save-banner')!.classList.remove('hidden'); }

setStatus('Shell skeleton — engine wiring lands in the next task.');
