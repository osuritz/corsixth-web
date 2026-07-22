#!/usr/bin/env bash
# Hygiene gate: artifacts must contain NO Theme Hospital game data and no
# threaded (pthread) runtime; engine's own preloads must be present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JS="$(find "$ROOT/build-wasm" -name 'corsix-th.js' | head -1)"
DATA="$(find "$ROOT/build-wasm" -name 'corsix-th.data' | head -1)"
[[ -n "$JS" && -n "$DATA" ]] || { echo "FAIL: artifacts not found under build-wasm/ — build first"; exit 1; }

python3 - "$JS" "$DATA" <<'PY'
import sys

js_path, data_path = sys.argv[1], sys.argv[2]
blob = open(js_path, 'rb').read() + open(data_path, 'rb').read()
low = blob.lower()

# TH game-data filename signatures that must NEVER ship (spec: engine-only deploys)
banned = [b'vblk-0', b'spointer', b'demo.dat']
hits = [b.decode() for b in banned if b in low]
if hits:
    print(f"FAIL: Theme Hospital game-data signatures in artifacts: {hits}")
    sys.exit(1)

# Threaded runtime marker: 'PThread' object is only emitted by -pthread builds
if b'PThread' in blob:
    print("FAIL: threaded (pthread) runtime detected in corsix-th.js")
    sys.exit(1)

# Sanity: prove the scan sees real content — engine's own preload must be present
if b'corsixth.lua' not in low:
    print("FAIL: engine preload (CorsixTH.lua) not found — scan or packaging is broken")
    sys.exit(1)

print("PASS: engine-only artifacts (no TH game data, no pthread runtime, engine preloads present)")
PY
