# Third-party components and source-review ledger

Snapshot: 2026-11-16. This ledger records **candidate or adopted third-party technology**, not every transitive npm package. The root [`NOTICE`](NOTICE) remains the legal attribution file for code already shipped. This file records what was inspected, why it was accepted or rejected, and the exact source boundary for future work.

> No source code from the new candidates below was copied into DS-Bot by this research change. References to source paths are evidence links, not vendored code.

## Review rules

Every candidate was checked against the ten required gates:

1. official GitHub repository;
2. official documentation;
3. relevant core source;
4. latest release or, where none exists, the inspected commit;
5. dependencies and runtime;
6. license and licensing boundaries;
7. integration boundary;
8. representative tests;
9. known limitations;
10. maintenance/activity state.

License compatibility is assessed against the Apache-2.0 DS-Bot distribution. AGPL components are therefore kept outside the product boundary unless a later legal and architectural review approves a standalone-service integration.

Where a default-branch HEAD differs from the latest release, the source evidence is pinned to the inspected HEAD commit and the release drift is stated explicitly. A later adoption must re-check the exact tag/commit and its tests before copying or linking anything.

## Native foundations

### DeepSeek Harness
- **Official docs:** `docs/subsystems/` in the inspected repository; the pinned source is the first-party contract.

- **Repository:** https://github.com/deepseek-ai/deepseek-harness
- **Pinned baseline:** `0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`
- **Upstream inspected:** master `0.2.2-rc.3`, commit `39163dd30f70`, committed 2026-11-13
- **License:** MIT
- **Runtime:** TypeScript/Node package family; DS-Bot injects the documented Cordis/DSH services.
- **Source reviewed:** `packages/session/session-persistence/src/index.ts`, `packages/session/session-projection/src/index.ts`, `packages/session-query/session-query/src/index.ts`, `packages/jobs/jobs/src/index.ts`, `packages/schedule/schedule/src/index.ts`, `packages/workflow/workflow/src/index.ts`, `packages/subagent/subagent/src/index.ts`, `packages/experimental/agent-team/src/index.ts`, `packages/compaction/compaction-basic/src/index.ts`, `packages/skill/skill/src/index.ts`, `packages/mcp/mcp-client/src/index.ts`, `packages/interaction/user-approval/src/index.ts`, `packages/interaction/permission-presets/src/index.ts`, `packages/telemetry/otel/src/index.ts`, `packages/llm/llm/src/index.ts`, `packages/llm/llm-retry/src/index.ts`, `packages/llm/token-meter/src/index.ts`, `packages/browser-use/browser-use/src/index.ts`, `packages/computer-use/computer-use/src/index.ts`, `packages/sandbox/sandbox-policy/src/index.ts`, `packages/ssh/ssh/src/index.ts`.
- **Tests/docs reviewed:** `docs/agent-lifecycle.md`, `docs/subsystems/session.md`, `jobs.md`, `schedule.md`, `workflow.md`, `subagent.md`, `agent-team.md`, `compaction.md`, `skills.md`, `mcp.md`, `approval.md`, `permission-presets.md`, `otel.md`, `session-query.md`; corresponding package READMEs and tests.
- **Integration:** **A/B, already adopted.** DS-Bot only uses documented plugin services and never patches DSH internals.
- **Known boundaries:** jobs from `dsh-jobs-local` die with the harness process; the workflow engine explicitly has no journal/resume; the experimental Agent Teams roster/task DAG is tied to a live lead Agent and is not automatically the DS-Bot room model.
- **Decision:** DSH is the only Agent Runtime and the execution substrate for sessions, jobs, schedule, approval, tools, MCP, browser/computer and model calls. Upgrading from `rc.1` to `rc.3` is a separate compatibility project.

### DS-Bot
- **Official docs:** [`README.md`](README.md), [`docs/vision.md`](docs/vision.md), [`docs/design/architecture.md`](docs/design/architecture.md), and [`CONTRIBUTING.md`](CONTRIBUTING.md).

