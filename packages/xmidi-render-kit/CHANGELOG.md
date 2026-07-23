# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

Not yet published to npm — see `docs/superpowers/reports/xmidi-toolkit-notes.md` (in the
parent corsixth-web repo) for the publish checklist and name-candidate decision still pending
sponsor sign-off.

## [0.1.0] - Unreleased

- Initial extraction from [corsixth-web](https://github.com/CorsixTH/CorsixTH)'s
  `web/src/`: `transcodeXmiToMid`, `renderMidiToPcm`, `encodeWav`, and a new
  `renderXmiToAudio` convenience wrapper combining all three stages with OGG-primary /
  WAV-fallback encoding.
- Synced `renderMidiToPcm`'s output shape with upstream `web/src/synth.ts`, which had
  diverged since this package's extraction: `PcmRenderResult` is now planar
  (`{ left, right }`, one `Float32Array` per channel) instead of interleaved
  (`{ pcm, channels }`). `renderXmiToAudio`'s `encodeOgg` now hands the encoder planar
  channels directly (its native shape); the WAV fallback path interleaves once, locally,
  right before `encodeWav` (whose own interleaved-PCM contract is unchanged).
