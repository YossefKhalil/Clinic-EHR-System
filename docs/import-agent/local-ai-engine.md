# The local AI engine: what landed and what is left

This is the working note for issue #18. The plan itself is
[`local-mode.md`](local-mode.md) (the issue body, verbatim).

## What the local engine is

A per-import engine. With it on, no prompt, no image and no extracted text
reaches OpenRouter, Cloudflare, OpenAI or Groq. Supabase stays in the loop for
the job, the sources, the chunks, the rows, the rejects and the audit;
nothing else changes. The Edge Functions keep the bookkeeping and the model
runs in the browser.

The model files are chosen by the clinic and stay on their own PCs. They are
never committed and never uploaded.

## What landed in this round

The text half of the plan (Phase 0 and Phase 1). The OCR half (Phase 2) is
written but dark.

### The reference files

The plan, the settings-card mockup and the ten local modules existed only in
the issue's comments. They are now files:

| File | What it is |
|---|---|
| `docs/import-agent/local-mode.md` | the plan (the issue body) |
| `public/mockups/local-ai-settings.html` | the settings-card mockup |
| `src/features/import-agent/local/*` | the local runtime |

The mockup lives in `public/mockups/`, where the other mockups live, not in
`docs/mockups/` as the plan says.

### The engine

One control sets the enabled flag and the mode together: **Off**, **Cloud**
or **This computer**. Cloud mode needs the clinic's consent before it can be
switched on, because it sends patient photos and extracted text to third
parties. The consent record holds no patient data.

The engine lives in the `ai_settings` row:

| Column | What it holds |
|---|---|
| `inference_mode` | `cloud` or `local` |
| `cloud_consent`, `cloud_consent_at` | the consent record |
| `local_profile` | the names, the sizes and the SHA-256 of the picked models |
| `local_config` | the runtime settings |

The files themselves and their handles never leave the browser. The server
learns the name, the size and the hash of each file, which is enough to say
which model produced a record.

A clinic that already had the import switched on gets the consent record
written by the schema migration, so the new rule does not switch a working
clinic off.

### The model probe

The plan asks for a capability probe (§3) but the issue's comments never
contained one. It is now `src/features/import-agent/local/adapters.js`, with
the two readers it needs:

- `gguf-metadata.js` reads the GGUF header: the architecture, the chat
  template and the tensors. The vision tower is found by the tensor names.
- `onnx-metadata.js` reads the ONNX graph header: the inputs, the outputs
  and the opsets. A hand-written protobuf reader, because the runtime only
  tells us the shape after it has loaded 450 MB of weights.

A file that cannot be used is refused with a code, not a stack trace:

| Code | What it means |
|---|---|
| `GGUF_ARCH_UNSUPPORTED` | the architecture is not in the runtime's build |
| `GGUF_TEMPLATE_MISSING` | the file carries no chat template |
| `ONNX_IO_UNMATCHED` | the graph matches no known vision adapter |
| `ONNX_OP_UNAVAILABLE` | the graph needs an op the browser runtime lacks |
| `FILE_TYPE_UNKNOWN` | the file is neither GGUF nor ONNX |
| `FILE_MISMATCH` | the name and the bytes disagree |

### The run

The browser claims the chunks one at a time, runs the same extractor the Edge
Function runs (`supabase/functions/import-extract/run-chunk.js`, imported
through the `@import-extract` alias), and hands the result back. The YAML
contract, the repair pass and the parsing are literally the same code in both
runtimes, so they cannot drift apart.

The server actions: `local_claim`, `local_submit`, `local_fail`,
`local_heartbeat` and `local_release`. The last one hands a chunk back
without counting it as a failed attempt, so a cancelled run does not use up
the chunk's retries.

A repeated submit leaves the same tray as the first one: the rejects of the
chunk's latest attempt replace the previous ones.

### What was wrong in the reference sources

The modules in the issue's comments are a draft. The following were fixed
here, and the fixes are worth knowing about:

- **The prompt builder was broken.** `buildPrompt` in `wllama-provider.js`
  built a ChatML prompt out of a single backtick, with no `<|im_start|>`
  markers at all. The text path now goes through `createChatCompletion`, so
  the prompt follows the chat template the GGUF carries, and the template
  override is a config value.
- **The tier never applied.** `resolveLocalConfig` expected a tier name
  (`'low'`), but every caller passed the tier *object*. The device defaults
  were dead code.
