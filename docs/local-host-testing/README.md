# Local host testing

Run the whole app on one PC with **no hosted Supabase data**. There are two
ways; the first needs only Node.

| | No-Docker mock | Local Supabase stack |
|---|---|---|
| Needs | Node 20+ (Deno for the Edge Functions) | Docker Desktop + WSL2 |
| Backend | `scripts/local-mock` (PGlite + the real Edge Functions) | real Postgres/GoTrue/PostgREST |
| Fidelity | RLS, triggers and Edge Functions run for real; the platform HTTP layer is emulated | full platform |
| Start | `npm run local` | `docs/local-host-testing/setup.ps1` |

Either way the login is **`yossef` / `123`** (Super Admin), and nothing touches
the hosted project.

## Option A - no Docker (`npm run local`)

### What it is

`scripts/local-mock` is a small Supabase-compatible backend:

- **Database:** a real Postgres (PGlite/WASM) with the same prelude a hosted
  project has (anon/authenticated/service_role roles, `auth` schema). It applies
  `supabase/schema.sql`, so RLS policies, `SECURITY DEFINER` helpers, triggers,
  the `anysearch(...)` computed field and `existing_national_ids` all behave
  like production.
- **REST:** a PostgREST slice (filters, order, limit/offset/Range, exact
  counts, single/maybeSingle, insert/update/delete/upsert, RPC).
- **Auth:** a small GoTrue (password grant, refresh, current user, logout,
  admin user CRUD).
- **Edge Functions:** the **real** `supabase/functions/*` code, run in one
  Deno process that captures each `Deno.serve(handler)`.

State lives in `.local/pgdata` (git-ignored). Delete it with `npm run local:reset`.

### Run

```bash
npm run local
```

That command:

1. writes `.env.local` (`VITE_SUPABASE_URL=http://127.0.0.1:54321` + a local
   anon key),
2. starts the mock API on `:54321`,
3. starts the Edge Functions in Deno on `:54328` (first run downloads
   `@supabase/supabase-js`/`js-yaml` from esm.sh once),
4. starts Vite on `http://localhost:3000`.

Open `http://localhost:3000` and sign in as `yossef` / `123`.

Requirements: Node 20+ and **Deno** on `PATH` (the Edge Functions). The rest of
the app works even if Deno is missing; only `/functions/v1/*` calls fail.

### What is not local

| Feature | Needs | Local default |
|---|---|---|
| Patient attachment upload | Cloudinary (`VITE_CLOUDINARY_*`) | disabled |
| Cloud AI extraction | provider keys entered in Settings | off; use **This computer** |
| Local AI extraction | GGUF/ONNX model files in `models/` | card works, no model to load |

### Testing the local AI engine (issue #52)

1. Open **Settings -> AI** and switch to **This computer** (the mock reports
   `LOCAL_INFERENCE_ENABLED=1`).
2. The card shows the runtime (`wllama …`), device chips, the **System RAM (GB)**
   field, the model pickers and, in the one-model layout, the optional **Vision
   projector** slot.
3. To load an actual model, put the files it asks for in `models/` (git-ignored):
   - single layout: a multimodal `.gguf` plus an `mmproj*.gguf`,
   - split layout: a text `.gguf`, `falcon_ocr_kv_token_q8.onnx` and its
     `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`,
     `config.json`.

   The Vite dev server serves `models/` with Range support.

## Option B - local Supabase stack (Docker)

Use this when you want the real platform (Studio, GoTrue, PostgREST, Storage).

### Prerequisites

1. **Docker Desktop** running with the Linux engine.
2. **Node 20+**.
3. Nothing global: the scripts use `npx supabase`.

#### Windows: WSL2 / Virtual Machine Platform

Docker Desktop's Linux engine needs the `VirtualMachinePlatform` Windows
feature. Check it:

```powershell
Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform |
    Select-Object FeatureName, State
```

- `Enabled` -> good.
- `Disabled` -> `dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`, then reboot.
- `DisabledWithPayloadRemoved` -> the payload was stripped from this Windows
  image. DISM can only re-add it from install media of the **same build**
  (`/Source:D:\sources\sxs /LimitAccess`) or from Windows Update on a supported
  build. `restorehealth` reports "The repair content could not be found
  anywhere". Without it, use Option A.

Also confirm virtualization is available:
`(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled` should be `True`.

### Setup

```powershell
powershell -ExecutionPolicy Bypass -File docs/local-host-testing/setup.ps1
npm run dev
```

The script runs `supabase start`, applies the migration + local seed, creates
`yossef` / `123` through the Auth admin API and promotes it, then writes
`.env.local`.

- Studio: `http://127.0.0.1:54323`  ·  API: `http://127.0.0.1:54321`  ·
  Emails: `http://127.0.0.1:54324`
- `start.ps1` / `stop.ps1` start and stop it; `supabase db reset` wipes the
  local DB.

## Files

| File | Purpose |
|---|---|
| `docs/local-host-testing/README.md` | this guide |
| `scripts/local-mock/*` | Option A backend (`start.mjs`, `server.mjs`, `auth.mjs`, `postgrest.mjs`, `db.mjs`, `jwt.mjs`, `functions-router.ts`) |
| `docs/local-host-testing/setup.ps1` | Option B one-time setup |
| `docs/local-host-testing/start.ps1` / `stop.ps1` | Option B start/stop |
| `docs/local-host-testing/env.local.example` | `.env.local` shape |
| `supabase/config.toml` | Option B local stack settings |
| `supabase/migrations/20260101000000_init.sql` | Option B initial migration |
| `supabase/seed.local.sql` | local sample patients (both options) |

## Caveats

- The mock's anon/service keys are local JWTs (`.local/mock-keys.json`), not
  real Supabase keys.
- `supabase/config.toml`'s local Edge secrets and
  `auth.minimum_password_length = 1` are **local only**; never copy them to a
  hosted project.
- Cloudinary is unconfigured locally, so attachment upload/list is disabled.
