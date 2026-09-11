#!/bin/bash
# Spike runner: launch headless Chrome with the spike extension, drive it over
# CDP, and drop the collected report + screenshots into ./out.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="$HERE/ext"
PROFILE="${TMPDIR:-/tmp}/dsh-spike-profile"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT=9222

rm -rf "$PROFILE" "$HERE/out"
mkdir -p "$PROFILE" "$HERE/out"

# An unpacked extension's id is the first 16 bytes of sha256(absolute path),
# each hex nibble mapped to a..p.
EXT_ID="$(node -e '
const { createHash } = require("node:crypto")
const hex = createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 32)
console.log([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(""))
' "$EXT")"
echo "extension dir: $EXT"
echo "extension id:  $EXT_ID"
echo "$EXT_ID" > "$HERE/out/ext-id.txt"

"$CHROME" \
  --user-data-dir="$PROFILE" \
  --load-extension="$EXT" \
  --disable-extensions-except="$EXT" \
  --remote-debugging-port="$PORT" \
  --no-first-run --no-default-browser-check --disable-features=Translate \
  --no-sandbox --disable-gpu --hide-scrollbars --headless=new --window-size=420,900 \
  about:blank &
CHROME_PID=$!
trap 'kill "$CHROME_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null || { echo "chrome devtools endpoint never came up"; exit 1; }

node "$HERE/cdp-spike.mjs" --ext-id "$EXT_ID" --out "$HERE/out" --port "$PORT"
