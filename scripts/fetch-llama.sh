#!/usr/bin/env bash
# Stage llama.cpp binaries for the BonesAI build.
#
# Looks for an already-built llama.cpp on this Mac and copies the binary
# plus any required shared libraries into vendor/llama-cpp/. electron-builder
# then bundles vendor/llama-cpp/ into the .app at Contents/Resources/llama-cpp/.
#
# Search order:
#   1. $LLAMA_CPP_DIR environment variable (treat as the llama.cpp root)
#   2. ../llama.cpp (parent of this repo)
#   3. ~/llama.cpp
#   4. $(brew --prefix)/bin (Homebrew install of llama.cpp)
#
# Within each candidate, looks for build/bin/llama-server, then bin/llama-server.

set -euo pipefail

cd "$(dirname "$0")/.."

VENDOR_DIR="vendor/llama-cpp"

find_binary() {
  local root="$1"
  for cand in \
    "$root/build/bin/llama-server" \
    "$root/bin/llama-server" \
    "$root/llama-server"; do
    if [[ -x "$cand" ]]; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

BIN=""
for ROOT in \
    "${LLAMA_CPP_DIR:-}" \
    "../llama.cpp" \
    "$HOME/llama.cpp"; do
  if [[ -n "$ROOT" && -d "$ROOT" ]]; then
    if FOUND=$(find_binary "$ROOT"); then
      BIN="$FOUND"
      ROOT_DIR="$ROOT"
      break
    fi
  fi
done

if [[ -z "$BIN" ]] && command -v brew >/dev/null 2>&1; then
  HB="$(brew --prefix 2>/dev/null)/bin/llama-server"
  if [[ -x "$HB" ]]; then
    BIN="$HB"
    ROOT_DIR="$(brew --prefix)"
  fi
fi

if [[ -z "$BIN" ]]; then
  cat >&2 <<'EOF'
Could not find a built llama-server binary.

Build llama.cpp first:

  cd ~/llama.cpp     # or wherever you have the source
  mkdir -p build && cd build
  cmake ..
  cmake --build . --config Release -j

Or install via Homebrew:

  brew install llama.cpp

Then re-run this script.
EOF
  exit 1
fi

echo "==> Found llama-server at: $BIN"

rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"

cp "$BIN" "$VENDOR_DIR/llama-server"
chmod +x "$VENDOR_DIR/llama-server"

# Copy companion dylibs from the same directory (libllama.dylib etc.)
BIN_DIR="$(dirname "$BIN")"
shopt -s nullglob
for f in "$BIN_DIR"/*.dylib "$BIN_DIR"/*.metallib; do
  cp "$f" "$VENDOR_DIR/"
done

# Some llama.cpp builds put dylibs one level up under lib/
LIB_DIR="$(dirname "$BIN_DIR")/lib"
if [[ -d "$LIB_DIR" ]]; then
  for f in "$LIB_DIR"/*.dylib; do
    cp "$f" "$VENDOR_DIR/"
  done
fi
shopt -u nullglob

echo "==> Staged into $VENDOR_DIR:"
ls -lh "$VENDOR_DIR"

echo ""
echo "Done. Re-run scripts/build-mac.sh to bundle into the .app."
