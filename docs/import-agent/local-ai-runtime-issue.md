# Local AI runtime: the stubborn failure, what we know, what to do

Tracking doc for the "chunks failed to extract — The provider call failed."
class of failures on the **local (in-browser) engine**. Companion docs:
[`mlc-runtime-plan.md`](mlc-runtime-plan.md) (the WebLLM/MLC escape hatch) and
[`ai-import-ui-redesign.md`](ai-import-ui-redesign.md) (why the settings page
makes this hard to see).

## TL;DR

- Two **proven** root causes were found and fixed: a missing `qwen35`/`qwen35moe`
  architecture entry, and a `DataCloneError` that silently broke every
  "save AI settings" click. Both shipped (`afe2888`, `1704db8`).
- One **proven** runtime limit remains: **Gemma-4's own chat template aborts
  llama.cpp** inside wllama 3.8.1 (`ggml_abort → common_chat_templates_get_caps`),
  so every completion dies and only "The provider call failed." was shown.
- wllama **v3 gates Jinja template parsing behind `jinja: true` at load time**.
  Our loader never sets it. This is the single most promising untested lever.
- The remaining reported failure (1 chunk) is still unidentified because the
  reason lived only in the browser console. As of `519bcc1` the reason is shown
  in the UI, so the next occurrence names itself.

## Environment

| Item | Value |
|---|---|
| Browser | Chrome (desktop), WebGPU available, no COOP/COEP (single thread) |
| Runtime | `@wllama/wllama` **3.8.1** (llama.cpp `server-context`, autosync c7bda03) |
| Models tried | `gemma-4-E2B-it-UD-Q4_K_XL.gguf` 3.18 GB · `gemma-4-E2B-it-UD-IQ3_XXS.gguf` 2.37 GB · `mmproj.gguf` (clip, 902 MB) · `Qwen3.6-35B-A3B-APEX-I-Compact.gguf` (qwen35moe, 17.3 GB) · `Bonsai-27B-Q1_0.gguf` (qwen35, 3.8 GB) |

## Evidence collected (all reproducible from this repo)

