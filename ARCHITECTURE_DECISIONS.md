# DS-Bot architecture decisions

Snapshot: 2026-11-16. These are product-architecture decisions for the AI-OS refactor, not implementation plans. The detailed message/turn blueprint remains [`docs/design/architecture.md`](docs/design/architecture.md).

The system-level target and deployment configuration are in [`docs/design/personal-ai-os.md`](docs/design/personal-ai-os.md).

Status values: **Accepted**, **Superseded**, **Proposed**. Every accepted decision names a reopen condition so it can be challenged by evidence instead of preference.

---

## ADR-001 — DSH is the only Agent Runtime and a mutable substrate

- **Status:** Accepted
- **Context:** DS-Bot currently runs every Bot through DSH Sessions and the DSH agent loop. Hermes Agent, OpenCode, Pi, Goose, LangGraph and Temporal all provide competing loop/session/state models. DSH is also the shared substrate for general Session, Turn, Tool and UI contracts, so treating it as permanently frozen would force product-specific workarounds into DS-Bot.
- **Decision:** DSH remains the only Agent Runtime and is a mutable foundation. General Session, Turn, Tool and UI contracts should land in DSH first when they are shared concerns; Bot-team organization, product semantics and the control center remain DS-Bot concerns. DSH changes happen in an independent DSH branch with a synchronized pinned version, cross-repo tests and a rollback path. DS-Bot does not add a second Agent Runtime.
- **Consequences:**
  - Model calls, tool calls, step boundaries, cancellation, compaction and Session replay remain DSH responsibilities.
  - DS-Bot owns Bot identity, teams, rooms, handoffs, memory semantics and the control center.
  - External runtimes may be run as independent products or external services, but may not be embedded as a second execution authority.
  - Production installs are never patched in place; a DSH change is released as a versioned dependency that both repositories can test and roll back.
- **Reopen condition:** DSH cannot expose a required lifecycle fact through a documented plugin API after a minimal compatibility spike; the proof must include the missing API and why a wrapper cannot recover it.

## ADR-002 — DS-Bot remains the only product and organization authority

- **Status:** Accepted
- **Context:** Hermes Bot Mode, OpenMausBot and DS-Bot all define rosters, Bot profiles, group membership and admin roles. Combining their models would create two sources of truth.
- **Decision:** Main Bots, member Bots, groups, admins, sections, model choice, workspace and capability attachment remain DS-Bot state. DSH provides execution identity and Session services beneath that state.
- **Consequences:**
  - “Chief Agent” is a product role over Main Bot plus group goals, not a fourth Bot type.
  - External projects cannot own a second roster or a second control center.
  - Any imported algorithm must accept DS-Bot ids and authorization checks at its boundary.
- **Reopen condition:** The product explicitly changes from a Bot/team model to a different primary object; that requires a product-direction decision and a migration design.

## ADR-003 — DSH upgrades are pinned compatibility releases

- **Status:** Accepted
- **Context:** DS-Bot pins DSH `0.2.2-rc.1`; DSH upstream master is `0.2.2-rc.3`. Broad refactors increase the chance of missed runtime changes.
- **Decision:** DSH upgrades happen in an isolated branch with a package-level diff, a capability smoke test, host tests, client freshness, and a real Bot turn/group/handoff run. The app continues to ship one pinned DSH version.
- **Consequences:**
  - New DSH capabilities are not assumed to exist merely because upstream has them.
  - The capability map records both the pinned version and upstream inspection version.
- **Reopen condition:** A required security fix or a required ability is only available in a newer DSH release; the same gate still applies.

## ADR-004 — One Task Runtime, built over the existing evidence surfaces

- **Status:** Accepted
- **Context:** DS-Bot already has group goals, handoff work, the task ledger, board archive and resume records. The task-completion design explicitly forbids a third task system. The missing piece is a unified read/write contract, not another application.
- **Decision:** Introduce a single `TaskRuntime` product boundary over:
  - `group.goal` for objectives, acceptance criteria, stages and assignments;
  - `handoff` work for delegation and completion;
  - `task-ledger` for append-only lifecycle measurement;
  - board archive and resume records for evidence and recovery;
  - DSH jobs/workflow only as execution substrates.
- **Consequences:**
  - The UI must not invent a separate task status that contradicts those records.
  - Existing stage semantics remain compatible until a migration is tested.
  - A task graph with `blockedBy` and optional parallel branches is an extension of this model, not a replacement.
  - If the existing records cannot express assignment ancestry, atomic evidence or approval inheritance, OpenMausBot `server/runtime/{types,store,tree,level}.ts` is the conditional C extraction candidate; its server, rooms and ACP engines are not imported.
