#!/bin/sh
# Tests for scripts/gate.sh, its hooks and scripts/install-hooks.sh: the repository lock, the
# setup preflight, the borrowed harness link, the step list, the dev/check.sh build step and its
# screenshot directory, and the pre-commit hook. ds-bot/test/gate.test.js runs this under
# `npm test`; each test drives the real scripts against a throwaway repository.
#
#   sh scripts/gate.test.sh
set -u

src="$(cd "$(dirname "$0")/.." && pwd)"
base=${TMPDIR:-/tmp}
# The physical path: git reports a checkout's root with symlinks resolved (/private/var on macOS),
# and every path the gate prints is compared against these.
tmp="$(cd "$(mktemp -d "${base%/}/gate-test.XXXXXX")" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT

failed=0
ran=0
pass() { ran=$((ran + 1)); printf 'ok %s\n' "$1"; }
fail() { ran=$((ran + 1)); failed=$((failed + 1)); printf 'not ok %s: %s\n' "$1" "$2"; }
expect_exit() { if [ "$2" -eq "$1" ]; then pass "$3"; else fail "$3" "exit $2, want $1"; fi; }
expect_nonzero() { if [ "$1" -ne 0 ]; then pass "$2"; else fail "$2" "exit 0, want non-zero"; fi; }
expect_in() { if grep -Fq -- "$2" "$1"; then pass "$3"; else fail "$3" "'$2' is not in: $(tr '\n' '|' <"$1")"; fi; }
expect_not_in() { if grep -Fq -- "$2" "$1"; then fail "$3" "'$2' is in: $(tr '\n' '|' <"$1")"; else pass "$3"; fi; }

# An empty repository on main with a commit, so worktrees can be added to it.
repo() {
  mkdir -p "$1"
  git -C "$1" init -q -b main
  git -C "$1" config user.email gate-test@example.invalid
  git -C "$1" config user.name "Gate Test"
  git -C "$1" config commit.gpgsign false
  : >"$1/README"
  git -C "$1" add README
  git -C "$1" commit -qm init
}

# The three installs the preflight looks for, as empty directories.
installs() {
  mkdir -p "$1/ds-bot/node_modules" "$1/link/node_modules" "$1/ds-bot/dev/harness/node_modules"
}

# Run a command in a directory and drop its output in a file; the status is the command's.
run() {
  dir=$1; out=$2; shift 2
  ( cd "$dir" && "$@" ) >"$out" 2>&1
}

# dev/check.sh with its build step stubbed; $2 is build-link.mjs's exit code.
check_stub() {
  mkdir -p "$1/ds-bot/node_modules" "$1/link/node_modules" "$1/ds-bot/dev/harness/node_modules"
  mkdir -p "$1/ds-bot/scripts" "$1/ds-bot/dev/desktop-linux"
  cp "$src/ds-bot/dev/check.sh" "$1/ds-bot/dev/check.sh"
  printf 'process.exit(0)\n' >"$1/ds-bot/scripts/build-client.mjs"
  printf 'process.exit(%s)\n' "$2" >"$1/ds-bot/scripts/build-link.mjs"
  printf '#!/bin/sh\nexit 0\n' >"$1/ds-bot/dev/bench.sh"
  printf '#!/bin/sh\nexit 0\n' >"$1/ds-bot/dev/desktop-linux/desktop.sh"
  chmod +x "$1/ds-bot/dev/bench.sh" "$1/ds-bot/dev/desktop-linux/desktop.sh"
}

empty_steps() {
  t="$tmp/empty-steps"; repo "$t"
  run "$t" "$t.out" env DSH_HARNESS= GATE_STEPS=, sh "$src/scripts/gate.sh"; st=$?
  expect_exit 2 "$st" "GATE_STEPS=',' exits 2"
  expect_in "$t.out" "names no steps" "GATE_STEPS=',' says why"
  run "$t" "$t.out" env DSH_HARNESS= GATE_STEPS=" " sh "$src/scripts/gate.sh"; st=$?
  expect_exit 2 "$st" "GATE_STEPS=' ' exits 2"
  expect_in "$t.out" "names no steps" "GATE_STEPS=' ' says why"
}

