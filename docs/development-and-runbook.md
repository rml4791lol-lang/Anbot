# Anbot development and runbook

Use Node.js 24 for development and packages, as the [test workflow](../.github/workflows/test.yml) does. Run `npm run setup`, `npm test`, `npm run build`, `node scripts/build-client.mjs --check` and `npm run lint` in `ds-bot/`. Commit generated `ds-bot/client.js` when client sources change. Use the isolated bench described in [AGENTS.md](../AGENTS.md) for DSH host changes.

Run `npm ci`, `npm test` and `npm run build` in `app/`. Run `npm run pack` to build a local package and `npm run check-packed` to start and exercise that package in throwaway directories. The [release checklist](dev/release-checklist.md) covers platform verification. Start release notes from the [bilingual template](../.github/release-notes-template.md).

The [release workflow](../.github/workflows/release.yml) targets the independent Anbot repository. Its private release assets require an authenticated browser or CLI for manual downloads. An installed app can use an explicitly configured update feed through `ANBOT_UPDATE_URL` or the legacy `DS_BOT_UPDATE_URL`. Keep credentials outside repository and package configuration.
