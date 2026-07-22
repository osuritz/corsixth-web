#!/usr/bin/env bash
# Serve the built artifacts + dev harness for a local boot test.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JS="$(find "$ROOT/build-wasm" -name 'corsix-th.js' | head -1)"
[[ -n "$JS" ]] || { echo "No corsix-th.js under build-wasm/ — run build/build.sh first"; exit 1; }
ART_DIR="$(dirname "$JS")"

cp "$ROOT/web/dev/index.html" "$ART_DIR/"
echo "Serving $ART_DIR at http://localhost:8123"
python3 -m http.server 8123 --directory "$ART_DIR"
