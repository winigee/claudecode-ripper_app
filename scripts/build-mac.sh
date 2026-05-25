#!/usr/bin/env bash
# Build BonesAI v0.7.0 for macOS 11 Big Sur (Intel x86_64).
#
# Run this on the target Mac. Prerequisites:
#   - Node.js 18.x or 20.x installed (https://nodejs.org)
#   - llama.cpp built somewhere on this Mac (see scripts/fetch-llama.sh)
#   - Run once: npm install
#
# The script produces:
#   dist/mac/BonesAI.app
#   dist/BonesAI-<version>-mac-x64.app.zip
#   dist/BonesAI-<version>-mac-x64.app.zip.sha256

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

if [[ ! -x "vendor/llama-cpp/llama-server" ]]; then
  echo "==> Staging llama.cpp binaries"
  ./scripts/fetch-llama.sh
fi

# Optional icon: drop a 1024x1024 PNG at build/icon.png or an .icns at build/icon.icns
mkdir -p build
if [[ -f "build/icon.png" || -f "build/icon.icns" ]]; then
  echo "==> Using icon at build/icon.{png,icns}"
else
  echo "==> No icon found at build/icon.png — building with default Electron icon."
fi

VERSION=$(node -p "require('./package.json').version")

echo "==> Building BonesAI v${VERSION} for macOS x86_64"
npx electron-builder --mac --x64 --dir

APP_PATH=$(find dist -name 'BonesAI.app' -type d -maxdepth 3 | head -n 1)
if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "Could not locate BonesAI.app under dist/. Build may have failed." >&2
  exit 1
fi

echo "==> Ad-hoc signing the .app"
codesign --force --deep --sign - "$APP_PATH"

ZIP_NAME="BonesAI-v${VERSION}-mac-x64.app.zip"
ZIP_PATH="dist/${ZIP_NAME}"
rm -f "$ZIP_PATH"

echo "==> Packing $ZIP_NAME with ditto"
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
