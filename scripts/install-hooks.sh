#!/bin/sh
# Point this repository's hooks at .githooks, for every worktree at once: core.hooksPath lives in
# the shared config, and a relative path is taken from each worktree's own root.
#
#   scripts/install-hooks.sh [--force]
#
# Nothing here is required for the gate to run: scripts/merge-dev.sh runs scripts/gate.sh itself.
# The hooks add it to a manual `git merge` and to `git push`, which `--no-verify` can skip.
set -eu

force=""
case "${1:-}" in
  "") ;;
  --force) force=1 ;;
  *) echo "usage: scripts/install-hooks.sh [--force]" >&2; exit 2 ;;
esac

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [ ! -d .githooks ]; then
  echo "install-hooks: no .githooks directory in $root" >&2
  exit 1
fi

# A hooks path that is not .githooks may be another tool's (husky and the like), so replacing it
# needs a deliberate --force.
previous="$(git config --get core.hooksPath || true)"
if [ -z "$previous" ]; then
  echo "core.hooksPath was unset"
else
  echo "core.hooksPath was $previous"
  if [ "$previous" != .githooks ] && [ -z "$force" ]; then
    echo "install-hooks: pass --force to replace a different core.hooksPath" >&2
    exit 1
  fi
fi

git config core.hooksPath .githooks
echo "core.hooksPath = $(git config core.hooksPath)"
