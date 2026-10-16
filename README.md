# Clinic EHR System — Lightning

A free, cloud-native Electronic Health Record (EHR) system for multi-section clinics.

**Goal.** Migrate the project off a self-hosted Laravel stack and make it fully cloud-based with zero server to own or scale: Supabase for the database and authentication, Cloudinary for image storage, Cloudflare Pages for hosting. Cloudflare Pages is a static host, so the app is rebuilt as a client-rendered SPA instead of a server-side Laravel + Blade app.

It is rebuilt from [BelalAhmed2214/health](https://github.com/BelalAhmed2214/health) by porting the same UI onto **Vite + Alpine.js + Bootstrap 5.3** with **Supabase** (database & auth) and **Cloudinary** (image uploads). A first-class goal of the rewrite is that it stays fast and responsive: mostly static HTML/CSS from a CDN-backed static host, with any client-side work kept lightweight and lazy.

## Features

- **Patient Registry** — create, read, update, delete patient records with visit history, symptoms, diagnosis, and internal notes
- **Attachments** — medical/lab papers and images attached to each patient file via Cloudinary (unsigned uploads)
- **AI Import** — 3-step import (Add data → Review → Done): drop Excel/CSV files, photos, Word/PDF documents or pasted text; an AI extraction pass proposes patient rows, a review grid flags problems, and the whole batch can be undone with one click. The extraction can run on OpenRouter, Cloudflare Workers AI, or any OpenAI-compatible endpoint — switchable from Settings
- **Price Tracking** — section and source breakdowns for clinic revenue
- **Editable Option Lists** — super-admin Settings page manages followers, sections and sources (EN/AR labels, activate/deactivate) across the whole app
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

Three Edge Functions back the app: `manage-user` (admin user CRUD), `ai-import` (provider proxy for the import flow) and `ai-settings` (encrypted storage of the AI provider credentials — OpenRouter key, Cloudflare account ID + token, or OpenAI-compatible base URL + key). Pushing changes under `supabase/functions/**` deploys them automatically via `.github/workflows/deploy-functions.yml`; to deploy manually:

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
│   │   ├── ai-settings.js      # OpenRouter key management client
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
