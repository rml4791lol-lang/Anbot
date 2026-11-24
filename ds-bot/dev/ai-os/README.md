# DS Bot Reality Harness

The Reality Harness runs a declared task against either an owned mock DS-Bot bench or an
explicitly attached DS-Bot instance. It records execution evidence and only calls a run
complete when its acceptance checks pass.

The harness is developer infrastructure. It uses the existing `/api/bot` endpoint and
`dev/bench.sh`; it does not add an Agent Runtime, task store, Bot roster or model route.

## Setup

```sh
cd ds-bot
npm ci
npm run harness
```

`dev/harness` pins the DSH version used by the tests and now provides the native `dsh`
CLI for mock benches. An explicit `DSH_HARNESS` still takes precedence.

## Commands

```sh
cd ds-bot
node --test test/ai-os-manifest.test.js test/ai-os-evidence.test.js test/ai-os-client.test.js test/ai-os-run.test.js test/ai-os-cli.test.js
npm run aios:manifest
npm run aios:mock
npm run aios:attached
```

The two `aios:*` mock commands run `dev/ai-os/scenarios/restart-team.json` against an owned
bench. The attached command expects a running DS-Bot instance, a reachable base URL, and a
session cookie.

```sh
DSBOT_RUN_COOKIE='<cookie>' npm run aios:attached
# or
node dev/ai-os/cli.mjs \
  --manifest dev/ai-os/scenarios/attached-repository-check.json \
  --mode attached \
  --base-url http://127.0.0.1:3080 \
  --cookie-file /path/to/cookie.txt
```

`--keep` leaves a mock bench and its scratch workspace running for debugging. Stop it with
`dev/bench.sh <name> <web-port> <mock-port> stop`.

## Evidence and boundaries

- Mock mode proves orchestration and state persistence, never model quality.
- Attached mode never starts, stops or restarts the attached process.
- The harness never reads or writes `~/.dsh`.
- `DSBOT_RUN_COOKIE` and cookie files are used only for requests and are redacted from
  evidence. Do not put credentials in manifests.
- `.aios-runs/` and `.dsh-test-aios-*` are disposable local artifacts and are ignored by Git.
- `result.json` is the only machine completion claim. Mock and attached results remain
  separate records and cannot be merged into one claim.

## Run bundle

Each run writes:

- `manifest.json`: the manifest, mode and start time;
- `events.jsonl`: append-only redacted events;
- `evidence.json`: the recorded events;
- `result.json`: the immutable completion result.
