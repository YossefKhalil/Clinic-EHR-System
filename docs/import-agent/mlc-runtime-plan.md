# Plan: MLC (WebLLM) as a second local runtime

Status: proposal. Companion docs:
[`local-ai-runtime-issue.md`](local-ai-runtime-issue.md) (why a second runtime
is needed) and [`ai-import-ui-redesign.md`](ai-import-ui-redesign.md) (how it is
presented).

## Why MLC / WebLLM

[`@mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm) (v0.2.86, Oct 2026) runs
models on **WebGPU** inside the tab, with an OpenAI-shaped API. It solves the
exact problems wllama cannot:

| Problem with wllama today | WebLLM |
|---|---|
| CPU wasm, one thread without COOP/COEP — a 3 GB model is slow and memory-fragile | WebGPU kernels, hardware accelerated, no `SharedArrayBuffer` anywhere in the bundle |
| llama.cpp jinja + Gemma-4 template → abort | the engine ships its own compiled templates; **Gemma-4 E2B is a prebuilt model** (text + audio, `q4f16_1`/`q4f32_1`) |
| Free-form YAML output → parse/repair churn | **XGrammar**: generation constrained by a JSON schema — the extractor's contract becomes enforceable at decode time |
| Weights must exist as local GGUF files | 163 prebuilt builds served from HF and cached in the browser (Cache API or IndexedDB); crash-resumable generation, model locking |
| `Qwen3.6`/`Bonsai` classes are fragile | Qwen3.5 family (0.8B–9B) prebuilt; Bonsai-27B 1-bit demonstrated in-tab (3.79 GB download) |

Costs and constraints, stated plainly:

- **GGUF files do not run on WebLLM.** Weights must be MLC builds. The local
  file picker flow therefore stays on wllama; WebLLM adds a *catalog + download*
  flow. (Compiling a user's own GGUF to MLC is possible with `mlc_llm` but is a
  separate, opt-in tool — not an app feature.)
- **WebGPU required.** Chrome/Edge 113+ (all platforms), Firefox 141+
  (Windows), Safari 26. No WebGPU → wllama remains the engine.
- **VRAM decides.** WebLLM publishes `vram_required_MB`; a `q4f16_1` build needs
  `shader-f16`, with `q4f32_1` as the fallback. A 4-bit 1B model is ~700 MB
  download / ~880 MB VRAM; Gemma-4 E2B and Qwen3.5-4B sit around 2–3.5 GB.
- Firefox cannot host the engine in a **service worker**; the in-tab engine is
  the supported path (fine for this app).
- Model artifacts are downloaded on demand and cached; the bundle itself is
  modest.

## Architecture

One seam, two adapters. Nothing downstream changes.

```
                        ┌────────────────────────────┐
runChunk ──► provider ──►│        LocalRuntime        │  load / complete /
                        │  (interface, see below)     │  unload / capabilities
                        └──────┬──────────────┬──────┘
                               │              │
                     ┌─────────▼───┐   ┌──────▼──────┐
                     │ WllamaRunt. │   │ WebLLMRunt. │
                     │ local GGUF  │   │ MLC catalog │
                     └─────────────┘   └─────────────┘
```

`LocalRuntime` (new interface, `src/features/import-agent/local/runtime/`):

```ts
interface LocalRuntime {
    id: 'wllama' | 'webllm';
    load(spec: ModelSpec, options: LoadOptions): Promise<LoadResult>;
    complete(request: CompletionRequest): Promise<CompletionResult>;
    unload(): Promise<void>;
    capabilities(): { multimodal: boolean; contextWindow: number | null };
}
```

- `WllamaRuntime` wraps the current `wllama-provider.js` unchanged.
- `WebLLMRuntime` wraps `CreateMLCEngine`; `complete()` maps to
  `engine.chat.completions.create()`.
- `setupLocalModels` picks the runtime from the profile: **catalog model →
  WebLLM; picked files → wllama**. The pump, extractor, YAML contract and the
  server are untouched.
- Constrained generation (phase 3): pass `response_format: { type:
  'json_schema', schema }` built from the field registry on WebLLM; keep the
  YAML repair pass for wllama.

## Model catalog

A checked-in JSON (like `architectures.json`), generated from
`webllm.prebuiltAppConfig.model_list` at upgrade time, each entry carrying:
`model_id`, family, params, quant, `vram_required_MB`, download size,
context window, modality (text / vision / audio), license. The settings card
filters it by the device's WebGPU limits and free VRAM, and shows a plain
download size before the clinic commits.

The clinic's own files keep working through wllama; the catalog is the
*recommended* path, not a replacement.

## Storage

- Default: WebLLM's Cache API; switchable to IndexedDB
  (`appConfig.cacheBackend = 'indexeddb'`) so `navigator.storage.persist()`
  (already implemented for the file store) protects it the same way.
- The card shows cached models with their sizes and a delete button; quota
  failures reuse the existing `fileStorage` warning states.

## Phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| 0 — spike | load `Gemma-4-E2B-it-q4f16_1-MLC` in the app behind a flag; time load + one extraction chunk | a chunk extracts faster than wllama on the same machine; no template aborts |
| 1 — seam | `LocalRuntime` interface; wllama behind it; all existing tests green | no behaviour change when `runtime: 'wllama'` |
| 2 — catalog | catalog JSON + "download a recommended model" card with progress, cache management | a clinic can go from nothing to a working local model without touching the file system |
| 3 — constrained output | JSON-schema generation for catalog models; YAML path untouched for wllama | parse-failure rate on the golden fixture drops measurably |
| 4 — multimodal | vision (and audio) catalog models through the existing image-parts path | a photo chunk extracts through WebLLM |
| 5 — hardening | VRAM pre-flight, WebGPU feature detection (`shader-f16`), device-lost recovery, telemetry on load failures | no silent failures; every refusal has a sentence |

## Risks

| Risk | Mitigation |
|---|---|
| Two engines to maintain | the seam is small; wllama stays the default for picked files |
| Model churn (MLC rebuilds libraries per release) | pin the `prebuiltAppConfig` version next to `architectures.json`; upgrades are a reviewed diff |
| VRAM overcommit on small clinic PCs | pre-flight against `adapter.limits` + the catalog's `vram_required_MB`; refuse with the number |
| Users expect their GGUF to run on WebLLM | the card says plainly which flow runs which engine |
| WebGPU absent (old Chrome, some Firefox/Linux) | wllama fallback, automatic and silent |
