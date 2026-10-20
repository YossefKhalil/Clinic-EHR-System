# AI settings and ordered provider fallback

Status: implemented on `ai-import-rebuild`. The database migration and the
updated Edge Functions are not deployed yet, so the hosted preview cannot load
or run this path until the owner approves the shared-project deploy.

## What the settings page now owns

- One server-only `ai_settings` row. The browser never reads the table and
  never receives a secret.
- Three separately stored credential sets: OpenRouter, Cloudflare and an
  OpenAI-compatible endpoint.
- One ordered `model_chain` list. Every row is `{ provider, model }`, rows can
  mix providers, and the first row is the primary.
- `enabled` remains the import-agent feature flag. It now also requires at
  least one complete chain row before it can be saved as on.

`provider` and `model` remain on the row for older deployed functions and for
rows written before this change. Saving a chain copies its first entry into
those columns. Saving an intentionally empty chain clears the legacy model so
status cannot synthesize a row the admin removed.

## Credential rules

- Secrets are AES-GCM encrypted under `AI_SETTINGS_ENC_KEY`, using a fresh IV.
  Decryption failures are `DECRYPT_FAILED`; a missing server key is
  `ENCRYPTION_KEY_MISSING`.
- A blank secret field keeps the stored secret. An explicit clear flag removes
  it. Typing a new secret clears the flag in the browser.
- A provider key referenced by a chain row cannot be removed. The save returns
  `PROVIDER_IN_USE` with the provider id.
- OpenAI-compatible credentials are ready with only a base URL. Its key is
  optional for local endpoints.
- Status returns only `configured`, `healthy`, `code`, `hasKey`, the Cloudflare
  account id and the OpenAI base URL. Keys are never echoed.
- Save and credential-test actions are super-admin only and are audited.

## Fallback semantics

`import-job` decrypts the ordered chain before extraction. Entries that are not
ready are skipped with a logged reason and the first ready entry runs. If no
entry is ready, start and pump fail explicitly instead of pretending a provider
is down.

For each chunk:

| Provider verdict | What happens |
|---|---|
| `failed` | Try the next ready entry. This includes provider errors, auth errors, timeouts and parse failures. |
| `ok` | Stop. Keep the chunk, including any rejected documents in the review tray. |
| `ok` with `rejected` documents | Stop. A schema repair failure is not a provider failure. |
| `truncated` | Stop and split the chunk. |
| `cancelled` | Stop and requeue the chunk. |
| Every entry `failed` | Mark the chunk failed with the last error code. Usage and cost from every attempt are aggregated. |
| No ready entry | Fail start or pump with `NOT_CONFIGURED`, `DECRYPT_FAILED`, `ENCRYPTION_KEY_MISSING` or `FEATURE_DISABLED`. |

Only `status === 'failed'` advances the chain. Successful, truncated and
cancelled results never fall through to another provider.

Usage from failed attempts is added to the winning result. If every provider
fails, the final failed result carries the aggregate and `persistChunkResult`
now records it. This was a real silent gap: failed results previously wrote
their token counts to the chunk row but did not call `import_bump_tokens` or
insert `ai_usage`, so a chain that exhausted every provider undercounted the
job cap and the daily cap.

## Silent failures and edge cases

These are reported deliberately, not hidden behind a successful UI.

1. **Unready chain entries are skipped, not surfaced in the import bar.** The
   settings tab and provider health show the problem, and the server logs the
   skipped provider/model/reason. A job can still run on a later entry while
   the primary is unhealthy.
2. **Provider tests do not prove a model id.** They check credentials against a
   cheap endpoint (`/key`, Cloudflare model search, `/models`). A typo in a
   model id passes the test and fails during extraction.
3. **Cloudflare is text-only.** An image request fails with
   `IMAGES_UNSUPPORTED`, and the chain then tries the next provider. A fallback
   can therefore mask a model or modality mismatch until logs are read.
4. **A failed auth on one provider advances to the next provider.** That is
   correct for mixed-provider chains, but it means one bad key can produce
   repeated attempts before the chain settles.
5. **Settings are read again on every pump.** Editing or disabling the chain
   while a job is extracting affects the next pump. `config.model_chain` on the
   job is a snapshot for diagnostics, not the runtime source.
6. **Disabling the feature mid-job does not cancel the job.** The next pump
   returns `FEATURE_DISABLED`; the job remains `extracting` until the user
   cancels or the feature is re-enabled.
7. **A missing `AI_SETTINGS_ENC_KEY` is a global warning.** It is accurate for
   encrypted keys, but a keyless OpenAI-compatible endpoint can still work. Saves
   that would leave existing encrypted keys in place are blocked until the key
   is restored or the stored secrets are cleared.
8. **Provider endpoints can be rate-limited or unreachable.** A failed test is
   not proof that extraction will fail, and a passing test is not proof that the
   chosen model will answer.
9. **OpenAI-compatible base URLs are treated as a base, not a full endpoint.**
   The test appends `/models`; a URL that already ends in `/models` fails the
   test. The extraction adapter also expects a base path.
10. **Legacy rows with a stored provider key and the old default model can still
    display that model.** It is the model the old single-provider code actually
    used. New saves clear the legacy model when the chain is empty.
11. **The old deployed `import-job` predates the `enabled` action.** Until it is
    redeployed, the import entry fails open in the preview.
12. **The new `ai-settings` function is not deployed.** The Settings card will
    show its explicit load error, with a retry, until the function is deployed.
13. **`model_chain` is not applied to the hosted database.** A hosted save or
    pump cannot use the chain until the schema migration is applied.
14. **The deploy workflow only auto-deploys from `master`.** A manual
    `workflow_dispatch` can deploy this branch, but it writes to the shared
    Supabase project and needs owner approval.
15. **The chain is capped at 8 entries.** Duplicate provider/model pairs,
    partial rows, unknown providers and missing credentials are rejected on
    save. The runtime parser drops malformed stored entries instead of crashing
    a pump.
16. **One `ai_usage` row is written per chunk, not per attempt.** The row uses
    the winning or final model and the aggregated token/cost total. Per-attempt
    provider attribution is available only in logs, not in the usage table.

## Verification on this branch

- `npm run lint`
- `npm test`
- `npm run build`
- `npm run check:registry`
- `deno check supabase/functions/ai-settings/index.ts`
- Browser checks with mocked settings state: EN/AR and RTL, tab switching,
  add/remove/reorder, validation messages, unreadable-key warning, and load
  failure independence from the option lists.

The full extraction path still needs the schema and both Edge Functions on the
hosted project plus real provider credentials.
