#!/usr/bin/env bash
# Canonical WASM build. Only requirement on the host: Docker.
# Usage: build/build.sh [clean]
set -euo pipefail

IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:latest}" # pinned in M1 Task 3
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="build-wasm"

if [[ "${1:-}" == "clean" ]]; then
  rm -rf "${ROOT:?}/${BUILD_DIR}"
fi

docker run --rm -v "$ROOT":/src -w /src "$IMAGE" bash -c "
  set -euo pipefail
  echo \"--- toolchain: \$(emcc --version | head -1)\"
  emcmake cmake -B ${BUILD_DIR} -DCMAKE_BUILD_TYPE=Release \
    -DWITH_MOVIES=OFF -DWITH_UPDATE_CHECK=OFF -DWITH_LUAJIT=OFF
  cmake --build ${BUILD_DIR} -j\$(nproc)
"

echo '--- artifacts:'
find "$ROOT/$BUILD_DIR" \( -name 'CorsixTH.js' -o -name 'CorsixTH.wasm' -o -name 'CorsixTH.data' \) | sort
