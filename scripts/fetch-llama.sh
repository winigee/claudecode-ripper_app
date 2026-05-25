#!/usr/bin/env bash
# Stage the inference engine (llamafile) into vendor/llama-cpp/ for the BonesAI build.
#
# Why llamafile (since v0.7.0):
# - Single self-contained Cosmopolitan-libc binary, no dylibs, no compile.
# - Runs on macOS 10.15+ Intel and Apple Silicon — Big Sur 11.x covered.
# - Speaks the same OpenAI-compatible HTTP API as llama-server.
#
# Downloads the "thin" variant (no embedded model) from llamafile's GitHub Releases.

set -euo pipefail

cd "$(dirname "$0")/.."

VENDOR_DIR="vendor/llama-cpp"
mkdir -p "$VENDOR_DIR"

LLAMAFILE_VERSION="0.10.1"
LLAMAFILE_URL="https://github.com/mozilla-ai/llamafile/releases/download/${LLAMAFILE_VERSION}/llamafile-${LLAMAFILE_VERSION}-thin"

if [[ -x "$VENDOR_DIR/llamafile" ]]; then
  SIZE=$(stat -f%z "$VENDOR_DIR/llamafile" 2>/dev/null || stat -c%s "$VENDOR_DIR/llamafile" 2>/dev/null || echo 0)
  if [[ "$SIZE" -gt 10000000 ]]; then
    echo "==> llamafile already staged at $VENDOR_DIR/llamafile ($SIZE bytes). Skipping."
    exit 0
  fi
fi

echo "==> Downloading llamafile $LLAMAFILE_VERSION (thin variant)"
curl -fL --progress-bar -o "$VENDOR_DIR/llamafile" "$LLAMAFILE_URL"
chmod +x "$VENDOR_DIR/llamafile"

ls -lh "$VENDOR_DIR/llamafile"
echo "==> Done."
