#!/usr/bin/env bash
# Build BonesAI for macOS 11 Big Sur (Intel x86_64).
#
# Run this on the target Mac. Prerequisites:
#   - Node.js 18.x or 20.x installed (https://nodejs.org)
#   - Run once: npm install
#
# The script produces:
#   dist/mac/BonesAI.app                    — the unpacked .app bundle
#   dist/BonesAI-<version>-mac-x64.app.zip  — a drag-to-Applications zip built with ditto
#
# After unzipping on the Mac:
#   1. Drag BonesAI.app into /Applications
#   2. Clear the Gatekeeper quarantine attribute (unsigned app):
#        xattr -cr /Applications/BonesAI.app
#   3. Open the app. Paste your Anthropic API key into Settings on first run.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-mac.sh must be run on macOS." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "==> Installing dependencies (first run)"
  npm install
fi

VERSION=$(node -p "require('./package.json').version")

echo "==> Building BonesAI v${VERSION} for macOS x86_64"
npx electron-builder --mac --x64 --dir

APP_PATH="dist/mac/BonesAI.app"
if [[ ! -d "$APP_PATH" ]]; then
  # electron-builder >= 24 uses dist/mac for x64
  APP_PATH=$(find dist -name 'BonesAI.app' -type d -maxdepth 3 | head -n 1)
fi
if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "Could not locate BonesAI.app under dist/. Build may have failed." >&2
  exit 1
fi

echo "==> Ad-hoc signing the .app so Gatekeeper can launch it"
codesign --force --deep --sign - "$APP_PATH"

ZIP_NAME="BonesAI-v${VERSION}-mac-x64.app.zip"
ZIP_PATH="dist/${ZIP_NAME}"
rm -f "$ZIP_PATH"

echo "==> Packing $ZIP_NAME with ditto (preserves bundle structure)"
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_PATH"

SHA=$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')
echo "$SHA  $ZIP_NAME" > "${ZIP_PATH}.sha256"

echo ""
echo "Done."
echo "  App bundle: $APP_PATH"
echo "  Zip:        $ZIP_PATH"
echo "  SHA-256:    $SHA"
echo ""
echo "Install:"
echo "  unzip $ZIP_PATH -d /tmp/bonesai && mv /tmp/bonesai/BonesAI.app /Applications/"
echo "  xattr -cr /Applications/BonesAI.app"
echo "  open /Applications/BonesAI.app"
