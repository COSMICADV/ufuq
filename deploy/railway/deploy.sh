#!/usr/bin/env bash
# Upload this repository from the Mac to the Railway service "app" and build it there
# (the repository's Dockerfile). Run from anywhere:
#   bash deploy/railway/deploy.sh
# First run: signs in to Railway in the browser and asks which project to link.
set -euo pipefail
cd "$(dirname "$0")/../.."

RW="railway"
if ! command -v railway >/dev/null 2>&1; then
  if command -v npx >/dev/null 2>&1; then RW="npx -y @railway/cli@latest"; else
    echo "Install the Railway CLI first:  npm i -g @railway/cli   (or: brew install railway)"; exit 1
  fi
fi

if ! $RW whoami >/dev/null 2>&1; then
  echo "Signing in to Railway (a browser window opens)…"
  $RW login
fi

if ! $RW status >/dev/null 2>&1; then
  echo "Choose the Railway project 'ufuq' (and the 'production' environment):"
  $RW link
fi

echo "Uploading and building on Railway (first build takes several minutes)…"
$RW up --service app --detach
echo
echo "Uploaded. Follow the build in the Railway dashboard → app → Deployments."
