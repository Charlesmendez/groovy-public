# RNNoise Native Addon (N-API)

This folder builds a small Node native addon that wraps Xiph's RNNoise (`vendor/rnnoise`) to denoise **PCM16LE mono**.

## Why

- **Server-side** denoise: any client using `/ws/audio` or WebRTC datachannel audio benefits.
- **Model-agnostic**: RNNoise runs before STT and only touches PCM bytes.

## Build

From repo root:

```bash
cd playground/native/rnnoise-addon
pnpm -C ../../.. --filter @create-voice-agent/playground exec node-gyp rebuild
```

This should produce:

- `playground/native/rnnoise-addon/build/Release/rnnoise.node`

## Runtime

The TypeScript loader in `playground/src/audio/rnnoise/native.ts` will:

- attempt to `require()` the built `.node` file
- fail-open (logs warning) if missing/unbuildable

## License

RNNoise vendored here is BSD-3-Clause. See `vendor/rnnoise/COPYING`.

