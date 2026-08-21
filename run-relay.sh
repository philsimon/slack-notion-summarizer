#!/bin/zsh

# Resolves to this script's own directory, so the relay finds its .env and
# node_modules regardless of where the repo is cloned.
SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"

cd "$SCRIPT_DIR"
exec node ./node_modules/.bin/tsx src/relay.ts
