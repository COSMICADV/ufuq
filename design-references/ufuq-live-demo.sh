#!/usr/bin/env bash
# UFUQ live demo over a Cloudflare Quick Tunnel (no account, no card, no domain).
#
# Starts local PostgreSQL + Redis (demo data in ~/ufuq-demo), opens a Quick
# Tunnel to the web app, then starts the API and builds/starts the web app for
# that tunnel's https://*.trycloudflare.com URL. The browser reaches the API
# through the same URL (/api/v1 is forwarded by the web app to the local API).
#
# Run:   bash ufuq-live-demo.sh      Stop: Ctrl-C (stops API, web and tunnel).
# The Quick Tunnel URL changes every time this script starts.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/ufuq-main" && pwd)"
DATA="$HOME/ufuq-demo"
LOGS="$DATA/logs"
PG=/opt/homebrew/opt/postgresql@16/bin
REDIS=/opt/homebrew/opt/redis/bin
API_PORT=4100
WEB_PORT=3100
RELAY_PORT=3099
export LC_ALL=en_US.UTF-8
mkdir -p "$LOGS" /tmp/ufq

pids=()
cleanup() {
  echo; echo "Stopping demo…"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

# 1. Database and Redis (kept running between demos).
if ! "$PG/pg_isready" -h 127.0.0.1 -p 55432 >/dev/null 2>&1; then
  "$PG/pg_ctl" -D "$DATA/pg" -o "-p 55432 -k /tmp/ufq" -l "$LOGS/postgres.log" start
fi
if ! "$REDIS/redis-cli" -p 56379 ping >/dev/null 2>&1; then
  "$REDIS/redis-server" --port 56379 --daemonize yes --dir "$DATA"
fi

# 2. Quick Tunnel → relay (drops X-Forwarded-Proto) → web app.
node "$(dirname "$0")/ufuq-tunnel-relay.mjs" "$RELAY_PORT" "$WEB_PORT" >"$LOGS/relay.log" 2>&1 &
pids+=($!)
: > "$LOGS/tunnel.log"
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$RELAY_PORT" >"$LOGS/tunnel.log" 2>&1 &
pids+=($!)
URL=""
for _ in $(seq 1 60); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGS/tunnel.log" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "Tunnel did not start — see $LOGS/tunnel.log"; exit 1; }
echo "Tunnel: $URL"

# 3. API (staging mode: Secure cookies, HTTPS via the tunnel).
#    Hops: cloudflared → relay → Next.js rewrite → API.
(
  cd "$REPO/apps/api"
  TRUST_PROXY_HOPS=3 NODE_ENV=staging \
    DATABASE_URL=postgresql://ufuq_app:localStagingAppPw_123456@127.0.0.1:55432/ufuq \
    REDIS_URL=redis://127.0.0.1:56379 \
    STORAGE_ENDPOINT=http://127.0.0.1:59000 STORAGE_REGION=us-east-1 STORAGE_BUCKET=ufuq-staging \
    STORAGE_ACCESS_KEY_ID=local STORAGE_SECRET_ACCESS_KEY=local-secret \
    SMTP_HOST=127.0.0.1 SMTP_PORT=1025 MAIL_FROM="Ufuq Demo <no-reply@ufuq.local>" \
    API_PORT=$API_PORT WEB_ORIGIN="$URL" \
    exec node dist/main.js
) >"$LOGS/api.log" 2>&1 &
pids+=($!)

# 4. Web app, built for this tunnel URL.
echo "Building the web app for $URL …"
(
  cd "$REPO"
  NEXT_PUBLIC_API_ORIGIN="$URL" API_PROXY_TARGET="http://127.0.0.1:$API_PORT" WEB_ORIGIN="$URL" \
    pnpm turbo run build --filter=@ufuq/web... >"$LOGS/web-build.log" 2>&1
)
(
  cd "$REPO/apps/web"
  PORT=$WEB_PORT WEB_ORIGIN="$URL" exec ./node_modules/.bin/next start -H 127.0.0.1
) >"$LOGS/web.log" 2>&1 &
pids+=($!)

for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:$WEB_PORT/" 2>/dev/null && break
  sleep 1
done

cat <<EOF

UFUQ LIVE DEMO
  Public website : $URL/
  Login          : $URL/login
  Admin ERP      : $URL/admin
  Employee app   : $URL/app
Logs: $LOGS   — keep this window open; Ctrl-C stops the demo.
EOF
echo "$URL" > "$DATA/current-url.txt"
wait
