#!/bin/sh
# check.sh on a git worktree must not export a non-existent DSH_HARNESS.
# That value is picked up by test/harness-resolve.mjs and breaks unit tests
# even after `npm run harness` has installed packages in dev/harness.
set -eu
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$PLUGIN/dev/check.sh"
if [ ! -f "$CHECK" ]; then
  echo "missing $CHECK" >&2
  exit 2
fi
# The probe copy must live in dev/ so check.sh still resolves PLUGIN/ROOT/MAIN
# from its real checkout (dirname of the script is dev/).
probe="$PLUGIN/dev/.check-harness-probe.sh"
trap 'rm -f "$probe"' EXIT
cp "$CHECK" "$probe"
python3 - "$probe" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
needle = "export DSH_HARNESS\n"
if needle not in text:
    raise SystemExit('check.sh no longer contains "export DSH_HARNESS"; update this test')
insert = (
    "export DSH_HARNESS\n"
    "if [ -n \"${DSH_HARNESS:-}\" ] && [ ! -d \"$DSH_HARNESS\" ]; then\n"
    "  echo \"POISON DSH_HARNESS=$DSH_HARNESS\"\n"
    "  exit 10\n"
    "fi\n"
    "echo \"DSH_HARNESS=${DSH_HARNESS:-unset}\"\n"
    "exit 0\n"
)
path.write_text(text.replace(needle, insert, 1))
PY
cd "$PLUGIN"
set +e
out=$(env -u DSH_HARNESS sh "$probe" --only lint --out /tmp/dsbot-check-harness-probe-out 2>&1)
st=$?
set -e
printf '%s\n' "$out"
if [ "$st" -eq 10 ] || printf '%s\n' "$out" | grep -q '^POISON DSH_HARNESS='; then
  echo "FAIL: check.sh exported a non-existent DSH_HARNESS in a worktree" >&2
  exit 1
fi
if [ "$st" -ne 0 ]; then
  echo "FAIL: probe exited $st" >&2
  exit 1
fi
echo "OK: check.sh did not export a missing DSH_HARNESS"