- **The high tier was unreachable.** `navigator.deviceMemory` is capped at 8
  by every browser, so `dm < 16` was always true. The tier now also looks at
  the WebGPU adapter limits.
- **The picked support files were ignored.** The OCR runtime asked for
  `/models/falcon-ocr/`, whatever the clinic had picked. The tokenizer
  library now reads the picked files through a local fetch, and a request
  that does not match one of them fails instead of reaching the network.
- **The wllama calls were the v2 API.** `type_k`, `use_mmap` and the
  `paths` object do not exist in v3; the runtime wants `cache_type_k`,
  `chat_template` and `{ default: <wasm url> }`.
- **The pump passed the wrong thing to the extractor.** The server hands out
  the chunk *row*; the extractor works on the chunk *payload* (the lines, the
  header, the images). The reference passed the row, so every chunk would
  have been extracted with no source text at all.
- **The capability probe did not exist.** See above.
- **The reference diff was one commit stale.** The last hunk of the
  `import-job` diff does not apply; the four `case` lines have to be added by
  hand.

The whole change was reviewed adversarially before it went out, and the
review found seven more defects in what the comments contained, all of them
fixed here: the runtime was called with the v2 signature (so every chunk
would have been extracted with no prompt), the vision model was never
recognised (the probe read a protobuf key as a four-byte number), the files
of the two-model layout were dropped when the settings were saved, a
cancelled chunk was stored as a finished one, a chunk taken over by another
window could still be marked as failed, the settings the admin saved were
ignored by the run, and a text field in the card was read as a number. The
tests in `tests/unit/local-*.test.js` cover each of them.

## Issue #52 fixes

The reported failures fell into eight groups. This is what changed.

### F1/F7: the probe contract

- The runtime's architecture list is generated from `@wllama/wllama` **3.8.1**
  and checked in as `architectures.json`. A unit test compares the file with
  the installed package, so an upgrade cannot silently widen or narrow the
  list. The wasm strings are evidence, not a stable API.
- An architecture outside the list is still refused, but the card offers
  **Load anyway**. The choice is stored on the slot
  (`allowUnsupportedArchitecture`) and travels with the file, so an import
  after a reload still loads the model the clinic accepted.
- Every refusal has a translated sentence under
  `aiSettings.local.probe.<CODE>` in both locales. The raw English `detail`
  stays on the result for diagnostics and is never the visible message. The
  i18n checker imports `PROBE_MESSAGE_KEYS` and fails when a key is missing.
- `MMPROJ_INVALID` is its own code: a file picked in the projector slot that
  is not a projector is refused with a sentence that says so.
- An ONNX graph that is cut short keeps `ONNX_TRUNCATED` and reports how many
  of the declared bytes were read; only a graph that is structurally not ONNX
  maps to `ONNX_MAGIC_INVALID`/`FILE_TYPE_UNKNOWN`. The sniffer accepts any
  plausible protobuf first key (field 1–15, wire 0/1/2/5), so an exporter that
  starts with `producer_version` or `domain` is not mislabelled.
- The readiness row names the runtime (`wllama 3.8.1`). wllama exposes no
  llama.cpp revision, so the label does not invent one.

### F2: System RAM and the tier

- `local_config.runtime.systemMemoryGb` (0–1024, **0 = not entered**) wins
  over `navigator.deviceMemory` when the tier is suggested. Firefox and Safari
  report no RAM, so a clinic on those browsers can now earn the `high` tier.
- The shared clamp in `limits.js` / `local-runtime.js` bounds the value on
  both sides. The readiness chip says `entered` or `reported`, and the tier
  chip is recomputed as the field changes.

### F4: the single-model vision setup

- A single profile may carry an optional `mmproj` projector
  (`mmprojName`/`mmprojSize`/`mmprojSha256`). It is part of the model identity
  (`localModelIdentity`, `sameLocalModel`), because a different projector
  reads the same photo differently.
- The projector is probed in the `projector` role and loaded as the second
  blob: `initWllama({ blobs: [model, projector] })`. The loaded runtime only
  claims `multimodal` when the projector is present, so a multimodal GGUF
  without its projector says "text only" instead of failing inside wllama.
- The card warns when a GGUF declares a vision tower and no projector is
  selected, and when the text half has no vision tower at all.
