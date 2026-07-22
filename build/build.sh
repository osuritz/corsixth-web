#!/usr/bin/env bash
# Canonical WASM build. Only requirement on the host: Docker.
# Usage: build/build.sh [clean]
set -euo pipefail

IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:6.0.3}" # winning combo, Task 1.5; pinned exact version, Task 3
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="build-wasm"

if [[ "${1:-}" == "clean" ]]; then
  rm -rf "${ROOT:?}/${BUILD_DIR}"
fi

docker run --rm -v "$ROOT":/src -w /src "$IMAGE" bash -c "
  set -euo pipefail
  echo \"--- toolchain: \$(emcc --version | head -1)\"
  echo \"--- cmake: \$(cmake --version | head -1)\"
  emcmake cmake -B ${BUILD_DIR} -DCMAKE_BUILD_TYPE=Release \
    -DWITH_MOVIES=OFF -DWITH_UPDATE_CHECK=OFF -DWITH_LUAJIT=OFF
  cmake --build ${BUILD_DIR} -j\$(nproc)
"

echo '--- artifacts:'
# Output basename is "corsix-th" (set via OUTPUT_NAME in CorsixTH/CMakeLists.txt), not "CorsixTH".
find "$ROOT/$BUILD_DIR" \( -iname 'corsix-th.js' -o -iname 'corsix-th.wasm' -o -iname 'corsix-th.data' \) | sort
