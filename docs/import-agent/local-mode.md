# Local inference mode — plan, configuration, and performance

Status: scaffolded, not yet wired into the UI. Correctness of the Falcon OCR port is unproven until the golden harness passes. Text-only local mode is the first shippable slice.

## 1. What “local” means

A **per-import mode**, not a new cloud provider. With it on, no prompt, image, or extracted text reaches OpenRouter / Cloudflare / OpenAI / Groq. Supabase stays in the loop for job, sources, chunks, rows, rejects, and audit — exactly as today. Edge Functions do **bookkeeping only**: claim, submit, persist. No model calls, no model hosting, no GPU.

- Model files are **chosen by the clinic** and stay on their PCs/SSDs; they never enter the app bundle.
- The runtime is **config-driven, not quota-driven**. There are no token caps, rates, or provider budgets in local mode. The only real bounds are the model’s context window and the device’s memory.

## 2. Architecture

```
Browser
  intake
    ├─ text/sheet/PDF ──────────────┐
    └─ image → (OCR when needed) ───┤
                                     ▼
                         create / add_source (Supabase)
                                     ▼
                         start(inference_mode: local)
                                     ▼
  local loop: local_claim → runChunk(local provider) → local_submit
                                     ▼
                         review / validation / commit (unchanged)

Supabase Edge Function import-job  (bookkeeping only)
  create / add_source / start / cancel / status / retry_chunk  (existing)
  local_claim      → claim 1 chunk, configurable lease, return payload
  local_submit     → shared pipeline + persist rows/rejects (guarded)
  local_fail       → requeue transient failures, fail deterministic ones
  local_heartbeat  → extend lease while the browser is working
```

Server-assisted rather than fully client-side because the browser cannot write `import_chunks` / `import_rows` under current RLS, and duplicating the pipeline client-side would fork validation and persistence behavior. All model inference is browser-local; only job bookkeeping crosses the network.

## 3. Modularity — user-selectable models

Two modes, chosen in the model setup panel:

| Mode | What the user picks | How images are handled | Memory shape |
|---|---|---|---|
| **single** | One multimodal GGUF | Images go straight to the model inside `runChunk` | One model resident |
| **split** | Text GGUF + ONNX vision model | ONNX model OCRs images to text lines, then the text model extracts | Vision loads lazily, releases before extraction |

Files are picked via `showOpenFilePicker`, persisted as IndexedDB handles (`src/features/import-agent/local/model-profile.js`), and dispatched by adapter: `.gguf` → wllama, `.onnx` → ONNX Runtime Web. Nothing is hardcoded to MiniCPM/Falcon; those are examples, and the two downloaded files are the first tested pair.

### Honest limit

The claim of “any model the user wants” is **not unconditional**. It works for any model whose runtime executes, i.e.:

- GGUF with an architecture supported by the wllama/llama.cpp build (ChatML preferred; template from the GGUF otherwise).
- ONNX with I/O matching a supported adapter (currently the Falcon OCR graph).

Unsupported files must be refused with a specific code, not crash. That requires the capability probe below.

### Capability probe and adapter registry (required)

`src/features/import-agent/local/adapters.js` will:
- Parse GGUF metadata (`general.architecture`, chat template, vision tensors) before loading.
- Read ONNX graph inputs/outputs and match to a known adapter shape.
- Map a compatible file to `{ adapter, capabilities, warnings }`.
- Surface a compatibility report in the setup panel; refuse unsupported files with codes: `GGUF_ARCH_UNSUPPORTED`, `GGUF_TEMPLATE_MISSING`, `ONNX_IO_UNMATCHED`, `ONNX_OP_UNAVAILABLE`.

### Settings card contract (mockup: `docs/mockups/local-ai-settings.html`)

Visual/interaction source of truth for this card: **`docs/mockups/local-ai-settings.html`** (self-contained, open in a browser; no build step). Port it as-is into the real settings card and update the mockup first whenever this contract changes.

The settings card replaces the old "AI Import enabled" switch with one segmented control — **Off / Cloud / Local**. It sets enabled and mode together and is the single source of truth for the engine. Every control in the mockup maps to a real field or probe; nothing is decorative:

