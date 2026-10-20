#!/usr/bin/env bash
# Production-style local run: builds the client once and serves it from the gateway.
source "$(dirname "$0")/common.sh"
check_prereqs
ensure_spacetimedb
publish_module
log "building client"
(cd "$WEB_DIR" && npm run build >"$LOG_DIR/build.log" 2>&1) || { cat "$LOG_DIR/build.log"; die "client build failed"; }
start_gateway
log "game ready at http://${GATEWAY_HOST:-127.0.0.1}:${GATEWAY_PORT:-8080} (Ctrl+C stops everything)"
wait -n "${PIDS[@]}"