- **Reopen condition:** A required dependency shape cannot be represented without corrupting existing group-goal revisions or handoff completion invariants.

## ADR-005 — Local durable execution first; Temporal is a conditional backend

- **Status:** Accepted
- **Context:** DSH `dsh-jobs-local` is process-local and DSH workflow explicitly has no journal/resume. DS-Bot has restart-safe handoff results, inflight turn notes and goal state, but no generic multi-step durable executor. Temporal is mature but requires a cluster, persistence and workers.
- **Decision:** Keep DS-Bot's local persisted task path as the default. If a real repeated recovery/duplication failure is measured, add a `TaskRuntime` backend interface and evaluate a Temporal adapter outside the default modular monolith.
- **Consequences:**
  - A Temporal cluster is not shipped with DS-Bot in this phase.
  - Local writes need idempotency keys and evidence references before a backend abstraction is added.
  - Temporal semantics (workflow history, activities, retry/timeout, worker ownership) become the acceptance model for a later adapter.
- **Reopen condition:** A recorded acceptance failure shows a task cannot resume exactly once without a distributed durable executor, and the local path cannot be repaired with a bounded journal/retry change.

## ADR-006 — Single Memory Hub; local Markdown is the source of truth

- **Status:** Accepted
- **Context:** DS-Bot already implements the Agent Memory Repo format with Bot/group/team scopes, BM25 recall, journal, snapshots, review, tidy, undo and move/restore. OpenViking is AGPL and depends on a server/vector stack; importing it would duplicate memory authority.
- **Decision:** `memory.js` and its sibling modules remain the only memory write authority. The canonical format stays Markdown plus append-only journal. OpenViking may be evaluated only as an optional backend behind a future `MemoryAdapter`.
- **Consequences:**
  - No vector database is required for the default product.
  - External retrieval must preserve DS-Bot scopes, provenance, expiry, pinning and undo semantics.
  - OpenViking source is not copied or linked into the Apache-2.0 product.
- **Reopen condition:** Measured recall quality or document volume exceeds the local BM25/Markdown design enough to justify an opt-in external adapter; legal review must approve the AGPL service boundary first.

## ADR-007 — DSH Tool Registry + official MCP is the only tool path

- **Status:** Accepted
- **Context:** DS-Bot registers scoped tools, local-agent tools and MCP capabilities. OpenCode, Goose, Pi and Hermes each have their own tool registries and permission models.
- **Decision:** Every model-visible tool is registered through DSH's tool registry and governed by one DS-Bot/DSH permission path. Outbound MCP goes through DSH's MCP client; DS-Bot's local-agent loopback server must use the official MCP server SDK instead of a hand-written `2025-03-26` protocol.
- **Consequences:**
  - No project-specific tool registry, function-call schema parser or local-agent tool list becomes a second public tool API.
  - Local-agent loopback MCP remains a transport adapter, not a second registry.
  - The DSH client and DS-Bot server SDK versions must be coordinated; two transport/auth implementations do not coexist long-term.
  - Capability packs reference MCP/skills; they do not bypass approval or scoping.
- **Reopen condition:** DSH's tool registry cannot represent a required execution mode or permission fact through a documented extension point.

## ADR-008 — DSH Model Runtime, DeepSeek first; LiteLLM only as an external gateway

- **Status:** Accepted
- **Context:** DSH already has provider registration, DeepSeek adapters, retry and token metering. LiteLLM duplicates routing, fallback, rate limits, cost and provider catalogs in a separate gateway.
- **Decision:** Model selection, provider registration, per-Bot model state, retry and usage remain DSH/DS-Bot responsibilities. LiteLLM is not integrated as a router or proxy. A user-deployed LiteLLM may be configured only as an external OpenAI-compatible endpoint. USD cost support, if required, reuses price data plus a thin DS-Bot adapter.
- **Consequences:**
  - DS-Bot never copies LiteLLM router/proxy/Redis limiter or enterprise code.
  - Model migration and compatibility records belong in the DSH upgrade gate.
  - Cost data from an external gateway is displayed as provider-reported data, not conflated with DSH `token-meter` facts.
- **Reopen condition:** DSH cannot satisfy a required provider/rate-limit/cost policy after the compatibility gate, or an operator explicitly chooses an external gateway.

## ADR-009 — Observability is local-first, OTel via DSH

