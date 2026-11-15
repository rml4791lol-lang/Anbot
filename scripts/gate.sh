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
# the failing step's own. Two runs in one repository do not overlap: the second names the run that
# holds the lock and exits 1.
set -eu

root="$(git rev-parse --show-toplevel)"
cd "$root"

gate_steps="${GATE_STEPS:-unit,build,lint}"
steps=""
for step in $(printf '%s' "$gate_steps" | tr ',' ' '); do
  steps="${steps:+$steps }$step"
done
if [ -z "$steps" ]; then
  echo "gate: GATE_STEPS='$gate_steps' names no steps; use unit, build or lint" >&2
  exit 2
fi

# The three installs a fresh worktree lacks. Without them every step fails on a missing module,
# which says nothing about the change being gated.
missing=0
if [ ! -d "$root/ds-bot/node_modules" ]; then
  echo "gate: ds-bot/node_modules missing at $root/ds-bot/node_modules; run: (cd ds-bot && npm ci)" >&2
  missing=1
fi
if [ ! -d "$root/link/node_modules" ]; then
  echo "gate: link/node_modules missing at $root/link/node_modules; run: npm ci --prefix link" >&2
  missing=1
fi
# A worktree has no dev/harness of its own, and without it the suite cannot load its packages: the
# main checkout beside it has one. In the main checkout itself this finds the same directory.
if [ -z "${DSH_HARNESS:-}" ]; then
  harness="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/ds-bot/dev/harness"
else
  harness="$DSH_HARNESS"
fi
if [ ! -d "$harness/node_modules" ]; then
  echo "gate: DSH_HARNESS node_modules missing at $harness/node_modules; run: (cd ds-bot && npm run harness)" >&2
  missing=1
fi
if [ "$missing" -ne 0 ]; then
  exit 1
fi
if [ -z "${DSH_HARNESS:-}" ]; then
  export DSH_HARNESS="$harness"
fi

# The borrowed harness link and dev/check.sh's screenshot directory are shared by every run in the
# repository, and two runs used to delete each other's files. The lock lives in the common git dir,
# so it covers every worktree. A live owner fails fast: waiting would only repeat the same answer
# later, and the owner is named so it can be looked at. A lock whose owner died is stale and is
# cleared; the retry loop covers the moment between mkdir and the owner write.
lock="$(git rev-parse --path-format=absolute --git-common-dir)/gate.lock"
tries=0
while ! mkdir "$lock" 2>/dev/null; do
  owner=""
  if [ -f "$lock/owner" ]; then
    owner="$(cat "$lock/owner")"
  fi
  if [ -n "$owner" ]; then
    owner_pid="$(printf '%s\n' "$owner" | sed -n 's/^pid=\([0-9][0-9]*\) .*/\1/p')"
    owner_host="$(printf '%s\n' "$owner" | sed -n 's/^pid=[0-9][0-9]* host=\([^ ]*\) .*/\1/p')"
    if [ -n "$owner_pid" ] && { [ "$owner_host" != "$(hostname)" ] || kill -0 "$owner_pid" 2>/dev/null; }; then
      echo "another gate is running in this repository ($owner)" >&2
      exit 1
    fi
    rm -rf "$lock"
    continue
  fi
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "another gate is running in this repository ($lock)" >&2
    exit 1
  fi
  sleep 5
done
printf 'pid=%s host=%s started=%s\n' "$$" "$(hostname)" "$(date '+%Y-%m-%dT%H:%M:%S')" >"$lock/owner"

# settings-shell.test.js loads its packages from this checkout's dev/harness whatever
# DSH_HARNESS says, and a worktree has no install of its own: borrow the main checkout's for the
# length of the unit run. A killed run can leave the link behind, dangling or live; either one
# would fool a later `-e` or `-d`, so it is removed before deciding and again on every exit path.
# `.gitignore`'s `node_modules/` matches directories only, so the link is an untracked file while
# it exists and must not outlive the run.
harness_link=ds-bot/dev/harness/node_modules
harness_link_made=""
cleanup() {
  if [ -n "$harness_link_made" ]; then
    rm -f "$harness_link"
  fi
  rm -rf "$lock"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM HUP

borrow_harness() {
  if [ -L "$harness_link" ]; then
    rm -f "$harness_link"
  fi
  if [ -d "$harness_link" ]; then
    return 0
  fi
  main_harness="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/ds-bot/dev/harness/node_modules"
  if [ ! -d "$main_harness" ]; then
    return 0
  fi
  ln -s "$main_harness" "$harness_link"
  harness_link_made=1
}

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
for step in $steps; do
  if [ "$step" = unit ]; then
    borrow_harness
    unit
    if [ -n "$harness_link_made" ]; then
      rm -f "$harness_link"
      harness_link_made=""
    fi
  else
    rest="${rest:+$rest,}$step"
  fi
done
# Not exec: the EXIT trap has to run.
if [ -n "$rest" ]; then
  sh ds-bot/dev/check.sh --only "$rest"
fi
