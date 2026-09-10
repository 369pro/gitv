#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

npm --prefix "$SCRIPT_DIR" run build --silent

if [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then
  REPO_PATH=$1
  shift
else
  REPO_PATH=$(node "$SCRIPT_DIR/dist/scripts/demo.js")
  printf 'gitv: created classroom repository at %s\n' "$REPO_PATH"
fi

exec node "$SCRIPT_DIR/dist/bin/gitv.js" "$REPO_PATH" "$@"

# Example: ./run.sh ../test_gitrepo
