#!/usr/bin/env bash
# Renders the link preview and the touch icon from their sources, with a
# headless Chromium. Run after changing tools/brand/banner.html or
# web/favicon.svg; the PNGs are committed (the server only serves files).
#   CHROME=/path/to/chrome-headless-shell bash tools/brand/render.sh
# (the headless shell: a full Chromium in --headless mode crops the viewport)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
web=$(cd "$here/../../web" && pwd)
chrome=${CHROME:-chromium-headless-shell}
shot() { "$chrome" --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size="$2" --screenshot="$3" "file://$1" >/dev/null 2>&1; }
shot "$here/banner.html" 1200,630 "$web/banner.png"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
printf '<!doctype html><style>html,body{margin:0;background:transparent}img{width:180px;height:180px;display:block}</style><img src="file://%s">' "$web/favicon.svg" > "$tmp/icon.html"
shot "$tmp/icon.html" 180,180 "$web/icon-180.png"
echo "wrote $web/banner.png and $web/icon-180.png"
