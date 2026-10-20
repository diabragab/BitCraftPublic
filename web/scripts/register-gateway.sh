#!/usr/bin/env bash
# Registers the gateway's SpacetimeDB identity with the arena module so it may
# authorize player sessions. Must run as the identity that published the module.
set -euo pipefail
cd "$(dirname "$0")/../gateway" # relative paths resolve like the gateway's config
SERVER="${SPACETIME_SERVER:-local}"
DB="${SPACETIME_DB:-kaykit-arena}"
TOKEN_FILE="${GATEWAY_TOKEN_FILE:-../.secrets/gateway-token}"
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "No gateway token at $TOKEN_FILE yet. Start the gateway once (npm start -w gateway) to create it." >&2
  exit 1
fi
IDENTITY=$(node -e "const t=require('fs').readFileSync(process.argv[1],'utf8').trim(); console.log(JSON.parse(Buffer.from(t.split('.')[1],'base64url')).hex_identity)" "$TOKEN_FILE")
echo "Registering gateway identity $IDENTITY with $DB on $SERVER"
spacetime call -s "$SERVER" "$DB" register_gateway "0x$IDENTITY"
