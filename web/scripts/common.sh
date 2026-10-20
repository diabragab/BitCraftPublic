# Shared helpers for dev.sh / start.sh. Configuration comes from web/.env (see .env.example).
set -euo pipefail
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$WEB_DIR/.env" ]]; then set -a; source "$WEB_DIR/.env"; set +a; fi
export SPACETIME_URL="${SPACETIME_URL:-http://127.0.0.1:3000}"
export SPACETIME_DB="${SPACETIME_DB:-kaykit-arena}"
export SPACETIME_SERVER="${SPACETIME_SERVER:-local}"
LOG_DIR="$WEB_DIR/.data/logs"
mkdir -p "$LOG_DIR"
PIDS=()

log() { printf '\033[1;33m[arena]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[arena] %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  for pid in "${PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

check_prereqs() {
  command -v node >/dev/null || die "Node.js 22.13+ is required"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' || die "Node.js 22.13+ is required (found $(node -v))"
  command -v spacetime >/dev/null || die "SpacetimeDB CLI not found. Install 2.10.x: https://spacetimedb.com/install"
  spacetime --version 2>/dev/null | grep -q "tool version 2.10" || log "warning: SpacetimeDB CLI is not 2.10.x; the modules pin spacetimedb =2.10.0"
  command -v cargo >/dev/null || die "Rust (cargo) is required to build the module: https://rustup.rs"
  rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown || die "Run: rustup target add wasm32-unknown-unknown"
  [[ -d "$WEB_DIR/node_modules" ]] || { log "installing npm dependencies"; (cd "$WEB_DIR" && npm install); }
}

ensure_spacetimedb() {
  if curl -fsS "$SPACETIME_URL/v1/ping" >/dev/null 2>&1; then
    log "SpacetimeDB already running at $SPACETIME_URL"
    return
  fi
  local listen="${SPACETIME_URL#http://}"
  log "starting SpacetimeDB on $listen (logs: $LOG_DIR/spacetimedb.log)"
  # SPACETIME_START_CMD lets you point at a custom binary/data dir.
  ${SPACETIME_START_CMD:-spacetime start --listen-addr "$listen"} >"$LOG_DIR/spacetimedb.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 60); do
    curl -fsS "$SPACETIME_URL/v1/ping" >/dev/null 2>&1 && { log "SpacetimeDB is up"; return; }
    sleep 0.5
  done
  die "SpacetimeDB did not start; see $LOG_DIR/spacetimedb.log"
}

publish_module() {
  log "building + publishing arena module as '$SPACETIME_DB' (non-destructive update if it exists)"
  # Never pass --delete-data here: publishing an update keeps existing rows.
  spacetime publish -s "$SPACETIME_SERVER" -p "$WEB_DIR/arena-module" "$SPACETIME_DB" -y >"$LOG_DIR/publish.log" 2>&1 \
    || { cat "$LOG_DIR/publish.log"; die "publish failed (are you logged in? try: spacetime login --server-issued-login $SPACETIME_SERVER)"; }
}

start_gateway() {
  log "starting gateway on ${GATEWAY_HOST:-127.0.0.1}:${GATEWAY_PORT:-8080} (logs: $LOG_DIR/gateway.log)"
  (cd "$WEB_DIR/gateway" && exec node --disable-warning=ExperimentalWarning src/index.js) >"$LOG_DIR/gateway.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 40); do
    token="${GATEWAY_TOKEN_FILE:-../.secrets/gateway-token}"; [[ "$token" = /* ]] || token="$WEB_DIR/gateway/$token"
    [[ -f "$token" ]] && curl -fsS "http://127.0.0.1:${GATEWAY_PORT:-8080}/api/config" >/dev/null 2>&1 && break
    sleep 0.25
  done
  bash "$WEB_DIR/scripts/register-gateway.sh" >"$LOG_DIR/register.log" 2>&1 \
    || { cat "$LOG_DIR/register.log"; die "could not register the gateway with the module"; }
  curl -fsS "http://127.0.0.1:${GATEWAY_PORT:-8080}/api/health" && echo
}
