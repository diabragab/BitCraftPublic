#!/usr/bin/env bash
# Shares the game running on this machine (npm start) through a temporary public HTTPS
# URL using a Cloudflare quick tunnel (no account needed). Run it in a second terminal.
# The URL changes every time the tunnel restarts; restarting the game does not change it.
set -euo pipefail
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$WEB_DIR/.env" ]]; then set -a; source "$WEB_DIR/.env"; set +a; fi
PORT="${GATEWAY_PORT:-8080}"

if ! command -v cloudflared >/dev/null; then
  cat >&2 <<'MSG'
cloudflared is not installed. Install it, then run this again:
  macOS:          brew install cloudflared
  Windows:        winget install --id Cloudflare.cloudflared   (or inside WSL use the Linux steps)
  Linux / WSL:    curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
                  chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/
MSG
  exit 1
fi

if ! curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "The game is not running on port $PORT. Start it first with: npm start" >&2
  exit 1
fi

if [[ "${TRUST_PROXY:-0}" != "1" ]]; then
  echo "warning: TRUST_PROXY is not 1 in web/.env, so every visitor shares one login rate limit." >&2
  echo "         Add TRUST_PROXY=1 to web/.env and restart npm start." >&2
fi

echo "Starting a Cloudflare quick tunnel to http://127.0.0.1:$PORT"
echo "Share the https://<random-name>.trycloudflare.com address printed below. Ctrl+C closes it."
exec cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT"
