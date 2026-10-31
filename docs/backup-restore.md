# Backup and restore

Clinic EHR has two independent data stores and therefore two backups.

| Store | What is backed up | Workflow | Retention |
| --- | --- | --- | --- |
| Supabase Postgres | Every schema (`pg_dump -Fc`) | `supabase-backup.yml` | 30 daily encrypted artifacts |
| Cloudinary | Original attachment bytes + manifest | `cloudinary-backup.yml` | 30 weekly encrypted artifacts |

Both archives are symmetric GPG encrypted with `BACKUP_PASSPHRASE`. Store a
copy of that passphrase offline; without it every archive is unreadable. The
GitHub artifacts are short-lived working copies, not the long-term backup.

## Private long-term storage

Free Supabase has no point-in-time recovery. A 30-day artifact window is not a
retention plan. Copy each new archive to private storage (a private bucket,
private repository, or encrypted external drive) on a schedule that matches the
clinic's retention policy.

**Never** push a database or attachment archive to a branch of this public
repository. The old commented `backups` branch in `supabase-backup.yml` is
deliberately not enabled for that reason.

Suggested schedule:

- daily database dump: keep 30 days in Actions, copy the first of each month to
  private storage;
- weekly Cloudinary archive: keep 30 days in Actions, copy the first of each
  month to private storage;
- check the restore drill job at least monthly, not only when a restore is
  needed.

## Automated restore drill

`restore-drill.yml` runs after every successful database backup. It downloads
the encrypted dump, starts a throwaway Postgres 16 container, creates the
minimal `auth.users` / `auth.uid()` / role stubs that the public schema
references, restores with `--schema=public --disable-triggers`, then runs
`supabase/verify-schema.sql` and counts patients. A backup that cannot be
restored fails this workflow.

The drill covers the application schema and data. Supabase Auth users are
covered by the full dump but are not restored into the throwaway database; for
a real disaster, restore into a new Supabase project so the auth schema and
platform roles already exist.

Trigger it manually from **Actions → Backup restore drill → Run workflow**.

## Manual database restore

1. Download the desired artifact from the backup run.
2. Decrypt it:

   ```bash
   printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes \
     --pinentry-mode loopback --passphrase-fd 0 \
     --decrypt backup-YYYY-MM-DD.dump.gpg > backup.dump
   ```

3. Restore into a fresh Supabase project (not over the production database):

   ```bash
   pg_restore --no-owner --no-acl --clean --if-exists \
     --dbname "$NEW_SUPABASE_DB_URL" backup.dump
   ```

4. Apply/verify the schema and spot-check data:

   ```bash
   psql "$NEW_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/verify-schema.sql
   psql "$NEW_SUPABASE_DB_URL" -c 'select count(*) from public.patients;'
   psql "$NEW_SUPABASE_DB_URL" -c 'select count(*) from public.app_options;'
   ```

5. Sign in with a real account, open a patient with attachments, and confirm
   the RLS section boundaries still hold.

The dump contains the `auth` schema as well, so a restore into a new Supabase
project preserves sign-in users. Do not restore over a live project without a
maintenance window and a fresh backup of that project.

## Cloudinary restore

The Cloudinary backup contains the original bytes under
`<resource_type>/<delivery_type>/<public_id>` and a `manifest.json` with the
SHA-256 of every file.

1. Download and decrypt the weekly archive:

   ```bash
   printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes \
     --pinentry-mode loopback --passphrase-fd 0 \
     --decrypt cloudinary-backup-YYYY-MM-DD.tar.gz.gpg | tar -xzf -
   ```

2. Check `manifest.json` for entries with `backup_error`; those assets need a
   manual export from the Cloudinary console before they are lost.
3. Re-upload each file with its original `public_id` and delivery type
   (`authenticated` for patient files). Preserve the folder prefix
   `clinic-ehr/...` and use `overwrite=true`; otherwise new public IDs will not
   match the `attachments` JSON in the database.
4. Verify a sample by opening the record in the app and comparing its size and
   checksum with the manifest.

## Cloudinary console settings

- **Backup storage:** off. The database metadata and the encrypted attachment
  archive are the backup.
- **Usage alert:** about 70% of the shared credit pool. Compression and small
  signed variants reduce the normal burn rate, but the alert is the early
  warning before uploads or transformations start failing.
- **PDF delivery:** allow PDF/ZIP delivery on free product environments (see
  the main README); without it PDFs upload but cannot be opened.

## Why keep-alive now queries the database

The old workflow called `/auth/v1/health`, which answers even when the Postgres
project itself is paused. `keep-alive.yml` now queries `app_options` through
PostgREST, so a failed DB query fails the workflow. The
monthly activity workflow writes one timestamp line, so GitHub does not disable
the scheduled workflows after 60 days without repository activity.
