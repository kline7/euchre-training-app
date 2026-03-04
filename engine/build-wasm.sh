#!/bin/bash
set -e

cd "$(dirname "$0")"

# Build WASM
cargo build --target wasm32-unknown-unknown --release

# Generate JS/TS bindings
wasm-bindgen \
  target/wasm32-unknown-unknown/release/euchre_engine.wasm \
  --out-dir pkg \
  --target web \
  --typescript

# Optimize (if wasm-opt is available)
if command -v wasm-opt &> /dev/null; then
  wasm-opt -Oz pkg/euchre_engine_bg.wasm -o pkg/euchre_engine_bg.wasm
  echo "wasm-opt applied"
fi

echo "WASM build complete: engine/pkg/"
ls -lh pkg/
