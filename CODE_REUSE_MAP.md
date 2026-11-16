# DS-Bot code reuse map

Snapshot: 2026-11-16. Product baseline: DS-Bot `0.3.6`, local commit `26228dfa`; pinned DSH `0.2.2-rc.1` at local commit `66491b05`. DSH upstream master was `0.2.2-rc.3` at commit `39163dd3`; it is an upgrade candidate, not this baseline.

This file is the human-readable decision map. `docs/reuse/code-reuse-registry.json` is the machine-readable source of record. `docs/design/architecture.md` remains the detailed message/turn layering design, and `docs/design/agent-comparison.md` remains the broader field comparison.

The target operating model is [`docs/design/personal-ai-os.md`](docs/design/personal-ai-os.md). The first executable milestone is [`docs/plans/2026-11-16-ai-os-reality-harness.md`](docs/plans/2026-11-16-ai-os-reality-harness.md).

## Reuse modes

| Mode | Meaning |
|---|---|
| **A. Direct code** | Copy a source module/file with its tests and record the exact version, license, modifications and notice. |
| **B. SDK / official interface** | Consume a published package, protocol, format or service through its documented boundary; do not fork its internals. |
| **C. Extracted module + adapter** | Extract a bounded module into a separate boundary and connect it through a DS-Bot interface. |
| **D. Reference design** | Use the mature design as evidence, but keep DS-Bot's existing implementation. |
| **E. Build in DS-Bot** | No suitable reusable implementation exists, or reuse would create a second product/runtime authority. |

## Non-negotiable conclusions

1. **DSH remains the only Agent Runtime.** DS-Bot owns Bot identity, team collaboration, product memory and the control surface; it does not own a competing model/tool loop.
2. **DS-Bot remains the only product authority.** External projects may supply a backend behind an adapter, but they may not create a second roster, session authority, permission system or control center.
3. **There is not a third task system.** The existing evidence surfaces stay distinct: `group.goal` is the plan, handoff `work` is delegation and completion, `task-ledger` is the append-only measurement log, and the team board is a self-report display.
4. **No candidate is copied into the core by this research.** Current adopted external boundaries are the existing DSH packages, MCP TypeScript SDK `2.4.0`, and the Agent Memory Repo Markdown format.
5. **AGPL projects are not linked into the Apache-2.0 product.** Obelisk and OpenViking remain design references unless a future standalone-service integration receives explicit legal review.

## Feature matrix

Status values: **已有** means implemented and test-covered; **部分** means the mechanism exists but is not yet unified for the requested AI-OS role; **缺失** means no implemented owner exists.

### Organization and execution

