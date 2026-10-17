# M4 — Extraction pipeline

| | |
|---|---|
| **Status** | Complete except the real-model run of fixture #1, which needs a hosted project and credentials (checklist in §10; M5 wires the UI that starts such a run) |
| **Spec** | §7.1–7.7 (providers, requests, YAML contract, parsing, repair, prompts), §9.3–9.5 (rows, pump), §13.5–13.6 (caps, secrets), §14.1/14.3 (layout, function API), Appendix A |
| **Exit criteria** | Chaos tests with a fake provider pass; cancel stops billing; resume after tab close works (lease reclaim covered in M2); fixture #1 with a real model — deferred, see §10 |

The pipeline never reads a clock on its own: `import-job` passes the server's `today` into `runPipeline`,
exactly like the fixture tests do. Everything under `_shared/import-core/` stays plain ESM; the LLM,
database and crypto edges live in `_shared/llm/`, `_shared/ai-settings.ts` and `functions/import-job/`.

## 1. Module layout

| Module | Responsibility |
|---|---|
| `_shared/import-core/yaml-contract.js` | Prompt builders (A.1 extractor, A.2 transcriber, A.3 repair note), the random delimiter, `parseContract` (spec §7.4–7.5) |
| `_shared/import-core/chunker.js` | Moved here from `src/features/import-agent/` (that path now re-exports it) so the function can chunk pasted text and split chunks; adds `splitChunkPayload` and `shiftSourceIds` |
| `import-extract/run-chunk.js` | One chunk end to end: request → provider call → parse → one repair call → verdict with usage, model and rejects. Provider and `js-yaml` are injected |
| `_shared/llm/provider.ts` | `LlmProvider`/`LlmRequest`/`LlmResult` interface, `LlmError` (retryable, Retry-After), `withRetries` |
| `_shared/llm/openai-compatible.ts` | Chat-completions adapter (Ollama/LM Studio/OpenAI), pure body builder, response and error mapping |
| `_shared/llm/openrouter.ts` | OpenAI-compatible shape with `provider.data_collection: 'deny'` and the ordered model fallback |
| `_shared/llm/cloudflare.ts` | Workers AI envelope; text-only this milestone (images → `IMAGES_UNSUPPORTED`, M8 revisits) |
| `_shared/ai-settings.ts` | AES-GCM/HKDF encryption of the `ai_settings` secrets and per-provider validation |
| `import-job/index.ts` | `create | add_source | start | pump | cancel | status | retry_chunk` (spec §14.3) |
| `supabase/schema.sql` | Adds `import_bump_tokens` (atomic usage increment, service-role only) |

## 2. Prompts and requests (spec §7.2, §7.5, §7.7, Appendix A)

- The A.1 text is stored verbatim; only `{field_keys}` and `{field_guide}` are generated from the field
  registry — 15 guide lines (all extracted fields except `notes`, which A.1 explains under LEFTOVERS).
  No example patients appear anywhere, so the model cannot echo phantom rows.
- Prompt ids are versioned and persisted on every chunk: `extractor@2026-10-17.1`, `repair@2026-10-17.1`,
  `transcriber@2026-10-17.1` (A.2, used from M8). A prompt change bumps the id.
- The user message is: staff hints (or `none`, capped at `MAX_HINT_CHARS` by `create`), then the source
  between a **per-request random delimiter** (`<<<SRC-xxxxxx>>>`). The source block carries the repeated
  header line as `HEADER: …` and the pooled `<id> | <content>` lines — the canonical copies the chunker
  already produced.
- `max_tokens` is sized from the chunk (≈300 tokens per expected record) with the 1 000/16 000 floor and
  ceiling, not a fixed value.
- The repair call appends exactly the A.3 note, the per-document parser errors and the invalid documents
  (wrapped in a fresh `<<<BAD-xxxxxx>>>` block) to the original user message, same system message. One
  repair call per chunk, then the result stands.

## 3. Parsing (spec §7.4)

- One stray markdown fence is stripped; output over `YAML_MAX_BYTES` (200 KB, byte length) is rejected
  before parsing with `OUTPUT_TOO_LARGE`.
- Documents are split on `---` lines and each parses **independently** with `FAILSAFE_SCHEMA` (injected
  module) in its own try/catch — one broken document never hides the others. Everything stays a string:
  unquoted national IDs keep their digits and leading zeros, `no` stays `"no"`, dates stay as written.
- Failures per document: parse errors, non-mapping documents, nested mappings in scalar fields, and
  **anchors/aliases/tags at the start of a value** (the alias-expansion vector) are rejected. Text before
  the first `---` is an invalid document too.
- Unknown keys — including `section`, which A.1 never asks for — move into `unmapped` as `"key: value"`;
  the unknown key names are collected for metrics. A scalar `notes` value is wrapped into a list, an
  array `_src` joins with commas.