- The split layout is unchanged: text GGUF plus an ONNX Falcon vision model.
  A GGUF in the vision slot is still refused with `VISION_GGUF_UNSUPPORTED`.

### F3: re-check, hashes and translated errors

- **Verify** hashes once and probes the header. **Re-check** probes the header
  again without re-reading a 700 MB file, which is the useful action after an
  interrupted download.
- The verification state machine keeps the probe positions
  (`bytesConsumed`, `fileSize`), the parameters and the runtime label, so a
  refusal can say *how far* the read got. A SHA-256 mismatch is its own code
  (`MODEL_HASH_MISMATCH`) and shows on the slot.
- A form loaded from the server does not lose the browser-side probe state:
  the capabilities, the warnings, the runtime label and the override are
  carried forward when the slot still names the same file.

### F8: persistence for Firefox and Safari

- The profile store is now **IndexedDB v3** with a `files` store. A browser
  without the File System Access API keeps the `File` itself; Chromium keeps
  its handle. `loadProfile` rehydrates the stored bytes into `file`, and every
  caller (`verifyModel`, `verifyLocalModelSlot`, `setupLocalModels`,
  `runner`) accepts `file ?? handle`.
- `persistLocalState` asks for `navigator.storage.persist()` and reports
  `granted`, `denied`, `quota` or `unsupported`. A quota failure keeps the
  in-memory file for the session and shows a warning instead of losing the
  settings; a denied request warns that the stored model may be evicted.
- The runner accepts a slot with a stored `File` and no handle, so a Firefox
  import no longer stops with `MODEL_PROFILE_HANDLE_MISSING`.

### F5: threads, COOP/COEP and docs

- The Threads field is disabled and annotated when the page is not
  cross-origin isolated, because `resolveThreads` returns 1 in that case. The
  readiness chip says `1 thread (page is not cross-origin isolated)`.
- Multi-thread loading stays an explicit deployment opt-in: the app still
  sets no COOP/COEP headers by default, so the Supabase calls are unaffected.

### F6: locales

- All new local keys exist in `src/locales/en.json` and
  `src/locales/ar.json` with matching placeholders, including the 24 probe
  messages. `scripts/check-local-i18n.mjs` validates `PROBE_MESSAGE_KEYS` as
  well as the keys it finds in the templates.

## What is dark, and why

The OCR path (Phase 2) is written but cannot run yet:

- The ONNX Runtime and the tokenizer library add 55 MB of wasm, and the
  hosting rejects a file over 25 MB. They are left out of the bundle, so the
  OCR path fails with `OCR_RUNTIME_UNAVAILABLE` and a clear message.
- Gate 1 (the Python golden fixture for Falcon) has not been run, so the
  correctness of the ONNX port is unproven.
- There is no evidence yet that Arabic handwriting meets the review bar. The
  plan is explicit: do not ship image extraction without it.

## The things that need a person

1. **The model files.** They are 1.1 GB and are never committed. A clinic
   copies them to the PC that runs the import. The text model is
   `MiniCPM5-1B-SFT.Q4_K_M.gguf` (686,149,536 bytes) and the OCR model is
   `falcon_ocr_kv_token_q8.onnx` (450,199,845 bytes) plus `tokenizer.json`,
   `tokenizer_config.json`, `special_tokens_map.json` and `config.json` from
   the same place. The SHA-256 of the text model is not pinned yet: the file
   has to be downloaded and hashed once.
2. **The deployment flag.** The local engine is off until
   `LOCAL_INFERENCE_ENABLED` is set on the Edge Functions. Both `import-job`
   and `ai-settings` read it, and the value has to be set on both.
3. **Real clinic data.** Gate 2 needs 20 real Arabic and English entries and
   Gate 3 needs representative Arabic handwriting pages. Neither can be
   made up.

## How the pieces fit

```
Browser
  intake -> create / add_source / start(inference_mode: local)
         -> local_claim -> runChunk (local model) -> local_submit
         -> review / validation / commit      (unchanged)

Supabase Edge Function import-job
  create / add_source / start / cancel / status / retry_chunk   (existing)
  local_claim / local_submit / local_fail / local_heartbeat / local_release
```

The cloud path is unchanged. A job runs in the engine that was active when
it was created; switching the engine later does not move a running job, and
an import started under the old engine is refused with `ENGINE_MISMATCH`.
