#!/bin/sh
# The local gate every way of landing commits runs: scripts/merge-dev.sh, .githooks/pre-merge-commit
# (a manual merge) and .githooks/pre-push. Unit, build and lint only: smoke, web and desktop need
# Chrome, xvfb and about 1 GB of memory, which a merge cannot wait for.
#
#   scripts/gate.sh                         unit, build, lint
#   GATE_STEPS=build,lint scripts/gate.sh    the two pre-push runs
#
# Called from anywhere: the root comes from git, not from the working directory. The exit code is
# dev/check.sh's own.
set -eu

root="$(git rev-parse --show-toplevel)"
cd "$root"
exec sh ds-bot/dev/check.sh --only "${GATE_STEPS:-unit,build,lint}"
