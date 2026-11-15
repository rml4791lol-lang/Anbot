#!/bin/sh
# Bring the current branch up to date with origin/dev.
#
#   scripts/merge-dev.sh
#
# ds-bot/client.js is built from ds-bot/src/client, so a conflict in it is never
# resolved by hand: it is taken from dev and rebuilt once the sources are merged.
# Any other conflict stops the script with the merge still open, to be resolved
# and committed as usual.
#
# A failing scripts/gate.sh (unit, build, lint) puts the branch back where it was before the merge:
# nothing else local checks these, and CI only sees them after a push.
set -eu

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "merge-dev: commit or stash your changes first" >&2
  exit 1
fi

# The hooks are the second gate, never this one: core.hooksPath is shared by every worktree, and
# one that never ran scripts/install-hooks.sh has none. Say so, then carry on.
hooks="$(git config --get core.hooksPath || true)"
if [ -n "$hooks" ]; then
  case "$hooks" in
    /*) hookdir=$hooks ;;
    *) hookdir="$root/$hooks" ;;
  esac
  if [ ! -d "$hookdir" ]; then
    echo "merge-dev: core.hooksPath is $hooks, which is not a directory; the hooks will not run" >&2
  fi
fi

# The commit to come back to if the gate fails. ORIG_HEAD ends up at the same one after a merge,
# but it is the merge that writes it; this reads it first, so the reset does not depend on that.
before="$(git rev-parse HEAD)"

git fetch origin dev
if git merge --no-edit origin/dev; then
  merged=1
else
  merged=0
fi

if [ "$merged" -eq 0 ]; then
  if git diff --name-only --diff-filter=U | grep -qx 'ds-bot/client.js'; then
    git checkout --theirs -- ds-bot/client.js
    git add ds-bot/client.js
  fi
  left="$(git diff --name-only --diff-filter=U)"
  if [ -n "$left" ]; then
    echo "merge-dev: resolve these, then run 'npm run build' in ds-bot and commit:" >&2
    echo "$left" >&2
    exit 1
  fi
fi

# The bundle includes locked packages (deep-view), so a lockfile that changed with the
# merge, or a checkout that never installed, needs `npm ci` before the build.
if [ ! -d ds-bot/node_modules ] || ! git diff --quiet ORIG_HEAD -- ds-bot/package-lock.json; then
  (cd ds-bot && npm ci --no-fund --no-audit >/dev/null)
fi
# The merged sources may differ from both sides' bundles even without a conflict.
(cd ds-bot && npm run build >/dev/null)
git add ds-bot/client.js
# The worktree was clean at the start, so resetting to it throws away only the merge.
if ! sh scripts/gate.sh; then
  echo "merge-dev: gate failed; the branch is back at $before" >&2
  git reset --hard "$before"
  exit 1
fi
if [ "$merged" -eq 0 ]; then
  git commit --no-edit
elif ! git diff --cached --quiet; then
  git commit -m "Rebuild client.js after merging dev"
fi
echo "merge-dev: up to date with origin/dev"