- **Status:** Accepted
- **Context:** DS-Bot has `usage.sqlite`, diagnostics, chat/task ledgers and turn metrics. DSH exposes `ctx.otel` channels, but mounting the service does not install global collection or consent.
- **Decision:** Local diagnostics and usage remain the default. If export is enabled, DS-Bot uses DSH `ctx.otel` with explicit transport, resource, redaction, queue and shutdown ownership; it does not install a global OpenTelemetry provider or independently upgrade the SDK. The current DSH app uses a coordinated `2.11.0 / 0.222.0 / API 1.9.1` line; upstream 3.1.1 requires a version-coordinated DSH upgrade.
- **Consequences:**
  - No API keys, raw paths or Session content are exported by default.
  - OTel loss/overflow is disclosed; telemetry is never treated as an authoritative task store.
  - An OTel adapter can be removed without changing task/memory behavior.
- **Reopen condition:** A deployment requires a collector and the DSH `dsh-otel` package is present in the pinned app composition; the consent and redaction review still applies.

## ADR-010 — One approval policy and one append-only governance trail

- **Status:** Accepted
- **Context:** DS-Bot has Bot/group permissions, approval cards and secret privacy; DSH has approval service, permission presets and sandbox policy. Goose/OpenCode/Hermes also expose mature approval mechanisms.
- **Decision:** DSH approval/preset/sandbox is the policy engine. DS-Bot actions must pass through that policy, and the product keeps an append-only governance view that records actor, action, target, outcome and evidence reference without storing secrets.
- **Consequences:**
  - A local-agent approval must not bypass the same policy.
  - UI-only approval state is not an audit trail.
  - Existing approval tests remain regression gates when adding tasks, memory, connectors or execution nodes.
- **Reopen condition:** DSH approval cannot express a required group/admin distinction through its documented API; the missing policy dimension must be proven first.

## ADR-011 — Control Center extends the existing client shell

- **Status:** Accepted
- **Context:** DS-Bot already has a React client, shell slots, settings pages, team board, activity feed, sidebar, command palette and theme system. An external dashboard template would be a second navigation and design system.
- **Decision:** Add Dashboard, Chat, Organization and Tasks as views over existing client primitives and current snapshots. Reuse current avatar, status, card, motion, theme and settings patterns.
- **Consequences:**
  - New pages are read-only projections first; mutations go through existing `teamActions` and host endpoints.
  - No second settings tree, icon system, permission matrix or task store.
  - Mock data is visibly labeled `Preview` and cannot be presented as live system state.
- **Reopen condition:** The existing slot/shell cannot host a required full-screen workspace without forking DSH client internals.

## ADR-012 — Evolution Engine builds on learning and task evidence

- **Status:** Accepted
- **Context:** DS-Bot has learning proposals, goal skills and learning cards, but no closed loop from capability gap to measured integration. Hermes and Goose provide useful self-review ideas but no drop-in product module.
- **Decision:** Extend `learning.js` and goal-skills into a measured loop: detect a repeated gap, research a candidate, create a test/prototype, record a reuse decision and promote a skill or adapter only after evidence. All integrations still pass ADR-013.
- **Consequences:**
  - Evolution cannot silently change permissions, models or production code.
  - The code-reuse registry is the memory of the Evolution Engine.
  - A generated skill is not a substitute for a tested adapter when the missing capability is executable behavior.
- **Reopen condition:** A measured evolution workflow outgrows the existing learning/task surfaces and needs its own durable experiment store.

## ADR-013 — External code adoption is evidence-gated

- **Status:** Accepted
- **Context:** “Reuse first” can turn into dependency and license sprawl without a strict adoption process.
- **Decision:** No external code enters the product without: version/commit, source paths, license review, dependency review, integration mode, test evidence, migration/rollback, NOTICE update and a matching registry entry.
- **Consequences:**
  - Code copy is the exception, not the default.
  - The preferred order is existing DSH service, official SDK/protocol, extracted module with adapter, then local implementation.
  - AGPL code requires an explicit standalone-service boundary and legal review; it is not linked into the product.
- **Reopen condition:** Never; the procedure may be simplified, but the evidence gates cannot be removed.

## ADR-014 — Organization reuse is conformance-driven, not wholesale import

- **Status:** Accepted
- **Context:** Hermes Bot Mode, OpenMausBot and DS-Bot overlap heavily. Directly importing any one of them would duplicate canonical chats, room state, mentions or approval.
- **Decision:** Use external organization projects as conformance cases for DS-Bot's existing room, handoff, queue and status semantics. A bounded, license-compatible host-state helper may be extracted after a failing DS-Bot test proves a gap: Hermes group-round/watermark logic or OpenMausBot assignment-ledger/tree/level logic are the only current C candidates. No model loop, server or ACP engine is extracted.
- **Consequences:**
  - No Python/Rust runtime, second Electron app or Hermes gateway dependency is added.
  - External tests can be translated into DS-Bot regression scenarios without copying their code.
  - Any extracted helper must operate on DS-Bot ids and authorization results, not a foreign roster.