| Check | Result |
|---|---|
| `probeModelFile(gemma-4-E2B…Q4_K_XL)` | ok — arch `gemma4` (supported), template from GGUF, context 131072, **multimodal false** (text-only as shipped; vision needs the mmproj sidecar) |
| `probeModelFile(mmproj.gguf, { role: 'projector' })` | ok — arch `clip`, a valid projector |
| `probeModelFile(Qwen3.6-35B…)` | refused `GGUF_ARCH_UNSUPPORTED` (`qwen35moe`) — **fixed** by adding the arch |
| `probeModelFile(Bonsai-27B…)` | refused (`qwen35`) — **fixed** |
| In-browser load + `createChatCompletion` (IQ3 build) | load ok → `getChatTemplate()` returns empty → completion aborts: `__wrap_abort → ggml_abort → common_chat_templates_get_caps → oaicompat_chat_params_parse` |
| wllama wasm strings | Jinja filters `capitalize`, `tojson`, `items`, `namespace`, `selectattr`… present; **`dictsort` absent** — Gemma-4's 18.8 KB template uses `\| dictsort` repeatedly |
| llama.cpp upstream | Gemma-4 template handling is young: parser fixes (#21326), specialized `peg-gemma4` parser (#21418), official-template alignment (#21704) — churn is expected here |
| wllama v3 docs | templates parsed with Jinja **only when `jinja: true` is set at load**; `chat_template` overrides at load; `WllamaError` has a `kv_cache_full` type |

## Root causes: found and fixed

| Symptom | Cause | Fix |
|---|---|---|
| `Qwen3.6-35B` / `Bonsai-27B` refused at pick time | arch list generated from `LLM_ARCH_NAMES` missed the `qwen35`/`qwen35moe` model targets that the wasm does contain | `afe2888` (+ wasm-symbol test) |
| "Could not save AI settings." right after a successful verify | Alpine reactive **Proxy** objects written to IndexedDB → `DataCloneError` | `1704db8` (`toStorable` deep copy before `put`) |
| "The provider call failed." with no reason | the runtime's message was dropped everywhere | `afe2888` maps the template abort to `MODEL_TEMPLATE_UNSUPPORTED`; `519bcc1` sends/persists `error_detail` and shows **Model** + **Reason** in the review banner |
| Settings not visible ("not superadmin") | profile fetch was CORS-blocked in the local mock | `ee088a4` (archived with the mock) |

## The still-open failure

After all of the above, one chunk can still fail with the generic code. Ranked
hypotheses, cheapest to test first:

1. **`jinja: true` is never set at load.** wllama v3 documents that Jinja
   template parsing is opt-in at load time. Without it the template path is in
   an undefined state — it may abort exactly as observed, or refuse catchably.
   *Fix: pass `jinja: true` in `buildLoadParams` and retest both gemma builds.*
2. **KV cache / context pressure.** wllama surfaces `kv_cache_full`; our mapping
   does not recognise it, so it degrades to `PROVIDER_ERROR`. A 3.2 GB model
   with a large `n_ctx` and a big chunk can hit it.
   *Fix: map the error type/message to `MODEL_CONTEXT_FULL` with guidance
   (lower `contextTokens`, smaller chunks).*
3. **wasm memory ceiling.** wllama is wasm32; weights + KV for a 3 GB model
   plus a long prompt can exceed the 4 GB ceiling. Symptoms are aborts.
   *Fix: map aborts to `MODEL_RUNTIME_ABORTED` with guidance (smaller quant,
   close other tabs, prefer a 2 B model).*
4. **A photo chunk on a text-only model.** The single failing chunk may be an
   image chunk: `gemma-4-E2B` probes text-only unless the mmproj is selected,
   and photo parts need the multimodal path.
   *Fix: pre-flight check — refuse to start when the job has images and the
   loaded runtime cannot read them, saying so before extraction.*
5. **A chat-template override with the wrong tokens.** Gemma-4 does **not** use
   `<start_of_turn>`; llama.cpp's gemma-4 handler uses `<|turn>user` /
   `<|turn>model` (+ `<|channel>thought` for reasoning). Any override preset we
   publish must use those tokens, or output is garbage.
   *Fix: ship a Gemma-4 override preset and only for arch `gemma4`.*

## Diagnostics to capture on the next occurrence

- The review banner now prints **Reason**; if it is still generic, open
  DevTools → Console and copy the `[local] chunk <id> failed: <code> - <detail>`
  line (shipped in `519bcc1`, present in the deployed preview bundle).
- DevTools → Network → the failing `local_fail`/`local_submit` request body.
- The model's `n_ctx` from the settings card vs the probe's declared context.

## Near-term fix list (repo pointers)

| # | Change | Where |
|---|---|---|
| 1 | load with `jinja: true`; verify `getChatTemplate()` is non-empty afterwards | `wllama-provider.js` `buildLoadParams` |
| 2 | map `WllamaError` `kv_cache_full` / `/kv cache\|context/i` → `MODEL_CONTEXT_FULL` | `wllama-provider.js` `mapRuntimeError` |
| 3 | map aborts (`ggml_abort`, `/out of memory/i`) → `MODEL_RUNTIME_ABORTED` | same |
| 4 | smoke-render a 1-token **chat** completion at verify time, so an unusable template fails at pick time, not mid-import | `model-profile.js` `defaultSmokeRender` |
| 5 | pre-flight: job has images + runtime not multimodal → refuse with an actionable code | `runner.js` before the pump |
| 6 | per-arch override presets (gemma4 tokens) offered in the card when a template failure is detected | `main.js` + locale keys |
| 7 | validate the configured `n_ctx` against the probe's context window at save time | `main.js` `aiLocalValidateConfig` |

## When wllama is not the answer

Even fixed, wllama is CPU wasm (one thread without COOP/COEP): a 3 GB model is
slow and memory-fragile. [`mlc-runtime-plan.md`](mlc-runtime-plan.md) covers the
WebGPU engine that already ships prebuilt builds of exactly these models.