- **Repository:** https://github.com/Fei2411/DS-Bot
- **Product version:** `0.3.6`
- **Local baseline commit:** `26228dfa`
- **License:** Apache-2.0
- **Runtime:** ESM Node plugin for DSH, with a React client bundle and Electron desktop shell.
- **Source reviewed:** host modules under `ds-bot/src/host/`, especially `roster.js`, `store.js`, `turns.js`, `delivery.js`, `groups.js`, `goals.js`, `handoffs.js`, `resume.js`, `task-ledger.js`, `memory*.js`, `parts.js`, `steward.js`, `capabilities.js`, `permissions.js`, `approvals.js`, `schedules.js`, `models.js`, `providers.js`, `usage.js`, `chat-index.js`, `diagnostics.js`; client shell under `ds-bot/src/client/`.
- **Tests reviewed:** the host test suite in `ds-bot/test/`, including `resume-redelivery.test.js`, `handoff-results.test.js`, `handoff-abandon.test.js`, `group-goal.test.js`, `memory.test.js`, `permissions.test.js`, `task-ledger.test.js`, `plugin-entry.test.js` and `client.js` freshness checks.
- **Integration:** **Product authority.** No external project may replace the Bot/team authority or create a second control center.
- **Decision:** Keep and evolve DS-Bot as the product and organization layer.

## Agent and organization candidates

### NousResearch/hermes-agent
- **Official docs:** https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop; session lifecycle, compression and subagent lifecycle pages under the same developer guide.

- **Repository:** https://github.com/NousResearch/hermes-agent
- **Inspected:** release `v0.23.1`; main head `e96221fa73d2`, committed 2026-11-16
- **License:** MIT
- **Runtime/dependencies:** Python `3.11`–`3.14` (`pyproject.toml`; the repository’s `.python-version` is `3.14`), `uv`, desktop/Node and Rust components; not a Node DSH plugin.
- **Core source reviewed:** `agent/conversation_loop.py` (1967 lines), `agent/runtime_session_lifecycle.py`, `agent/interrupt_control.py`, `agent/context_compressor.py`, `agent/context_compressor_window.py`, `agent/memory_manager.py`, `agent/memory_context.py`, `agent/delegation_context.py`, `agent/subagent_lifecycle.py`, `agent/periodic_scheduler.py`, `agent/skill_bundles.py`, `tools/approval.py`, `cron/scheduler.py`, `cron/occurrences.py`, `cron/delivery_queue.py`, `apps/desktop/src/plugins/hermes-bots/group-rounds.ts`.
- **Tests:** broad `tests/` tree with ACP isolation, approval, gateway/session, cron, context and memory tests; for example `tests/agent/test_concurrent_interrupt.py`, `tests/agent/test_context_compressor.py`, `tests/acp_adapter/test_permissions.py`, `apps/desktop/e2e/group-turn-integrity.spec.ts`, cron tests and `evals/compaction/`.
- **Reusable mechanisms observed:** run-budget wrap-up, bounded context compression with tail preservation, delegated-child environment fencing, skill bundles, cron in-flight/stale-claim guards, handoff/reference restoration.
- **Limitations:** large, multi-surface Python agent; importing it would create a second runtime and duplicate DSH session/tool semantics. Its cron store and gateway assumptions are not DS-Bot's persistence model.
- **Reuse mode:** **D. Reference design.**
- **Decision:** Do not import. Use selected invariants as tests/ADRs after reproducing a DS-Bot failure. No code copied.

### NousResearch/Hermes-Bot-Mode
- **Official docs:** the repository README is the primary contract; Hermes has since moved the maintained implementation into Hermes Agent `apps/desktop/src/plugins/hermes-bots/`.

- **Repository:** https://github.com/NousResearch/Hermes-Bot-Mode
- **Inspected:** no release; archived main head `80fee22582b8`, last commit 2026-08-17
- **License:** MIT
- **Runtime/dependencies:** 6461-line JavaScript plugin for the Hermes desktop gateway.
- **Core source reviewed:** `plugin.js`; split across canonical Bot chat pinning, roster watermarks, avatar sync, group rounds, mention-handoff quoting, routines and session hiding.
- **Tests:** `tests/group-chat.test.mjs`, `tests/mention-handoff-quoting.test.mjs`, `tests/canonical-chat-creation.test.mjs`, `tests/roster-*.test.mjs`, `tests/routine-*.test.mjs`, and related session tests.
- **Limitations:** archived; integrally tied to Hermes gateway RPC names and host APIs; monolithic client plugin; repository notice says Bot Mode now ships inside Hermes Agent.
- **Reuse mode:** **C/D; conditional extraction of the pure group-round/watermark/epoch algorithm only.**
- **Decision:** Do not integrate the archived plugin shell. The maintained implementation is in Hermes Agent `apps/desktop/src/plugins/hermes-bots/group-rounds.ts`; extract it behind a DSH/DS-Bot adapter only after a failing group-concurrency test proves the need. Preserve attribution and existing behavior.

