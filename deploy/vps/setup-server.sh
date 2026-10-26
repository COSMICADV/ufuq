#!/usr/bin/env bash
# One-time server preparation on Oracle Cloud Ubuntu 24.04 (ARM, Ampere A1).
# Run on the server, from the repository's deploy/vps folder:
#   sudo bash setup-server.sh
#
#  1. Installs Docker Engine + the Compose plugin.
#  2. Creates .env with fresh random secrets (kept if it already exists).
#  3. Creates certs/ and backups/.
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash setup-server.sh"; exit 1
fi
TARGET_USER="${SUDO_USER:-ubuntu}"

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker…"
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
usermod -aG docker "$TARGET_USER"
# Keep container logs from filling the disk.
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }' > /etc/docker/daemon.json
  systemctl restart docker
fi

# Ports 80/443: Docker publishes them through its own iptables rules, which
# come before the image's default REJECT, so nothing to change here. Open
# them in the Oracle VCN Security List (see README).

# 2. .env with generated secrets
gen() { openssl rand -hex 24; }
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(gen)/" .env
  sed -i "s/^UFUQ_APP_DB_SECRET=.*/UFUQ_APP_DB_SECRET=$(gen)/" .env
  sed -i "s/^MINIO_ROOT_PASSWORD=.*/MINIO_ROOT_PASSWORD=$(gen)/" .env
  chmod 600 .env
  echo "Created .env with new secrets."
else
  echo ".env already exists — left unchanged."
fi

# 3. Folders
mkdir -p certs backups
chown -R "$TARGET_USER:$TARGET_USER" . 2>/dev/null || true
chmod 700 certs

cat <<EOF

Server ready. Next:
  1. Put the Cloudflare Origin Certificate in $(pwd)/certs/origin.pem
     and its private key in $(pwd)/certs/origin.key
  2. Log out and back in (so '$TARGET_USER' can use docker), then:
       cd $(pwd) && docker compose up -d --build
EOF
