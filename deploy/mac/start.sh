#!/usr/bin/env bash
# Start (or update) UFUQ on this Mac and publish it on the domain.
#   bash deploy/mac/start.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker Desktop, open it once, then run this again."; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop is not running. Open Docker Desktop, wait until it says 'running', then run this again."; exit 1
fi

gen() { openssl rand -hex 24; }
if [ ! -f .env ]; then
  cat > .env <<ENV
UFUQ_DOMAIN=1to1os.com
POSTGRES_PASSWORD=$(gen)
UFUQ_APP_DB_SECRET=$(gen)
MINIO_ROOT_USER=ufuq
MINIO_ROOT_PASSWORD=$(gen)
DEMO_SEED=true
NODE_HEAP_MB=512
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_SECURE=false
MAIL_FROM=Ufuq <no-reply@1to1os.com>
BACKUP_KEEP_DAYS=14
BACKUP_HOUR_UTC=1
TUNNEL_TOKEN=
ENV
  chmod 600 .env
  echo "Created deploy/mac/.env with new random secrets."
fi

extract_token() { tr '\n' ' ' | sed -E 's/.*--token[[:space:]]+([^[:space:]]+).*/\1/; s/[[:space:]]//g'; }

if ! grep -q '^TUNNEL_TOKEN=.\{100,\}' .env; then
  TOKEN=""
  # 1) Take it from the clipboard (Cloudflare's copy button puts the whole docker command there).
  CLIP="$(pbpaste 2>/dev/null || true)"
  if printf '%s' "$CLIP" | grep -q -- '--token'; then
    TOKEN="$(printf '%s' "$CLIP" | extract_token)"
    echo "Took the tunnel token from the clipboard."
  fi
  # 2) Otherwise ask for it.
  if [ "${#TOKEN}" -lt 100 ]; then
    echo
    echo "Paste the Cloudflare Tunnel token (or the whole docker command), then press Enter:"
    read -r INPUT
    TOKEN="$(printf '%s' "$INPUT" | extract_token)"
  fi
  if [ "${#TOKEN}" -lt 100 ]; then
    echo "No valid tunnel token found. In Cloudflare press the copy button next to 'docker run cloudflare/cloudflared…', then run this again."; exit 1
  fi
  grep -v '^TUNNEL_TOKEN=' .env > .env.tmp && printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" >> .env.tmp && mv .env.tmp .env
  chmod 600 .env
  echo "Token saved."
fi

# A tunnel started by hand with 'docker run' would compete with the stack's one.
for c in $(docker ps -q --filter ancestor=cloudflare/cloudflared:latest); do
  if [ -z "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c")" ]; then
    docker rm -f "$c" >/dev/null && echo "Stopped a hand-started tunnel container."
  fi
done

mkdir -p backups
echo "Building and starting UFUQ (first time takes 10–20 minutes)…"
docker compose up -d --build

# Keep the Mac awake while plugged in, so the site stays online.
pgrep -x caffeinate >/dev/null || (nohup caffeinate -dims >/dev/null 2>&1 &)

echo
echo "Started. Status:    docker compose -f deploy/mac/docker-compose.yml ps"
echo "Local check:        http://localhost:8080"
echo "Public:             https://1to1os.com"