### milind-soni/OpenMausBot
- **Official docs:** https://docs.openmausbot.com/ (chat/teams, permissions and automation pages).

- **Repository:** https://github.com/milind-soni/OpenMausBot
- **Inspected:** release `v0.1.161`; main head `5c919b7adb10`, committed 2026-11-16
- **License:** Apache-2.0
- **Runtime/dependencies:** Node `>=24`, pnpm workspace; own server, Electron, cloud/VM, connectors and MCP control plane.
- **Core source reviewed:** `server/runtime/types.ts` (typed assignment states/outcomes/roots/parents/approval/evidence), `server/runtime/store.ts` (atomic assignment + event persistence), `server/runtime/tree.ts` (ancestry, settled descendants, wake ownership, restart notes), `server/runtime/level.ts` (approval inheritance), `server/group-goal-run.ts`, `server/routines.ts`; plus `server/room-round-turns.ts`, `server/room-queue.ts`, `server/decider/room-routing.ts`, `server/host/room-sessions.ts`, `server/bot-automations.ts`, `server/agent-tool-policy.ts`, `server/routine-schedules.ts`, `server/permission-proxy.ts`.
- **Tests:** `server/runtime/runtime.test.ts`, `server/runtime/scenarios.test.ts`, `server/drivers/acp/approval-matrix.test.ts`, `server/group-goal-run.test.ts`, `server/routines.test.ts`, `server/team-lifecycle.e2e.test.ts`, plus room queue/recovery/context and routine tests.
- **Reusable mechanisms observed:** typed assignment ledger and atomic event store, tree/restart semantics, approval inheritance, bounded coordinator/worker turns, sequential room queue, one-turn-per-round accounting, delta-only room prompt, bounded model room router, bot-owned automation cleanup.
- **Limitations:** requires Node `>=24`, pnpm `10.33.0`, Electron and external ACP engines; room scheduler and permission proxy would duplicate DS-Bot `groups.js`/`turns.js` and DSH approval. Only host-level coordination logic is a candidate.
- **Reuse mode:** **C conditionally / D.**
- **Decision:** Do not vendor the server. If the unified TaskRuntime needs a model that DS-Bot’s current goal/handoff records cannot express, extract `runtime/types.ts`, `store.ts`, `tree.ts` and `level.ts` behind a DSH host adapter, after compatibility and attribution review. Current DS-Bot round relay and queue behavior stays authoritative. No code copied.

### anomalyco/opencode
- **Official docs:** https://opencode.ai/docs/ (agents, permissions, compaction and SDK pages).

- **Repository:** https://github.com/anomalyco/opencode
- **Inspected:** release `v2.3.0` (newest release feed entry; GitHub `/latest` metadata was inconsistent and returned `v1.19.5`); default `dev` head `0fad04b3d5a8`, committed 2026-11-16
- **License:** MIT
- **Runtime/dependencies:** Bun/TypeScript monorepo; its own core session database, runner, provider and desktop layers.
- **Core source reviewed:** `packages/core/src/session/runner/step.ts`, `packages/core/src/session/compaction.ts`, `packages/core/src/session/inbox.ts`, `packages/core/src/permission.ts`, `packages/core/src/job.ts`, `packages/core/src/job/recovery.ts`, `packages/core/src/agent.ts`, `packages/core/src/tool/runtime.ts`, plus session execution/restart/subagent files.
- **Tests:** package-local tests, including compaction tests, permission tests, session runner/recovery tests and provider recorded tests.
- **Reusable mechanisms observed:** pre-durable-output compaction, cooperative tool stop, declared permission rulesets, retry before durable output, session restart and subagent reporting.
- **Limitations:** the runner, database and session state form a complete competing runtime; the code is tightly coupled to Effect and OpenCode's own schemas.
- **Reuse mode:** **D. Reference design.**
- **Decision:** Do not import. DSH already owns step lifecycle, tools, compaction and cancellation.

