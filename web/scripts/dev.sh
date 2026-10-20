#!/usr/bin/env bash
# One command for local development: SpacetimeDB + arena module + gateway + Vite dev server.
source "$(dirname "$0")/common.sh"
check_prereqs
ensure_spacetimedb
publish_module
start_gateway
log "starting Vite dev server: http://127.0.0.1:5173 (Ctrl+C stops everything)"
(cd "$WEB_DIR/client" && exec npx vite --host "${VITE_HOST:-127.0.0.1}") &
PIDS+=($!)
wait -n "${PIDS[@]}"
