#!/bin/sh
set -e
rm -rf dist

for t in tests/*/; do
  PAGE="${t%/}" npx vite build
done