### block/goose (canonical: aaif-goose/goose)
- **Official docs:** https://goose-docs.ai/docs/ (smart context, subagents, tool permissions and GDK).

- **Repository:** https://github.com/block/goose (redirects to https://github.com/aaif-goose/goose)
- **Inspected:** release `v1.59.1`; main head `0bf8b6240720`, committed 2026-11-16
- **License:** Apache-2.0
- **Runtime/dependencies:** Rust workspace; native CLI/desktop and extension/MCP layers.
- **Core source reviewed:** `crates/goose/src/agents/state_machine/mod.rs`, `tool_approval.rs`/`tool_confirmation.rs`, `proactive_compaction.rs`, `subagent_handler.rs`, `tool_execution.rs`, `config/permission.rs`, `permission/permission_judge.rs`, `crates/goose-context-management/`.
- **Tests:** `crates/goose/src/agents/state_machine/tests/` includes approval, compaction lifecycle, cancellation, steering, subagent and reconstruction tests; `crates/goose-agent/tests/tool_approval.rs`.
- **Reusable mechanisms observed:** explicit operation state machine, permission levels plus smart-approval inspection, proactive compaction based on unreported tool tokens, subagent lifecycle and cancellation.
- **Limitations:** Rust and its own state machine/provider architecture; extracting the state machine into DS-Bot would create a second control plane.
- **Reuse mode:** **D. Reference design.**
- **Decision:** Do not add the Rust runtime. Use its state/approval test cases as evidence when improving DS-Bot/DSH.

### badlogic/pi-mono (canonical: earendil-works/pi)
- **Official docs:** https://pi.dev/docs/latest (sessions, compaction, SDK and security).

- **Repository:** https://github.com/badlogic/pi-mono (redirects to https://github.com/earendil-works/pi)
- **Inspected:** release `v1.5.2`; main head `22fc026b872b`, committed 2026-11-15
- **License:** MIT
- **Runtime/dependencies:** Node `>=22.19`, npm workspace; agent package, AI/provider package and coding-agent package.
- **Core source reviewed:** `packages/agent/src/agent-loop.ts` (959 lines), `agent.ts`, `types.ts`; `packages/coding-agent/docs/compaction.md`, `sessions.md`, `session-format.md`.
- **Tests:** `packages/agent/test/agent-loop.test.ts`, `agent.test.ts`, `e2e.test.ts`, tool-typebox and proxy tests; coding-agent session/compaction tests.
- **Reusable mechanisms observed:** sequential/parallel tool policy, tool-loadout diff declarations, truncated-tool-call refusal, append-only Session entries with branch summaries, system-prompt/tool checkpoint compaction and context edits.
- **Limitations:** its Session format and agent loop are a complete alternative runtime; importing would duplicate DSH.
- **Reuse mode:** **D. Reference design.**
- **Decision:** Do not import. Use its invariants to check DSH/DS-Bot Session and compaction behavior.

## Memory and retrieval candidates

### AgentMemoryRepo/agentmemoryrepo
- **Official docs:** https://cognition.com/agent-memory-repo and the repository `SPEC.md`.

- **Repository:** https://github.com/AgentMemoryRepo/agentmemoryrepo
- **Inspected:** no release; main head `8798cb26c817`, committed 2026-10-06
- **License:** MIT
- **Source reviewed:** `SPEC.md` (58 lines), `README.md`, `skills/`.
- **Format contract:** `MEMORY.md` entry point, one bullet per fact, open metadata in `[key: value; ...]`, `[[topic]]` cross-links and source/added provenance.
- **Integration:** **B/D, already adopted as a format contract** in `ds-bot/src/host/memory.js` and `memory-entries.js`.
- **Limitations:** it is a format/spec, not a complete memory runtime; the inspected repository contains no implementation engine or tests. DS-Bot adds scopes, BM25, journal, snapshots, review, tidy and undo.
- **Decision:** Keep compatibility. No runtime dependency or new code copy.

### volcengine/OpenViking
- **Official docs:** https://docs.openviking.ai/ (DSH integration, retrieval, context layers and API).