| Feature | DS-Bot implementation | DSH implementation | Candidate evidence | Decision |
|---|---|---|---|---|
| Bot lifecycle | `ds-bot/src/host/roster.js`, `store.js`, `agents.js`, `turns.js`; Main Bot creation and deletion rules | `packages/session/session-persistence`, `packages/session/session-projection`, agent lifecycle docs | Hermes Agent roster, Hermes Bot Mode canonical chats, OpenMausBot bot profiles | **已有.** Keep DS-Bot as lifecycle owner; do not import another roster. |
| Bot identity and roles | `state.mainBotIds`, Bot instructions/character/model/workspace, group admin and Main Bot permissions in `roster.js` and `permissions.js` | Session identity, model selection, permission presets, subagent identity | Hermes Bot Mode profile/meta, OpenMausBot bot access and roles | **已有.** Reuse current identity model; DSH supplies execution identity only. |
| Multi-Agent organization | Main Bots, member Bots, groups, local-agent Bots, sections and team board | Subagents and experimental Agent Teams with roster and shared task DAG | Hermes Agent delegation, Hermes Bot Mode groups, OpenMausBot rooms | **已有 at product level; partial at task-DAG level.** Keep DS-Bot organization. DSH Agent Teams is not a second roster candidate. |
| Bot-to-Bot communication | `delivery.js`, `ledger.js`, `inbox.js`, `backlog.js`; durable exchange books and quiet notes | `agent.send`, `agent.steer`, `agent.followup`, Session inbox and events | Hermes canonical bot chat, OpenMausBot room queue, OpenCode session inbox | **已有.** Keep `delivery` as the single send funnel. Apply the architecture blueprint's queue/envelope split before adding more delivery modes. |
| Group chat and message routing | `groups.js` rounds, @mentions, relays, room logs, admin, group sessions | Session fan-out primitives; Agent Team mailbox is not the product room | Hermes Bot Mode group rounds, OpenMausBot room routing/queue/delta prompt | **已有.** Keep DS-Bot rooms; use external implementations only as conformance cases. |
| Agent dispatch | `turns.js`, `delivery.js`, `groups.js`, `steer.js`; each Bot turn runs through DSH | Agent loop, step lifecycle, concurrency and cancellation | Hermes conversation loop, OpenCode session runner, Pi agent loop, Goose state machine | **已有.** Do not add a runtime adapter for Hermes/OpenCode/Pi/Goose. |
| Task planning | Group goals with objective, acceptance, constraints, sequential stages and assigned tasks in `goals.js`; DSH plan/todo tools | Goal, plan and todo services; Agent Team shared task DAG | LangGraph state/interrupts, OpenMausBot chief/room jobs, OpenCode goal plugin | **部分具备.** Extend the existing group goal into a task graph only where dependencies/parallel branches are proven necessary; OpenMausBot `server/runtime/{types,store,tree,level}.ts` is the conditional C extraction candidate; no new task application. |
| Long-running task management | Group idle driver, handoffs, schedules, `resume.js`, task ledger | Process-local jobs; schedule service; workflow scripts | Temporal durable execution, LangGraph checkpoints, Hermes cron | **部分具备.** DSH jobs are explicitly process-local and DSH workflow has no journal/resume. Keep the current persistent goal/handoff path, define a `TaskRuntime` seam, and evaluate the OpenMausBot assignment-ledger extraction before Temporal. |
| Session management | Bot parts, group own-parts, current/earlier Session switching, archive and restore in `parts.js` and `store.js` | Session format v4, persistence, projections, query and title services | Hermes canonical Session, Pi append-only Session tree, OpenCode Session store | **已有.** Reuse DSH Session persistence/query; DS-Bot only maps Bot/group ownership and product parts. |
| Context compression | `steward.js`, checkpoint/handoff notes in `parts.js`, memory snapshots | DSH compaction engine, tool-result pruning and image offload | Hermes compressor, OpenCode/Pi/Goose compaction | **已有.** Keep DSH compaction plus DS-Bot Steward. No copied or parallel compressor. |
| Handoff | `handoffs.js` parent/child work tree, persistent result files, abandonment, restart recovery | Agent messaging and subagent result delivery | Hermes Bot Mode mention handoff, OpenMausBot room handoff | **已有.** DS-Bot handoff remains the product contract; DSH supplies transport and execution. |
| Checkpoint and recovery | Session parts, `inflight.json`, handoff result files, ledger books, restart tests | Session persistence and replay; DSH workflow does **not** journal/resume | LangGraph checkpoint/interrupt, Temporal history replay | **部分具备.** Use DSH Session replay and current recovery tests. Introduce step-level idempotency only after a reproduced resumed-task duplicate is measured. |
| Task recovery after restart | `resume.js`, handoff recovery tests, task-ledger durability, group goal restart behavior | Session log replay; process-local jobs die with the process | Temporal durable execution | **部分具备.** Define crash-safe transitions for the unified task view. Temporal is a conditional backend for distributed durable execution, not a core dependency. |

### Memory, tools and models

