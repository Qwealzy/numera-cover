#!/usr/bin/env bash
# Numera VPS setup. Run ONCE as root on a fresh Ubuntu 24.04 server (safe to re-run); it starts nothing.
#
#   scp -r deploy/vps root@<server-ip>:/root/numera-vps      (from your laptop, repo root)
#   ssh root@<server-ip>
#   bash /root/numera-vps/setup.sh
#
# What it does: installs python, git, cloudflared; creates the unprivileged user "numera"; checks out the PUBLIC repo
# (no credentials needed) into /opt/numera and installs the engine into a virtualenv there; installs the systemd units,
# the helper commands and an empty env file template at /etc/numera/numera.env (mode 600); enables a firewall that
# allows SSH only (the tunnel needs no inbound port). It never asks for, prints or stores a secret.
#
# Overrides (environment): NUMERA_REPO_URL (default the public repo), NUMERA_REF (branch or tag, default main),
# NUMERA_SKIP_UFW=1 (leave the firewall alone).
set -euo pipefail

REPO_URL="${NUMERA_REPO_URL:-https://github.com/Qwealzy/numera-cover.git}"
REF="${NUMERA_REF:-main}"
APP_USER=numera
INSTALL_DIR=/opt/numera
ETC_DIR=/etc/numera
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (ssh root@<server-ip>, or sudo bash setup.sh)"
for f in numera-engine.service numera-keeper.service numera-tunnel.service numera.env.template preflight.sh \
         update.sh status.sh tunnel-config.sh; do
  [ -f "$KIT_DIR/$f" ] || die "missing $KIT_DIR/$f: copy the whole deploy/vps folder to the server"
done
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  echo "WARNING: written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}; continuing" >&2
fi

say "1/6 system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl git gnupg python3 python3-venv python3-pip ufw

say "2/6 cloudflared (Cloudflare's apt repository)"
install -m 0755 -d /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update -y
apt-get install -y cloudflared

say "3/6 service user and directories"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$INSTALL_DIR"
install -d -o root -g "$APP_USER" -m 0750 "$ETC_DIR"

say "4/6 engine from the public repository ($REPO_URL, $REF)"
if [ -d "$INSTALL_DIR/.git" ]; then
  runuser -u "$APP_USER" -- git -C "$INSTALL_DIR" fetch --prune origin "$REF"
  runuser -u "$APP_USER" -- git -C "$INSTALL_DIR" merge --ff-only FETCH_HEAD
else
  [ -z "$(ls -A "$INSTALL_DIR")" ] || die "$INSTALL_DIR is not empty and not a git checkout"
  runuser -u "$APP_USER" -- git clone --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
fi
if [ ! -x "$INSTALL_DIR/engine/.venv/bin/python" ]; then
  runuser -u "$APP_USER" -- python3 -m venv "$INSTALL_DIR/engine/.venv"
fi
runuser -u "$APP_USER" -- "$INSTALL_DIR/engine/.venv/bin/python" -m pip install --upgrade pip
runuser -u "$APP_USER" -- "$INSTALL_DIR/engine/.venv/bin/python" -m pip install -e "$INSTALL_DIR/engine"
runuser -u "$APP_USER" -- "$INSTALL_DIR/engine/.venv/bin/python" -c \
  'import numera_engine.quote_api, numera_engine.keeper; print("engine imports ok")'

say "5/6 units, helper commands, env file template"
install -d -m 0755 /usr/local/lib/numera
install -m 0755 "$KIT_DIR/preflight.sh" /usr/local/lib/numera/preflight.sh
install -m 0755 "$KIT_DIR/update.sh" /usr/local/sbin/numera-update
install -m 0755 "$KIT_DIR/status.sh" /usr/local/sbin/numera-status
install -m 0755 "$KIT_DIR/tunnel-config.sh" /usr/local/sbin/numera-tunnel-config
for u in numera-engine numera-keeper numera-tunnel; do
  install -m 0644 "$KIT_DIR/$u.service" "/etc/systemd/system/$u.service"
done
if [ -e "$ETC_DIR/numera.env" ]; then
  echo "kept existing $ETC_DIR/numera.env (never overwritten)"
else
  install -m 0600 -o root -g root "$KIT_DIR/numera.env.template" "$ETC_DIR/numera.env"
  echo "created $ETC_DIR/numera.env (mode 600): fill in the two keys with: sudo nano $ETC_DIR/numera.env"
fi
chmod 600 "$ETC_DIR/numera.env"
systemctl daemon-reload
# enabled for boot, NOT started: they refuse to start until the env file has the keys (preflight)
systemctl enable numera-engine.service numera-keeper.service numera-tunnel.service

say "6/6 firewall (SSH only; the Cloudflare Tunnel is outbound-only)"
if [ "${NUMERA_SKIP_UFW:-}" = "1" ]; then
  echo "skipped (NUMERA_SKIP_UFW=1)"
else
  ufw allow OpenSSH
  ufw default deny incoming
  ufw default allow outgoing
  ufw --force enable
fi

cat <<'EOF'

Setup done. Nothing is running yet. Next, in order:
  1. sudo nano /etc/numera/numera.env          (type QUOTE_SIGNER_KEY and KEEPER_KEY, save)
  2. sudo -u numera -H cloudflared tunnel login          (open the printed URL in your browser, pick numeralabs.xyz)
  3. sudo -u numera -H cloudflared tunnel create numera-api
  4. sudo -u numera -H cloudflared tunnel route dns numera-api api.numeralabs.xyz
  5. sudo numera-tunnel-config                  (writes /etc/numera/cloudflared.yml, moves the credentials file)
  6. sudo systemctl start numera-engine numera-keeper numera-tunnel
  7. numera-status ; curl https://api.numeralabs.xyz/health
See deploy/vps/README.md for details.
EOF
