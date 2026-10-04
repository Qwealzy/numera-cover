#!/usr/bin/env bash
# numera-tunnel-config: after "cloudflared tunnel create numera-api" (run as the numera user), move the tunnel's
# credentials file to /etc/numera and write /etc/numera/cloudflared.yml: api.numeralabs.xyz -> the engine on loopback.
# Run as root: sudo numera-tunnel-config   (HOSTNAME_OVERRIDE only for a different hostname)
set -euo pipefail
APP_USER=numera
CF_DIR="/home/$APP_USER/.cloudflared"
ETC_DIR=/etc/numera
HOSTNAME_PUBLIC="${HOSTNAME_OVERRIDE:-api.numeralabs.xyz}"
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }

shopt -s nullglob
creds=("$CF_DIR"/*.json)
[ "${#creds[@]}" -eq 1 ] || { echo "expected exactly one tunnel credentials file in $CF_DIR, found ${#creds[@]}: run 'sudo -u $APP_USER -H cloudflared tunnel create numera-api' first" >&2; exit 1; }
src="${creds[0]}"
id="$(basename "$src" .json)"
case "$id" in *[!0-9a-fA-F-]*|"") echo "unexpected credentials file name $src" >&2; exit 1 ;; esac

install -m 0600 -o "$APP_USER" -g "$APP_USER" "$src" "$ETC_DIR/tunnel-credentials.json"
cat > "$ETC_DIR/cloudflared.yml" <<EOF
# Cloudflare Tunnel for the Numera Quote API (written by numera-tunnel-config)
tunnel: $id
credentials-file: $ETC_DIR/tunnel-credentials.json
ingress:
  - hostname: $HOSTNAME_PUBLIC
    service: http://127.0.0.1:8000
  - service: http_status:404
EOF
chmod 0640 "$ETC_DIR/cloudflared.yml"
chgrp "$APP_USER" "$ETC_DIR/cloudflared.yml"
echo "wrote $ETC_DIR/cloudflared.yml for tunnel $id -> $HOSTNAME_PUBLIC"
echo "The running tunnel needs only the credentials file. $CF_DIR/cert.pem (from 'tunnel login') can create tunnels and DNS"
echo "records for your Cloudflare account: delete it when setup is finished:  sudo rm $CF_DIR/cert.pem"
