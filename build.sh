#!/bin/sh
set -e
rm -rf dist
mkdir -p dist/runtime/1/systems dist/tests/1 dist/tests/2
 
npx -y esbuild@0.25.12 runtime/1/main.js --bundle --minify --format=esm --outfile=dist/runtime/1/main.js
cp runtime/1/wizard.png dist/runtime/1/
cp runtime/1/systems/network.js runtime/1/systems/network.worker.js dist/runtime/1/systems/
 
cp tests/1/index.html dist/tests/1/
go run github.com/gaboose/ldtkbuddy@4b5857b -o dist/tests/1 tests/1/ldtk.json

cp tests/2/index.html dist/tests/2/
go run github.com/gaboose/ldtkbuddy@4b5857b -o dist/tests/2 tests/2/ldtk.json
