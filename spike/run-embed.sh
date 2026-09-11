#!/bin/bash
# Spike runner (phase 3): headless Chrome + extension loaded over CDP.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${TMPDIR:-/tmp}/dsh-embed-profile"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT=9222
# The CDP loadUnpacked command cannot resolve paths containing spaces.
EXT_COPY=/tmp/dsh-spike-ext

rm -rf "$PROFILE" "$HERE/out" "$EXT_COPY"
mkdir -p "$PROFILE" "$HERE/out"
cp -R "$HERE/ext" "$EXT_COPY"

"$CHROME" \
  --user-data-dir="$PROFILE" \
  --enable-unsafe-extension-debugging \
  --remote-debugging-port="$PORT" \
  --no-first-run --no-default-browser-check --disable-features=Translate \
  --no-sandbox --disable-gpu --hide-scrollbars --headless=new --window-size=420,900 \
  about:blank >"$HERE/out/chrome.log" 2>&1 &
CHROME_PID=$!
trap 'kill "$CHROME_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null || { echo "chrome devtools endpoint never came up"; exit 1; }

node "$HERE/cdp-embed.mjs" --ext "$EXT_COPY" --out "$HERE/out" --port "$PORT"
