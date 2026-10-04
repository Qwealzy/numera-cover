#!/bin/sh
# Start-up guard run by systemd (ExecStartPre) before numera-engine and numera-keeper: refuses to start on a
# mistake that could touch real funds or leave the rate limiter blind. Prints variable NAMES only, never values.
#   preflight.sh engine | keeper
set -eu
role="${1:-}"

fail() {
  echo "numera preflight ($role): $1" >&2
  exit 1
}

[ "${NUMERA_ENV:-}" = "testnet" ] || fail "NUMERA_ENV must be testnet"
[ "${NUMERA_CHAIN_ID:-}" = "998" ] || fail "NUMERA_CHAIN_ID must be 998 (testnet only; never 999)"
if [ -n "${NUMERA_POOLS:-}" ] && [ "${NUMERA_ALLOW_POOL_OVERRIDE:-}" != "1" ]; then
  fail "NUMERA_POOLS is set: pool addresses come from the deployments files; empty it (or set NUMERA_ALLOW_POOL_OVERRIDE=1 on purpose)"
fi

case "$role" in
  engine)
    [ -n "${QUOTE_SIGNER_KEY:-}" ] || fail "QUOTE_SIGNER_KEY is empty in /etc/numera/numera.env"
    [ "${NUMERA_PROXY_MODE:-}" = "proxy" ] || fail "NUMERA_PROXY_MODE must be proxy (Cloudflare Tunnel in front)"
    [ -n "${NUMERA_TRUSTED_PROXIES:-}" ] || fail "NUMERA_TRUSTED_PROXIES is empty (needs 127.0.0.1,::1 for cloudflared)"
    case "${NUMERA_BIND_HOST:-127.0.0.1}" in
      127.*|::1|localhost) ;;
      *) fail "NUMERA_BIND_HOST must be loopback (the tunnel is the only way in)" ;;
    esac
    [ -n "${NUMERA_CLIENT_IP_HEADER:-}" ] || fail "NUMERA_CLIENT_IP_HEADER is empty (CF-Connecting-IP for Cloudflare)"
    case "${NUMERA_CORS_ORIGINS:-}" in
      *'*'*) fail "NUMERA_CORS_ORIGINS must list exact origins, no wildcard" ;;
    esac
    ;;
  keeper)
    [ -n "${KEEPER_KEY:-}" ] || fail "KEEPER_KEY is empty in /etc/numera/numera.env"
    ;;
  *)
    fail "usage: preflight.sh engine|keeper"
    ;;
esac
exit 0
