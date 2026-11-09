#!/usr/bin/env bash
# Container entrypoint for the hosted staging/demo (Dockerfile).
#
#  - builds the restricted `ufuq_app` connection from the owner connection
#    (the running API never connects as the owner — AD-03);
#  - applies migrations and the reference seed (idempotent, every boot);
#  - starts the API (:4000), the web app (:3000) and the relay on $PORT;
#  - with DEMO_SEED=true, seeds the demo company once, through the API.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${DATABASE_MIGRATION_URL:?owner connection string (Neon) is required}"
: "${UFUQ_APP_DB_SECRET:?a generated secret for the ufuq_app role is required}"

# Hex, so it is URL- and SQL-safe without escaping.
UFUQ_APP_DB_PASSWORD="$(printf '%s' "$UFUQ_APP_DB_SECRET" | sha256sum | cut -d' ' -f1)"
export UFUQ_APP_DB_PASSWORD
DATABASE_URL="$(node -e '
const u = new URL(process.env.DATABASE_MIGRATION_URL);
u.username = "ufuq_app";
u.password = process.env.UFUQ_APP_DB_PASSWORD;
console.log(u.toString());
')"
export DATABASE_URL
export API_PORT=4000 WEB_ORIGIN="${PUBLIC_ORIGIN:-$WEB_ORIGIN}"
NEXT_PORT="${NEXT_PORT:-3000}"

# The SECURITY DEFINER login lookups run as the owner under FORCE ROW LEVEL
# SECURITY, so the owner must be a superuser or have BYPASSRLS.
(cd packages/db && node -e '
const { Client } = require("pg");
const c = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
c.connect()
  .then(() => c.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"))
  .then(({ rows }) => {
    console.log(`Database owner: superuser=${rows[0].rolsuper} bypassrls=${rows[0].rolbypassrls}`);
    return c.end();
  });
') || echo "Could not inspect the database owner role."

echo "Applying migrations…"
(cd packages/db && ./node_modules/.bin/prisma migrate deploy)
echo "Seeding reference data…"
(cd packages/db && ./node_modules/.bin/tsx prisma/seed.ts)
node deploy/hosted/ensure-bucket.mjs || echo "Storage bucket check failed — uploads unavailable until storage is reachable."

pids=()
(cd apps/api && exec node --max-old-space-size="${NODE_HEAP_MB:-200}" dist/main.js) &
pids+=($!)
(cd apps/web && NODE_OPTIONS="--max-old-space-size=${NODE_HEAP_MB:-200}" exec ./node_modules/.bin/next start -H 127.0.0.1 -p "$NEXT_PORT") &
pids+=($!)
node deploy/hosted/relay.mjs "${PORT:-10000}" "$NEXT_PORT" 0.0.0.0 &
pids+=($!)

if [ "${DEMO_SEED:-false}" = "true" ]; then
  for _ in $(seq 1 90); do
    node -e 'fetch("http://127.0.0.1:4000/api/v1/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' && break
    sleep 2
  done
  (cd apps/api && DEMO_API_URL=http://127.0.0.1:4000 node scripts/demo-seed.mjs) || echo "Demo seed failed — see above."
fi

# Exit (and let the platform restart the container) if any process dies.
wait -n "${pids[@]}"
echo "A process exited; stopping the container."
kill "${pids[@]}" 2>/dev/null || true
exit 1