lock_held() {
  t="$tmp/lock-held"; repo "$t"; installs "$t"
  mkdir -p "$t/.git/gate.lock"
  printf 'pid=%s host=%s started=2026-01-01T00:00:00\n' "$$" "$(hostname)" >"$t/.git/gate.lock/owner"
  run "$t" "$t.out" env DSH_HARNESS= GATE_STEPS=build sh "$src/scripts/gate.sh"; st=$?
  expect_exit 1 "$st" "a held lock makes the gate exit 1"
  expect_in "$t.out" "another gate is running in this repository" "the held lock says so"
  expect_in "$t.out" "pid=$$ host=" "the held lock names its owner"
}

concurrent() {
  t="$tmp/concurrent"; repo "$t"; installs "$t"
  printf '#!/bin/sh\nsleep 2\n' >"$t/ds-bot/dev/check.sh"
  ( cd "$t" && DSH_HARNESS= GATE_STEPS=build sh "$src/scripts/gate.sh" ) >"$t.a" 2>&1 &
  apid=$!
  sleep 1
  ( cd "$t" && DSH_HARNESS= GATE_STEPS=build sh "$src/scripts/gate.sh" ) >"$t.b" 2>&1; bst=$?
  expect_exit 1 "$bst" "a second concurrent gate exits 1"
  expect_in "$t.b" "another gate is running in this repository" "the second gate says another is running"
  wait "$apid"; ast=$?
  expect_exit 0 "$ast" "the first gate finishes"
  if [ ! -e "$t/.git/gate.lock" ]; then pass "the lock is gone after the run"; else fail "the lock is gone after the run" "$t/.git/gate.lock remains"; fi
}

stale_lock() {
  t="$tmp/stale-lock"; repo "$t"; installs "$t"
  printf '#!/bin/sh\nexit 0\n' >"$t/ds-bot/dev/check.sh"
  sh -c 'exit 0' >/dev/null 2>&1 &
  dead=$!
  wait "$dead" 2>/dev/null || true
  mkdir -p "$t/.git/gate.lock"
  printf 'pid=%s host=%s started=2026-01-01T00:00:00\n' "$dead" "$(hostname)" >"$t/.git/gate.lock/owner"
  run "$t" "$t.out" env DSH_HARNESS= GATE_STEPS=build sh "$src/scripts/gate.sh"; st=$?
  expect_exit 0 "$st" "a lock whose owner is gone is cleared"
}

preflight() {
  t="$tmp/preflight"; repo "$t"
  run "$t" "$t.out" env DSH_HARNESS= GATE_STEPS=build sh "$src/scripts/gate.sh"; st=$?
  expect_exit 1 "$st" "a checkout without installs exits 1"
  expect_in "$t.out" "ds-bot/node_modules missing at $t/ds-bot/node_modules" "the preflight names ds-bot/node_modules"
  expect_in "$t.out" "run: (cd ds-bot && npm ci)" "the preflight gives npm ci"
  expect_in "$t.out" "link/node_modules missing at $t/link/node_modules" "the preflight names link/node_modules"
  expect_in "$t.out" "run: npm ci --prefix link" "the preflight gives npm ci --prefix link"
  expect_in "$t.out" "DSH_HARNESS node_modules missing at $t/ds-bot/dev/harness/node_modules" "the preflight names the harness"
  expect_in "$t.out" "run: (cd ds-bot && npm run harness)" "the preflight gives npm run harness"
  expect_not_in "$t.out" "Cannot find module" "no module error instead of the preflight"

  t="$tmp/preflight-link"; repo "$t"
  mkdir -p "$t/ds-bot/node_modules" "$t/ds-bot/dev/harness/node_modules"
  run "$t" "$t.out" env DSH_HARNESS= GATE_STEPS=build sh "$src/scripts/gate.sh"; st=$?
  expect_exit 1 "$st" "only link/node_modules missing exits 1"
  expect_in "$t.out" "link/node_modules missing at $t/link/node_modules" "only the missing link is named"
  expect_not_in "$t.out" "run: (cd ds-bot && npm ci)" "the installed ds-bot is not reported"

  t="$tmp/preflight-harness"; repo "$t"
  mkdir -p "$t/ds-bot/node_modules" "$t/link/node_modules"
  run "$t" "$t.out" env DSH_HARNESS= GATE_STEPS=build sh "$src/scripts/gate.sh"; st=$?
  expect_exit 1 "$st" "only the harness missing exits 1"
  expect_in "$t.out" "run: (cd ds-bot && npm run harness)" "the missing harness gives npm run harness"
  expect_not_in "$t.out" "run: npm ci --prefix link" "the installed link is not reported"

  t="$tmp/preflight-dsh"; repo "$t"; installs "$t"
  run "$t" "$t.out" env DSH_HARNESS="$t/gone" GATE_STEPS=build sh "$src/scripts/gate.sh"; st=$?
  expect_exit 1 "$st" "a DSH_HARNESS without node_modules exits 1"
  expect_in "$t.out" "DSH_HARNESS node_modules missing at $t/gone/node_modules" "the preflight names the resolved checkout"
}

