# Backup and restore (free tier)

Supabase free tier has **no backups and no point-in-time recovery**. This project
ships a nightly encrypted backup workflow to compensate:

- `.github/workflows/keep-alive.yml` — daily ping so the free project is never
  paused after 7 days of inactivity (pre-existing).
- `.github/workflows/supabase-backup.yml` — nightly `pg_dump`, encrypted with
  gpg (AES256), stored as a GitHub Actions artifact for 30 days.

## Repository secrets used

| Secret | Where it comes from |
|---|---|
| `SUPABASE_DB_URL` | Already configured for the schema workflow. Direct connection string (port 5432). |
| `BACKUP_PASSPHRASE` | Set this yourself. Store a copy offline (password manager / safe). **Losing it makes every backup unreadable.** |

Values are write-only in GitHub: nobody — including GitHub Actions logs — can
read them back after saving. The workflow fails with a clear message when either
secret is missing.

## Restore

```bash
# Decrypt first (enter the passphrase when prompted)
gpg --output backup-2026-01-01.dump --decrypt backup-2026-01-01.dump.gpg

# Then restore into a THROWAWAY database first
DATABASE_URL="postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" \
  ./scripts/restore-supabase.sh backup-2026-01-01.dump
```

`--clean` drops existing objects, so verify against a throwaway project before
touching production. Re-run `supabase/schema.sql` afterwards if policies or
triggers need repairing.

## Limits to know

- GitHub artifacts: 500 MB free, 30-day default retention (max 90 days).
- Free Supabase DB: 500 MB max — a dump is at most that size, so artifacts fit.
- For retention beyond 30 days, uncomment the "Push to backups branch" step
  (private repo only) or upload dumps to storage you control.
- A backup you have never restored is not a backup: drill a restore at least
  once into a throwaway project.
- Schema is versioned in `supabase/schema.sql` — keep it committed.

## Recommended upgrade

Once patient/charity records become irreplaceable, move Supabase to **Pro
($25/mo)**: no auto-pause, daily backups with 7-day retention, 8 GB DB,
250 GB egress.
