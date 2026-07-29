#!/bin/sh
# Every POSIX hook is launched through here, for one reason.
#
# On macOS and Linux a hook does not run in a login shell, so a node installed
# by nvm, fnm, volta or asdf is on PATH for the person and invisible here. The
# previous launcher was `command -v node || exit 0`: correct, fail-open, and it
# would have left the plugin doing nothing at all, silently and forever, for
# anyone whose node came from a version manager. Silence is this plugin's worst
# failure mode -- it is indistinguishable from working correctly and finding
# nothing.
#
# So: look where node actually lives before giving up. Cheap checks first; the
# login shell, which costs a process spawn, only as a last resort.
#
# Still fails open. No node found anywhere means no hook, never a blocked turn.

[ -n "$1" ] || exit 0
script="$1"
shift

node_bin=$(command -v node 2>/dev/null)

if [ -z "$node_bin" ]; then
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node" \
    "$HOME/.fnm/aliases/default/bin/node" \
    "$HOME/.asdf/shims/node" \
    "$HOME/.local/bin/node"
  do
    if [ -x "$candidate" ]; then node_bin="$candidate"; break; fi
  done
fi

# nvm keeps one directory per installed version. Any of them will do -- this
# needs Node 14, and nobody has a version manager pinned below that -- so take
# the last one listed rather than depending on `sort -V`, which BSD sort on
# macOS does not have.
if [ -z "$node_bin" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  for dir in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$dir" ]; then node_bin="$dir"; fi
  done
fi

# Last resort: ask the login shell what its PATH is. This is what actually
# rescues an unusual setup, and it is last because it spawns a shell.
if [ -z "$node_bin" ] && [ -n "$SHELL" ] && [ -x "$SHELL" ]; then
  found=$("$SHELL" -lc 'command -v node' 2>/dev/null)
  if [ -x "$found" ]; then node_bin="$found"; fi
fi

[ -n "$node_bin" ] || exit 0

exec "$node_bin" "$(dirname "$0")/$script" "$@"