# A main checkout with the main harness install, and a worktree of it with a stub unit suite.
unit_worktree() {
  repo "$1"
  mkdir -p "$1/ds-bot/node_modules" "$1/link/node_modules" "$1/ds-bot/dev/harness/node_modules"
  git -C "$1" worktree add -q "$2" -b wt
  mkdir -p "$2/ds-bot/node_modules" "$2/link/node_modules" "$2/ds-bot/dev/harness" "$2/ds-bot/test"
  : >"$2/ds-bot/test/harness-resolve.mjs"
  : >"$2/ds-bot/test/drain.mjs"
  printf "import test from 'node:test'\ntest('stub', () => {})\n" >"$2/ds-bot/test/one.test.js"
}

dangling_link() {
  t="$tmp/dangling"; unit_worktree "$t/main" "$t/wt"
  link="$t/wt/ds-bot/dev/harness/node_modules"
  ln -s "$t/gone" "$link"
  run "$t/wt" "$t.out" env DSH_HARNESS= GATE_STEPS=unit sh "$src/scripts/gate.sh"; st=$?
  expect_exit 0 "$st" "a dangling harness link does not fail the gate"
  if [ ! -e "$link" ] && [ ! -L "$link" ]; then pass "the dangling link is cleared"; else fail "the dangling link is cleared" "$link remains"; fi
}

live_link() {
  t="$tmp/live"; unit_worktree "$t/main" "$t/wt"
  link="$t/wt/ds-bot/dev/harness/node_modules"
  ln -s "$t/main/ds-bot/dev/harness/node_modules" "$link"
  run "$t/wt" "$t.out" env DSH_HARNESS= GATE_STEPS=unit sh "$src/scripts/gate.sh"; st=$?
  expect_exit 0 "$st" "a leftover live harness link does not fail the gate"
  if [ ! -e "$link" ] && [ ! -L "$link" ]; then pass "the leftover link is removed after the unit step"; else fail "the leftover link is removed after the unit step" "$link remains"; fi
}

check_build_link() {
  t="$tmp/check-link"; repo "$t"; check_stub "$t" 1
  run "$t" "$t.out" sh ds-bot/dev/check.sh --only build; st=$?
  expect_nonzero "$st" "dev/check.sh fails when link.js is stale"
  expect_in "$t.out" "check failed: build" "the stale link.js is the failing step"
}

check_out() {
  t="$tmp/check-out"; repo "$t"; check_stub "$t" 0
  run "$t" "$t.a" sh ds-bot/dev/check.sh --only build; ast=$?
  run "$t" "$t.b" sh ds-bot/dev/check.sh --only build; bst=$?
  expect_exit 0 "$ast" "dev/check.sh build passes with stub scripts"
  expect_exit 0 "$bst" "dev/check.sh build passes twice"
  a="$(sed -n 's/^total .*screenshots: //p' "$t.a")"
  b="$(sed -n 's/^total .*screenshots: //p' "$t.b")"
  case "$a" in
    */shots/check-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9]*) pass "the screenshot directory carries seconds and the pid" ;;
    *) fail "the screenshot directory carries seconds and the pid" "got '$a'" ;;
  esac
  if [ "$a" != "$b" ]; then pass "two runs write to different screenshot directories"; else fail "two runs write to different screenshot directories" "both wrote $a"; fi
}