- `finishReason === 'length'` means the last document may be cut mid-value: it is **dropped** (kept in
  `discarded`), the result is marked `truncated`, and the pump splits the chunk in half (spec §7.4).

## 4. Providers (spec §7.1)

- **Retries** happen only for 429, 5xx and timeouts: exponential backoff (500 ms → 8 s) plus jitter,
  `Retry-After` honoured when it exceeds the computed delay, max **3 attempts per chunk**
  (`PROVIDER_MAX_ATTEMPTS`, renamed from `PROVIDER_MAX_RETRIES` — the value always meant attempts and
  nothing else referenced the old name). Parse/schema failures never retry; they use the repair loop.
- **Timeouts** per call (`PROVIDER_TIMEOUT_MS`, 120 s) via `AbortSignal.timeout` combined with the
  caller's signal; an abort — user cancels, tab closes — aborts the provider request itself, so billing
  stops.
- **OpenRouter** sends `provider: { data_collection: 'deny' }` on every request and accepts a
  comma-separated `model` value as an ordered fallback list: the next model is tried only after a
  model's retries are exhausted on transient failures, never on auth or rejection errors.
- **Cloudflare Workers AI** maps the `{ result: { response, usage } }` envelope; image requests fail
  fast (`IMAGES_UNSUPPORTED`) until M8 designs the vision path.
- **OpenAI-compatible** covers local servers (Ollama/LM Studio) with base URL plus optional key.

## 5. Settings encryption (spec §13.6)

- Format `v1.<iv>.<ciphertext>` (base64), AES-GCM-256 under a key derived with HKDF-SHA256 from the
  dedicated `AI_SETTINGS_ENC_KEY` secret (salt `import-agent/ai-settings/v1`, info `aes-gcm-256`) — never
  from the service-role key. A fresh 96-bit IV per encryption.
- Any decryption failure is an explicit `DECRYPT_FAILED` ("re-enter credentials"), never "no key".
  `readAiSettings` validates the row for its active provider and decrypts exactly the one key needed;
  `enabled: false` or a missing key/model is `FEATURE_DISABLED`/`NOT_CONFIGURED`.
- The `ai_settings` row stays service-role-only (M2), so credentials never reach the browser.

## 6. The `import-job` function (spec §9.5, §14.3)

All actions are JWT-authenticated, then use the service role; every response is `{ ok: true, … }` or
`{ ok: false, code, message_key }` and contains **no patient values** — counts, labels and code only.

| Action | Behaviour |
|---|---|
| `create` | Feature-flag and rate-limit checks (`MAX_CONCURRENT_JOBS`, `JOBS_PER_USER_DAY`; violations → `audit_log` + `429`). Freezes the **active** `app_options` lists into `config.enum_snapshot`, the prompt ids, the resolved limits and provider/model (never secrets) into `config`; sets `token_cap` and `expires_at`; returns signed upload URLs for `<user>/<job>/<idx>-<name>` in `import-staging` |
| `add_source` | Job must be `uploaded`. Accepts prepared chunk payloads (validated shape) or raw pasted `text`, which the server chunks with the shared chunker — pooled ids are shifted to the job's next source number (`shiftSourceIds`). Re-checks `MAX_CHUNKS` and the shared `MAX_ROWS` sheet budget server-side |
| `start` | `uploaded` → `extracting`; requires at least one chunk |
| `pump` | The §9.5 loop: token caps before any call; claims up to `PUMP_PARALLEL` chunks under a 90 s lease; runs them concurrently through `runChunk`; persists via `runPipeline`; returns progress |
| `cancel` | Sets `status = 'cancelled'` + `cancelled_at`; the running pump aborts in-flight provider calls within 2 s |
| `retry_chunk` | Resets one chunk (`queued`, attempts 0) and re-opens the job for extraction |
| `status` | Progress only — no claims, no calls |

Pump details worth naming:

- **Caps**: `tokens_in + tokens_out ≥ token_cap` stops extraction with `status = review` and the
  `JOB_TOKEN_CAP` banner ("keeps what it has"); the daily user cap returns the `USER_DAILY_TOKEN_CAP`
  banner and leaves the job `extracting` (it resumes when the window rolls). Settings problems return
  `FEATURE_DISABLED` / `NOT_CONFIGURED` / `DECRYPT_FAILED` before any call.
- **Rows**: the chunk's documents go through the shared `runPipeline` (same code the browser reruns on
  edits) with the frozen enum snapshot, `defaults`, the server `today` and `requireSection: false`.
  Rows insert with `ON CONFLICT (chunk_id, seq) DO NOTHING` via upsert `ignoreDuplicates` — duplicate
  delivery cannot duplicate rows. Pipeline rejects and unparsable documents land in `import_rejects`
  with the chunk's source lines for the tray.
