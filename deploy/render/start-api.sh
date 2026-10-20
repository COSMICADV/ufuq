#!/usr/bin/env bash
# Render staging start command for apps/api (see render.yaml and
# deploy/render/README.md). Runs from the repository root.
#
# 1. Builds the two database URLs from the parts Render provides: the owner
#    connection (migrations, seeding) and the restricted `ufuq_app` role the
#    API itself must use (AD-03 — the running API never connects as the owner).
# 2. Applies migrations and the reference seed (idempotent; every boot).
# 3. Makes sure the storage bucket exists.
# 4. Starts the API; on the first boot of an empty database it also seeds the
#    staging demo company through the running API (DEMO_SEED=true).
set -euo pipefail

: "${DATABASE_MIGRATION_URL:?owner connection string is required}"
: "${UFUQ_APP_DB_SECRET:?generated ufuq_app secret is required}"
: "${DB_HOST:?}" "${DB_PORT:?}" "${DB_NAME:?}"

# Render generates base64 secrets; the role password is their SHA-256 in hex
# so it is URL- and SQL-safe without escaping.
UFUQ_APP_DB_PASSWORD="$(printf '%s' "$UFUQ_APP_DB_SECRET" | sha256sum | cut -d' ' -f1)"
export UFUQ_APP_DB_PASSWORD

export DATABASE_URL="postgresql://ufuq_app:${UFUQ_APP_DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
export API_PORT="${PORT:-4000}"
if [ -n "${WEB_HOST:-}" ] && [ -z "${WEB_ORIGIN:-}" ]; then
  export WEB_ORIGIN="https://${WEB_HOST}"
fi

# The SECURITY DEFINER login lookups run as the owner under FORCE ROW LEVEL
# SECURITY, so the owner must be a superuser or have BYPASSRLS (README).
(cd packages/db && node -e '
const { Client } = require("pg");
const c = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
c.connect()
  .then(() => c.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"))
  .then(({ rows }) => {
    const r = rows[0];
    console.log(`Database owner: superuser=${r.rolsuper} bypassrls=${r.rolbypassrls}`);
    if (!r.rolsuper && !r.rolbypassrls) console.log("WARNING: owner cannot bypass RLS; logins will fail.");
    return c.end();
  });
') || echo "Could not inspect the database owner role."

echo "Applying migrations…"
(cd packages/db && ./node_modules/.bin/prisma migrate deploy)
echo "Seeding reference data…"
(cd packages/db && ./node_modules/.bin/tsx prisma/seed.ts)

node deploy/render/ensure-bucket.mjs || echo "Storage bucket check failed — uploads will be unavailable until storage is reachable."

cd apps/api
node dist/main.js &
api_pid=$!

if [ "${DEMO_SEED:-false}" = "true" ]; then
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${API_PORT}/api/v1/health" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  DEMO_API_URL="http://127.0.0.1:${API_PORT}" node scripts/demo-seed.mjs || echo "Demo seed failed — see the log above."
fi

wait "$api_pid"
