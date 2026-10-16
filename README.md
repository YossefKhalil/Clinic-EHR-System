# Clinic EHR System — Lightning

A free, cloud-native Electronic Health Record (EHR) system for multi-section clinics.

**Goal.** Migrate the project off a self-hosted Laravel stack and make it fully cloud-based with zero server to own or scale: Supabase for the database and authentication, Cloudinary for image storage, Cloudflare Pages for hosting. Cloudflare Pages is a static host, so the app is rebuilt as a client-rendered SPA instead of a server-side Laravel + Blade app.

It is rebuilt from [BelalAhmed2214/health](https://github.com/BelalAhmed2214/health) by porting the same UI onto **Vite + Alpine.js + Bootstrap 5.3** with **Supabase** (database & auth) and **Cloudinary** (image uploads).

**Live:** https://clinc-ehr.pages.dev

## Why it stands out

- **Same clinic workflow, zero infrastructure.** Every screen of the Laravel original (registry, dashboard, prices, users, EN/AR) is here — plus features the original never had: patient attachments, AI import from spreadsheets/scans/PDFs/pasted text, Excel export, and a Settings page that edits the option lists without a redeploy.
- **Free end to end.** Static hosting, managed Postgres + auth, CDN file storage and all automation (CI, schema deploys, function deploys, keep-alive) run within free tiers. There is no VPS, no PHP runtime, no container, and nothing to patch.
- **Fast because it is mostly static.** One prebuilt bundle served from Cloudflare's edge network; heavy libraries (SheetJS, mammoth) are downloaded only at the moment they are used.
- **Secure by construction.** Postgres RLS enforces every read/write inside the database, Edge Functions hold all secrets, AI provider keys are stored AES-GCM encrypted, and the browser only ever receives the public anon key.
- **Operable by one person.** Push to deploy functions and schema, transactional schema apply with rollback, lint+build CI on every push, one-click undo for import batches, and a keep-alive cron so a free Supabase project never pauses.

## How it compares to the Laravel original

The original is a well-structured Laravel app (controllers → DTOs → service → repository, form requests, policies, middleware, Breeze auth). The rewrite keeps that domain model and the same Bootstrap dashboard UI, but moves the runtime entirely off the server:

| Area | [BelalAhmed2214/health](https://github.com/BelalAhmed2214/health) (Laravel) | Clinic EHR — Lightning (this repo) |
| --- | --- | --- |
| Runtime & hosting | PHP 8.3+ (Laravel 13) on a host you provision (shared/VPS/PaaS); server-rendered Blade per request; manual deploys | No runtime at all — a static `dist/` folder on Cloudflare Pages' CDN; deploy by pushing to git |
| Database | SQLite/MySQL/Postgres that you manage, with migrations you run yourself | Managed Supabase Postgres; schema applied by CI in a single transaction with rollback on failure |
| Auth | Laravel session auth (Breeze); sessions stored in your database | Supabase Auth (GoTrue) with JWTs; no session store to manage |
| Authorization | Middleware + policies evaluated in PHP on each request | Postgres RLS enforced inside the database, plus JWT-gated Edge Functions |
| Search | Single-column `LIKE '%term%'` on the field you pick | Indexed all-column `anysearch` + Arabic-aware fuzzy suggestions, order-independent tokens |
| Patient files | Not present | Cloudinary attachments — browser uploads straight to the CDN with live progress |
| Bulk / AI import | Not present (manual entry only) | AI import from Excel/CSV/PDF/Word/phone photos/pasted text, with a review grid, retries and one-click undo |
| Export | Not present | Excel export |
| Option lists (followers, sections, sources) | Hardcoded PHP enums/arrays — edit code and redeploy to change | DB-backed `app_options` edited from a super-admin Settings page, no redeploy |
| Bilingual | Session locale; switching reloads the page; some strings hardcoded Arabic in views | Instant client-side EN/AR switch with full RTL |
| Automation & ops | No CI or deploy automation; you patch PHP and manage the server | GitHub Actions: lint+build CI, transactional schema apply, function auto-deploy, daily keep-alive |
| Cost model | Needs PHP hosting you keep alive | Runs within free tiers end to end |

In short: the Laravel app trades a hosting bill and ops work for full server control. This rewrite trades server control for zero ops and $0 — while adding attachments, AI import, export and self-service settings. If you need PHP-level server control, the original is the better fit; if you want a clinic system with no server to maintain, this is.

## Free cloud-based — no server to own, scale or pay for

- **Hosting.** Cloudflare Pages' free tier serves the static build from Cloudflare's edge network with automatic SSL. There is no app server in the request path.
- **Data & auth.** Supabase's free tier provides managed Postgres and authentication. Authorization is done by RLS *inside the database*, so nothing else needs to run to be secure. The included daily cron (`.github/workflows/keep-alive.yml`) pings the project's GoTrue health endpoint so a free-tier project never hits the inactivity pause.
- **Files.** The Cloudinary upload preset is **unsigned**, so the browser POSTs every attachment directly to Cloudinary — no signing endpoint, no server bandwidth, delivery through Cloudinary's CDN with on-the-fly transforms.
- **AI extraction.** Runs on whichever provider you plug in (OpenRouter, Cloudflare Workers AI — which has a free daily allowance — or any OpenAI-compatible endpoint) behind a Supabase Edge Function. Credentials are encrypted at rest, never shipped to the client.
- **Automation.** GitHub Actions is free for public repositories: CI lint+build, schema apply, Edge Function deploys and the keep-alive ping all run on free runners.
- **No cost-shifting.** `.env.example` contains only public values. The `SUPABASE_SERVICE_ROLE_KEY` and provider API keys exist only as Edge Function secrets or repository secrets.

## Fast and responsive by design

- **One static artifact.** A single hashed entry bundle (≈280 KB JS + ≈315 KB CSS minified, mostly Bootstrap + icons) served with immutable caching from the edge. No per-request PHP boot, no server-side rendering.
- **Heavy code is lazy.** `xlsx` (≈490 KB) loads only when you import or export a spreadsheet; `mammoth` (≈300 KB) only when a `.docx` is actually dropped; admin/user/AI modules arrive on first use via dynamic `import()`. The initial page never pays for them.
- **No page reloads.** Views switch with `x-show` on an always-mounted DOM, and writes update rows in place (status toggles, deletes, user edits) instead of re-rendering whole pages.
- **Search that feels instant.** Keystrokes are debounced with a request-id guard against stale responses; while the indexed server query (`anysearch`) is in flight, the first suggestions render from already-loaded rows through the Arabic-aware fuzzy matcher. Results cap at 5, with full keyboard navigation (arrows, Enter, Escape).
- **Arabic-aware matching.** Normalization handles alef/ya/ta-marbuta variants, harakat, tatweel and Arabic-Indic digits, and requires every token to match somewhere across ~18 fields, order-independently — so `احمد محمد` finds `محمد احمد السيد`, and Arabic-digit phone numbers match.
- **Attachments that don't touch a server.** Direct browser→Cloudinary uploads with XHR progress, list thumbnails delivered at `w_320,q_80` and full view at `w_1600,q_90` via `f_auto`.
- **Bounded, cancellable AI import.** Text is chunked every 4,000 characters, spreadsheets 15 rows per request with the header repeated, 3 requests in parallel; images are downscaled to 1600 px / q0.85 in the browser before they are sent. Hard caps (8 MB/file, 10 files, 500 rows), a Cancel button via `AbortController`, and one automatic retry per chunk when parsing fails.
- **Survives redeploys.** A `vite:preloadError` handler reloads once (sessionStorage-guarded) when a stale tab references old hashed chunks — the classic "blank page after deploy" failure mode is handled, not left to the user.

## Production-ready — why it can run a real clinic

**Security**

- RLS is enabled on every table. Section staff only ever see their own section's patients; policies run through `SECURITY DEFINER` helpers (`is_admin()`, `is_section_user()`) to avoid the classic RLS recursion trap, and execute on those helpers is revoked from `PUBLIC`.
- Privilege escalation is blocked at the source: signup metadata is never trusted for `is_admin`/`section` — `handle_new_user()` hard-codes `FALSE, NULL`.
- `ai_settings` is removed from the PostgREST API surface entirely (`REVOKE ALL ... FROM anon, authenticated`). Provider keys are stored AES-GCM encrypted (HKDF-SHA256 key derived from the service-role key) and only masks/last-4 are ever exposed back.
- Every Edge Function verifies the caller's Supabase JWT and its own role gate (admin-only / admin-or-section). The service-role key never leaves the function.

**Operations & reliability**

- `supabase/schema.sql` is idempotent: safe to re-run as a repair path (it recreates policies and backfills missing profile rows). CI applies it with `--single-transaction --set ON_ERROR_STOP=1`, verifies expected columns afterwards, and rolls the whole file back if any statement fails.
- Edge Functions deploy automatically when `supabase/functions/**` changes, eliminating drift between repo and hosted functions.
- CI runs ESLint (flat config, `no-undef`/`no-unused-vars`) + build on every push and PR.
- Failure handling with real UX: non-stacking toasts, database error codes mapped to human sentences (duplicate / constraint / permission), bulk imports inserted in chunks of 50 that fall back to per-row retries so one bad row can't abort a batch, and skipped rows downloadable as CSV.
- Undo is first-class: every import batch carries an indexed `import_batch_id`; one click deletes exactly that batch.
- Duplicate safety: in-batch duplicates flagged in the review grid; cross-section duplicates detected via a `SECURITY DEFINER` RPC that answers "already exists elsewhere" without leaking the other section's rows.

**Data integrity**

- `national_id` is unique; mobile numbers and dates of birth are normalized from the national ID deterministically on the client, not guessed.
- Option values are validated in the database by a trigger against `app_options` — deactivated options stay valid on historical rows.
- `updated_at` is maintained by triggers, and the registrar's name is denormalized at write time so section staff see "Registered by" under RLS.
- Date filters convert the viewer's local day boundaries to UTC instants before comparing with `timestamptz`, so there are no off-by-timezone edge rows.

**Real-world details**

- Full RTL through logical CSS properties (`margin-inline`, `inset-inline-*`), instant EN/AR switching persisted to localStorage, localized ARIA labels, `aria-live` toasts, a keyboard-operable dropzone, and a `capture="environment"` camera shortcut for phone photos.
- Loading spinners clear in `finally` — a failed request can never strand the app on the loading screen.

## Features

- **Patient Registry** — create, read, update, delete patient records with visit history, symptoms, diagnosis, and internal notes
- **Instant Global Search** — one box across every patient field, Arabic-aware, with keyboard navigation
- **Attachments** — medical/lab papers and images attached to each patient file via Cloudinary (unsigned uploads)
- **AI Import** — 3-step import (Add data → Review → Done): drop Excel/CSV files, photos, Word/PDF documents or pasted text; an AI extraction pass proposes patient rows, a review grid flags problems, and the whole batch can be undone with one click. The extraction can run on OpenRouter, Cloudflare Workers AI, or any OpenAI-compatible endpoint — switchable from Settings
- **Excel Export** — export the patient list for reporting (SheetJS loads only when used)
- **Price Tracking** — section and source breakdowns for clinic revenue
- **Editable Option Lists** — super-admin Settings page manages followers, sections and sources (EN/AR labels, activate/deactivate) across the whole app, no redeploy
- **User Management** — admin/staff roles with section-based access via Supabase Edge Functions
- **Dashboard** — stats cards (total, completed, pending, per-section, per-source) and recent patient table
- **Bilingual** — full English/Arabic translations with RTL support

## Tech Stack

| Layer | Technology |
|---|---|
| Build | Vite 5.4 |
| UI | Alpine.js 3.14 + Bootstrap 5.3.3 |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth |
| Files | Cloudinary (unsigned upload) |
| AI extraction | OpenRouter / Cloudflare Workers AI / OpenAI-compatible (server-side credentials, via Supabase Edge Function) |
| Hosting | Cloudflare Pages |
| Spreadsheet/docs | SheetJS (xlsx), js-yaml, mammoth |

## Getting Started

### Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project — database + Postgres Auth + (for user management) an Edge Function
- A [Cloudinary](https://cloudinary.com) account — optional; only if you want patient photo uploads
- A [Cloudflare Pages](https://pages.cloudflare.com) project — optional; the app runs locally without it

Cloudflare Pages is a static host, so "moving off Laravel" means the app runs entirely from a **static build artifact** — no app server, no PHP, and no managed runtime to pay for. Everything live (data, auth, uploads, hosting) is a managed service.

### 1. Clone & Install

```bash
git clone https://github.com/YossefKhalil/Clinic-EHR-System.git
cd Clinic-EHR-System
npm install
```

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_CLOUDINARY_CLOUD_NAME=your-cloud-name
VITE_CLOUDINARY_UPLOAD_PRESET=clinic_ehr_uploads
```

### 3. Database Schema

The whole schema lives in `supabase/schema.sql`: tables, RLS policies, triggers,
indexes, and the column migrations. The file is **idempotent** — running it on a
database that already has the schema is a no-op, so it can be re-applied safely.

**One-time setup**, pick either route:

**Automated (push to `master` applies it).** Add one repository secret under
*Settings → Secrets and variables → Actions*:

| Secret | Value |
| --- | --- |
| `SUPABASE_DB_URL` | Postgres connection string, e.g. `postgresql://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres` |

Use the shared **session** pooler on port `5432` (or the direct connection).
GitHub runners are IPv4-only, so the direct `db.<ref>.supabase.co` host will not
resolve unless your project has the IPv4 add-on — the session pooler works either
way. Do **not** use the transaction pooler on port `6543`: it cannot reliably run
DDL.

`.github/workflows/supabase-schema.yml` then applies the schema with
`psql --single-transaction --set ON_ERROR_STOP=1` whenever `supabase/schema.sql`
changes, verifies the columns afterwards, and rolls the whole file back if any
statement fails. Run it manually from *Actions → Supabase Schema → Run workflow*.

**Manual.** Paste `supabase/schema.sql` into the Supabase SQL Editor and Run.

Either way, re-running the file after a schema change is the repair path: it
drops and recreates the RLS policies and backfills any `auth.users` rows that are
missing a `public.users` profile row.

> **Keep-alive.** On the Supabase free tier, projects pause after a week of
> inactivity. `.github/workflows/keep-alive.yml` pings `/auth/v1/health` daily to
> prevent that. Add the `SUPABASE_URL` and `SUPABASE_KEY` repository secrets
> (project URL + anon key) to enable it.

> **Growing past one file?** Once you want versioned, ordered migrations, move to
> the Supabase CLI (`supabase init`, `supabase link`, then `supabase migration new`
> + `supabase db push` in CI). This project was set up by pasting SQL, so the
> remote migration history is empty — run `supabase db pull` once and accept the
> prompt to record it as already applied, otherwise `db push` will try to recreate
> existing objects.

> `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are **build-time** variables
> (`import.meta.env`, read in `src/services/supabase.js`). For Cloudflare Pages
> they must be set in the Pages project's build environment variables, not in the
> Worker's runtime variables.

### 4. Deploy Edge Functions

Three Edge Functions back the app: `manage-user` (admin user CRUD), `ai-import` (provider proxy for the import flow) and `ai-settings` (encrypted storage of the AI provider credentials — OpenRouter key, Cloudflare account ID + token, or OpenAI-compatible base URL + key). Pushing changes under `supabase/functions/**` deploys them automatically via `.github/workflows/deploy-functions.yml` (requires the `SUPABASE_ACCESS_TOKEN` repository secret); to deploy manually:

```bash
supabase functions deploy manage-user ai-import ai-settings
```

Set the `SUPABASE_SERVICE_ROLE_KEY` secret in the Supabase project. `ai-settings` encrypts the stored credentials with material derived from that secret — after rotating the service role key, re-save the provider credentials from the Settings page. The only environment fallback is a legacy `OPENROUTER_API_KEY` secret, used when no OpenRouter key is stored in the database.

### 5. Development

```bash
npm run dev
```

A local dev server is still the fastest way to iterate — Supabase is still the real backend. Cloudflare Pages is only for hosting the built artifact.

`npm run lint` runs ESLint (flat config) over `src/` with `no-undef` and `no-unused-vars` enabled. CI runs lint + build on every push (`.github/workflows/ci.yml`).

### 6. Build & Deploy

```bash
npm run build
```

Output goes to `dist/`. Deploy to Cloudflare Pages with:

- **Build command:** `npm run build`
- **Output directory:** `dist`

Since Cloudflare Pages only serves the static `dist/`, the build step does not depend on Supabase or Cloudinary being live — it can fail loudly at runtime if the env vars are missing, but it cannot fail at build time because of them.

## Project Structure

```
├── index.html                  # SPA entry point (all pages)
├── src/
│   ├── main.js                 # Alpine.js app controller
│   ├── services/
│   │   ├── i18n.js             # Locale system (en/ar)
│   │   ├── supabase.js         # Auth & client init
│   │   ├── cloudinary.js       # Attachment uploads
│   │   ├── patients.js         # Patient CRUD
│   │   ├── prices.js           # Price statistics
│   │   ├── users.js            # User management (Edge Function)
│   │   ├── dashboard.js        # Dashboard stats
│   │   ├── options.js          # Editable option lists
│   │   ├── fuzzy.js            # Arabic-aware fuzzy search
│   │   ├── ai-import.js        # AI extraction parsing/validation
│   │   ├── ai-import-client.js # File reading + chunked extraction calls
│   │   ├── ai-settings.js      # AI provider settings client
│   │   └── export.js           # Excel export
│   ├── locales/
│   │   ├── en.json             # English translations
│   │   └── ar.json             # Arabic translations
│   └── styles/
│       └── main.css            # Custom styles + RTL
├── supabase/
│   ├── schema.sql              # Full DB schema + RLS
│   ├── seed.sql                # Seed notes
│   └── functions/
│       ├── manage-user/        # Admin user CRUD
│       ├── ai-import/          # Provider proxy + extraction prompt
│       ├── ai-settings/        # Encrypted AI provider credential store
│       └── _shared/            # Shared Edge Function helpers
├── eslint.config.js
├── package.json
├── vite.config.js
└── .env.example
```

## License

MIT
