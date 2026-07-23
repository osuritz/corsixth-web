// Public API surface. Everything a consumer needs is exported from here — see README.md for
// a quickstart and the per-function docs in xmi2mid.ts / synth.ts / render.ts for details.
export { transcodeXmiToMid } from './xmi2mid';
export { renderMidiToPcm, type PcmRenderResult } from './synth';
export { encodeWav } from './wav';
export {
  renderXmiToAudio,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_VBR_QUALITY,
  type AudioFormat,
  type RenderXmiToAudioOptions,
  type RenderXmiToAudioResult,
} from './render';
