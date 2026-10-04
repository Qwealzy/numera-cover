#!/usr/bin/env bash
# numera-update: pull the latest public code (engine + deployments files), refresh the engine install, restart the
# services, wait for /health. Run as root: sudo numera-update   (NUMERA_REF=<branch or tag>, default main)
set -euo pipefail
APP_USER=numera
INSTALL_DIR=/opt/numera
REF="${NUMERA_REF:-main}"
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }

before="$(runuser -u "$APP_USER" -- git -C "$INSTALL_DIR" rev-parse --short HEAD)"
runuser -u "$APP_USER" -- git -C "$INSTALL_DIR" fetch --prune origin "$REF"
runuser -u "$APP_USER" -- git -C "$INSTALL_DIR" merge --ff-only FETCH_HEAD \
  || { echo "cannot fast-forward: the checkout has local changes. Look at: git -C $INSTALL_DIR status" >&2; exit 1; }
after="$(runuser -u "$APP_USER" -- git -C "$INSTALL_DIR" rev-parse --short HEAD)"
echo "code: $before -> $after"
runuser -u "$APP_USER" -- "$INSTALL_DIR/engine/.venv/bin/python" -m pip install -q -e "$INSTALL_DIR/engine"

# the units may have changed in the repo (e.g. CacheDirectory=): reinstall them from the checkout's kit, reload systemd
KIT="$INSTALL_DIR/deploy/vps"
if [ -f "$KIT/numera-engine.service" ] && [ -f "$KIT/numera-keeper.service" ]; then
  install -m 0644 "$KIT/numera-engine.service" /etc/systemd/system/numera-engine.service
  install -m 0644 "$KIT/numera-keeper.service" /etc/systemd/system/numera-keeper.service
  install -m 0755 "$KIT/preflight.sh" /usr/local/lib/numera/preflight.sh
  install -m 0755 "$KIT/status.sh" /usr/local/sbin/numera-status
  install -m 0755 "$KIT/update.sh" /usr/local/sbin/numera-update   # install replaces the file; this run is unaffected
  install -m 0644 "$KIT/numera-tunnel.service" /etc/systemd/system/numera-tunnel.service
fi
# the hot-fix drop-in (ReadWritePaths=/opt/numera/engine/.cache) is superseded by CacheDirectory=: remove it
for u in numera-engine numera-keeper; do
  rm -f "/etc/systemd/system/$u.service.d/cache.conf" "/etc/systemd/system/$u.service.d/cache-rw.conf"
  rmdir "/etc/systemd/system/$u.service.d" 2>/dev/null || true
done
systemctl daemon-reload

systemctl restart numera-engine numera-keeper
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:8000/health >/dev/null 2>&1; then
    echo "engine healthy after ${i}s"
    systemctl is-active numera-engine numera-keeper numera-tunnel || true
    exit 0
  fi
  sleep 1
done
echo "engine did not become healthy in 30 s. Read: journalctl -u numera-engine -n 50 --no-pager" >&2
exit 1
