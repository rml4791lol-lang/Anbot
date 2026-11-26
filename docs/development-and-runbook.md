# Anbot development and runbook

Use Node.js 24 for development and packages, as the [test workflow](../.github/workflows/test.yml) does. Run `npm run setup`, `npm test`, `npm run build`, `node scripts/build-client.mjs --check` and `npm run lint` in `ds-bot/`. Commit generated `ds-bot/client.js` when client sources change. Use the isolated bench described in [AGENTS.md](../AGENTS.md) for DSH host changes.

Run `npm ci`, `npm test` and `npm run build` in `app/`. Run `npm run pack` to build a local package and `npm run check-packed` to start and exercise that package in throwaway directories. The [release checklist](dev/release-checklist.md) covers platform verification. Start release notes from the [bilingual template](../.github/release-notes-template.md).

The smoke test needs a DeepSeek Harness checkout at the DSH version `app/package.json` pins, with its dependencies installed and `pnpm run build:artifacts` run once ([CONTRIBUTING](../CONTRIBUTING.md) has the commands). `dev/bench.sh` looks for `deepseek-harness` beside the checkout and beside the main worktree. From a linked worktree elsewhere, set `DSH_HARNESS` to the checkout.

## Comparing Bot setups on the search-overlay repair

Run `node app/scripts/compare-search-repair.mjs prepare` from the repository root to reproduce the search-overlay regression in two detached worktrees in a temporary Git repository. The command prefers the local npm cache, fetches what it lacks, and prints the comparison directory. Its `comparison.json` records the shared repair prompt, test digest and each arm’s instructions and Skill shortlist.

Use `node app/scripts/compare-search-repair.mjs bind <comparison-directory>` to check the worktree and sandbox bindings in a fresh pinned DSH host. It uses a closed loopback endpoint and sends no repair task. Use `node app/scripts/compare-search-repair.mjs run <comparison-directory>` with `ANBOT_REPAIR_BASE_URL`, `ANBOT_REPAIR_MODEL` and the credential expected by the adapter through `ANBOT_REPAIR_API_KEY`. The provider protocol defaults to `openai-responses` and can be set with `ANBOT_REPAIR_PROTOCOL`. Set `ANBOT_REPAIR_EFFORT` to a level the provider accepts on the wire. The driver declares and reads back that exact level before creating the Bots. Both Bots must reply from the configured route before receiving the repair task. The isolated host closes after the run. The run directory’s `bindings.json` records the observed worktree, Session, model route and tool names.

For the local DeepSeek Responses relay, set `ANBOT_REPAIR_BASE_URL=http://127.0.0.1:15721/v1`, `ANBOT_REPAIR_MODEL=deepseek-v4.1-flash` and `ANBOT_REPAIR_EFFORT=max`. Supply the adapter's bearer value in the launch environment. A local relay that authenticates upstream can accept a non-secret placeholder. Keep actual credentials out of the repository and evidence logs. Run `prepare` again to obtain clean worktrees for each new comparison.

Run `node app/scripts/compare-search-repair.mjs verify <comparison-directory>` to check both candidate diffs and rerun the identical acceptance tests. This also runs at the end of `run`. Use `node app/scripts/compare-search-repair.mjs takeover <DSH-run-directory>` with the same provider credential to reopen the successful run. Both Bots must refuse input during the hold and read a temporary human edit in their original Session after return. The driver records the evidence in `takeover.json`, removes its files and reruns the regression checks.

## Updating the installed macOS app from a local build

Build and check the package first: `npm test`, `node scripts/build-client.mjs --check`, `npm run lint` and the smoke test in `ds-bot/`, then `npm test`, `npm run build`, `npm run pack` and `npm run check-packed` in `app/`. Take the SHA-256 of `dist-pack/mac-arm64/Anbot.app/Contents/Resources/app.asar`, then run from `app/`:

```sh
scripts/install-local.sh dist-pack/mac-arm64/Anbot.app <app.asar sha256> <label>
```

The script refuses a package with another hash, bundle identifier or executable name, so the shell data and keychain identity stay the same. It copies the installed app, the data folder (without its `archive/`) and the shell data into `~/.ds-bot/archive/pre-anbot-<label>.*`, then quits the app. It refuses to swap if the app keeps running. After the swap it starts the app with a debugging port and runs [`verify-install.mjs`](../app/scripts/verify-install.mjs). That check compares Bot IDs and settings, groups, the Main Bot's chat, diagnostics, the update repository and the GenUI client with the saved state. Then the script restarts the app normally and waits for the team window. A failure at any step puts the previous app back. Quit the app first and give it a few quiet seconds: started while the previous copy is still shutting down, the app has been seen to load its start page minutes late (198 s once), and the check then gives up and the install rolls back.

Quit when no Bot is working. An interrupted turn gets one automatic continuation on the next start. To roll back by hand, quit the app, move it aside and move `<backup>/DS Bot.before-swap.app` to `/Applications/DS Bot.app`. Restore a data snapshot only when the older build cannot read the current data. The data snapshots are APFS clones, which take space only as the live data changes afterwards. The app copy also starts as a clone, and the replaced bundle moves into the backup. Remove old `pre-anbot-*` folders once a build has proved itself.

The [release workflow](../.github/workflows/release.yml) targets the independent Anbot repository. Its private release assets require an authenticated browser or CLI for manual downloads. An installed app can use an explicitly configured update feed through `ANBOT_UPDATE_URL` or the legacy `DS_BOT_UPDATE_URL`. Keep credentials outside repository and package configuration.
