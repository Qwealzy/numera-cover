#!/usr/bin/env bash
# numera-status: one screen with the state of the three services, the local health answer and the last log lines.
# Prints no secret (the env file is never read here).
for u in numera-engine numera-keeper numera-tunnel; do
  printf '%-16s %s\n' "$u" "$(systemctl is-active "$u" 2>&1)"
done
echo
echo "-- engine /health (local)"
curl -sS --max-time 5 http://127.0.0.1:8000/health || echo "(no answer)"
echo
echo "-- last keeper lines"
journalctl -u numera-keeper -n 8 --no-pager -o cat 2>/dev/null || echo "(run with sudo to read the journal)"
echo "-- last engine lines"
journalctl -u numera-engine -n 8 --no-pager -o cat 2>/dev/null || true
echo "-- last tunnel lines"
journalctl -u numera-tunnel -n 5 --no-pager -o cat 2>/dev/null || true
