# M0 — Schema confirmations and decisions

| | |
|---|---|
| **Status** | Complete — resolves every **[CONFIRM]** in the design spec (v0.1, 2026-10-17) |
| **Sources read** | `supabase/schema.sql`, `src/main.js`, `src/services/{patients,options,export,i18n}.js`, `index.html`, `supabase/functions/manage-user`, the v1 AI import removed in `a9a0b1c` (`git show a9a0b1c^:…`) |
| **Answers** | Open question Q1–Q12 of the spec, section 19.2 |

This document is the M0 exit artefact: the schema is read, the registry keys are fixed to real
columns, and the remaining clinic-policy questions are listed with the default we proceed on
until the clinic decides otherwise.

---

## 1. `patients` table — the real schema

From `supabase/schema.sql` (verified, not assumed):

| Column | Type | Constraints | Registry? |
|---|---|---|---|
| `id` | uuid | PK | — |
| `name` | text | `NOT NULL` | yes |
| `national_id` | text | **`UNIQUE` `NOT NULL`** — global, not per section | yes |
| `mobile` | text | — | yes |
| `date_of_birth` | date | — | yes |
| `age` | integer | — | yes |
| `marital_status` | text | no DB constraint (form restricts to 4 values) | yes |
| `children_count` | integer | **no DB default** (the form's `0` is client-side) | yes |
| `governorate` | text | no DB constraint (form restricts to the 27-name list) | yes |
| `address` | text | — | yes |
| `problem` | text | — | yes |
| `solution` | text | — | yes — **this is "Diagnosis & Treatment Plan"** |
| `notes` | jsonb | `DEFAULT '[]'` — JSON **array of strings**, not a child table | yes |
| `visit_date` | date | — | yes |
| `is_completed` | boolean | `DEFAULT FALSE` | — (app-managed) |
| `price` | decimal(10,2) | — | yes |
| `follower` | text | validated by trigger against `app_options(kind='follower')` | yes |
| `section` | text | validated by trigger against `app_options(kind='section')` | yes |
| `source_of_money` | text | validated by trigger against `app_options(kind='source')` | yes |
| `user_id` | uuid | FK → `users(id)` | — (app-managed) |
| `created_at`, `updated_at` | timestamptz | triggers maintain `updated_at` | — |
| `attachments` | jsonb | `DEFAULT '[]'` — Cloudinary metadata array | — (app-managed) |
| `registered_by_name` | text | denormalized registrar name | — (app-managed) |

Notable consequences:

- **`deleted_at` does not exist.** Deletes are hard (`deletePatient()`). M7 adds soft delete,
  the partial unique index `UNIQUE (national_id) WHERE deleted_at IS NULL`, and a regression
  pass over: `getPatients`, global search (`anysearch`), dashboard counts, price statistics,
  export, and the patient/profile pages.
- **`national_id` is unique globally** — no section scoping. `DUP_EXISTING_HIDDEN` therefore
  means "exists in a section the user cannot see", which is exactly the `existing_national_ids`
  RPC use-case from §8.6.
- **`solution`, not `diagnosis`.** The form label "Diagnosis & Treatment Plan" writes to
  `solution` (`index.html:1038`). The registry key is `solution`.
- **`date_of_birth`, not `dob`.** The registry key is `date_of_birth`.
- **`age` can exist without a DOB.** When `date_of_birth` is set the form recomputes `age` and
  makes it read-only; with no DOB the age can be typed. So `AGE_DERIVED` is real behaviour of
  the app, and a source age with no DOB is stored as written.
- **`children_count` has no database default.** The form's `0` is client-side
  (`newPatientForm()`). An import that leaves it unstated stores `NULL`; the next edit shows `0`.
- **`governorate` stores one of the 27 English names** from `GOVERNORATES`
  (`src/services/patients.js`): `Cairo`, `Giza`, … `Kafr El Sheikh`, … `Matrouh`. Arabic input
  is matched by the alias table; the stored value is the English list entry.
- **`notes` is a JSONB array.** The commit RPC writes the array; the undo guard reads the
  column; there is no child table.
- **Attachments are Cloudinary metadata on the row.** The undo "linked records" guard is:
  `attachments` non-empty, or `updated_at` newer than the commit (within tolerance).

## 2. Option lists (`app_options`) — the real enum source

`app_options(kind, key, label_en, label_ar, active, sort_order)`, kinds `follower` | `section` |
`source`. Patient rows store the immutable **`key`**; labels are editable, bilingual, and may be
deactivated. Seeded values: followers `hassan_hamam`…`mohamed_rabie`; sections `agamy`,
`dekhila`; sources `charity`, `country`.

Import behaviour:

- **Snapshot at job start.** `import_jobs.config` carries the full option rows (key + both
  labels) for the three kinds, so a Settings edit mid-run cannot desynchronise the validator
  from the review UI.
- The enum engine matches extracted text against `label_en`, `label_ar`, the key itself, and the
  Arabic alias tables, and stores the **key**.
- `section` is never LLM-extracted; it comes from the user's `users.section` (section staff) or
  the bulk-fill default (admins).

## 3. Answers to the open questions (Q1–Q12)

| # | Verdict | Source / decision |
|---|---|---|
| Q1 | **Answered.** Columns as §1. `national_id` unique **globally**; no partial index today. | schema.sql |
| Q2 | **Answered.** Mobile is stored in **local format `01xxxxxxxxx`**. Evidence: v1 prompt ("write it with the leading 0, e.g. `01012345678`"), v1 validator `^01\d{9}$`, and the form placeholder `+2010...`. Landlines are allowed by the form (free text) — import keeps the cleaned digits and raises `MOBILE_FORMAT` (warn). `PHONE_STORAGE_FORMAT = 'local'`. | v1 code (`a9a0b1c^`), `index.html` |
| Q3 | **Answered.** Notes are a JSONB array column on `patients`, not a child table. | schema.sql |
| Q4 | **Answered.** Lists live in `app_options` as **keys + bilingual labels**; patients store keys. | schema.sql, `src/services/options.js` |
| Q5 | **Open — clinic decision.** Proceed with *optional* (the form allows blank). Flip in `import_settings` if the clinic requires it; the confirmation text already reminds the user (§10.9). | spec default |
| Q6 | **Open — clinic decision.** One row = one patient (assumption A1). No visits table exists today, and v1 also treated it flat. Revisit if a visits entity is introduced. | schema.sql |
| Q7 | **Answered.** No table references `patients`; attachments are a JSONB column. Undo guard = `attachments` non-empty OR `updated_at` changed. | schema.sql |
| Q8 | **Open — legal/policy.** Adapters support OpenRouter, Cloudflare Workers AI and an OpenAI-compatible/self-hosted endpoint; feature stays behind `import_agent_enabled` until the clinic signs off. | spec §13.8 |
| Q9 | **Open — clinic decision.** Proceed with defaults: undo window 7 days, staging TTL 7 days (24 h after done/cancelled), rows 30 days, batch payloads 90 days. All in `limits.js`. | spec Appendix B |
| Q10 | **Open.** Unknown share of photos/handwriting; M8 stays after M6 in the schedule. | spec §18.1 |
| Q11 | **Open — clinic decision.** Default: section staff see only their own batches. | spec §12.6 |
| Q12 | **Open — clinic decision.** Default: no permanent report store; CSV download + batch records per retention. | spec §12.6 |

## 4. Additional findings the spec could not see

1. **The v1 AI import was removed** (`a9a0b1c`), including `ai_settings`, `patients.import_batch_id`
   and `existing_national_ids()`. M2 recreates the table and the RPC; the key store moves from the
   service-role-derived key to a dedicated `AI_SETTINGS_ENC_KEY` secret as the spec requires
   (§13.6), format `v1.<iv>.<ciphertext>` unchanged.
2. **Attachments use Cloudinary, not Supabase Storage** (unsigned uploads). Staging for the import
   agent is unaffected: it will use a **new private Supabase Storage bucket `import-staging`**,
   which is a fresh, self-contained addition.
3. **`users.section` CHECK was dropped** when option lists became editable; the users' section is
   validated by the app only. The import functions must treat `users.section` as authoritative
   but still verify it exists in `app_options`.
4. **Table count of patients columns is 24** (22 in `CREATE TABLE` + `attachments` +
   `registered_by_name` added by idempotent `ALTER`s). The registry covers 17 importable columns;
   the other 7 are app-managed and allow-listed in the CI check. (M2 adds an 8th app-managed
   column, `import_batch_id`.)
5. **`anysearch` is a computed field** over every patient column. M7's soft-delete regression must
   keep it consistent with the new `deleted_at` filter.
6. **CI already applies schema and builds** (`ci.yml`, `supabase-schema.yml`, `deploy-functions.yml`).
   M0 wires Vitest and the registry/schema check into `ci.yml`; no new workflow files.

## 5. Decision-log additions (extend §19.1 of the spec)

| # | Decision | Why |
|---|---|---|
| D15 | Registry keys **equal column names**: `date_of_birth`, `solution` (spec's illustrative `dob`/`diagnosis` are renamed). | One schema (I4); the registry→RPC mapping loses its last special cases; CI check is an exact set comparison. |
| D16 | Governorate values are the app's existing 27 **English** list entries; Arabic matched via alias table. | Matches what the form already stores; no data migration. |
| D17 | Unstated `children_count` imports as `NULL`, not `0`. | DB has no default; `0` would be a silent assertion. Empty stays empty (I9). |
| D18 | Import staging uses a new private Supabase Storage bucket; attachments stay on Cloudinary. | Cloudinary is unsigned/browser-side; staging needs RLS + service-role cleanup. |
| D19 | `PHONE_STORAGE_FORMAT = 'local'` (`01xxxxxxxxx`). | Confirmed from v1 behaviour and validators (Q2). |

## 6. Defaults assumed by `limits.js` (Appendix B)

Every tunable lives in `supabase/functions/_shared/import-core/limits.js` exactly once. Deployment
overrides come from an `import_settings` row in M2; nothing in this list is duplicated elsewhere.