- **Reopen condition:** A DS-Bot acceptance test remains failing after a bounded design comparison and the extracted helper is the smallest solution.

## ADR-015 — The Personal Agent is the product; the Bot team is the substrate

- **Status:** Accepted
- **Context:** DS-Bot currently describes itself primarily as a team of long-lived Bots. That model is strong for organization, transparency and execution, but it makes the user reason about rosters, groups, handoffs and task mechanics before receiving value. The Personal Agent thesis is different: the product wins by removing the friction between intent and outcome—context switching, re-explaining context, remembering follow-ups and operating several devices—not by exposing more agents or more chat. A Personal Agent also needs a trust surface that lets a user observe, approve, stop and undo consequential work.
- **Decision:** DS-Bot's primary product subject is one Personal Agent with a stable identity, persistent memory and a single relationship with the user. The Bot team remains the internal execution model behind that relationship. The product must support four inputs—user intent, user-created schedules, explicitly authorized ambient events and task follow-ups—and one trust loop: plan → preview/approval → execute → progress → verify → undo or rollback where possible. Multi-Bot organization is an observability and control surface, not a prerequisite for normal use.
- **Consequences:**
  - Chat remains a primary surface, but it is not the only entry. The control center must expose a small “Now/Inbox” surface for pending events, approvals, progress, results and recoverable failures.
  - The Main Bot can present as the user's single Personal Agent while specialist Bots work behind it. Group and Organization views explain and control the team; they do not become the default task-entry flow.
  - Proactive behavior is trigger-whitelisted. An ambient source needs an explicit user grant, a scope, a retention rule, a rate budget and a way to revoke it. “Record everything” is not an acceptable implementation of context awareness.
  - The TaskRuntime, DSH Sessions, approvals, evidence and task ledger remain the execution and safety substrate; this decision does not create a second runtime or a second task model.
  - Memory stays under the existing single write authority. Personal Agent context is assembled from scoped memory, history and event adapters; it is not copied into a new personal data lake.
  - Local models and local routers are supported through DSH provider configuration. V1 does not build a competing inference engine or model router; the entity that must remain local in the first product promise is sensitive context and governance, not every model weight.
  - Personal Agent success is measured by reduced human friction and trusted completion, not by message count, Bot count, token burn or automation volume.
- **Reopen condition:** Real usage shows that users primarily value explicit multi-Bot orchestration, while proactive, context-aware assistance fails to improve completion, trust or retention. Any reversal still has to preserve the existing execution, evidence and approval guarantees.

## ADR-016 — Orca is a transaction-pattern reference, not a replacement model

- **Status:** Accepted
- **Context:** Orca has useful idempotency, freshness and capability-reporting mechanics, but its orchestration objects (`dispatch`, `gate`, `worker_done`) do not match DS Bot's Goal/admin-pass and living-handoff semantics. Copying them would create a second task model and weaken the behavior DS Bot already gets from room goals, claims, handoff result trees and DSH approvals.
- **Decision:** Borrow transaction properties, not Orca's state machine:
  - Use the existing `requests.js` identity/receipt layer for Goal changes that can otherwise be applied twice; do not build another idempotency store.
  - Expose `lastEventAt` and a `possiblyStalled` view flag as an observational heuristic; never convert it into a cancelled or failed state without a separate timeout policy.
  - Declare local-agent capabilities from what the protocol driver can carry, and report version/sign-in probes that actually exist. Do not invent per-CLI compatibility ranges.
  - Treat plan-quota probes, dispatch ledgers, gates and improved notification delivery as separate upgrades that need a concrete failing test or threat model.
- **Consequences:**
  - `group_goal` change actions can be replayed without advancing a stage twice.
  - The existing `message_bot` request ids, handoff result tree, claims checks and approval cards remain the canonical paths.
  - A local-agent's capabilities may honestly read `planQuota: false` or `subagentSessions: false`; the UI must show that limitation rather than infer a healthy state.
  - Orca source can be used to design tests and conformance cases, but not vendored as a second runtime.
- **Reopen condition:** A real DS Bot task loses Goal/handoff state that the existing `requests.js`, result tree, resume and evidence records cannot recover; the missing operation must be demonstrated with a failing restart or duplicate-side-effect test before introducing a new orchestration object.
