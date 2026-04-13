#!/usr/bin/env bash
set -e
PROJ="$(cd "$(dirname "$0")" && pwd)"
ICON_DIR="$PROJ/DevDashboard.app/Contents/Resources"
ICONSET="$ICON_DIR/AppIcon.iconset"
mkdir -p "$ICONSET"

python3 /tmp/_gen_icon.py "$ICONSET"

iconutil -c icns "$ICONSET" -o "$ICON_DIR/AppIcon.icns"
rm -rf "$ICONSET"

/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile AppIcon" "$PROJ/DevDashboard.app/Contents/Info.plist" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon" "$PROJ/DevDashboard.app/Contents/Info.plist"

touch "$PROJ/DevDashboard.app"
echo "Done: $ICON_DIR/AppIcon.icns"