| Feature | DS-Bot implementation | DSH implementation | Candidate evidence | Decision |
|---|---|---|---|---|
| Long-term memory | Three scopes: Bot, group, team; Markdown `MEMORY.md` plus topic files, journal, snapshots, summaries and archives in `memory.js` | Context/session references and memory injection points; no competing product memory store | Agent Memory Repo format, OpenViking context database | **已有.** Agent Memory Repo is the adopted **format**; DS-Bot's implementation remains authoritative. OpenViking is optional external backend research, not a replacement. |
| Memory retrieval | BM25 ranking, auto-recall, `recall`, scope filters, prompt budget and frozen per-part snapshots in `memory-search.js` and `memory.js` | Session/context compaction; DSH does not own the Bot/group/team memory hierarchy | OpenViking hierarchical retrieval/tier budgeting | **已有.** Keep local BM25; evaluate OpenViking's URI/tier/budget design only if retrieval quality is measured as insufficient. |
| Memory correction | Append-only journal, `retired.jsonl`, batch undo, move/restore/forget, pin/expiry and memory panel | Session persistence supplies history, not memory semantics | OpenViking memory lifecycle, Agent Memory Repo update loop | **已有.** Do not replace the journal with vector-store state. |
| Skills | Shared capability library, skill/pack attachment, DSH skill catalog, learning proposals | Skill registry, filesystem discovery, session skill catalog | Hermes skill bundles, OpenCode skills, Goose skills | **已有.** Reuse DSH skill registry and DS-Bot capability library; no second skill loader. |
| MCP | `capabilities.js` and `local-agents/*` use DSH MCP plus official `@modelcontextprotocol/client` `2.4.0`; `local-agents/mcp.js` still hand-writes a `2025-03-26` loopback server | `packages/mcp/mcp-client`, MCP resources and transports; official SDK with `versionNegotiation: auto` | Official MCP spec `2026-07-28`, TypeScript SDK `2.4.0`, MCP servers `2.4.0` | **Already adopted via B, with drift.** Keep the official protocol boundary; replace the hand-written loopback server with the official server SDK and unify the duplicated SDK versions before adding more MCP features. |
| Tool invocation | `tools.js` registers scoped team tools and masks hidden tools; per-Bot capability attachment | Tool registry, ordered pre/post hooks, execution modes and step tool sets | OpenCode permission/tool runtime, Goose tool approval, Pi tool loadout | **已有.** DSH tool registry is the single invocation path. |
| Browser automation | `browser/` sessions, tasks, refs and script runner; Bot-owned browser | `browser-use` package with leases and tools | Hermes browser registry, Goose MCP browser, OpenMausBot browser sessions | **已有.** Keep DS-Bot's Bot-owned browser bridge; reuse DSH only through documented seams. |
| Computer use | `computer/` leases, Mac helper, app grants, indicators and approvals | `computer-use`, sandbox and memory/OS adapters | OpenMausBot CUA, Hermes computer tools, Goose MCP control | **已有.** Keep DS-Bot consent/lease model; do not add a second computer executor. |
| Filesystem and workspace | Bot/group folders, scoped read/write, file save/preview in `folders.js`, `files.js`, `preview.js` | Workspace, filesystem, shell, sandbox and spill packages | OpenCode environment/filesystem, Pi tools, Goose extensions | **已有.** Reuse DSH filesystem/sandbox; DS-Bot only owns Bot/group selection. |
| Scheduled tasks | `schedules.js`, Settings -> Scheduled tasks, room/Bot ownership | DSH schedule service with recurrence, delivery and historical Session changes | Hermes cron scheduler, OpenMausBot routines | **已有.** Use DSH schedule as the execution service; DS-Bot owns product ownership and UI. |
| Email and calendar | Mail connectors, IM platforms, phone relay and MCP connector catalog; no unified calendar model | MCP and connector runtime; no DS-Bot calendar product model | OpenMausBot connected apps/Composio, MCP servers | **部分具备.** Add calendar only behind the same connector boundary; do not add a fourth inbox/store. |
| Model provider and DeepSeek | Per-Bot model selection, provider/key settings, model refresh, route fallback and usage display in `models.js`, `providers.js`, `usage.js` | `llm`, DeepSeek adapter, pi-ai adapter, retry, provider catalog and token meter | LiteLLM router/cost/budget/fallback | **已有.** DSH is the only provider router. LiteLLM may be used as an external OpenAI-compatible gateway, never copied into DS-Bot. |
| Model upgrades | DSH pin in `app/package.json`, update flow, provider discovery and compatibility tests | Release-tested provider/runtime packages | DSH upstream `0.2.2-rc.3`; LiteLLM model catalog | **部分具备.** DSH upgrades require a dedicated compatibility gate; DS-Bot does not maintain a parallel model catalog. |

