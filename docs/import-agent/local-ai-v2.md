# Local AI (GPU) — a model from your own disk

Status: **the only local engine in the app, and on by default.** The old
wllama/GGUF engine is gone, and nothing is downloaded: the clinic picks the
model folder it already has. An import still runs in the cloud — wiring the
GPU engine into the wizard is the next step, described at the end.

## What it is

A local engine that runs a model on **WebGPU** through MLC/WebLLM, loading the
files from a folder on this computer. It is text-only: spreadsheets, Word,
plain text and PDFs through the existing readers. Photos are refused with a
sentence, not a mid-import failure.

```
src/features/import-agent/local-v2/
  folder.js    pick, check and mount a model folder
  device.js    WebGPU probe, reported memory, the fit decision
  engine.js    the only file that imports @mlc-ai/web-llm
  provider.js  the complete() contract the extractor uses
  setup.js     device check → mount → load → provider
  settings.js  the Alpine component behind the card
  profile.js   what this computer uses, as plain JSON
  errors.js    every failure code and its sentence key
public/local-mlc-sw.js   serves the mounted folder to the engine
```

Nothing here changes a Supabase table, function or policy.

## The folder

The picker wants an **MLC build compiled for WebLLM**, which is four things:

| File | Why |
|---|---|
| `mlc-chat-config.json` | the build's own description: quantisation, context window, conversation template |
| `params_shard_*.bin` (or `tensor-cache.json`) | the weights |
| `tokenizer.json` or `tokenizer.model` | how text becomes tokens |
| `*-webgpu.wasm` | the compiled MLC library for this engine version |

The wasm library is usualy not in the model repo — MLC publishes it separately
in `mlc-ai/binary-mlc-llm-libs`. If the folder holds no `.wasm`, the card keeps
the model and asks for that one file, and the note says which version this app
pins (`0.2.87`); a library from another version fails with "the library was
built for a different WebLLM version", not with a mysterious GPU error.

**Anything in the list is fine** — quantisation, family and size are read from
`mlc-chat-config.json`, so a MiniCPM, a Gemma or a Qwen build all work without
an app release. The context window the card offers is the build's own window,
read from the same file, and can only be lowered.

## How the files reach the engine

WebLLM loads a model over HTTP. Rather than teach the engine a second loading
path, the app pretends to be that server:

1. The page mounts the picked files in `public/local-mlc-sw.js` under
   `/__local-mlc/<random>/`, posting `File` objects — references, not bytes.
2. The engine is given `model` = that path and `model_lib` = its `.wasm`.
3. The worker answers every request by streaming the file from disk.

No network traffic, no copy in memory, no upload. The engine does keep a copy
of what it reads in browser cache (that is how WebLLM works), which is why the
second load of the same folder is faster; `Forget` clears the saved model, not
the folder.

Two browser requirements: a secure origin (https, or `localhost`) for the
worker, and WebGPU itself — Chrome/Edge 113+, Firefox 141+ on Windows, Safari
26. The folder picker uses File System Access where it exists and
`<input webkitdirectory>` where it does not, so Firefox works too.

## The card

**Settings → AI → Local AI (GPU)**, at the top of the AI card, always shown.

- **Choose model folder…** — checks the four pieces before anything loads.
- The model's name, size, quantisation and context window, plus the file count.
- **Load & test** — mounts, loads, then frees the GPU memory. Only a load that
  succeeded sets the profile's `savedAt`, which is what makes the card say
  **Ready**; picking a folder never does.
- **Choose the .wasm library** — only when the folder has none.
- **Advanced** — context window, temperature, top-p, repetition penalty.
- **Forget** — drops this computer's saved model. The folder is untouched.

Refusals are sentences with both numbers (the model needs ≈5.7 GB, this
computer reports 4 GB), or the name of the file that is missing — never a bare
error code. The raw engine message stays behind the details line.

## What changed when the old engine was removed

The wllama/GGUF engine, its ONNX OCR model, the file pickers, the local config
knobs and the `local_profile` save path are deleted, along with their tests and
four dependencies. The **Local** option in the engine switch went with them.

The server side is untouched: `import-job`, the shared `local-runtime.js`
rules and the `LOCAL_INFERENCE_ENABLED` deployment flag still exist, so a
deployment that had local inference turned on keeps its stored settings. The
settings form shows such a row as Off rather than pretending this browser can
still run it.

## What is not wired yet

An import still runs on the server. Wiring the GPU engine into the wizard needs
three things that were deliberately left out of this step:

1. `localSetup()`/`runLocalImport()` choosing the v2 provider when a model is
   saved on this computer.
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
- Chrome and Firefox both, with a folder from each filesystem (NTFS path with
  spaces, and a network share).
- Every failure state has a sentence and a next action.
