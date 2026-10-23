# Local AI Import: Text Model Not Working Despite Being Configured

## Problem

User has configured a text model (`MiniCPM5-1B-SFT.i1-Q4_K_M.gguf`) in the split layout, and the settings card shows "Ready" with the model name and SHA-256. But when starting an import, they get:

```
Alpine Expression Error: importAgent.error.NO_MODEL_PROFILE
```

## Current State

- Text model: `MiniCPM5-1B-SFT.i1-Q4_K_M.gguf` — shows "Ready" with SHA-256
- Vision model: `falcon_ocr_kv_token_q8.onnx` — shows "Error: unknown protobuf wire type 4" (fixed in code but not deployed to user)
- Support files: All 4 missing (shows as warning)
- Layout: "Two models, text and vision" (split)
- Engine: "This computer (private)"
- `LOCAL_INFERENCE_ENABLED` flag: Not set (needs to be set on Supabase)

## Possible Causes

1. **Profile not persisted to IndexedDB** - The settings card saves to the server (ai_settings.local_profile) but the actual file handle lives in the browser's IndexedDB. If the user didn't click "Save local settings" after picking the model, the handle isn't stored.

2. **Profile loaded from server vs IndexedDB mismatch** - `localSetup()` calls `loadProfile()` which reads from IndexedDB, but the UI shows data from the server response.

3. **Model handle lost on reload** - File System Access API handles require re-granting permission after reload. The user may have picked the model, but after page reload the handle is invalid until they re-grant permission.

4. **`LOCAL_INFERENCE_ENABLED` not set** - This would cause a different error (`LOCAL_MODE_DISABLED`), but worth verifying.

## What Needs Investigation

- Does the "Save local settings" button actually persist the file handle to IndexedDB?
- After page reload, does the model show as "Not verified" instead of "Ready"?
- What does `loadProfile()` actually return at runtime?

## Related: AI Config Issues

The user also mentioned "ai config maybe causing issue". Possible config issues:
- `local_config` not being passed correctly to the job creation
- `inference_mode` not being set to 'local' when creating the job
- Server-side validation rejecting the local config

## Next Steps

1. Verify the model is actually saved in IndexedDB (Application tab → IndexedDB → clinic-local-profile)
2. Check if "Save local settings" was clicked after model selection
3. Try: pick model → verify & load → save local settings → hard refresh → check if still "Ready"
4. Set `supabase secrets set LOCAL_INFERENCE_ENABLED=1 --project-ref xrotdkccsgdzswvejaki`
5. Check browser console for any errors during model save/load