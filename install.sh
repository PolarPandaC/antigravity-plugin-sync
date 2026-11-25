#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
MODE=install
if [ "${1-}" = '--uninstall' ]; then
  MODE=uninstall
  shift
fi

RUNTIME=''
case "$(uname -s)" in
  Darwin) EMBEDDED="${ANTIGRAVITY_USER_DATA_DIR:-$HOME/Library/Application Support/Antigravity}/bin/agy-node" ;;
  *) EMBEDDED="${ANTIGRAVITY_USER_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/Antigravity}/bin/agy-node" ;;
esac

if command -v node >/dev/null 2>&1; then
  if [ "$(node -p "Number(process.versions.node.split('.')[0])>22||(Number(process.versions.node.split('.')[0])===22&&Number(process.versions.node.split('.')[1])>=13)" 2>/dev/null)" = true ]; then
    RUNTIME=$(command -v node)
  fi
fi

if [ -z "$RUNTIME" ] && [ -x "$EMBEDDED" ]; then
  if [ "$("$EMBEDDED" -p "Number(process.versions.node.split('.')[0])>22||(Number(process.versions.node.split('.')[0])===22&&Number(process.versions.node.split('.')[1])>=13)" 2>/dev/null)" = true ]; then
    RUNTIME=$EMBEDDED
  fi
fi

if [ -z "$RUNTIME" ]; then
  printf '%s\n' 'Error: Install Node.js 22.13+ or launch Antigravity desktop app first.' >&2
  exit 1
fi

exec "$RUNTIME" "$ROOT/scripts/$MODE.mjs" "$@"
