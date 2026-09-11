#!/bin/bash
# Spike runner (phase 2): launch headless Chrome with the panel extension, drive
# it over CDP, and drop the report + screenshots into ./out.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="$HERE/ext"
PROFILE="${TMPDIR:-/tmp}/dsh-spike-profile"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT=9222

rm -rf "$PROFILE" "$HERE/out"
mkdir -p "$PROFILE" "$HERE/out"

"$CHROME" \
  --user-data-dir="$PROFILE" \
  --load-extension="$EXT" \
  --disable-extensions-except="$EXT" \
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

node "$HERE/cdp-panel.mjs" --out "$HERE/out" --port "$PORT"