# A scratch repository with the real hooks and a gate stub that refuses.
hook_repo() {
  repo "$1"
  mkdir -p "$1/.githooks" "$1/scripts"
  cp "$src/.githooks/pre-merge-commit" "$1/.githooks/pre-merge-commit"
  if [ -f "$src/.githooks/pre-commit" ]; then cp "$src/.githooks/pre-commit" "$1/.githooks/pre-commit"; fi
  chmod +x "$1/.githooks/pre-merge-commit"
  [ ! -f "$1/.githooks/pre-commit" ] || chmod +x "$1/.githooks/pre-commit"
  printf '#!/bin/sh\necho "gate stub refuses" >&2\nexit 1\n' >"$1/scripts/gate.sh"
  chmod +x "$1/scripts/gate.sh"
  git -C "$1" config core.hooksPath .githooks
}

pre_commit_bypass() {
  t="$tmp/pre-commit"; hook_repo "$t"
  git -C "$t" checkout -qb feature
  : >"$t/feature-file"
  git -C "$t" add feature-file
  git -C "$t" commit -qm feature
  git -C "$t" checkout -q main
  run "$t" "$t.out" git merge --no-ff -m "merge feature" feature; st=$?
  expect_nonzero "$st" "the merge into main is refused"
  expect_in "$t.out" "gate stub refuses" "the merge ran the gate"
  if [ -f "$t/.git/MERGE_HEAD" ]; then pass "the refused merge stays open"; else fail "the refused merge stays open" "no MERGE_HEAD"; fi
  run "$t" "$t.out" git commit --no-edit; st=$?
  expect_nonzero "$st" "git commit cannot bypass the gate"
  expect_in "$t.out" "gate stub refuses" "git commit ran the gate too"
}

pre_commit_plain() {
  t="$tmp/pre-commit-plain"; hook_repo "$t"
  : >"$t/plain"
  git -C "$t" add plain
  run "$t" "$t.out" git commit -qm plain; st=$?
  expect_exit 0 "$st" "a plain commit on main is not gated"
}

install_hooks() {
  t="$tmp/install-hooks"; repo "$t"
  mkdir -p "$t/.githooks" "$t/scripts"
  cp "$src/scripts/install-hooks.sh" "$t/scripts/install-hooks.sh"
  run "$t" "$t.out" sh scripts/install-hooks.sh; st=$?
  expect_exit 0 "$st" "installing into an unset core.hooksPath works"
  expect_in "$t.out" "core.hooksPath was unset" "the unset value is printed"
  if [ "$(git -C "$t" config core.hooksPath)" = .githooks ]; then pass "core.hooksPath is .githooks"; else fail "core.hooksPath is .githooks" "got $(git -C "$t" config core.hooksPath)"; fi
  run "$t" "$t.out" sh scripts/install-hooks.sh; st=$?
  expect_exit 0 "$st" "re-running with .githooks needs no force"

  git -C "$t" config core.hooksPath .husky
  run "$t" "$t.out" sh scripts/install-hooks.sh; st=$?
  expect_exit 1 "$st" "a different core.hooksPath is refused"
  expect_in "$t.out" "core.hooksPath was .husky" "the previous value is printed"
  if [ "$(git -C "$t" config core.hooksPath)" = .husky ]; then pass "the refused value is left alone"; else fail "the refused value is left alone" "got $(git -C "$t" config core.hooksPath)"; fi

  run "$t" "$t.out" sh scripts/install-hooks.sh --force; st=$?
  expect_exit 0 "$st" "--force replaces the value"
  if [ "$(git -C "$t" config core.hooksPath)" = .githooks ]; then pass "--force leaves .githooks"; else fail "--force leaves .githooks" "got $(git -C "$t" config core.hooksPath)"; fi
}

empty_steps
lock_held
concurrent
stale_lock
preflight
dangling_link
live_link
check_build_link
check_out
pre_commit_bypass
pre_commit_plain
install_hooks

printf '\n%d tests, %d failed\n' "$ran" "$failed"
[ "$failed" -eq 0 ]