### Operations and product OS

| Feature | DS-Bot implementation | DSH implementation | Candidate evidence | Decision |
|---|---|---|---|---|
| Permission, approval and sandbox | `permissions.js`, `approvals.js`, group/admin rights, approval cards, secret redaction | Approval service, permission presets, sandbox policy | Goose permission judge, OpenCode permission rules, Hermes approval isolation | **已有/部分统一.** DSH approval/preset is the policy engine; DS-Bot must route every Bot/team action through it and keep an append-only product audit view. |
| Operation audit | Conversation ledgers, task ledger, memory journal, handoff result records and diagnostics | Session events and telemetry records; approval events | Obelisk query model, OTel session logs | **已有/部分.** Do not infer audit from UI. Define which events are append-only and retain evidence references. |
| System monitoring | `usage.js`, `usage.sqlite`, `chat-index.js`, `diagnostics.js`, turn metrics and task metrics | `ctx.otel` plus Session telemetry adapter | OpenTelemetry JS / OTLP SDKs | **已有/部分.** Keep local diagnostics private; expose optional OTel export through `ctx.otel` with explicit consent, redaction and shutdown ownership. |
| Control Center | Existing `src/client/` shell, Settings pages, team board, activity/live state and command palette | Slots, settings shell, host services and client primitives | Linear/Raycast-style references are visual, not reusable code | **部分具备.** Extend the existing shell into Dashboard/Chat/Organization/Tasks pages; do not add an external admin template or second navigation system. |
| Chief Agent | Main Bot and group admin already have team-management authority; group goals drive the work loop | Agent loop and orchestration primitives | Temporal workflows, LangGraph supervisor patterns | **已有/部分.** “Chief” is a product role over Main Bot + goals, not another runtime. Make the role explicit in the UI and prompts. |
| Evolution Engine | `learning.js`, goal skills and learning cards propose skills from completed work | Skill registry and evaluation infrastructure | Hermes self-review, OpenCode goals, Goose recipes | **部分具备.** Extend learning into a measured capability-gap -> research -> test -> integrate loop; no external project is a drop-in Evolution Engine. |
| Information Hub | Connectors, IM, mail, activity feed and Bot inbox | MCP, web/browser and Session events | MCP servers, OpenMausBot triggers/app events | **部分具备.** Create one normalized external-event model over existing connectors; do not create another scheduler or memory inbox. |
| Execution Nodes | Desktop/Web, local-agent CLIs and Bot workspaces; no distributed node registry | SSH, workspace, subprocess and schedule remote-host primitives | Temporal workers, OpenMausBot cloud/VM, Hermes gateway | **部分具备.** Reuse DSH SSH/workspace primitives and current desktop bridge before designing a node protocol. |
| Project/Workspace product view | Bot/group folders and sections; no project record with milestones/assets | Workspace and worktree services | Obelisk project indexing, OpenMausBot projects | **部分具备.** Add a project view over existing conversations, goals, folders and tasks; do not make a new workspace authority. |

## External project decisions

