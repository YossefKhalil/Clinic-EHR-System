# Local AI v2 (WebGPU) — models, the card, and the engine path

Status: **built behind a flag, not yet driving imports.** This document covers
what exists in the tree, which models it offers, how to try it on a machine
with a GPU, and what is still missing before the flag flips. The plan and its
reasoning live in #54; the v1 investigation is in
[`local-ai-runtime-issue.md`](local-ai-runtime-issue.md).

## What it is

A second local engine that runs a model on **WebGPU** through MLC/WebLLM,
beside the existing wllama/GGUF path. It is text-only: spreadsheets, Word,
plain text and PDFs through the existing readers. Photos are refused with a
sentence, not a mid-import failure.

The whole path is one folder, `src/features/import-agent/local-v2/`:

| File | Job |
|---|---|
| `catalog.json` | the checked-in model list: id, publisher, licence, size, VRAM, context, sampling |
| `catalog.js` | catalog access, custom entries, WebGPU probe, and the pure device-fit decision |
| `engine.js` | the only file that imports `@mlc-ai/web-llm`; resolves addresses, loads, one chat call, unload, error mapping |
| `provider.js` | the same `complete()` contract v1 implements, plus the reasoning strip |
| `profile.js` | the saved model and sampling, the last picked model, as plain JSON |
| `setup.js` | device check → engine load → provider |
| `settings.js` | the Alpine component behind the settings card |
| `errors.js` | every failure code and the sentence key that explains it |

Nothing in `local/` (the v1 engine) changed, and no Supabase code changed.

## Models: three sources, one list

The card shows one list, assembled from three places:

1. **Built into this app** (`catalog.json`, `source: "webllm"`). Only metadata
   is stored. The download address, the wasm library, the buffer sizes and the
   build's own overrides are read from the **installed** `@mlc-ai/web-llm`
   release at load time. A hand-copied `model_lib` URL drifts one release
   behind the runtime and the pair must match — this cannot drift.
   `tests/unit/local-v2-catalog-multi.test.js` asserts every one of those ids
   exists in the pinned package, so a stale entry fails the suite instead of
   the download.
2. **Linked by the project** (`source: "link"`), which carries its own two
   addresses. The reference model, LFM2.5-8B-A1B, is one: it is a community
   conversion that the WebLLM release does not ship.
3. **Added by the clinic** (`source: "custom"`), stored in
   `localStorage['clinic.localAi.v2.customModels']`. This is how a model that
   is not in the list — MiniCPM2, or whatever is converted next — is used
   without an app release. Two addresses plus a context window; see below.

Currently shipped: LFM2.5-8B-A1B, Gemma 4 E2B, Gemma 3 1B, Qwen3.5 (0.8B / 2B
/ 4B / 9B), Qwen3 1.7B, Llama 3.2 (1B / 3B), Phi-4 mini, SmolLM2 1.7B and
DeepSeek R1 Distill 7B — five families, 0.4 GB to 5.1 GB.

## Adding a model that is not in the list

**Add another MLC model** in the card takes:

| Field | What it is |
|---|---|
| Model id | the folder name WebLLM caches under, e.g. `MiniCPM2-2B-q4f16_1-MLC` |
| Model address | the repo URL, e.g. `https://huggingface.co/mlc-ai/MiniCPM2-2B-q4f16_1-MLC` (no `/resolve/` part) |
| Wasm library | the matching `-webgpu.wasm` from `mlc-ai/binary-mlc-llm-libs`, built for the same engine version |
| Context window | what the build was compiled for (4096 is typical) |
| Size in GB | optional; only used for the storage check |

Validation happens before anything is stored: the id must be safe as a folder
name and not collide with a shipped one, both addresses must be `https`, the
library must end in `.wasm`, and the window must be between 512 and 1,048,576.
A value that fails is refused in the card with the reason — it never becomes a
multi-gigabyte download that dies at 99%.

The one thing the app cannot check for you is whether the wasm library was
compiled for the same engine version. If it was not, the load fails with the
"model build does not match the engine version" sentence, and the fix is a
library from the matching `v0_2_87` folder.

## Turning it on

Off by default. Any one of:

```
VITE_LOCAL_AI_V2=1 npm run dev      # build-time
open the app once with ?localV2=1   # remembered on this device
localStorage['clinic.localAi.v2.enabled'] = '1'
```

With the flag on, **Settings → AI → This computer** shows a card at the top: a
list of models with their size, context and whether they fit; the picked
model; one **Download & test** button; an **Advanced** drawer (context window,
temperature, top-p, repetition penalty); and **Add another MLC model**.

## Trying it on a real machine

1. Chrome or Edge 113+, or Firefox 141+ on Windows. Safari 26 also works.
2. `VITE_LOCAL_AI_V2=1 npm run dev`, open `http://localhost:3000?localV2=1`.
3. Settings → AI → This computer. A row that cannot run here says why, with
   the two numbers (model needs ≈5.2 GB, device reports 4 GB).
4. Pick a small model first — Qwen3.5 0.8B is 0.44 GB — and press **Download &
   test**. Progress is the engine's own report.
5. Status becomes **Ready**. Reload: it stays Ready, and the weights come from
   the browser cache. Then try the model you actually want.

The engine is a lazy chunk (~6 MB uncompressed) fetched only when a model is
loaded, so an installation that never turns v2 on never downloads it.

## What is not wired yet

The import wizard still runs the v1 engine. Wiring v2 into an import needs
three things that were deliberately left out of this step:

1. `localSetup()`/`runLocalImport()` picking the v2 setup when the flag is on.
2. A job identity for v2 (`{ modelId, quant, contextWindow }`, already produced
   by `profileIdentity()`), which the Edge Function compares on every claim.
   That is a server change — it must be made and tested on its own, and it
   cannot be verified here.
3. The add-step refusal for photos, using `v2RefusesImages()` and the
   `aiSettings.localV2.error.textOnly` sentence.

## Gates before the default flips

- One real chunk extracted through the existing contract, with load time and
  tok/s recorded (this environment has no GPU, so it was not measured here).
- 20 real records through review.
- Chrome and Firefox both.
- Every failure state has a sentence and a next action.
