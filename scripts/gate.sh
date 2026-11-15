#!/bin/sh
# The local gate every way of landing commits runs: scripts/merge-dev.sh, .githooks/pre-merge-commit
# (a manual merge into main) and .githooks/pre-push. Unit, build and lint only: smoke, web and
# desktop need Chrome, xvfb and about 1 GB of memory, which a merge cannot wait for.
#
#   scripts/gate.sh                          unit, build, lint
#   GATE_STEPS=build,lint scripts/gate.sh     the two pre-push runs
#   GATE_CONCURRENCY=4 scripts/gate.sh        the unit files in parallel
#
# Called from anywhere: the root comes from git, not from the working directory. The exit code is
# the failing step's own.
set -eu

root="$(git rev-parse --show-toplevel)"
cd "$root"

# A worktree has no dev/harness of its own, and without it the suite cannot load its packages: the
# main checkout beside it has one. In the main checkout itself this finds the same directory.
if [ -z "${DSH_HARNESS:-}" ]; then
  candidate="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/ds-bot/dev/harness"
  if [ -d "$candidate/node_modules" ]; then
    export DSH_HARNESS="$candidate"
  fi
fi

# settings-shell.test.js loads its packages from this checkout's dev/harness whatever
# DSH_HARNESS says, and a worktree has no install of its own: borrow the main checkout's.
if [ ! -e ds-bot/dev/harness/node_modules ]; then
  main_harness="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/ds-bot/dev/harness/node_modules"
  if [ -d "$main_harness" ]; then
    ln -s "$main_harness" ds-bot/dev/harness/node_modules
  fi
fi

# Unit runs here rather than through dev/check.sh, which runs the bare `npm test`, because it is the
# one step the gate sets a flag for, and node reads --test-concurrency only before the file list:
# npm cannot append it to the script. So this is the command in ds-bot/package.json's test script
# with that flag added, and the two have to be kept in step.
#
# Serial is the default: the files share ports and temporary directories, and on one commit a
# parallel run reported 2486 to 2508 tests with 0 or 1 failures, while --test-concurrency=1 gave
# 2507 and none. It costs about 3.5 minutes; raise it only for a change that cannot touch those.
unit() {
  (cd ds-bot && node --import ./test/harness-resolve.mjs --import ./test/drain.mjs \
    --test --test-concurrency="${GATE_CONCURRENCY:-1}" --test-timeout=120000 --test-force-exit \
    "test/*.test.js")
}

rest=""
for step in $(printf '%s' "${GATE_STEPS:-unit,build,lint}" | tr ',' ' '); do
  if [ "$step" = unit ]; then
    unit
  else
    rest="${rest:+$rest,}$step"
  fi
done
[ -z "$rest" ] || exec sh ds-bot/dev/check.sh --only "$rest"
