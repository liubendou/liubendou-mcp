#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${1:-arm64}"
case "$ARCH" in arm64) SWIFT_ARCH=arm64 ;; x64) SWIFT_ARCH=x86_64 ;; *) echo 'Unknown architecture' >&2; exit 1 ;; esac
if [ "$(uname -s)" != Darwin ]; then echo 'This build must run on macOS.' >&2; exit 1; fi
if [ "$(node -p 'process.arch')" != "$ARCH" ]; then echo 'Node architecture does not match the requested DMG.' >&2; exit 1; fi
OUT="$ROOT/out/$ARCH"
STAGE="$OUT/disk"
APP="$STAGE/六本豆 Lite.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/lite"
cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
cp -R "$ROOT/payload/lite/." "$APP/Contents/Resources/lite/"
mkdir -p "$APP/Contents/Resources/lite/runtime"
cp "$(command -v node)" "$APP/Contents/Resources/lite/runtime/node"
cp -R "$ROOT/node_modules" "$APP/Contents/Resources/lite/node_modules"
cp "$ROOT/package.json" "$APP/Contents/Resources/lite/package.json"
chmod 755 "$APP/Contents/Resources/lite/runtime/node"
SDK="$(xcrun --sdk macosx --show-sdk-path)"
xcrun swiftc -swift-version 5 -parse-as-library -O -whole-module-optimization \
  -sdk "$SDK" -target "$SWIFT_ARCH-apple-macosx14.0" -module-name LiubendouLite \
  -framework AppKit -framework WebKit -framework Security -framework CryptoKit -framework IOKit \
  "$ROOT"/Sources/*.swift -o "$APP/Contents/MacOS/LiubendouLite"
strip -x "$APP/Contents/MacOS/LiubendouLite"
codesign --force --sign - --options runtime --timestamp=none --entitlements "$ROOT/node-entitlements.plist" "$APP/Contents/Resources/lite/runtime/node"
codesign --force --sign - --timestamp=none "$APP"
ln -s /Applications "$STAGE/Applications"
cp "$ROOT/使用说明.txt" "$STAGE/使用说明.txt"
DMG="$OUT/六本豆Lite-0.3.3-macOS-$ARCH-preview.dmg"
hdiutil create -volname '六本豆 Lite' -srcfolder "$STAGE" -format UDZO "$DMG"
(cd "$OUT" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256.txt")
echo "Created $DMG"
