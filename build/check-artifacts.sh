#!/usr/bin/env bash
# Hygiene gate: artifacts must contain NO Theme Hospital game data and no
# threaded (pthread) runtime; engine's own preloads must be present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JS="$(find "$ROOT/build-wasm" -name 'corsix-th.js' 2>/dev/null | head -1 || true)"
DATA="$(find "$ROOT/build-wasm" -name 'corsix-th.data' 2>/dev/null | head -1 || true)"
WASM="$(find "$ROOT/build-wasm" -name 'corsix-th.wasm' 2>/dev/null | head -1 || true)"
if [[ -z "$JS" || -z "$DATA" || -z "$WASM" ]]; then
    echo "FAIL: artifacts not found under build-wasm/ — build first"
    exit 1
fi

python3 - "$JS" "$DATA" "$WASM" <<'PY'
import re
import sys

js_path, data_path, wasm_path = sys.argv[1], sys.argv[2], sys.argv[3]
js_bytes = open(js_path, 'rb').read()
wasm_bytes = open(wasm_path, 'rb').read()
js_text = js_bytes.decode('utf-8', errors='surrogateescape')

# 1. Extract the file-packager preload manifest embedded in corsix-th.js:
#    loadPackage({files:[{filename:"/corsixth/...",start:N,end:N}, ...]})
names = re.findall(r'filename:"([^"]+)"', js_text)
if not names:
    print("FAIL: could not parse any preload manifest filenames from corsix-th.js "
          "— packaging format changed, this check is blind")
    sys.exit(1)

# 2. Every manifest path must live under /corsixth/ in one of the engine's own
#    preload subtrees (mirrors the CMake preload glob). Anything else is how
#    actual embedded Theme Hospital game data would show up.
allowed_top = {'CorsixTH.lua', 'Lua', 'Bitmap', 'Campaigns', 'Levels'}
bad = []
for n in names:
    parts = n.split('/')
    # expected shape: ['', 'corsixth', <top>, ...]
    if len(parts) < 3 or parts[1] != 'corsixth' or parts[2] not in allowed_top:
        bad.append(n)
if bad:
    print(f"FAIL: preload manifest contains paths outside the engine allowlist "
          f"(possible embedded TH game data): {bad}")
    sys.exit(1)

# 3. Threaded runtime marker: 'PThread' object is only emitted by -pthread builds
if b'PThread' in js_bytes + wasm_bytes:
    print("FAIL: threaded (pthread) runtime detected in corsix-th.js/.wasm")
    sys.exit(1)

# Sanity: prove the manifest parse sees real content — engine's own preload must be present
if '/corsixth/CorsixTH.lua' not in names:
    print("FAIL: engine preload (CorsixTH.lua) not found in manifest — scan or packaging is broken")
    sys.exit(1)

print(f"PASS: engine-only artifacts (no TH game data, no pthread runtime, "
      f"engine preloads present; {len(names)} manifest files checked)")
PY