- **Repository:** https://github.com/volcengine/OpenViking
- **Docs:** https://docs.openviking.ai/
- **Inspected:** release `v0.5.5`; main head `5f53cbf01128`, committed 2026-11-16
- **License:** AGPL-3.0 for the main server/project; the TypeScript SDK (`@openviking/sdk` `0.1.0`) and DSH plugin (`@openviking/dsh-memory-plugin` `0.5.36`) are Apache-2.0. The DSH plugin declares peer packages around DSH `0.1.0-rc.6`.
- **Runtime/dependencies:** Python `>=3.10`, Rust crates, FastAPI service, vector index backends, optional Redis/MySQL, parser stack, LiteLLM and OpenTelemetry dependencies. The TypeScript SDK is Node `>=18`; the DSH plugin expects Node `^22.19 || >=24`.
- **Core source reviewed:** `openviking/core/context.py`, `retrieval_targets.py`, `skill_loader.py`; `openviking/retrieve/context_assembler/pipeline.py`, `tiers.py`, `budget.py`, `memory_lifecycle.py`, `skill_package_retriever.py`; `openviking/service/memory_compile.py`, `resource_memory_link_service.py`, `session_auto_commit.py`; `openviking/storage/context_update_plan.py`.
- **Tests:** large Python test tree covering retrieval, context assembly, memory lifecycle, resources, skills, storage and server behavior.
- **Reusable mechanisms observed:** URI-first candidate tiers (`uri`/`abstract`/`overview`/`full`), breadth-first budget allocation, cross-turn recall dedup ledger, resource/memory/skill unified URIs, memory compile and lifecycle operations.
- **Limitations:** service-scale deployment and AGPL boundary; vector backend is explicitly outside the current DS-Bot memory design; import would add server topology and a second memory authority.
- **Reuse mode:** **D now; B only as an opt-in external Memory Adapter service after legal review and a measured retrieval gap.**
- **Decision:** Do not add to the core or default app. Preserve DS-Bot's Markdown source of truth and local BM25. If pursued later, consume the Apache-2.0 DSH plugin/SDK as an external provider and prove compatibility with the pinned DSH API first; do not embed or fork the AGPL server.

### tommy0103/obelisk
- **Official docs:** repository `README.md`, `packages/dsh-plugin/README.md`, `skill-doc/references/retrieval-semantics.md` and `docs/adr/0012-obelisk-as-dsh-optional-retrieval-plugin.md`.

- **Repository:** https://github.com/tommy0103/obelisk
- **Inspected:** release `v0.2.5`; main head `cc75c2dd1aea`, committed 2026-11-09
- **License:** AGPL-3.0
- **Runtime/dependencies:** Node `>=22.13` CLI/Electron + TypeScript + built-in SQLite; indexes sessions from multiple agent providers.
- **Core source reviewed:** `packages/core/src/indexer.ts`, `schema.sql`, `query.ts`, `provider-indexing.ts`, provider adapters; app indexer worker/service.
- **Tests:** `tests/indexer.test.mjs`, `indexer-readonly.test.mjs`, `indexer-upsert-drift.test.mjs`, `provider-indexing.test.mjs`, Session detail/query tests.
- **Reusable mechanisms observed:** FTS5 external-content tables, BM25 ordering, cursor/drift tracking, message/tool/subagent/workflow relations and read-only index builds.
- **Limitations:** AGPL; a separate Electron app/provider schema; not directly compatible with DS-Bot's DSH-owned session index.
- **Reuse mode:** **D. Already independently implemented in `ds-bot/src/host/chat-index.js`.**
- **Decision:** Do not copy or link. Keep DS-Bot's trigram FTS5/BM25 and safe LIKE fallback.

## Workflow, model and observability candidates

### temporalio/temporal
- **Official docs:** https://docs.temporal.io/ (workflows, activities, retry policies and event history).

