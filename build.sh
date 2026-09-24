#!/bin/sh
set -e
rm -rf dist ldtkbuddy
mkdir -p dist/runtime/1/systems

cp runtime/1/systems/network.js runtime/1/systems/network.worker.js dist/runtime/1/systems/

for t in tests/*/; do
  PAGE="${t%/}" npx vite build
done