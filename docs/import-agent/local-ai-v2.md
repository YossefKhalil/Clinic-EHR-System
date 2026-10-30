# Local AI v2 (WebGPU) — the engine path

Status: **built behind a flag, not yet driving imports.** This document covers
what exists in the tree, how to try it on a machine with a GPU, and what is
still missing before the flag flips. The plan and its reasoning live in #54;
the v1 investigation is in [`local-ai-runtime-issue.md`](local-ai-runtime-issue.md).

## What it is

A second local engine that runs a model on **WebGPU** through MLC/WebLLM,
beside the existing wllama/GGUF path. It is text-only: spreadsheets, Word,
plain text and PDFs through the existing readers. Photos are refused with a
sentence, not a mid-import failure.

The whole path is one folder, `src/features/import-agent/local-v2/`:

| File | Job |
|---|---|
| `catalog.json` | the checked-in model list: id, addresses, quant, size, context, licence, sampling |
| `catalog.js` | catalog access, WebGPU probe, and the pure device-fit decision |
| `engine.js` | the only file that imports `@mlc-ai/web-llm`; load, one chat call, unload, error mapping |
| `provider.js` | the same `complete()` contract v1 implements, plus the reasoning strip |
| `profile.js` | the saved model and sampling, as plain JSON |
| `setup.js` | device check → engine load → provider |
| `settings.js` | the Alpine component behind the settings card |
| `errors.js` | every failure code and the sentence key that explains it |

Nothing in `local/` (the v1 engine) changed, and no Supabase code changed.

## Turning it on

Off by default. Any one of:

```
VITE_LOCAL_AI_V2=1 npm run dev      # build-time
open the app once with ?localV2=1   # remembered on this device
localStorage['clinic.localAi.v2.enabled'] = '1'
```

With the flag on, **Settings → AI → This computer** shows a card at the top:
model name, size, context, a status dot, one **Download model** button, and an
**Advanced** drawer (context window, temperature, top-p, repetition penalty).

## Trying it on a real machine

1. Chrome or Edge 113+, or Firefox 141+ on Windows. Safari 26 also works.
2. `VITE_LOCAL_AI_V2=1 npm run dev`, open `http://localhost:3000?localV2=1`.
3. Settings → AI → This computer. The card should say **Not set up** (or
   **This device cannot run it**, with the reason and the numbers).
4. **Download model** — 4.4 GB, cached by the browser. Progress is the
   engine's own report; the card frees the GPU once the model is proven.
5. Status becomes **Ready**. Reload the page: it stays Ready (the profile was
   saved), and the weights come from the cache.

The engine is a lazy chunk (`index-*.js`, ~6 MB uncompressed) that is fetched
only when a model is loaded, so an installation that never turns v2 on never
downloads it.

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
