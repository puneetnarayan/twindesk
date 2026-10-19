#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Renders background.html with headless Chrome at 1x and 2x and packs both into background.tiff,
# the DMG window background used by build-dmg.sh. Run it after editing background.html.
# CHROME=/path/to/chrome overrides the browser.
set -e
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for s in 1 2; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --virtual-time-budget=6000 --window-size=660,440 --force-device-scale-factor=$s \
    --screenshot="$TMP/bg@${s}x.png" "file://$PWD/background.html" >/dev/null 2>&1
done
tiffutil -cathidpicheck "$TMP/bg@1x.png" "$TMP/bg@2x.png" -out background.tiff
echo "built mac/dmg/background.tiff"
