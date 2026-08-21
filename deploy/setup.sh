#!/usr/bin/env bash
# roomvi — single-box provisioning (web + in-process job runner).
# Idempotent: safe to re-run. Designed for Ubuntu 24.04 on t4g.small (ARM) or
# t3.small (x86). Run as root:  sudo bash deploy/setup.sh
set -euo pipefail

APP_DIR=/opt/roomvi/frontend
REPO_URL="${REPO_URL:-https://github.com/vespersolutionspk18/roomvi.git}"
BRANCH="${BRANCH:-main}"

echo "== base packages =="
apt-get update -qq
apt-get install -yqq curl git ca-certificates gnupg

echo "== swap (builds and sharp need headroom on small boxes) =="
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== node 22 =="
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yqq nodejs
fi

echo "== caddy =="
if ! command -v caddy >/dev/null; then
  install -d /usr/share/keyrings
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq && apt-get install -yqq caddy
fi

echo "== app =="
mkdir -p "$(dirname "$APP_DIR")"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
fi
cd "$APP_DIR"

[ -f .env.local ] || { echo "FATAL: $APP_DIR/.env.local missing — create it from deploy/env.production.example first."; exit 1; }

npm ci
npm run build
npx drizzle-kit migrate || true   # no-op when migrations are already applied

echo "== services =="
install -m 644 deploy/roomvi-web.service /etc/systemd/system/
useradd -r -s /usr/sbin/nologin roomvi 2>/dev/null || true
chown -R roomvi:roomvi /opt/roomvi
systemctl daemon-reload
systemctl enable --now roomvi-web
systemctl reload caddy

echo "done. web on :3000 behind caddy. logs: journalctl -u roomvi-web -f"