- **Usage**: every call's usage is added with the `import_bump_tokens` RPC (atomic, so parallel chunks
  cannot lose an increment) and also recorded per call in `ai_usage` with model and cost when reported.
- **Truncation and re-queue**: a truncated chunk or a reconciliation `requeueSplit` marks the parent
  `split` (rows written so far stay) and queues its two children; children are inserted **sequentially**
  after the parallel phase so two splits cannot race for the same `idx`. A one-line chunk that cannot
  split fails with `SPLIT_IMPOSSIBLE`.
- **Stuck chunks**: a chunk whose attempts ran out while leased can never be claimed again; the pump
  marks those `failed` with `MAX_ATTEMPTS` so the job settles to `review` instead of spinning.
- **Cancellation**: the pump watches `cancelled_at` every 2 s and aborts the shared `AbortController`;
  cancelled chunks return to `queued` (no row loss), the response carries `JOB_CANCELLED`.
- **Resume after tab close**: leases expire; the next pump (any tab, later day) reclaims the same
  chunks and skips already-persisted rows via the unique `(chunk_id, seq)` — the M2 reclaim test covers
  the contract.

## 7. Tunables (`limits.js`)

- Added: `JOBS_PER_USER_DAY: 20`, `JOB_TOKEN_CAP: 500_000`, `USER_DAILY_TOKEN_CAP: 2_000_000`;
  `PROVIDER_MAX_ATTEMPTS: 3` (rename above). `MAX_CONCURRENT_JOBS: 2` existed from M1.
- `import_settings.limits` overrides resolve through the same `resolveLimits` and are snapshotted into
  `config.limits` at creation, so a job's behaviour is explainable after the fact.

## 8. i18n

- Four new keys in both locales: `importAgent.warn.JOB_TOKEN_CAP`, `USER_DAILY_TOKEN_CAP`,
  `CHUNKS_FAILED` (`:count`), `JOB_CANCELLED`.
- Action errors return `code` plus `message_key` = `importAgent.error.<CODE>`; the UI's message keys for
  those codes land with the M5 screen, alongside the tray rendering.

## 9. Deviations and decisions

- Raw model responses are **not persisted** in this milestone: the spec's `raw_response_path` column and
  the M2 cleaner already handle their existence and deletion, but writing every completion to storage
  buys little over `extracted`/rejects plus `ai_usage` — revisit if a pilot needs replay.
- The rebuild keeps the OpenAI-compatible request body for OpenRouter (rather than a bespoke shape) so
  the three adapters share one mapper; the only OpenRouter-specific parts are the deny-data-collection
  preference, attribution headers and the model fallback.
- `PROVIDER_TIMEOUT_MS` is a per-call timeout; chunk-level wall-clock safety comes from the lease
  (90 s) plus the split-on-timeout path — a timed-out call retries, then falls to the next model, then
  fails the chunk (never loops past the attempt budget).
- The `retry_chunk` action resets attempts to 0 deliberately: it is a user-initiated manual retry, not
  an automatic one, so it may exceed `MAX_ATTEMPTS` over time.
- Cloudflare's adapter rejects images for now; the M8 image path will decide whether tiling goes
  through a multimodal endpoint or the transcriber prompt (A.2 is already stored).
- `next_label` in pump responses is `c<idx>` against `import_chunks.idx` (job-global chunk order), not
  the per-source `chunk_id` inside the payload — the two numbering schemes exist by design (spec §6.3
  payload versus §9.3 rows) and the UI shows the job-global one.

## 10. Tests and deferred checks

- Suites added: `yaml-contract` (19), `run-chunk` (10), `llm-providers` (17), `ai-settings` (7),
  `import-core-chunker` (4) — 317 tests across 25 files, plus `check:registry`, `eslint src`,
  `vitest run --coverage` (normalizer branch gate stays 100%) and `vite build`.
- Chaos coverage with the fake provider: valid output, fence, repair merge, repair failure, still-bad
  documents, truncation drop-last, oversized output, provider error codes, cancellation before and
  mid-chunk, retry/backoff/Retry-After, model fallback, auth stops the fallback, cloudflare envelope
  and image rejection, key round-trips and tamper detection.
- **Deferred (needs the hosted project)**: the real-model run of fixture #1 through thresholds, which
  mirrors the M2 deployment checklist:
  1. Deploy: `supabase functions deploy import-job`; the worker logic is imported by `import-job`
     (`import-extract/` is not deployed as its own function).
  2. Secrets: add `AI_SETTINGS_ENC_KEY` (new here) alongside M2's `IMPORT_CLEANUP_SECRET`.
  3. Schema: re-run `supabase/schema.sql` (adds `import_bump_tokens`).
  4. Settings: enable the agent, pick a provider/model and store the key with `encryptSecret`.
  5. Then create → add_source (fixture #1) → start → pump to review, and record the §18 M4 numbers.
