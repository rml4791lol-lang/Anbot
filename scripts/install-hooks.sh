#!/bin/sh
# Point this repository's hooks at .githooks, for every worktree at once: core.hooksPath lives in
# the shared config, and a relative path is taken from each worktree's own root.
#
#   scripts/install-hooks.sh
#
# Nothing here is required for the gate to run: scripts/merge-dev.sh runs scripts/gate.sh itself.
# The hooks add it to a manual `git merge` and to `git push`, which `--no-verify` can skip.
set -eu

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [ ! -d .githooks ]; then
  echo "install-hooks: no .githooks directory in $root" >&2
  exit 1
fi

git config core.hooksPath .githooks
echo "core.hooksPath = $(git config core.hooksPath)"