- **Repository:** https://github.com/temporalio/temporal
- **Docs:** https://docs.temporal.io/
- **Inspected:** release `v1.32.2`; main head `170fb83dca48`, committed 2026-11-14
- **License:** MIT
- **Runtime/dependencies:** Go `1.27.3` server (inspected `go.mod`), persistence/visibility stores, workers, task queues and cluster deployment.
- **Core source reviewed:** `service/history/workflow/mutable_state_impl.go`, `task_refresher.go`, `workflow_task_state_machine.go`, `retry.go`, `service/history/tasks/activity_retry_timer.go`, `common/backoff/retrypolicy.go`.
- **Tests:** workflow timer/task/recovery/reset tests, history workflow unit tests, retry and visibility tests.
- **Reusable mechanisms observed:** replayable mutable state, workflow/activity task lifecycle, timers, retry policies, worker leases and split-brain fencing.
- **Limitations:** full distributed service and database require a second deployable system; no small extractable module can preserve its reliability semantics.
- **Reuse mode:** **D now; B as a conditional external TaskRuntime backend only after measured recovery failure.**
- **Decision:** Do not introduce a Temporal cluster in this phase. DS-Bot's `resume.js`, handoffs and goal driver remain the default.

### langchain-ai/langgraph
- **Official docs:** https://docs.langchain.com/oss/python/langgraph/overview, persistence, checkpointers and interrupts pages.

- **Repository:** https://github.com/langchain-ai/langgraph
- **Docs:** https://docs.langchain.com/oss/python/langgraph/overview
- **Inspected:** release `1.2.22`; main head `41fb001df931`, committed 2026-11-15
- **License:** MIT
- **Runtime/dependencies:** Python `>=3.10`; `langgraph-checkpoint`, SQLite/Postgres checkpoint packages, LangChain core.
- **Core source reviewed:** `libs/langgraph/langgraph/pregel/_checkpoint.py`, `_loop.py`, `_retry.py`, `_task_status.py`, `graph/state.py`; interruption tests.
- **Tests:** `libs/langgraph/tests/test_interruption.py`, `test_interrupt_state.py`, `test_checkpoint_migration.py`, `test_pregel.py` and checkpoint conformance suites.
- **Reusable mechanisms observed:** immutable checkpoint IDs and channel versions, pending task/interrupt identity, deterministic replay, per-task writes, parallel subgraph interruption semantics.
- **Limitations:** Python state-graph runtime and an alternative execution model; importing would be a second Agent Runtime.
- **Reuse mode:** **D. Reference design.**
- **Decision:** Do not integrate. Use its checkpoint/interrupt invariants to define TaskRuntime acceptance tests.

### BerriAI/litellm
- **Official docs:** https://docs.litellm.ai/docs/ (routing, fallbacks, spend tracking and budgets).

- **Repository:** https://github.com/BerriAI/litellm
- **Docs:** https://docs.litellm.ai/docs/
- **Inspected:** release `v1.109.1`; main head `8d200a4f981a`, committed 2026-11-16
- **License:** MIT outside `litellm/enterprise/`; `litellm/enterprise/LICENSE.md` is a separate BerriAI Enterprise License whose production use requires commercial authorization. Do not copy or depend on the enterprise tree under the MIT assumption.
- **Runtime/dependencies:** Python `>=3.10,<3.16`, Python proxy/SDK plus a Rust core; storage-backed routing, budgets, rate limits and logging.
- **Core source reviewed:** `litellm/router.py`, `litellm/router_strategy/lowest_tpm_rpm.py`, `litellm/cost_calculator.py`, `litellm/proxy/proxy_server.py`, router/core and usage modules referenced by those files.
- **Tests:** `tests/code_coverage_tests/router_code_coverage.py`, router strategy tests, e2e budget/rate-limit/cost tests and Rust router tests.
- **Reusable mechanisms observed:** deployment routing, fallback/cooldown, TPM/RPM accounting, cost calculation, spend tracking and provider catalog.
- **Limitations:** a full model gateway with its own auth, storage, admin UI and enterprise boundary; DSH already owns provider registration, retry and token metering.
- **Reuse mode:** **D; C only for the price data/cost calculator if DS-Bot later needs USD cost.**
- **Decision:** Do not copy or depend on LiteLLM in DS-Bot. A user-deployed LiteLLM may appear only as an external OpenAI-compatible endpoint through DSH provider configuration; the router, proxy, Redis limiter and enterprise code stay outside the product.

### Model Context Protocol (MCP)
- **Official docs:** https://modelcontextprotocol.io/specification/2026-07-28, the tools/transports/authorization pages and https://ts.sdk.modelcontextprotocol.io/v2/.