| Control | Backing state / probe | Module | Feasibility |
|---|---|---|---|
| Engine segmented control (Off/Cloud/Local) | Off: `import_settings.enabled=false`. Cloud: `enabled=true`, `config.inference_mode='cloud'`. Local: `enabled=true`, `config.inference_mode='local'` | existing ai-settings save path — no schema change beyond optional keys | Yes. **Default state: Off** — sleep until an admin explicitly enables an engine. Local segment renders disabled (tooltip) unless `LOCAL_INFERENCE_ENABLED=1`. Switching never deletes cloud keys; jobs only *start* in the current mode. Turning Off while a local pump runs: it finishes the in-flight chunk, then stops claiming; other claims expire by lease. |
| Cloud consent modal | `import_settings.cloud_consent` (accepted flag + `accepted_at`); required for Cloud only — Off/Local need no consent | `services/ai-settings.js` | Yes. Static-backdrop modal ("I accept the risk — send clinic data to cloud providers", confirm disabled until checked) blocks the first switch to Cloud; Cancel keeps the current engine. Persisted per clinic by the super-admin; the consent record holds no PHI. Deleting the flag re-prompts on the next switch (the mockup's "Reset cloud consent" link demos this). On load the card never trusts restored form state: a `cloud` selection without consent falls back to Off. |
| Model layout select (single / split) | `model-profile.mode` | `model-profile.js` | Yes. Resolved mode+config is written into `job.config` at start (see §8 open item 4) so resume/lease handoff can't drift. |
| **Browse** per model card | `showOpenFilePicker` with `.gguf`/`.onnx` type filters | `model-store.js` | Yes on Chrome/Edge. Firefox/Safari fallback: `<input type="file">`, user re-picks after reload. Browsers do not expose full paths — only name/size/SHA are displayed or stored. |
| **Support files** folder (split, ONNX) | `showDirectoryPicker` for `tokenizer.json` + `config.json` + `special_tokens_map.json` | `falcon-ocr.js`, `model-profile.js` | Yes on Chromium; fallback is multi-file select. These files are still a blocked download for Falcon (§8 correctness) — UI is ready, files pending. |
| **Verify & load** + status badges | State machine: `Not configured → Not verified → Ready / Error(<code>)`, stored per profile slot | `model-profile.js`, `adapters.js` | Yes. Verify = chunked SHA-256 (`hash-wasm`) → magic sniff (`GGUF` magic / `PK` zip header) → capability probe → worker smoke render (one prompt, few tokens) → release memory. Failures surface the probe codes, not crashes. |
| Device readiness chips | WebGPU: `navigator.gpu` + `adapter.limits`; threads: `navigator.hardwareConcurrency`; RAM: `navigator.deviceMemory` (browser caps its value at 8 — chip reads "8 GB+ (reported)"); free storage: `navigator.storage.estimate()` | `manifest.js` tier detection | Yes, with caveats: no AC-power API (Battery API deprecated) and no exact-RAM API — chips only use measurable signals. Chips feed the *suggested* tier; user overrides always win. |
| Per-model config accordions | 1:1 with the §4 tables: context, kvCacheType, gpuLayers, threads, batch/ubatch, maxOutputTokens, flashAttention, enableThinking, chatTemplate override, repairPass (text card); OCR fields on the vision card | `local-config.js` | Yes. Values are validated locally (bounds) and re-clamped in the Edge Function. `stopSequences` stays derived from the template — not user-editable. |
| Runtime row (lease / heartbeat / attempts / parallel) | §4 Runtime table | `pump.js` + `local_claim` params | Yes; server clamps sane ranges; `parallel>1` shows the ×-memory note. |
| Save / Discard | `{ enabled, inference_mode, profile{name,size,sha256,mode}, config }` → `import_settings` via the existing ai-settings function; file bytes and handles never leave the browser | `services/ai-settings.js` | Yes. Optional keys only; RLS untouched; cloud keys continue to encrypt server-side as before. |
| Handle persistence (implied by pickers) | `FileSystemFileHandle` stored in IndexedDB per profile slot | `model-profile.js` | Yes on Chromium. Permission re-grant needs a user gesture after reload (§8 open item 8): on load, restore badges/name/SHA from storage, but require one click on the handle to reactivate. Cache-cleared handles fall back to "Repair models" (§11). |

Porting order stays as in §7: the settings card ships behind `local_enabled` after Gate 2 so no UI depends on unbenchmarked models.

## 4. Configuration, not quotas

Local mode is controlled by `src/features/import-agent/local/local-config.js`. Defaults vary by device tier; users may override any of them. None of this is a cloud quota.

### Text model

| Key | Purpose | Default (tier-aware) |
|---|---|---|
| `contextTokens` | model context | 8192 (4096 low / 16384 high) |
| `kvCacheType` | KV cache quantization | `f16` (warn above 16k ctx) |
| `batchSize` / `ubatchSize` | prefill throughput | 512 / 512 (256 low) |
| `threads` | worker threads | 4 (2 low / 6 high) |
| `gpuLayers` | GPU offload | all (`-1`) |
| `flashAttention` | reduce memory/latency | on |
| `mmap` | avoid RAM copy | on |
| `temperature` / `topK` / `topP` / `repeatPenalty` | decoding | greedy (0/1/1/1) |
| `maxOutputTokens` | safety only | from context budget |
| `enableThinking` | skip MiniCPM’s think block | false when supported |
| `chatTemplate` | override the GGUF template | null (auto) |
| `stopSequences` | generation stop points | from template |
| `repairPass` | retry invalid YAML once | on |

### OCR

| Key | Purpose | Default |
|---|---|---|
| `executionProvider` | ORT backend | `webgpu` |
| `stripWidth` × `stripHeight` | strip size | 896 × 256 (640 × 224 low) |
| `overlap` | strip overlap | 64 px (48 low) |
| `imageLongSide` | downscale before tiling | 1280 (896 low) |
| `maxNewTokens` | per-strip output cap | 512 (256 low) |
| `graphOptimizationLevel` | ORT graph opt | `all` |

### Runtime

| Key | Purpose | Default |
|---|---|---|
| `leaseSeconds` | chunk lease | 900 s (1800 low) |
| `heartbeatSeconds` | keep-alive | 60 s |
| `maxAttempts` | retries per chunk | 5 |
| `parallel` | concurrent chunks | 1 (warn above 1) |

### Server behavior for local jobs

- `token_cap` is `0` — **unlimited**, and the UI shows no token bar.
- `local_claim` accepts configurable `lease_seconds` and `max_attempts`, clamped to sane ranges.
- `local_fail` requeues transient errors until `maxAttempts` is exhausted, then fails; deterministic errors fail immediately.
- `pump` rejects local jobs (`LOCAL_MODE_REQUIRED`).
- `local_submit` is guarded: `status='running'`, result shape validated, `pipeline_kind: 'text'`.

Kept as **storage/safety limits** (configurable in `import_settings`, not AI quotas): `MAX_FILES`, `MAX_FILE_BYTES`, `MAX_ROWS`, `MAX_CHUNKS`, payload size, DB row counts. These protect the database and payload size, not AI usage.

## 5. Runtime design

### Text extraction

Reuse `supabase/functions/import-extract/run-chunk.js` verbatim — same prompts, YAML contract, parse, repair pass. The local provider implements the existing `complete()` interface:

- Single mode: wllama with WebGPU/worker, greedy decoding, thinking disabled, tight stop sequences. Images are passed as `image_url` blocks through `createChatCompletion` (multimodal GGUF only).
- Split mode: wllama for text; ONNX OCR converts image chunks to text first.

`extractionBudgets()` derives `maxOutputTokens` and prompt budget from `contextTokens`; no fixed 16k ceiling.

### OCR runtime (Falcon-shaped graphs)

Verified ONNX I/O:
- Inputs: `tokens [B,S]`, `image_patches [B,N,768]`, `pos_t [B,S]`, `pos_hw [B,S,2]`, `attention_mask [B,S,T]`, `past_key_values [22,2,B,16,P,64]`
- Outputs: `next_token [B]`, `present_key_values`
- Prompt: ` ".
- Image block: `[244,245,246,247,248, 227×N, 230]`
- Attention: `q >= k` OR both tokens inside the image block.
- KV cache: ~180 KB per token at fp32; strips are mandatory.

## 6. Model delivery and caching

Do not put models in `public/` or the bundle; `models/` is gitignored.

1. **File System Access picker (primary for clinics):** copy the model folder to each PC, pick once, handle persists in IndexedDB. No download, no LAN dependency. Chrome/Edge.
2. **LAN `/models` static server:** Vite dev/preview middleware + nginx/Caddy with Range and immutable cache headers; browser stores bytes in Cache Storage after the first fetch.
3. **Supabase Storage — last resort.** Not for 1.1 GB on free tier.

Each model entry carries a SHA-256 and size. Verification is chunked (`hash-wasm` over `file.stream()`), cached in IndexedDB, and runs once per file. “Repair models” re-reads/picks the file if the cache is cleared.

Memory policy:
- Never hold two models while extracting. In split mode vision loads lazily and `release()`s before text extraction resumes.
- If a run OOMs, downgrade one tier and retry once.

## 7. Validation order — hard gates

The plan ships in this order until each gate passes:

### Gate 1 — Python ⇄ JS golden fixture for Falcon (before any more UI work)
Build a Python harness (HF `transformers` + the real model) that dumps for one fixed image:
- prompt token ids, `pos_t`, `pos_hw`, attention mask
- the first N output token ids and logits

Then assert the JS round-trip on those fixtures. This is the only way to know patches, positions, mask, KV, and stop tokens are correct. Do not proceed without this.

### Gate 2 — Text model benchmark on real clinic Arabic data
Run `runChunk` with wllama on 20 real Arabic/English entries. Acceptance:
- ≥ 98% character accuracy on IDs/dates
- ≥ 90% name accuracy after review
- no context overflow, no YAML trunctation

### Gate 3 — OCR benchmark on target clinic PCs
Representative pages: train strip size, tokens/s, peak memory, and thermal behavior. Acceptance:
- one strip < 20 s, one page < 3 min
- peak tab memory < 2.5 GB
- JavaScript does not trigger OOM across 10 pages

### Gate 4 — End-to-end integration test
`create → add_source → start(local) → local_claim → runChunk → local_submit → review`. No PHI reaches a cloud provider. Verify RLS remains untouched, review/resume/retry unchanged, and cancel works.

### Then: UI wiring
- Import wizard mode switch: “This computer (private)” vs “Cloud”.
- Settings card: engine Off/Cloud/Local control, layout select, model cards with verify + config accordions (§3 Settings card contract; port the reference mockup `docs/mockups/local-ai-settings.html`).
- Model setup panel: mode (single / split), pickers, progress, verify, warnings.
- Local pump progress labels: “Reading photos”, “Extracting records”, “Repairing document”.
- Inline config editor for context, KV cache, strip size, threads — no “limit” language.

## 8. Stress-test results (newest first)

### Fixed while scaffolding

| Issue | Fix |
|---|---|
| Tokenizer init was a stub | `AutoTokenizer.from_pretrained` with `env.localModelPath`; still needs a version check against Transformers.js. |
| `pos_t` for generated tokens was wrong | Carry the last prompt position and increment per token. Needs the golden fixture to confirm. |
| OCR text persisted as `image` (grounding off) | `pipeline_kind: 'text'` now reaches `persistChunkResult`. |
| `makeStrips` rebuilt the full scaled canvas per strip | One canvas, crop strips — O(n). |
| Download accumulated all chunks in an array | Streams directly into Cache Storage. |
| SHA-256 read the whole file into memory | Chunked `hash-wasm` over `file.stream()`. |
| Worker imported DOM code | `OffscreenCanvas` with a main-thread fallback. |
| Split mode loaded both models at once | Vision loads lazily and releases before extraction. |
| Split mode reused the text model for OCR | v1 rejects GGUF vision in split mode with `VISION_GGUF_UNSUPPORTED`. |
| Client-trusted submit | `local_submit` validates shape and guards on `status='running'`. |

### Open — correctness

1. Python golden fixture for Falcon (highest priority).
2. `pos_hw` NaN handling in WebGPU; masked-0 fallback if needed.
3. Attention mask dtype `bool` vs `uint8` on WebGPU.
4. Zero-length KV cache acceptance; dummy-prefix fallback may shift positions.
5. GQA head count: config says `n_kv_heads=8`, ONNX cache says 16 — verify against the export.
6. Stop tokens: EOS only; add `<|end_of_query|>` / `<|OCR_PLAIN|>` handling.
7. Chat template: hardcoded ChatML breaks other user GGUFs; use the GGUF template or expose `chatTemplate`.
8. Think block: MiniCPM-specific; make it config-driven.
9. Arabic normalization: Arabic-Indic digits, diacritics, RTL line order.

### Open — architecture / data flow

1. **Image payload size in `local_claim`.** Single mode keeps image tiles in the chunk payload; a 30-tile payload can be several MB and may hit Edge Function response limits. Move images to Storage and return signed URLs, or keep images client-side and identify by source id.
2. **Lease/attempt semantics.** Aborting/retrying burns attempts; add `local_release` that does not count aborted attempts.
3. **Duplicate submits.** Two tabs can submit the same chunk; needs a lease-ownership check and idempotent persist.
4. **Job config drift.** Store resolved local config in `job.config` and refuse resume with a different model/config.
5. **Model identity in results.** Store file name + hash in `job.config` and chunk `model` for audit.

### Open — performance / operations

1. `deviceMemory` is a poor proxy for GPU capability; probe `adapter.limits.maxBufferSize` / `maxStorageBufferBindingSize`.
2. KV cache may exceed a single WebGPU buffer on low-end adapters; strips + adaptive caps mandatory.
3. ONNX load + shader compile is 30–90 s and paid twice in split mode; show it in ETA.
4. COOP/COEP may break Supabase auth/storage; test login, signed uploads, realtime; consider `credentialless` or dropping COEP if threads are not needed.
5. Background tab throttling and thermal throttling; add pause/cooldown policy.
6. Cache Storage 1.1 GB may exceed managed-PC quotas; prefer file handles.
7. Malicious model files; disable external-data ONNX; warn before loading untrusted files.
8. File-handle permission needs a user gesture after reload; do not auto-load on page load.
9. No tests yet: `buildPositions`, `buildAttentionMask`, `assembleTokens`, `mergeStripLines`, config resolution, `local-config.js` merge/tiers.

## 9. What the two starter models are

| Model | Role | Verified state | Main risk |
|---|---|---|---|
| `MiniCPM5-1B-SFT.i1-Q4_K_M.gguf` | text → YAML | 686,149,792 bytes; SHA-256 `2818E3DDA38EFF3495DBB59749A3D626DE76B86BEEBB2415ED8E367BBC3728CE`; arch `llama`, ChatML, 131k ctx | Model card lists en/zh only; Arabic quality unproven. `i1` is imatrix — wllama warns these can be slow and lower quality. Static `Q4_K_M` (from `mradermacher/MiniCPM5-1B-SFT-GGUF`) as fallback. |
| `falcon_ocr_kv_token_q8.onnx` | image → text | 450,199,845 bytes; SHA-256 `58449918A4313A69A5F5DA7C8001802F308347B23F3E9060786C115CD859F1E7`; 22 layers, 16 heads, int8 MatMulNBits | Base model, not Falcon-OCR-Arabic. Arabic handwriting unproven. Needs tokenizer + config from `acid1burn/falcon_ocr_kv_token_q8.onnx`. KV cache memory-hungry. |

Immediate downloads (do first):
1. `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json` from `acid1burn/falcon_ocr_kv_token_q8.onnx` into `models/falcon-ocr/`. Without them, ONNX OCR cannot run.
2. Static `Q4_K_M` GGUF as the tested-for-wllama default; benchmark against the current `i1` file.

## 10. Phases (revised)

| Phase | Work | Exit |
|---|---|---|
| 0 (1–2 days) | Python ⇄ JS golden fixture for Falcon; probe GGUF metadata and ONNX shape; capability report. | Fixtures pass; adapter mapping known. |
| 1 (3–4 days) | Text-only local mode: wllama provider + config, settings card engine control + model pickers/verify (§3 contract), local claim/submit, review. | Gate 2 passes on real data. |
| 2 (3–5 days) | OCR intake path with Falcon ONNX; strip tiling; line merge; image→text. | Gate 3 passes; Arabic handwriting meets the accuracy bar. |
| 3 (2–3 days) | Model delivery & repair, config editor, resume/cancel/heartbeat, low-memory tiers, docs, pilot. | Gate 4 passes on target PCs. |

## 11. Risks and fallbacks

| Risk | Fallback |
|---|---|
| MiniCPM5 Arabic quality | Fine-tune on clinic data; try static Q4_K_M; switch local text model for Arabic; parse IDs/dates deterministically. |
| Falcon base Arabic handwriting (base, not Arabic tune) | Clinic LAN GPU running Falcon-OCR-Arabic; cloud vision for images only; handwriting → manual entry. |
| WebGPU unavailable | Require Chrome/Edge for local; WASM fallback ≈ 5–10× slower and hot. |
| Falcon OCR memory | Smaller strips; one model at a time; downgrade tier on OOM. |
| `i1` quant slow/low quality | Static `Q4_K_M`. |
| Background tab throttling | Worker inference + “keep tab visible” warning; pause on hidden. |
| Browser cache cleared | “Repair models” re-picks; file handles preferred. |

## 12. Go/no-go gate

If the accuracy bar fails after all of the above:
- Fine-tune MiniCPM5 on clinic data (LoRA → GGUF).
- Run Falcon-OCR-Arabic on a clinic LAN GPU (not the browser).
- Hybrid: text local, images to cloud vision.
- Or reduce to printed text only and route handwriting to manual entry.

Do not ship image extraction in local mode without real-sample evidence that Arabic handwriting accuracy meets the review bar.
