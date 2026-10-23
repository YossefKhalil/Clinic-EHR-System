## Title: Firefox support for local AI (import engine / local inference)

## Description
The local AI import engine (and any local inference features) currently only work in Chromium-based browsers. Firefox throws errors or silently fails because it lacks support for certain Web APIs used by the engine.

## Steps to reproduce
1. Open the app in Firefox (tested on Firefox 128+).
2. Navigate to the Import / AI features page.
3. Attempt to use the local AI import engine (e.g., import a document, run local extraction).
4. Observe console errors / feature failure.

## Expected behavior
Local AI features should work in Firefox with graceful degradation or polyfills.

## Actual behavior
Errors in Firefox console, typically related to:
- WebGPU / WebAssembly SIMD / SharedArrayBuffer availability
- `navigator.gpu` missing (WebGPU not enabled by default in Firefox)
- `Worker` / `OffscreenCanvas` / `ReadableStream` differences
- COOP/COEP headers not set for SharedArrayBuffer
- `crypto.subtle` algorithm differences

## Root cause (hypothesis)
The local engine likely uses:
- ONNX Runtime Web / WebML / WebGPU for inference
- SharedArrayBuffer for zero-copy tensor sharing
- Web Workers with specific capabilities

Firefox requires:
- `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` for SharedArrayBuffer
- WebGPU enabled via `dom.webgpu.enabled` in `about:config` (not default)
- WASM SIMD may need explicit opt-in

## Files to investigate
- `src/features/import-agent/local/` — local engine entry, adapters, workers
- `src/services/ai-local.js` — local AI service
- `vite.config.js` / build config — COOP/COEP headers, worker bundling
- `index.html` — COOP/COEP meta tags

## Suggested approach
1. **Detect capabilities** at runtime and fall back to server-side inference when WebGPU/SharedArrayBuffer unavailable.
2. **Set COOP/COEP headers** on the Cloudflare Pages deployment (`_headers` file or Worker middleware).
3. **Polyfill / transpile** WASM SIMD for non-supporting browsers.
4. **Document minimum browser requirements** and show a friendly notice in Firefox.
5. **Test matrix**: Chrome, Edge, Firefox, Safari (if applicable).

## Environment
- Firefox version: 128+
- OS: Windows / Linux / macOS
- Feature: Local AI import engine / local inference

## Acceptance criteria
- [ ] Local AI import works in Firefox (with WebGPU enabled in about:config, or via CPU fallback)
- [ ] Clear user messaging when hardware acceleration unavailable
- [ ] No console errors blocking the feature
- [ ] CI includes Firefox in test matrix (Playwright / WebDriver)