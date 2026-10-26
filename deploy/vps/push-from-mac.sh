#!/usr/bin/env bash
# Copy this repository from your Mac to the server (no GitHub access needed on
# the server). Re-run it to ship updates; the server's .env, certs/ and
# backups/ are never overwritten.
#
#   bash deploy/vps/push-from-mac.sh ubuntu@<SERVER_IP> [~/.ssh/oracle_key]
#
# Then on the server:  cd ~/ufuq/deploy/vps && docker compose up -d --build
set -euo pipefail

TARGET="${1:?usage: push-from-mac.sh ubuntu@<SERVER_IP> [ssh-key]}"
KEY="${2:-}"
SSH="ssh"
[ -n "$KEY" ] && SSH="ssh -i $KEY"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

rsync -az --delete -e "$SSH" \
  --exclude node_modules --exclude .next --exclude dist --exclude .turbo \
  --exclude '*.tsbuildinfo' --exclude .git --exclude .DS_Store \
  --exclude .env --exclude 'deploy/vps/.env' \
  --exclude 'deploy/vps/certs' --exclude 'deploy/vps/backups' \
  --exclude product-documentation --exclude design-references \
  "$REPO/" "$TARGET:ufuq/"

echo "Copied to $TARGET:~/ufuq"
