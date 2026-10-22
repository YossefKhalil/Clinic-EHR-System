#!/usr/bin/env bash
# Restore a Supabase backup produced by supabase-backup.yml.
#
# Usage:
#   DATABASE_URL="postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" \
#     ./scripts/restore-supabase.sh backup-2026-01-01.dump
#
# WARNING: --clean drops existing objects. Run against an EMPTY or throwaway
# database first. Never restore into production without a dry-run.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi
if [ $# -ne 1 ]; then
  echo "Usage: $0 <backup.dump>" >&2
  exit 1
fi

FILE="$1"
if [ ! -f "$FILE" ]; then
  echo "File not found: $FILE" >&2
  exit 1
fi

echo "Restoring $FILE into $DATABASE_URL ..."
pg_restore \
  --dbname="$DATABASE_URL" \
  --no-owner --no-acl \
  --clean --if-exists \
  --verbose \
  "$FILE"

echo "Restore complete. Re-run supabase/schema.sql if you need to repair policies."