- **Specification:** https://github.com/modelcontextprotocol/modelcontextprotocol; release `2026-07-28`, head `2be673cfa630`
- **TypeScript SDK:** https://github.com/modelcontextprotocol/typescript-sdk; release `v2.4.0`, head `919bb8ea88b8`
- **Official servers:** https://github.com/modelcontextprotocol/servers; release `v2.4.0`, head `e1dc4b18dbb9`
- **License:** Apache-2.0/MIT transition; specifications and documentation have separate terms, with documentation under CC-BY-4.0.
- **Runtime/dependencies:** TypeScript SDK requires Node `>=20`; DS-Bot already pins `@modelcontextprotocol/client` `2.4.0`.
- **Integration:** **B, already adopted with version drift.** DS-Bot's `capabilities.js` and local-agent adapter use DSH MCP plus the official client SDK. DSH supplies `packages/mcp/mcp-client`; however, `ds-bot/src/host/local-agents/mcp.js` still hand-writes an `initialize`/`tools/list`/`tools/call` server pinned to protocol `2025-03-26`, while the official client supports the `2026-07-28` modern era. The dependency lock also contains DSH's older client and DS-Bot's `2.4.0` package, so one transport/auth plane must be selected.
- **Limitations:** mixed-license transition requires per-contribution review if source is copied; MCP servers are separate products and must be selected through tool/authentication policy. The modern spec uses stateless requests and per-request capability negotiation; the legacy `initialize` protocol must not be presented as current.
- **Decision:** Protocol/SDK is the source of truth. Replace the hand-written loopback server with the official `@modelcontextprotocol/server` SDK and keep only the per-session token/DSH `onCall` adapter. Use DSH `mcp-client` for outbound servers. Do not vendor a server implementation into the product.

### OpenTelemetry JavaScript
- **Official docs:** https://opentelemetry.io/docs/languages/js/ and the Node getting-started/exporter pages.

- **Repository:** https://github.com/open-telemetry/opentelemetry-js
- **Docs:** https://opentelemetry.io/docs/
- **Inspected:** release `v3.1.1`; main head `5a78e6ae`, committed 2026-11-13
- **License:** Apache-2.0
- **Runtime/dependencies:** Node/browser SDK, tracer/meter/logger providers, OTLP exporters.
- **Relevant DSH integration:** `packages/telemetry/otel/src/index.ts` exposes `ctx.otel.createEventReporter()` and `ctx.otel.createSessionLogReporter()`; `docs/subsystems/otel.md`; `packages/session/session-telemetry-otel` and `packages/host/product-telemetry-otel`. DSH uses the coordinated OTel `2.11.0 / 0.222.0 / API 1.9.1` line in the current app lock; upstream `3.1.1 / 0.301.1 / API 1.10` requires Node `>=22.15` and cannot be mixed with an `api@1.9.x` runtime.
- **Tests:** DSH `packages/telemetry/otel/tests/session-log.spec.ts`; upstream SDK trace/metric/log tests and exporter conformance tests.
- **Reusable mechanisms observed:** resource/scope attribution, independent batched channels and explicit shutdown ownership. Traces and metrics are stable; logs remain development-status.
- **Limitations:** DSH's OTel seam is opt-in and does not install a global provider; the current app lock contains `@deepseek-ai/dsh-otel` `0.2.2-rc.1`, but DS-Bot has no trace/metric consumer. Transport failure/overflow can lose records; no durable outbox.
- **Reuse mode:** **B through DSH.**
- **Decision:** Do not add the upstream SDK directly to DS-Bot and do not install a global `NodeSDK`/provider. Upgrades must be coordinated by DSH. If trace/metric export is needed, extend the DSH OTel service contract and register a DS-Bot consumer with consent, redaction and shutdown ownership.

## Dependency and license checks required on every future adoption

- Record the exact tag and commit, not only the repository URL.
- Review the license file at that commit, including enterprise/subdirectory exceptions and documentation licenses.
- Check transitive dependency licenses before adding a runtime dependency.
- Preserve copyright and NOTICE text in the root `NOTICE`.
- Record modified files and keep a local patch if the source is copied.
- Re-run `npm test`, client freshness, lint and the relevant smoke/bench checks.
- Do not treat “open source” as permission to copy trademarks, logos or site assets.
