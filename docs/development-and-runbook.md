# Anbot development and runbook

Use Node.js 24 for development and packages, as the [test workflow](../.github/workflows/test.yml) does. Run `npm run setup`, `npm test`, `npm run build`, `node scripts/build-client.mjs --check` and `npm run lint` in `ds-bot/`. Commit generated `ds-bot/client.js` when client sources change. Use the isolated bench described in [AGENTS.md](../AGENTS.md) for DSH host changes.

Run `npm ci`, `npm test` and `npm run build` in `app/`. Run `npm run pack` to build a local package and `npm run check-packed` to start and exercise that package in throwaway directories. The [release checklist](dev/release-checklist.md) covers platform verification. Start release notes from the [bilingual template](../.github/release-notes-template.md).

The smoke test needs a DeepSeek Harness checkout with its dependencies installed. `dev/bench.sh` looks for `deepseek-harness` beside the checkout and beside the main worktree. From a linked worktree elsewhere, set `DSH_HARNESS` to the checkout.

## Updating the installed macOS app from a local build

Build and check the package first: `npm test`, `node scripts/build-client.mjs --check`, `npm run lint` and the smoke test in `ds-bot/`, then `npm test`, `npm run build`, `npm run pack` and `npm run check-packed` in `app/`. Take the SHA-256 of `dist-pack/mac-arm64/Anbot.app/Contents/Resources/app.asar`, then run from `app/`:

```sh
scripts/install-local.sh dist-pack/mac-arm64/Anbot.app <app.asar sha256> <label>
```

The script refuses a package with another hash, bundle identifier or executable name, so the shell data and keychain identity stay the same. It copies the installed app, the data folder (without its `archive/`) and the shell data into `~/.ds-bot/archive/pre-anbot-<label>.*`, then quits the app. It refuses to swap if the app keeps running. After the swap it starts the app with a debugging port and runs [`verify-install.mjs`](../app/scripts/verify-install.mjs). That check compares Bot IDs and settings, groups, the Main Bot's chat, diagnostics, the update repository and the GenUI client with the saved state. Then the script restarts the app normally and waits for the team window. A failure at any step puts the previous app back.

Quit when no Bot is working. An interrupted turn gets one automatic continuation on the next start. To roll back by hand, quit the app, move it aside and move `<backup>/DS Bot.before-swap.app` to `/Applications/DS Bot.app`. Restore a data snapshot only when the older build cannot read the current data. Each backup holds a full copy of the app and the data folder, so remove old `pre-anbot-*` folders once a build has proved itself.

The [release workflow](../.github/workflows/release.yml) targets the independent Anbot repository. Its private release assets require an authenticated browser or CLI for manual downloads. An installed app can use an explicitly configured update feed through `ANBOT_UPDATE_URL` or the legacy `DS_BOT_UPDATE_URL`. Keep credentials outside repository and package configuration.
