#!/usr/bin/env bash
#
# Install the Gemini plugin into Xenocept's local plugin store without
# going through npm. Useful for local development before the package is
# published (or after a local change you haven't pushed yet).
#
# Usage: ./install.sh [server_url]
#   server_url defaults to http://127.0.0.1:9500

set -euo pipefail

DIRECTORY_ID="xenocept-plugin-aeor-gemini"
SERVER_URL="${1:-http://127.0.0.1:9500}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

FILES=(
  "index.mjs"
  "package.json"
)

echo "Installing ${DIRECTORY_ID} to ${SERVER_URL} (npm scope)..."

for file in "${FILES[@]}"; do
  filepath="${SCRIPT_DIR}/${file}"
  if [[ ! -f "$filepath" ]]; then
    echo "  SKIP  ${file} (not found)"
    continue
  fi
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT "${SERVER_URL}/api/v1/plugins/npm/${DIRECTORY_ID}/${file}" \
    --data-binary "@${filepath}")
  if [[ "$status" == "200" ]]; then
    echo "  OK    ${file}"
  else
    echo "  FAIL  ${file} (HTTP ${status})"
    exit 1
  fi
done

echo "Done. Reload the Xenocept client (Plugins tab → Search/refresh) to pick up the plugin."
