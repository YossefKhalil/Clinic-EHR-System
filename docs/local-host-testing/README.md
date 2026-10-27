# Local host testing

Run the whole app on one PC against a **local Supabase stack**, so nothing you
do in the UI touches the hosted project or its patient data.

- Frontend: Vite dev server on `http://localhost:3000`
- Backend: Supabase CLI local stack (Postgres, Auth, REST, Storage, Studio,
  Edge Functions) on `http://127.0.0.1:54321`
- Login created for you: username **`yossef`**, password **`123`**
  (email `yossef@clinic.local`, promoted to Super Admin)

Everything is local. The only things that are **not** local are the optional
externals:

| Feature | Needs | Local default |
|---|---|---|
| Patient attachment upload | A Cloudinary account (`VITE_CLOUDINARY_*`) | Disabled |
| Cloud AI extraction | Provider API keys entered in Settings | Off; use **This computer** |
| Local AI extraction | The GGUF/ONNX model files in `models/` | Card works, no model to load |

## One-time prerequisites

1. **Docker Desktop** installed and **running**. Start it and wait until the
   whale icon says "Engine running".
2. **Node 20+** (the repo is developed on Node 24).
3. Nothing global to install: the scripts use `npx supabase`.

### Windows note: WSL2 / Virtual Machine Platform

Docker Desktop's Linux engine needs the Windows feature **Virtual Machine
Platform** (`VirtualMachinePlatform`) and WSL2. If `docker info` fails with
`open //./pipe/dockerDesktopLinuxEngine`, check:

```powershell
Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform |
    Select-Object FeatureName, State
```

- `Enabled` -> good.
- `Disabled` -> run (as Administrator, then reboot):
  `dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`
- `DisabledWithPayloadRemoved` -> the feature's payload was stripped from this
  Windows image; DISM cannot re-add it offline and `restorehealth` fails with
  "The repair content could not be found anywhere". Fix by either:
  - enabling it from Windows Update on a supported build
    (`wsl --install --no-distribution` after the enable), or
  - pointing DISM at install media of the **same build**:
    `dism /online /enable-feature /featurename:VirtualMachinePlatform /all /Source:D:\sources\sxs /LimitAccess`,
    or
  - reinstalling Docker Desktop / repairing WSL from an image that still
    carries the payload.

Also confirm virtualization is exposed to Windows:

```powershell
(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled   # should be True
(Get-CimInstance Win32_ComputerSystem).HypervisorPresent          # either value is fine
```

If `VirtualizationFirmwareEnabled` is `False` and the PC is itself a VM, turn
on nested virtualization for that VM.

Once `docker info` prints a `ServerVersion`, the rest is automatic.

## One-time setup

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File docs/local-host-testing/setup.ps1
```

The script:

1. checks Docker is up,
2. runs `supabase start` (first run downloads ~1.5 GB of images),
3. applies `supabase/schema.sql` as the initial migration and seeds
   `supabase/seed.local.sql` (3 sample patients),
4. creates the login `yossef` / `123` through the Auth admin API and promotes
   it to Super Admin,
5. writes `.env.local` with the local URL and anon key.

Then start the app:

```powershell
npm run dev
```

Open `http://localhost:3000`, sign in as `yossef` / `123`.

## Daily use

```powershell
# start the backend (keeps data) and the dev server
powershell -ExecutionPolicy Bypass -File docs/local-host-testing/start.ps1

# stop the backend (data is kept on disk)
powershell -ExecutionPolicy Bypass -File docs/local-host-testing/stop.ps1
```

- Supabase Studio (inspect the local DB): `http://127.0.0.1:54323`
- Local emails (Inbucket): `http://127.0.0.1:54324`
- API: `http://127.0.0.1:54321`

## Reset the local database

This wipes the local DB and re-applies the migration + seed. The login account
is recreated by `setup.ps1` afterwards:

```powershell
npx --yes supabase@2.122.0 db reset
powershell -ExecutionPolicy Bypass -File docs/local-host-testing/setup.ps1 -SkipStart
```

## Testing the local AI engine (issue #52)

1. Sign in and open **Settings -> AI**.
2. Switch the engine to **This computer** (the local engine is enabled locally
   by `LOCAL_INFERENCE_ENABLED=1` in `supabase/config.toml`).
3. The card shows the runtime (`wllama …`), the device chips, an optional
   **System RAM (GB)** field for Firefox/Safari, the model pickers, and — in the
   one-model layout — the optional **Vision projector** slot.
4. To actually load a model, put the files the card asks for in `models/` (they
   are git-ignored and never uploaded):
   - single layout: one multimodal `.gguf` plus an `mmproj*.gguf` projector,
   - split layout: a text `.gguf` plus `falcon_ocr_kv_token_q8.onnx` and its
     `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`,
     `config.json`.
   The dev server serves `models/` with HTTP Range support.

The local engine needs no internet. A router/model file is not required to
exercise the settings card, the probe/verification messages, or the stored
profile behaviour.

## What each file here is

| File | Purpose |
|---|---|
| `README.md` | this guide |
| `setup.ps1` | one-time: start the stack, migrate, seed, create the login, write `.env.local` |
| `start.ps1` | start the stack (keep data) and `npm run dev` |
| `stop.ps1` | stop the stack, keep data |
| `env.local.example` | shape of the generated `.env.local` |

Related repo files:

| File | Purpose |
|---|---|
| `supabase/config.toml` | local stack settings (ports, local seed paths, local-only Edge secrets, `login` verify_jwt off, weak-password allowance) |
| `supabase/migrations/20260101000000_init.sql` | the initial migration = a copy of `supabase/schema.sql` |
| `supabase/seed.local.sql` | local-only sample patients |

## Notes and caveats

- The local Edge secrets in `supabase/config.toml` are **local only**. A hosted
  project sets real ones with `supabase secrets set`.
- `auth.minimum_password_length = 1` is **local only**, so the throwaway
  `123` password works. Never copy that to a hosted project.
- Cloudinary is not configured locally, so attachment upload/list is disabled.
  Add `VITE_CLOUDINARY_CLOUD_NAME` / `VITE_CLOUDINARY_UPLOAD_PRESET` to
  `.env.local` to enable it.
- The local stack runs the real `supabase/functions/*` code, so `login`,
  `ai-settings`, `manage-user`, `import-job` and `cloudinary-sign` behave like
  the deployment.
