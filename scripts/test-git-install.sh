#!/bin/sh
# Exercise npm's Git prepare lifecycle against the current committed checkout.
set -eu

root=$(git rev-parse --show-toplevel)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM

npm install --global "git+file://$root" --prefix "$scratch/prefix" --cache "$scratch/cache"
"$scratch/prefix/bin/periscope" --help
"$scratch/prefix/bin/periscope" --version
node --import "$scratch/prefix/lib/node_modules/periscope/bin/register-types.mjs" \
  --input-type=module -e 'await import(process.argv[1])' \
  "$scratch/prefix/lib/node_modules/periscope/src/tui/app.ts"
