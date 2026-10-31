# Local AI (GPU) — models, the card, and the engine path

Status: **the only local engine in the app, and on by default.** The old
wllama/GGUF engine and its settings card are gone. An import still runs in the
cloud: wiring the GPU engine into the wizard is the next step, described at the
end.

## What it is

A local engine that runs a model on **WebGPU** through MLC/WebLLM. It is
text-only: spreadsheets, Word, plain text and PDFs through the existing
readers. Photos are refused with a sentence, not a mid-import failure.

The whole path is one folder, `src/features/import-agent/local-v2/`:

| File | Job |
|---|---|
| `catalog.json` | the checked-in model list: id, publisher, licence, size, VRAM, context, sampling |
| `catalog.js` | catalog access, custom entries, WebGPU probe, and the pure device-fit decision |
| `engine.js` | the only file that imports `@mlc-ai/web-llm`; resolves addresses, loads, one chat call, unload, error mapping |
| `provider.js` | the `complete()` contract the extractor uses, plus the reasoning strip |
| `profile.js` | the saved model and sampling, the last picked model, as plain JSON |
| `setup.js` | device check → engine load → provider |
| `settings.js` | the Alpine component behind the settings card |
| `errors.js` | every failure code and the sentence key that explains it |

Nothing here changes a Supabase table, function or policy. The card reads and
writes only this browser's storage.

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
   without an app release.

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

## Where it lives

**Settings → AI → This computer**, at the top of the AI card, always shown
(no flag, no query parameter). It offers: a list of models with their size,
context and whether they fit; the picked model; one **Download & test**
button; an **Advanced** drawer (context window, temperature, top-p, repetition
penalty); and **Add another MLC model**.

A row that cannot run on this device says why, with both numbers (model needs
≈5.2 GB, device reports 4 GB). A model that is picked but not yet loaded is not
"Ready": readiness means a load actually succeeded in this browser.

## Trying it on a real machine

1. Chrome or Edge 113+, or Firefox 141+ on Windows. Safari 26 also works.
2. `npm run dev`, open `http://localhost:3000`, Settings → AI.
3. Pick a small model first — Qwen3.5 0.8B is 0.44 GB — and press **Download &
   test**. Progress is the engine's own report.
4. Status becomes **Ready**. Reload: it stays Ready, and the weights come from
   the browser cache. Then try the model you actually want.

The engine is a lazy chunk (~6 MB uncompressed) fetched only when a model is
loaded, so an installation that never opens the card never downloads it.

## What changed when the old engine was removed

The wllama/GGUF engine, its ONNX OCR model, the file pickers, the local config
knobs and the `local_profile` save path are deleted, along with their 16 test
files and three dependencies (`@wllama/wllama`, `onnxruntime-web`,
`hash-wasm`). The **Local** option in the engine switch is gone with it.

The server side is untouched: `import-job`, the shared `local-runtime.js`
rules and the `LOCAL_INFERENCE_ENABLED` deployment flag still exist, so a
deployment that had local inference turned on keeps its stored settings. The
settings form shows such a row as Off rather than pretending this browser can
still run it.

## What is not wired yet

An import still runs on the server. Wiring the GPU engine into the wizard needs
three things that were deliberately left out of this step:

1. `localSetup()`/`runLocalImport()` choosing the v2 provider when the clinic
   has a model on this device.
2. A job identity for v2 (`{ modelId, contextWindow }`), which the Edge
   Function compares on every claim. Today's identity is built from file names
   and hashes, so this is a server-side change and must be made and tested on
   its own — it cannot be verified from this environment.
3. The add-step refusal for photos, using the text-only rule and the existing
   `aiSettings.localV2.error.textOnly` sentence.

## Gates before local imports run on the GPU engine

- One real chunk extracted through the existing contract, with load time and
  tok/s recorded (this environment has no GPU, so it was not measured here).
- 20 real records through review.
- Chrome and Firefox both.
- Every failure state has a sentence and a next action.
