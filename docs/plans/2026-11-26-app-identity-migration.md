# Anbot's own application identity (2026-11-26)

## Why

Until this change the desktop app shipped upstream DS Bot's identifiers: bundle id
`io.github.fei2411.dsbot` and the Windows installer GUID `32c46dfc-ed78-5d41-85a4-a3c7f083f2e0`.
That was deliberate — it let an Anbot build replace an installed DS Bot in place, keeping the
shell data and the keychain entry — but it also meant macOS, LaunchServices, Windows' Add/Remove
Programs and the NSIS upgrade registry all treated Anbot as DS Bot. A public Anbot release could
not sit beside an upstream DS Bot, and every macOS permission (Screen Recording, Accessibility,
notifications) was attributed to a product Anbot is not.

Anbot now uses `io.github.rml4791lol-lang.anbot` and the installer GUID
`a446109a-7d6f-45b8-95af-d6ddc6075a51`. The GUID is fixed from here on: changing it again makes
Windows keep two entries for one product.

## Who is affected

| Where | Effect |
|---|---|
| This machine (macOS) | Same app path (`/Applications/DS Bot.app`), same shell data folder (`~/Library/Application Support/DS Bot`), same data folder (`~/.ds-bot`), same keychain item. macOS sees a different bundle, so Screen Recording and Accessibility grants must be given again for computer use. |
| Any other machine that installed Anbot before this change | On macOS the installer replaces the app in the same path; permissions are asked again. On Windows an Anbot installer built after this change is a new product entry: it does not upgrade the earlier Anbot, and the user should uninstall the old entry first. |
| An installed upstream DS Bot | Not replaced any more on Windows. On macOS the two can live side by side. The Debian packages keep `--replaces=dsbot` / `--conflicts=dsbot`, so apt still refuses two side by side. |
| Mobile app, Docker images | Untouched; they keep their own package names until their own phase. |

## What stays the same on purpose

- `app/src/legacy.mjs` still lists `['DS Bot', 'DeepSeek Bot']`. A start that finds one of those
  shell folders reuses it, and keeps the keychain identity Electron captured from its name, so
  Chromium cookies, the ChatGPT sign-in record and the safe-storage key keep working.
- `~/.ds-bot` and `~/DS Bot` stay in use: `locations.json` in the shell folder records them, and
  `app/src/place.mjs` still falls back to them when `~/.anbot` does not exist.
- `bot/secrets.json` stays where it is. It is plain `{version: 1, secrets: […]}` here, not the
  passphrase-encrypted form, so there is no key to unlock for it.

## Rehearsal (2026-11-26, cloned data, real app bundle)

Ran the packaged candidate (bundle id `io.github.rml4791lol-lang.anbot`) against a clone of the
live data folder and a clone of the shell folder, with the clone's `locations.json` pointing at
the clone. Then `app/scripts/verify-install.mjs` against the clone's saved `bot/state.json`:

```
{"bots":16,"groups":2,"settingsKept":true,"historyOpened":true,"diagnostics":true,
 "updateRepository":"https://github.com/rml4791lol-lang/Anbot","genuiLoaded":true,"activeTurns":0}
```

- The team opened: 16 Bots with their settings, 2 groups.
- Old chat was readable (`historyOpened`, which reads the Main Bot's chat from the saved part).
- Secrets: `bot/secrets.json` holds three entries in the plain version-1 form, so nothing needs a
  key. There is no `chatgpt-signin.enc` in the live shell data, so no safe-storage record to
  unlock. With the real home the app keeps the legacy `DS Bot` shell folder, and therefore the
  `DS Bot Safe Storage` keychain item its Chromium cookies were encrypted with.

What the rehearsal could not cover: the start that discovers `DS Bot` from a modified `HOME`. The
candidate exits before logging under a fake home, and that is not something this change alters
(the lookup is by folder name, not bundle id). The installed app was checked after the swap
instead, below.

## Rollback

The install keeps the previous app in `~/.ds-bot/archive/pre-anbot-<label>.*`. To go back by
hand: quit Anbot, move the current `/Applications/DS Bot.app` aside, move
`<backup>/DS Bot.before-swap.app` to `/Applications/DS Bot.app`, and open it. The data folders
are untouched by the identity change, so the older app reads them as before. The keychain item
and the shell folder are shared, so no data has to be restored.

## How the install was done

`app/scripts/install-local.sh` refuses a candidate whose bundle identifier differs from the
installed app; the identity change is the one replacement it allows, and only with
`ANBOT_ALLOW_IDENTITY=1` and only for `io.github.rml4791lol-lang.anbot`. Without that variable the
check is unchanged.
