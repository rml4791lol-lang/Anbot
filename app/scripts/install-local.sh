#!/bin/bash
# Replace the installed macOS app with a locally built package and keep a way back.
#
#   app/scripts/install-local.sh <candidate.app> <app.asar sha256> [label]
#
# Backs up the installed app, the data folder and the shell data, quits the app, swaps the
# bundle, starts the new one with a debugging port, checks it against the saved Bot state
# (scripts/verify-install.mjs), quits it, and starts it the normal way. Any failure puts the
# previous app back. User data is never written; the backup is a copy.
# Environment: ANBOT_TARGET (default /Applications/DS Bot.app), ANBOT_DATA (~/.ds-bot),
# ANBOT_SHELL ("~/Library/Application Support/DS Bot"), ANBOT_ALLOW_IDENTITY=1 (2026-11-26
# identity change: replace an app of another bundle identifier, or install beside it, with
# an app whose bundle identifier is Anbot's own).
set -Eeuo pipefail
umask 077
candidate=${1:?usage: install-local.sh <candidate.app> <app.asar sha256> [label]}
expected=${2:?usage: install-local.sh <candidate.app> <app.asar sha256> [label]}
label=${3:-local}
case "$label" in *[!A-Za-z0-9._-]*|'') echo 'label must match [A-Za-z0-9._-]+' >&2; exit 2 ;; esac
here=$(cd "$(dirname "$0")/.." && pwd)
target=${ANBOT_TARGET:-/Applications/DS Bot.app}
profile=${ANBOT_DATA:-$HOME/.ds-bot}
shell_data=${ANBOT_SHELL:-$HOME/Library/Application Support/DS Bot}
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist"; }

# A fixed-string match on the command line: the path has spaces and dots.
running() {
  ps -axo command= | awk -v exe="$exe" 'index($0, exe) == 1 && (length($0) == length(exe) || substr($0, length(exe) + 1, 1) == " ") { found = 1 } END { exit !found }'
}
wait_exit() {
  for ((i = 0; i < ${1:-45}; i++)); do
    running || return 0
    sleep 0.5
  done
  return 1
}
quit() {
  if running; then
    /usr/bin/osascript -e 'with timeout of 6 seconds' -e "tell application \"$target\" to quit" -e 'end timeout' || true
  fi
}

identity=io.github.rml4791lol-lang.anbot
codesign --verify --deep --strict "$candidate"
test "$(shasum -a 256 "$candidate/Contents/Resources/app.asar" | awk '{print $1}')" = "$expected"
target_existed=0
if [[ -d "$target" ]]; then
  target_existed=1
  codesign --verify --deep --strict "$target"
  exe_name=$(plist "$target" CFBundleExecutable)
  test "$(plist "$candidate" CFBundleExecutable)" = "$exe_name"
  # The same bundle identifier keeps the shell data, keychain entry and process; the identity
  # change of 2026-11-26 is the one replacement that differs, and only for Anbot's own id.
  if [[ "${ANBOT_ALLOW_IDENTITY:-}" == "1" ]]; then
    test "$(plist "$candidate" CFBundleIdentifier)" = "$identity"
  else
    test "$(plist "$candidate" CFBundleIdentifier)" = "$(plist "$target" CFBundleIdentifier)"
  fi
else
  # A missing target is a fresh copy, never a typo'd path: only an explicit identity install.
  [[ "${ANBOT_ALLOW_IDENTITY:-}" == "1" ]] || { echo "No app at $target." >&2; exit 2; }
  test "$(plist "$candidate" CFBundleIdentifier)" = "$identity"
  exe_name=$(plist "$candidate" CFBundleExecutable)
fi
exe="$target/Contents/MacOS/$exe_name"
test -f "$profile/bot/state.json"
test -f "$shell_data/locations.json"

mkdir -p "$profile/archive"
backup=$(mktemp -d "$profile/archive/pre-anbot-$label.XXXXXXXX")
stage=$(mktemp -d "$(dirname "$target")/.anbot-$label.XXXXXXXX")
old_stage="$stage/pre-swap.app"
new_stage="$stage/new.app"

rollback() {
  rc=$?
  trap - ERR
  echo "Install did not finish; backup: $backup" >&2
  if [[ -d "$old_stage" ]]; then
    quit
    if wait_exit 30; then
      [[ -e "$target" ]] && mv "$target" "$stage/failed.app"
      mv "$old_stage" "$target"
      open "$target"
      echo 'The previous app is back.' >&2
    else
      echo "The app did not quit. The previous app is at $old_stage." >&2
    fi
  elif [[ "$target_existed" == "0" && -d "$target" ]]; then
    # A fresh copy: nothing to put back, so it goes away again.
    quit
    if wait_exit 30; then rm -rf "$target"; fi
  elif [[ -d "$target" ]] && ! running; then
    open "$target"
  fi
  exit "$rc"
}
trap rollback ERR

mkdir "$backup/profile-snapshot" "$backup/electron-support"
if [[ "$target_existed" == "1" ]]; then cp -cR "$target" "$backup/$(basename "$target")"; fi
cp -cR "$candidate" "$new_stage"
codesign --verify --deep --strict "$new_stage"
quit
if ! wait_exit 50; then
  echo 'The app kept running. Nothing was replaced.' >&2
  trap - ERR
  rm -rf "$new_stage" && rmdir "$stage"
  exit 3
fi
# APFS clones share blocks with the originals until either side changes, so a backup of a
# large data folder costs almost no space. cp skips sockets, which the app recreates.
clone_into() {
  local from=$1 into=$2 skip=${3:-} entry
  shopt -s dotglob nullglob
  for entry in "$from"/*; do
    [[ -n "$skip" && "$entry" == "$from/$skip" ]] && continue
    cp -cR "$entry" "$into/"
  done
  shopt -u dotglob nullglob
}
clone_into "$profile" "$backup/profile-snapshot" archive
clone_into "$shell_data" "$backup/electron-support"
test -f "$backup/profile-snapshot/bot/state.json"
test -f "$backup/electron-support/locations.json"
port=$(node -e "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
if [[ "$target_existed" == "1" ]]; then mv "$target" "$old_stage"; fi
mv "$new_stage" "$target"
open "$target" --args --remote-debugging-address=127.0.0.1 --remote-debugging-port="$port"
node "$here/scripts/verify-install.mjs" "$port" "$backup/profile-snapshot/bot/state.json"
quit
wait_exit 50
lines=$(wc -l < "$shell_data/logs/main.log" | tr -d ' ')
open "$target"
for ((i = 0; i < 60; i++)); do
  if running && tail -n "+$((lines + 1))" "$shell_data/logs/main.log" | grep -q 'team window shown'; then
    codesign --verify --deep --strict "$target"
    if [[ "$target_existed" == "1" ]]; then mv "$old_stage" "$backup/$(basename "$target" .app).before-swap.app"; fi
    rmdir "$stage"
    trap - ERR
    printf 'Installed %s; rollback: %s\n' "$label" "$backup"
    exit 0
  fi
  sleep 0.5
done
false