| Project | Version inspected | License | Reuse mode | Final decision |
|---|---|---|---|---|
| DeepSeek Harness | pinned `0.2.2-rc.1`; upstream `0.2.2-rc.3` | MIT | A/B (existing) | **Use as the runtime substrate.** Upgrade only through its documented entry points and the app's pinned dependency set. |
| NousResearch/hermes-agent | release `v0.23.1`; head `e96221fa` | MIT | D | **Reference only.** Adapt selected control-plane ideas; no Python runtime import. |
| NousResearch/Hermes-Bot-Mode | no release; archived head `80fee225` | MIT | C/D | **Do not integrate the plugin shell.** If a DS-Bot group test proves a gap, extract the pure round/watermark/epoch algorithm behind a DSH adapter; the maintained copy is in Hermes Agent `group-rounds.ts`. |
| milind-soni/OpenMausBot | `v0.1.161`; head `5c919b7a` | Apache-2.0 | C conditionally / D | **Conditional C.** Its typed assignment ledger, atomic assignment/event store, tree restart semantics and approval-level inheritance are the strongest extraction candidates for the unified TaskRuntime; extract only behind DSH/session primitives and with attribution. |
| AgentMemoryRepo/agentmemoryrepo | head `8798cb26` | MIT | B/D (format) | **Adopted format already.** Keep compatibility and provenance; no runtime dependency. |
| anomalyco/opencode | `v2.3.0`; dev head `0fad04b3` (GitHub `/latest` metadata was inconsistent with the release feed) | MIT | D | **Reference only.** No second session/runner. |
| block/goose | `v1.59.1`; canonical `aaif-goose/goose` head `0bf8b624` | Apache-2.0 | D | **Reference only.** Its state machine and approval model inform tests, not runtime composition. |
| badlogic/pi-mono | `v1.5.2`; canonical `earendil-works/pi` head `22fc026b` | MIT | D | **Reference only.** No additional Session format or agent loop. |
| tommy0103/obelisk | `v0.2.5`; head `cc75c2dd` | AGPL-3.0 | D | **Do not copy/link.** DS-Bot's `chat-index.js` already implements FTS5/BM25. |
| volcengine/OpenViking | `v0.5.5`; head `5f53cbf0` | Server AGPL-3.0; TypeScript SDK and DSH plugin Apache-2.0 | B (optional external service) / D now | **Deferred optional Memory Adapter.** Consume the Apache-2.0 DSH plugin/SDK against an external AGPL server after a DSH compatibility spike; no server or vector database is introduced by default. |
| temporalio/temporal | `v1.32.2`; head `170fb83d` | MIT | D now; B later only if proven | **Conditional external TaskRuntime backend.** Do not run a Temporal cluster until local job/workflow recovery fails a documented acceptance test. |
| langchain-ai/langgraph | `1.2.22`; head `41fb001d` | MIT | D | **Do not add as a runtime.** Use checkpoint/interrupt semantics as test inputs; DSH remains the loop. |
| BerriAI/litellm | `v1.109.1`; head `8d200a4f` | MIT outside `litellm/enterprise/`; separate enterprise license | D; C for cost data/calculator only | **Do not integrate the router/proxy.** A user-deployed LiteLLM may appear only as an external OpenAI-compatible endpoint; USD cost support, if required, uses the price data plus a thin adapter. |
| modelcontextprotocol/modelcontextprotocol | release `2026-07-28` | Apache-2.0/MIT transition; docs CC-BY-4.0 | B | **Use as protocol source of truth.** |
| modelcontextprotocol/typescript-sdk | `v2.4.0`; head `919bb8ea` | Apache-2.0/MIT transition | B | **Already used by DS-Bot.** Keep the version pinned and update through the official package. |
| modelcontextprotocol/servers | `v2.4.0`; head `e1dc4b18` | Apache-2.0/MIT transition | B | **Use selected servers through MCP only.** Do not vendor server implementations into the product. |
| open-telemetry/opentelemetry-js | `v3.1.1`; head `5a78e6ae` | Apache-2.0 | B through DSH | **Do not add a global SDK to DS-Bot.** Use DSH's `ctx.otel` seam when export is enabled. |

## First implementation order after this map

1. Freeze the current message/turn baselines with the architecture blueprint's `plainRelay` table test.
2. Split the delivery envelope/queue/waker only after the baseline test lands.
3. Replace `local-agents/mcp.js` with the official MCP server SDK and unify DSH/DS-Bot SDK versions; keep the per-session bearer token and DSH tool-call adapter.
4. Define a single `TaskRuntime` view over `group.goal`, handoff `work`, `task-ledger`, board archive and resume records; do not add storage until the view has a failing acceptance test.
5. Add the Control Center as a read-only projection over existing roster/live/work/usage/task data before adding mutation actions.
6. Evaluate DSH `0.2.2-rc.1 -> 0.2.2-rc.3` in an isolated compatibility branch after the first four steps.

## Verification

- `npm test` in `ds-bot/`
- `node scripts/build-client.mjs --check`
- `npm run lint`
- `dev/bench.sh smoke 3096 8796 reset && node dev/smoke.mjs smoke 3096` for host changes
- Source/license review must be repeated when an external dependency, copied file, model provider or public interface changes.
