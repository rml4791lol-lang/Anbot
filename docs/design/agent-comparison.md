# DS-Bot vs. the field: an architectural comparison

**Subject:** DS-Bot at `<repo-root>` (package `ds-bot` 0.3.6, Apache-2.0; README calls it v0.3_preview, pinned to DSH 0.2.2-rc.1).
**Date:** 2026-11-15. **Method:** read the repo directly (paths + line numbers below), read upstream READMEs and docs via `curl -sk https://raw.githubusercontent.com/...` and docs sites, and ran the installed CLIs (`claude --help`, `codex --help`, `codex exec --help`, `codex queue --help`, `codex sandbox --help`) on this machine: `claude` 2.1.323 at `/opt/homebrew/bin/claude`, `codex-cli` 0.162.1 at `<path-to-codex>`.
**Limits:** the GitHub API is unreachable from this machine, so repository file listings were not available; only files whose paths I could name were fetched. Anything I could not verify is marked **unverified** rather than asserted. No repo files were modified; this document is the only output.

---

## 0. DS-Bot's baseline (the "row zero" the other rows are compared against)

| | DS-Bot |
|---|---|
| **Turn model** | One DSH agent turn per wake: model call + tool loop through the normal DSH agent loop. Measured 2026-11-14 over 12 Bot sessions: **394 turns/day**, p50 **35.4 s**, p90 **323.9 s**, 7.9 tool calls/turn, 28.7% of turns with zero tool calls (`docs/plans/2026-11-14-bot-turn-economy.md`; script `ds-bot/dev/turn-economy.mjs`). |
| **Wake model** | `deliver()` with a role taxonomy; busy + "plain" note → coalesced backlog (≤5, 2 s quiet / 30 s max); `silent` notes → `agent.send(msg,'next-turn',false)` (queued, no wake); otherwise `agent.followup()` starts a turn (`ds-bot/src/host/delivery.js:199-210`, `ds-bot/src/host/backlog.js`). 59.9% of turns are opened by another Bot's message. |
| **Orchestration** | Rooms with rounds and @-mentions; admin answers by default; work handoff tree (`handoffs.js`); per-room Goals with stages (`goals.js`). |
| **Memory** | Markdown "Agent Memory Repo" per Bot / per group / team; post-turn memory review; `recall`/`remember`/`forget` tools; per-Session frozen memory snapshot for prefix-cache stability (`ds-bot/src/host/memory.js`, `memory-review.js`). |
| **Tools** | 26 team tools + DSH built-ins with 17 DSH tools deliberately hidden; MCP/skills/packs through a shared capability library (`ds-bot/src/host/tools.js`, `capabilities.js`). |
| **Observability** | Append-only JSONL conversation ledgers, daily task ledger, chat index, `usage.sqlite` per-call token ledger, scrubbed `diagnostics.jsonl`, reply fact-check markers, `dev/metrics.mjs` (every ratio prints its denominator). |

---

## 1. Ten-row matrix

Short phrases; the long form with sources is in §2.

| System | Turn model | Wake model | Orchestration | Memory | Tools | Observability |
|---|---|---|---|---|---|---|
| **OpenMausBot** | One harness turn per user/trigger message; provider-native protocol normalised into one canonical event stream | Explicit triggers (schedule, webhook, connected-app events) feed one queued task executor; interval schedules **skip** an occurrence while the previous run is active | "Channels" (separate transcript/instructions/folder/roster); a cheap "Jev" model picks which bot answers an unmentioned message, room lead as fallback; MCP control plane for external clients | Per-channel thread transcript (NDJSON) + shared channel instructions; no extracted long-term memory layer documented | Per-driver native tools + Composio connected apps + a permission broker with inline Allow/Deny cards | SSE event stream to the UI; trigger run history; compact transcript pages over MCP |
| **LobeHub** | Topic run with ops/streams; server-mode runtime | Background sub-agents: parent gets a receipt and ends its turn; result delivered only when the **topic is idle**, claimed before the wake-up turn, claims handed back if that turn fails; ≤5 per topic | Groups + `callSubAgent`/`callAgent`; marketplace agents; sub-agent thread in the right panel | User memory + knowledge base (retrieval details **unverified**); memory edits as a learning loop per README narrative | Plugin/MCP marketplace + open SKILL.md skills shared with Claude Code/Codex | Per-user `op_lifecycle` gateway feed; client follows runs it did not start; acceptance system |
| **Claude Code** | Agentic loop until stop; mid-turn typed message read after running tool calls, or Esc cancels the call | Per-session **Unix-socket inbox**; delivered between tool calls if busy, **starts a turn** if idle; `notify_when_idle` subscribes to one notice *without* a turn or tokens; inbound policy accept/hold/refuse | Subagents (own context, own tools/permissions/model, optional git worktree); experimental **agent teams** with shared task list + direct messaging; background sessions (`--bg`, `claude agents`) | CLAUDE.md hierarchy (managed → user → project → local) with `@import` (max depth 4) + auto memory | Built-ins + MCP + skills + plugins + **32 hook events** (incl. PreToolUse, PermissionRequest, Stop, TeammateIdle, PreCompact) | Local JSONL transcripts, `/context`, debug logs, cache-hit guidance |
| **Codex CLI** | Session turn over an app-server JSON-RPC protocol; `exec` for one-shot | `codex queue --thread <id> --message` queues into an existing thread; `resume`/`fork`; background agents list via shared local daemon | Cloud tasks (`codex cloud`), `remote-control`, sub-agent support **unverified**; plugins/MCP | `AGENTS.md` + layered profiles (`-p`, `~/.codex/<name>.config.toml`) | MCP client, plugin subcommand, sandboxed shell with `read-only`/`workspace-write`/`danger-full-access` | JSONL events (`--json`), rollout files, `codex debug`, `apply` of latest diff |
| **OpenAI Agents SDK** | `Runner.run` loop until final output / `max_turns` | None built in — the caller drives every run | Handoffs (control transfer) + agents-as-tools + guardrails; sandbox agents on a container manifest | Sessions (automatic history per conversation); no extraction pipeline | Functions, MCP servers, hosted tools; guardrails validate I/O | Built-in tracing of runs/spans |
| **LangGraph** | Graph super-steps until END | None built in — external invoke | Nodes/subgraphs, `Command(goto)`, map-reduce sends | Checkpointer (per-thread state) + long-term store; short-term working memory | Plain functions inside nodes; no tool registry of its own | LangSmith tracing |
| **Letta** | Agent step loop with in-context memory blocks | Channels (Slack/Telegram/Discord) + API; CLI/server/desktop | Subagents; shared memory repositories; "dreaming" background reviewers | **MemFS**, a git-backed memory filesystem; `/remember`, `/doctor` audit of placement/duplication/prompt-token use, size budgets (5/50 MiB) | MCP + built-in memory tools | Desktop/web app; trace detail **unverified** |
| **AutoGen** | `team.run(task=…)` until a termination condition | None built in; caller drives | RoundRobin / Selector / Swarm (handoff messages) / Magentic-One teams; `AgentTool`; GraphFlow; actor-based Core runtime | Memory + RAG modules | Function tools + MCP servers | Tracing/observability docs; Studio UI (explicitly not production-ready) |
| **Langfuse / AgentOps** | Observability products: trace = one run, spans = steps | n/a | n/a | Langfuse versions prompts **and skills**; datasets/experiments | SDK decorators/integrations | Their product: OTEL traces (Langfuse), session replays + cost (AgentOps) |
| **harnessdesk / agenticmail** | harnessdesk: host-owned turn over ACP/native runtimes, `turn/completed` is the one global signal; agenticmail: wake per inbound email/RPC callback | harnessdesk **message queue** lives beside the session, one message per turn, held when a turn ended badly; agenticmail: IMAP IDLE → SSE, ThreadCache + AgentMemory prepended to every wake prompt | harnessdesk: hand-off packets, `/race`, rooms/boards with a human referee, Flows; agenticmail: `call_agent` synchronous RPC with `outputSchema`, task claim/submit | harnessdesk handoff packet (Goal/Where it stands/Files changed/Open plan/Ground truth); agenticmail per-agent markdown memory + thread cache | harnessdesk projects 90 plugin tools into each agent's tool interface; agenticmail 100 MCP tools | harnessdesk: `audit.ndjson`, usage dashboard per agent; agenticmail: task/result records |

---

## 2. Per-system facts

### 2.1 DS-Bot (our repo)

1. **Host model: a DSH plugin, not a separate runtime.** `ds-bot/index.js` + `src/host/` run inside the DSH process and use documented plugin APIs only (`AGENTS.md` hard rule 1). The team's state is one `state.json` guarded by `homeLock()`, a single-writer lock (`ds-bot/src/host/store.js`), so two processes cannot both own the team.
2. **Deployment shapes:** Electron desktop app with its own pinned DSH and its own `DSH_HOME` (`app/`, `app/electron-builder.yml`), a DSH plugin install (`dsh plugin --profile web add ds-bot`), a Docker image/compose stack (`docker/Dockerfile`, `docker-compose.yml`, port 13080→3080), and a React Native mobile client (`mobile/`).
3. **Turn lifecycle** is DSH's: the plugin watches `turn/start` (claims the pending trigger, `ds-bot/src/host/turns.js:814`) and `turn/end` (`:1060`), tracks steps/tool calls, and decides whether to answer the asker (`:1203-1251`). A turn turned away before its first step may end without `turn/end` — the code comments this explicitly (`:825`).
4. **Wake taxonomy** in one function: `deliver({role, steer, silent, queue, deferred, resumed, retried, resent, merged, abandoned …})` with a header per role — reply / stopped / room / report / kickoff / continue / update / secret (`ds-bot/src/host/delivery.js:58-77`, signature `:124`).
5. **Coalescing:** while a Bot is busy or arming, a "plain relay" goes to a backlog that merges by Session; `BACKLOG_LIMIT = 5`, `WAITING_QUIET_MS = 2000`, `WAITING_MAX_MS = 30_000`; earlier requests are reduced to a count, replies keep their own header (`ds-bot/src/host/backlog.js`; comment at `delivery.js:18-20`: "a burst of notes costs one turn, not one turn each").
6. **Silent notes don't wake.** Profile updates and stop receipts go through `agent.send(message,'next-turn',false)` (`delivery.js:209`) so they queue for the next turn; the design note complains that the role taxonomy *still* lets `role:'update'` wake a turn (`docs/plans/2026-11-14-turn-triggers-issue.md`).
7. **Steer is preemptive.** For a private Session in the model phase with no calls running, the plugin cancels the model call with a hook reason and prepends the steer to `next-turn` (`ds-bot/src/host/steer.js`, `SHELL_TOOLS=['pwsh','bash']`, `STEER_GRACE_MS=1000`); a foreground shell call is detached into the jobs registry and re-rendered when it finishes.
8. **Crash recovery is exchange-level.** `resume.js` replays deliveries no turn took up, dedupes with a `taken` set built from `agent.inbox.nextStep/nextTurn` (line 204, checks at 291/302), re-delivers with `steer:false, resent:true` (`:309`), and treats a replayed `turn/end` as settled from the Session log rather than re-answered.
9. **Memory is a file format, not a vector DB.** Entries are Markdown bullets ending in `[key: value; …]`, `MEMORY.md` indexes `[[topic]]` files, under `<home>/memory/{bots/<id>,groups/<id>,team}` plus `journal.jsonl`, `snapshots/`, `summaries/`, `archive/` (`memory.js` header). A post-turn review extracts memory rather than trusting the model to call `remember` (`memory-review.js`: "a model reads what is new there and keeps, changes, or removes entries, as a person would after a talk").
10. **Prompt stability for prefix caching:** `prompt.js` is one prompt section whose text depends only on the Session's Bot record, in eight fixed sections (identity / work loop / evidence / stopping / delivery / collaboration / memory / failure), and each Session freezes its memory section at first render (`memory.js`).
11. **Context management is a policy, not just a trim.** A separate small model call ("the context steward") decides at a check line — 0.8 of the declared window with an absolute 380k ceiling, hard line 0.95 — whether the work is mid-flight (condense older messages into a checkpoint, keeping the Bot's messages word for word) or at a stopping point (move to a fresh Session part with a cache-warm handoff note) (`ds-bot/src/host/steward.js`, `parts.js`). DSH's own compaction is wrapped and disabled for Bot Sessions (`parts.js`).
12. **Tool surface is deliberately narrowed and widened at once.** 26 Plugin tools (`message_bot`, `post_to_group`, `read_inbox`, `remember`, `recall`, `group_goal`, `show_view`, `create_bot`, `stop_bot`, …) and 17 DSH tools hidden — including every delegation tool (`subagent*`, `workflow`, `ralph`, `send_message`, `team_task_*`) and the blocking `ask_user_question` (`tools.js`).
13. **Models:** one model per Bot, fixed at creation and changeable, with thinking levels resolved from provider metadata; retry honours the provider's `retryAfter` with exponential backoff + jitter (`models.js`); provider routes and keys stay in DSH's credential store (`providers.js`).
14. **Permissions** are DSH presets applied per Bot and optionally overridden per group; DSH's Session-only `auto` review is excluded (`permissions.js`). Group approval cards never show DSH's own UI: DS Bot answers them from the group chat (`approvals.js`). Private Bots are fenced at the *tool* layer — file tools' paths are checked, shell is acknowledged as unable to be fenced (`privacy.js` header: "a shell can still reach any file the account can").
15. **Failure semantics add a fact-check:** `claims.js` marks a reply whose Markdown file link does not exist, or that announces work while no tool/job/subagent/handoff is running; "the marker is only for the reader: nothing is retried, resent or reworded."
16. **Evaluation tooling exists in `dev/`:** `eval/` (golden.jsonl, judge.mjs, stability.mjs, extract-answers), `learning-eval/`, `metrics.mjs` (daily production metrics; "a ratio with no data prints n/a, never 0%"), `turn-economy.mjs`, `steward-eval.mjs`, `ledger.mjs`, `llm-tap.mjs`. The repo has 217 test files under `ds-bot/test/`.

### 2.2 OpenMausBot (`milind-soni/OpenMausBot`, Apache-2.0)

1. **Two processes, one event stream.** A React app on port 5199 sends typed HTTP commands and folds a single SSE stream into state; a harness server on `127.0.0.1:8799` owns every agent process and normalises each provider's native protocol into one canonical runtime event stream, logged per thread as NDJSON (README "How it works").
2. **Driver-per-provider with graceful degradation.** `server/drivers/` speaks Claude, Codex and Grok Build over their own CLIs (stream-JSON / JSON-RPC / ACP) plus a cloud-computer agent; an unknown driver degrades to "unavailable" and cannot crash the fleet.
3. **Every bot gets a computer.** Cloud computer via boat.dev with a Computer panel, live screen preview and a "this Mac" option — computer use is per-bot infrastructure, not a tool flag.
4. **Permission broker as first-class UX.** Every risky action becomes an inline Allow/Deny/answer card (README "Bots ask before they act").
5. **Routing model, not a router prompt.** "Jev" — a separate cheap decision model (Cloudflare Workers AI / TypeSafe Jev / OpenRouter) — picks which bot answers an unmentioned message in a few hundred ms, falling back to the room lead.
6. **Triggers are a product surface.** A bot creates schedules/webhooks with a `trigger` tool (no confirmation), a live card, run history, pause/resume/run-now; webhook secrets are shown once with bearer auth recommended.
7. **Overlap protection on schedules.** Interval schedules align to their start time and **skip** an occurrence while the previous run is active "so slow work cannot build an unbounded queue" (README §Triggers).
8. **Event durability is bounded and explicit.** Connected-app events queue server-side; the desktop long-polls, so it needs no public address, and events wait while the app is closed; desktop keeps 500 events/day, Cloud 2,000.
9. **External control plane over MCP** with a deliberately bounded surface: inspect bots/channels, read/search transcripts, create/configure, send work, wait, switch models, interrupt — but not approvals, deletion, credentials or computer lifecycle (`docs/mcp-server.md`).
10. **Headless mode is a first-class CLI**: `openmausbot team apply team.yaml` and `openmausbot run "Room Lead" "…" --export ./out`, one JSON document with `--json` and meaningful exit codes (`docs/headless-cli.md`).

### 2.3 LobeHub (`lobehub/lobehub`, LobeHub Community License)

1. **Product framing is "agents on your team", not "a chat app with agents"** — the README's Day 1 / Week 1 / Month 3 narrative is explicitly about an agent accumulating corrections as lessons (README).
2. **Server-mode runtime has a real background sub-agent protocol.** PR #20862: `callSubAgent({runInBackground:true})`/`callAgent(...)` return a receipt written into the tool's placeholder row; the completion bridge distinguishes background runs by `state.background`; delivery waits until the topic is idle, then the result is delivered "as a new message on the main line, and the parent agent wakes up to act on it".
3. **Delivery has claims and hand-back.** "Each result is claimed before its wake-up turn starts, and a turn that fails to start hands its claims back" — the same failure shape DS-Bot solves with `resent`/`taken`.
4. **Concurrency is capped per topic:** at most five background sub-agents at once; the client runtime and group conversations reject the flag.
5. **Result messages are typed and non-editable.** Stored as a user message whose sender is the sub-agent (`metadata.subAgentCallback`), read by the model wrapped in `<sub_agent_result id name status>`, skipped by the input template, rendered as a turn spoken by the sub-agent with an "unfinished" tag on failure.
6. **Live-follow semantics for runs you did not start.** The client refetches the topic when a top-level run starts elsewhere, refetches threads when a child starts/ends, refetches messages when a child ends after the parent stopped streaming — and skips runs this tab started to avoid a duplicate resume stream.
7. **Skills are an open format, not a plugin API.** The marketplace ships Skills in SKILL.md that "also work in Claude Code, Codex CLI and ChatGPT", alongside Agents and MCP servers (README Marketplace).
8. **Deployment is Docker Compose or one-click**, with a self-hosting path separate from the cloud app (README).

### 2.4 Claude Code (`claude` 2.1.323, Claude Code docs; proprietary)

1. **The loop is the product.** "Claude Code is the layer around the model that provides the tools and manages the context the model sees" — the harness, not the model (docs/en/how-claude-code-works.md:23).
2. **Mid-turn steering is a documented contract:** a typed message while tool calls run "is read as soon as those calls finish, within the same turn, and adjusts before its next step"; Esc cancels the running tool call and Claude waits (`how-claude-code-works.md:210-211`).
3. **Cross-session messaging is socket-based.** A session binds an inbox socket (Unix domain socket on macOS/Linux, named pipe on Windows); a message is delivered between tool calls if the receiver is active, and **starts a new turn** when idle (docs/en/cross-session-messaging.md:59, :239-243).
4. **Idle notification without a turn:** `SendMessage` accepts `notify_when_idle`, so a watcher gets one notice when the target next goes idle or exits — "Claude Code subscribes without starting a turn or spending tokens in the watched session" (:92).
5. **Inbound messages are policy-gated:** `accept` / `hold` / `refuse`, with permission-class rules (a bypassing sender's message is held for approval), held messages re-evaluated when the mode changes (:201-220).
6. **Subagents are full configurations:** frontmatter supports `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `autoCompactWindow`, `skills`, `initialPrompt`, `memory`, `effort`, `background`, `omitClaudeMd`, `isolation: worktree` (docs/en/sub-agents.md:223, :300-313).
7. **Subagent context discipline is explicit:** each runs in its own context window and returns only a summary; a fork starts from a copy; tool calls stay out of the parent's context; descriptions are budgeted (a 15,000-token warning) (sub-agents.md:11, :27; how-claude-code-works.md:148).
8. **Agent teams are experimental but real:** a lead coordinates full sessions, teammates share a task list with pending/in-progress/completed states and dependencies, claim work, message each other directly, and can send plan-approval requests (docs/en/agent-teams.md:11, :208).
9. **Background sessions are addressable:** `--bg` returns an id used by `claude attach|logs|stop|rm`; `claude agents` lists them; resuming a running background session attaches to it instead of loading the transcript (claude --help; docs/en/sessions.md:27-43).
10. **Resume restores more than text:** permission mode, agent identity, an active goal, and — importantly — "interrupted tool calls … doesn't get rerun when you resume"; background work that died shows as a note that does not start a turn (sessions.md:47-56).
11. **Compaction is automatic, steerable and bounded:** auto-compaction summarises, "Compact Instructions" in CLAUDE.md or `/compact focus …` steers it, and it stops after a few attempts with a "thrashing" error instead of looping (how-claude-code-works.md:134-138).
12. **32 hook events** including `PreToolUse`, `PermissionRequest`, `PostToolUseFailure`, `SubagentStart/Stop`, `TaskCreated/Completed`, `Stop`, `StopFailure`, `TeammateIdle`, `PreCompact`, `PreModelSwitch`, `Elicitation` (docs/en/hooks.md event headings).
13. **Memory has two layers:** CLAUDE.md files with managed→user→project→local load order and `@import` up to four hops, plus auto memory that Claude writes itself (docs/en/memory.md:55-64, :102-106).

### 2.5 Codex CLI (`openai/codex`, Apache-2.0; `codex-cli` 0.162.1)

1. **A long-lived app-server, not a script:** subcommands `app-server`, `exec-server`, `remote-control`, `agents` (browse sessions on a shared local daemon), `cloud`, `mcp`, `plugin`, `resume`, `fork`, `queue`, `archive`, `apply` (`codex --help`).
2. **Queueing into a live thread is a CLI primitive:** `codex queue --thread <UUID|name> --message <TEXT>` — DS-Bot's backlog has no equivalent user-facing command.
3. **Remote queueing:** the same command accepts `--remote ws://|wss://|unix://` and `--remote-auth-token-env`, i.e. the queue protocol is designed to cross a process/machine boundary.
4. **Sandbox modes are a CLI enum:** `-s read-only|workspace-write|danger-full-access`, plus `--dangerously-bypass-approvals-and-sandbox` and `--approve-for-me` (auto-review approvals inside workspace-write) (`codex exec --help`).
5. **Sandbox is inspectable and re-runnable:** `codex sandbox [COMMAND…]` runs a command under seatbelt with `--sandbox-state-json`; `codex sandbox uninstall` removes the legacy Windows sandbox.
6. **Structured outputs are first class:** `exec --json` (JSONL), `-o/--output-last-message FILE`, and `--output-schema FILE` validating the final response against a JSON Schema (`codex exec --help`).
7. **Configuration layers:** `-c key=value`, `-p/--profile` layering `$CODEX_HOME/<name>.config.toml`, `--strict-config`, plus managed `requirements.toml` that can force managed-hooks-only (docs/config.md).
8. **Lifecycle hooks exist as config**, and can be restricted to managed hooks by admins (`requirements.toml: allow_managed_hooks_only = true`).
9. **Authentication:** ChatGPT plan or API key; local OSS providers via `--oss` and `--local-provider lmstudio|ollama`.
10. **Resume/fork semantics are explicit subcommands** (`resume --last`, `fork`), and `apply` applies the latest diff as a patch.

### 2.6 OpenAI Agents SDK (`openai/openai-agents-python`, MIT)

1. **Five primitives, no runtime process:** Agents (instructions + tools + guardrails + handoffs), handoffs, agents-as-tools, guardrails, sessions (README "Core concepts").
2. **Handoffs are control transfer, agents-as-tools are calls** — the README keeps both and expects the developer to choose.
3. **Sandbox agents are a distinct type:** `SandboxAgent` + `Manifest` + `GitRepo` entries with `UnixLocalSandboxClient`/`DockerSandboxClient` via `RunConfig(sandbox=…)`, aimed at "long horizons" (README).
4. **Realtime agents** run over WebSocket against `gpt-realtime-2.1` with typed events (`audio`, `history_added`, `agent_end`) — a different transport from the text runner (README).
5. **Voice agents** are STT → workflow → TTS, again a separate pipeline.
6. **Sessions give automatic history across runs**; there is no extraction or consolidation pipeline in the SDK.
7. **Tracing is built in** and on by default; the SDK is the only system here where a trace is a language-level concept rather than an integration.
8. **Python 3.10+**, pip/uv installable; no server, no CLI, no desktop shell.

### 2.7 LangGraph (`langchain-ai/langgraph`, MIT)

1. **Durable execution is the core value:** a checkpointer persists state at every super-step; a workflow resumes "from its last recorded state" after a crash or a human-in-the-loop pause (docs/langgraph/durable-execution).
2. **Resume is replay, not continuation:** "the code does NOT resume from the same line of code"; the runtime replays recorded steps from the last checkpoint — so side effects must be wrapped in tasks/nodes and made idempotent (same doc).
3. **Three durability modes** — `exit`, `async`, `sync` — trading performance for crash-consistency, selectable per call.
4. **Interrupts are dynamic:** `interrupt(value)` suspends anywhere in a node, saves state, and surfaces the payload; `Command(resume=…)` supplies the resume value, and "the node restarts from the beginning of the node".
5. **Threads are the addressable unit:** `thread_id` "is effectively your persistent cursor"; a new id starts a new thread with empty state.
6. **Typed resume schemas:** `interrupt(response_schema=…)` turns the resume payload into JSON Schema clients can render as a form (langgraph ≥1.2.12).
7. **Memory is two-layer:** short-term working memory per thread (checkpointer) plus a long-term store, per README.
8. **No tools, no prompts, no model routing** — LangGraph is orchestration only; those come from the surrounding framework and LangSmith for traces.

### 2.8 Letta (`letta-ai/letta`, Apache-2.0)

1. **Memory is a filesystem the agent edits.** MemFS is "a git-backed memory filesystem that they can inspect and edit"; memory is shared across the agent's conversations (docs.letta.com/configuration/memory).
2. **Memory maintenance is a workflow, not a hope:** `/init` bootstraps memory (inspects the repo, asks about working style, can review prior sessions with subagents); `/remember` teaches; `/memory` or `$MEMORY_DIR` inspects.
3. **Drift is audited:** `/doctor` audits placement, duplication and **system-prompt token usage** — a first-class answer to "my memory is bloating the prompt".
4. **Dreaming is background subagent review:** recent conversations are consolidated "without interrupting your active work", triggered after N completed agent steps or when the context window is compacted; an option makes the agent review its own proposed memory updates in a second background conversation.
5. **Memory is versioned and bounded:** the git-backed repo is backed up before large reorganisations; cloud budgets are 5 MiB (Free) / 50 MiB (Pro) per repository.
6. **The product now ships as a harness**, not just a server: `letta` TUI, `letta server`, channels (Slack/Telegram/Discord/custom), a TypeScript Agent SDK, cloud and desktop (README).
7. **The V1 API server is retired to an `archive` branch**, i.e. the project moved from "MemGPT server" to "agent harness with memory" (README).

### 2.9 AutoGen (`microsoft/autogen`; archived → Microsoft Agent Framework)

1. **Archived, with an explicit successor.** The README carries a red "Archived" badge and points to `microsoft/agent-framework` as the "enterprise-ready successor"; AutoGen is "community-managed" and in maintenance mode, accepting only bug fixes, security patches and docs (README).
2. **Team presets are the orchestration API:** `RoundRobinGroupChat` (shared context, turn-taking), `SelectorGroupChat` (a model picks the next speaker), `Swarm` (`HandoffMessage` signals transitions), `MagenticOneGroupChat` (generalist web/file tasks) (AgentChat Teams docs).
3. **Termination is a composable condition object:** `TextMentionTermination`, `MaxMessageTermination`, `ExternalTermination`, etc. — termination is data, not a prompt instruction.
4. **Broadcast semantics:** in a round-robin team each agent "broadcasts its response to all other agents, ensuring that the entire team maintains a consistent context" — the opposite trade-off from DS-Bot's per-member Session isolation (Teams docs).
5. **`AgentTool` wraps an agent as a tool** (`return_value_as_last_message=True`) with `max_tool_iterations=10` — agents-as-tools again, with a hard iteration cap (README).
6. **Studio is explicitly not production-ready** ("AutoGen Studio … not production-ready"), though it is the visual agent builder.
7. **License caveat:** the repository `LICENSE` is **Creative Commons Attribution 4.0 ("Attribution 4.0 International")**, not a software license — a real risk for code reuse.

### 2.10 Observability pair: Langfuse (`langfuse/langfuse`, MIT) and AgentOps (`AgentOps-AI/agentops`, MIT)

1. **Langfuse is OpenTelemetry-native**: traces of LLM calls, retrieval, embeddings and agent actions, inspectable as logs and user sessions (README Core Features).
2. **Prompt management is a product**: version control, server+client caching, a playground — and, in beta, **Skill Management** with versioning/labels for SKILL.md skills, promote/rollback, and linking a skill version to traces.
3. **Evaluation is first-class:** LLM-as-a-judge, code evaluators, user feedback, manual labelling, datasets and experiments for pre-deployment tests, plus custom pipelines over APIs/SDKs.
4. **An AI gateway sits in front of providers**: one endpoint, central credentials, per-user/service-account keys, centrally approved models, spend per user/key/model, every call recorded as a trace (beta).
5. **AgentOps trades depth for two lines of code:** `agentops.init(api_key)` … `agentops.end_session('Success')`, then session replays, step-by-step execution graphs and cross-provider LLM cost tracking (README).
6. **AgentOps' integration list is the adoption strategy:** CrewAI, AG2 (AutoGen), Agno, LangGraph, OpenAI Agents SDK, LangChain, Camel, LlamaIndex, Cohere, Microsoft.
7. **Both are self-hostable and MIT** (Langfuse's MIT applies to the core; the repo badge says MIT, the `ee` folders carry commercial terms — **not re-verified here**).
8. **Neither is an agent runtime.** They observe and evaluate; they do not own turns, wakes or delivery — which is why they are useful as a *layer* over DS-Bot rather than a competitor.

### 2.11 harnessdesk (`HarnessDesk/HarnessDesk`, MIT) and agenticmail (`agenticmail/agenticmail`, MIT)

1. **harnessdesk owns the turn boundary across heterogeneous runtimes.** One `AgentRuntime` per agent — Codex native, everything else over ACP — and the host is "the only place that sees `turn/completed` for all of them" (`docs/architecture.md`).
2. **Its message queue is the closest published analogue to DS-Bot's backlog, with one crucial difference:** the queue lives *beside* the session so "an adapter re-emitting a whole Session cannot erase it", sends one message per turn when the turn ends, and **holds the queue rather than firing it when a turn ended badly**.
3. **One permission policy in front of every backend**, applied "before any backend's own question reaches the user", plus one append-only audit log `audit.ndjson` (`docs/architecture.md`).
4. **Hand-off packets are structured, not conversational:** Goal / Where it stands (last 6 exchanges, 600-char asks, 1,000-char answers) / Conversation (transcript mode, 120,000-char limit) / Files changed (+N −M, ≤200 files) / Open plan (incomplete TodoWrite items) / Ground truth (cwd, branch, commit) (`docs/multi-agent.md`).
5. **Three cooperation modes, deliberately named:** hand-off (sequential baton), `/race` (one agent on two isolated seats, judged), rooms/boards (concurrent, human referee) — "Flows configure the third one; they are not a fourth".
6. **Its board encodes "cannot move without a person"**, including finished work whose facts are not good: CI failed, CI cancelled, closed PR, stale fact — and "nothing checked at all" alone keeps a run in "Needs you".
7. **Reuses each backend's own sandbox** (Seatbelt, Landlock, ACL) instead of duplicating it, and its usage dashboard reports spend per agent over 30 days, account headroom and a year of activity.
8. **agenticmail treats email as the queue.** A real address per agent; inbound relay polls Gmail IMAP every 30 s (or Cloudflare Email Routing → Worker → `POST /mail/inbound`), delivers to the agent's Stalwart mailbox, and IMAP IDLE fires SSE — a durable, external, wake-on-event inbox.
9. **Wake context is layered and budgeted:** every wake prepends **ThreadCache** (envelopes + previews of the last 10 messages, shared across CC'd agents) and **AgentMemory** (a markdown file each agent writes at end-of-wake), so agents "don't `read_email` prior history" (README).
10. **RPC beats text orchestration, by its own measurement:** `call_agent` is a synchronous agent-to-agent call with timeout, long-poll and SSE notification; the project's paper claims 53× faster response than conventional sub-agent spawning and names the "Conversational Fallacy".
11. **Typed task contracts:** `call_agent`/`POST /tasks/assign` accept `outputSchema` (JSON Schema draft-7 subset), `submit_result` validates it and returns 400 with validator errors so the worker can retry with a corrected shape.
12. **Its own scale evidence is modest but concrete:** versions 0.9.0–0.9.54, "1038 tests pass", 100 MCP tools / 75+ HTTP endpoints.

---

## 3. Where DS-Bot is behind (ranked)

Ranking is by (impact on correctness of Bot behaviour) × (cost of not having it), not by how easy it is to copy.

1. **No `record` vs `action` distinction at the delivery layer — every non-silent message can spend a full turn.** DS-Bot's own measurement says 59.9% of 394 daily turns were opened by another Bot's message, 21.3% by memory notifications (`docs/plans/2026-11-14-bot-turn-economy.md`), and the follow-up note records that `role:'update'` still enters the inbox and wakes a turn (`docs/plans/2026-11-14-turn-triggers-issue.md`, pointing at `delivery.js:38`, `roster.js:479`, `tools.js:388`). The designed fix — `deliver({kind:'action'|'record'})` — is not implemented.
   **Proved by:** harnessdesk's queue holds messages without firing them and only `turn/completed` triggers delivery (`docs/architecture.md`); Claude Code's `notify_when_idle` "subscribes without starting a turn or spending tokens" (`cross-session-messaging.md:92`); Codex's `queue` is a message, not a run; LobeHub's background sub-agent delivery explicitly waits for topic idle (PR #20862).
2. **No idle-subscription primitive ("tell me when that Bot goes idle").** DS-Bot has handoff parent/child blocking and `lateWork`, but no way for Bot A to ask "wake me when B finishes this" without B sending a message that itself wakes A. Claude Code's `notify_when_idle` sends one notice with the turn's end time and a one-line status, and if the watcher is idle it starts a turn; agenticmail gets the same effect from long-poll + SSE.
3. **No step-level durability for tool side effects.** DS-Bot recovers *messages* (exchange-level dedupe, `resent`), but a crashed turn's tool calls are not checkpointed and there are no idempotency keys. LangGraph makes this the centre of its design: checkpoints per super-step, three durability modes, replay from the last checkpoint, and an explicit rule that side effects must be wrapped in tasks and be idempotent (`durable-execution.mdx`). Claude Code takes the opposite stance — interrupted tool calls are **not** rerun on resume (`sessions.md:50`) — which is safe but loses work.
4. **No OS-level sandbox; "private Bot" is a tool-layer fence.** `privacy.js` says it plainly: "a shell can still reach any file the account can". Codex exposes `read-only|workspace-write|danger-full-access` and a re-runnable `codex sandbox` under seatbelt (`codex exec --help`, `codex sandbox --help`); Claude Code has `--restricted` and permission modes; harnessdesk reuses Seatbelt/Landlock/ACL per backend; OpenAI's SDK ships container sandbox agents. DS-Bot's private-Bot promise is therefore weaker than it reads in the README.
5. **Approvals are borrowed, not owned.** DS-Bot applies DSH presets and races DSH's own approval card; in group Sessions it answers the card itself (`approvals.js`, `permissions.js`). There is no DS-Bot-owned allow/deny rule language, no per-tool policy evaluated before the backend asks, and (as far as I could verify) no append-only approval audit log. harnessdesk has exactly that: "one policy, applied before any backend's own question reaches the user, and one append-only audit log (`audit.ndjson`)". Claude Code has `PermissionRequest`/`PermissionDenied` hooks and per-subagent `permissionMode`.
6. **No in-turn background child with claim/hand-back.** DS-Bot removed DSH's subagent tools and replaced them with Bot-to-Bot handoffs, which is a legitimate design — but it means a Bot cannot spawn a cheap background worker mid-turn, keep working, and receive the result as a message. LobeHub's PR #20862 is the reference implementation: receipt in the placeholder, delivery on topic idle, per-result claims, claims returned if the wake-up turn fails, ≤5 concurrent, result rendered as a sub-agent turn with an `<sub_agent_result>` wrapper.
7. **Memory retrieval is keyword-based, with no semantic index and no diff/rollback UI.** DS-Bot keeps Markdown entries and a `recall` tool with topic files (`memory.js`), plus snapshots and `reviewed.json`. Letta has a git-backed MemFS with `/doctor` auditing duplication and system-prompt token cost and "dreaming" consolidation by background subagents (`docs.letta.com/configuration/memory`). DS-Bot's memory review runs after a turn (`memory-review.js`), but there is no equivalent audit command and no vector recall.
8. **Observability stops at the ledger — no trace/span model, no replay of a turn's steps.** DS-Bot has JSONL books, `usage.sqlite`, metrics and diagnostics, which is more than most (see §4), but there is no OpenTelemetry export, no per-turn span tree, no prompt-version-to-trace linkage. Langfuse provides all three plus datasets/experiments and LLM-as-judge; AgentOps adds step-level replays. DS-Bot's `dev/eval/` is a local golden-file judge, not a service with history.
9. **No typed contracts on delegated work.** DS-Bot handoffs carry text and a work tree (`handoffs.js`), and task results are free-form. agenticmail validates submitted results against a JSON Schema (`outputSchema`, 400 with validator errors); Codex validates a final answer with `--output-schema`; HarnessDesk's packet is a fixed schema with named sections and hard limits (`docs/multi-agent.md`). A DS-Bot handoff that returns "done" is unfalsifiable except through the `claims.js` marker.
10. **Schedules can overlap; trigger hygiene is thin.** DS-Bot's `schedules.js` is a thin layer over DSH's schedule service (list/create/remove, unwrap reminder framing). OpenMausBot explicitly **skips** an occurrence while the previous run is active "so slow work cannot build an unbounded queue" and shows a calendar with run history.
11. **No cross-machine or cloud execution.** Codex has `cloud`, `remote-control` and `--remote` queue targets; Claude Code has Remote Control, mobile and cloud sessions; DS-Bot has a mobile client and IM bridges but every turn needs the user's machine awake (README states this).
12. **No user-facing hook/extensibility surface.** Claude Code exposes 32 lifecycle hook events with matchers, async hooks and prompt/agent-based hooks; Codex has config hooks with managed-only mode. DS-Bot consumes DSH events internally (`turns.js` switch over `turn/start`, `tool/*`, `turn/end`) but does not expose a hook configuration to users.

---

## 4. Where DS-Bot is ahead or equivalent

1. **A team that persists across sessions, with rights.** Main Bots create/change/remove Bots; only the user deletes one; any Bot can call any other (`docs/vision.md`). Claude Code's agent teams are experimental, session-scoped and gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; OpenMausBot has channels and a responder picker but no rights model; harnessdesk rooms need a human referee.
2. **Groups are a first-class object, not a fan-out.** Rounds, @-mentions that start members concurrently, an admin that answers by default, a member answering one call at a time, and a round that does not wait on a busy member (`groups.js`). AutoGen's round-robin broadcasts every message to every agent (shared context); DS-Bot isolates each member's Session and shares only the room.
3. **Memory scopes are richer than any comparator here:** per-Bot, per-group, and team memory, with read-but-not-write across Bots and write rights tied to Main Bots (`docs/vision.md`, `memory.js`). Letta has shared memory repositories, Claude Code has project-scoped auto memory; neither has a group-scoped memory whose readers are exactly the room members.
4. **Prompt-prefix stability is designed in.** One prompt section derived only from the Bot record, fixed section order, per-Session frozen memory snapshot (`prompt.js`, `memory.js`). Claude Code documents prompt caching and warns that a model switch or CLAUDE.md edit costs a slow uncached turn — DS-Bot's structure exists precisely to avoid that class of regression.
5. **Burst coalescing with content rules.** The backlog merges "plain" notes by Session, keeps the newest verbatim, keeps replies with their own header, counts earlier requests, and costs one turn per burst (`backlog.js`). harnessdesk's queue sends one message per turn but does not merge text; Claude Code queues each message separately.
6. **Exchange-level crash recovery with explicit re-delivery marking.** `resume.js` dedupes by `exchangeId`, rebuilds `taken` from the inbox, re-delivers with `resent:true` so the recipient reads "DeepSeek Harness restarted before it could reach you" (`delivery.js:64`). LangGraph checkpoints graph state (a different guarantee); Claude Code deliberately does not rerun interrupted calls and does not re-deliver messages.
7. **Reply fact-checking (`claims.js`).** A reply that links a local file that is not there, or claims work while nothing runs, gets a marker on the group message. No comparator does this at the message level; the closest is harnessdesk's board rule that "nothing checked at all" keeps a run in "Needs you".
8. **Private Bots as a product concept with tool-level fencing.** Read fencing for file/search/session tools, write-outside-folder approval, exclusion from groups and Main-Bot status (`privacy.js`, README). The comparators offer sandboxing (a different control) or nothing.
9. **Local agent CLIs as first-class Bots across three protocols.** `local-agents/engines.js` lists 10 CLIs — claude-code (`stream-json`), codex-cli (app-server JSON-RPC), and ACP for Devin/OpenCode/Cursor/Gemini/Grok/Cline/Qwen/Goose — each with its own sign-in probe. harnessdesk is the closest (Codex native + ACP); DS-Bot additionally treats each as a *Bot* with team tools via MCP.
10. **Turn-economy instrumentation.** DS-Bot classifies what opened every turn (reply/request/update/stopped/memory/user) and reports p50/p90 duration, tool calls and in-turn injection size (`dev/turn-economy.mjs`). LobeHub's PR #22530 (per the design note) records "why woken"; nobody else publishes this metric.
11. **Nine IM bridges with no public IP.** Weixin, WeCom, Feishu, DingTalk, QQ, Telegram, Discord, Slack (`src/host/im/platforms/`) — comparable to agenticmail's email/phone gateway and LobeHub's "plug in any IM app", but with the harder Chinese platforms covered.
12. **Rich chat surface.** ~130 client modules: streaming turns, reasoning view, queue dock, Enter-to-steer, handoff cards, learning cards, widgets/views, BTW side questions, team board, memory panel, usage page, approval notices (`src/client/`). Claude Code's terminal UI and Codex's TUI are deliberately narrower; DS-Bot is a chat product.
13. **Group Goals** (`goals.js`): one outcome per room with stages/tasks, user steering from goal endpoints, and a relay that nudges the admin when nothing runs and the goal is not done. AutoGen has termination conditions; LangGraph has interrupts; nobody here has "a room with an outcome and a nudge when it stalls".

---

## 5. Copy candidates

Effort: S ≈ under a day, M ≈ a few days, L ≈ a week or more for one maintainer. Risk is about DS-Bot's own invariants (DSH contracts, prefix-cache stability, turn economy, privacy).

| Mechanism | Source project | License | Effort | Risk |
|---|---|---|---|---|
| `deliver({kind:'action'\|'record'})` + record "why woken" on every turn | LobeHub PR #22530 (idea), harnessdesk queue semantics | LobeHub Community (design only), harnessdesk MIT | S | Medium: changes turn counts; must re-measure with `turn-economy.mjs` before/after |
| Hold-queue-when-a-turn-ended-badly | harnessdesk `docs/architecture.md`, `docs/message-queue.md` | MIT (code copyable) | S–M | Low; DS-Bot already has `resume.js`; risk is double-holding |
| Idle-subscription (`notify_when_idle`-style one-shot) | Claude Code `cross-session-messaging.md` | Proprietary (reimplement from docs) | M | Medium: needs a subscription store and a turn/end hook; must not wake twice |
| Inbound policy accept/hold/refuse + sender-permission gating | Claude Code docs; harnessdesk policy engine | Proprietary / MIT | M | Medium: overlaps with group approvals and `permissions.js` |
| Background child with claim/hand-back and result-as-message | LobeHub PR #20862 | Community License (design only) | L | High: DSH subagent tools are hidden on purpose; would need a new work type in `handoffs.js` |
| Structured handoff packet (Goal / Where it stands / Files changed / Open plan / Ground truth) | harnessdesk `docs/multi-agent.md` | MIT | S | Low–Medium: prompt length; must stay cache-stable (packet is per-handoff, not per-Session) |
| Typed result contract (`outputSchema` + validation on submit) | agenticmail README | MIT | M | Medium: schema drift; needs a place to store schemas in `state.json` |
| Step-level checkpoints / idempotency keys for tool side effects | LangGraph `durable-execution.mdx` | MIT | L | High: cannot patch DSH; only wrappable at the tool-call boundary |
| Memory audit (`/doctor`-style: placement, duplication, prompt-token cost) | Letta `docs.letta.com` | Apache-2.0 (code copyable) | M | Low–Medium: read-only audit first; memory format must not change |
| Dreaming / sleep-time consolidation by a background reviewer | Letta | Apache-2.0 | M | Medium: token cost; DS-Bot already has `memory-review.js` and `learning.js` — extend, don't duplicate |
| Git-backed memory with diff/rollback | Letta MemFS | Apache-2.0 | M–L | Medium: `memory/snapshots/` exists; a real git repo per Bot adds ops surface |
| Skip-overlapping schedule occurrences + run history | OpenMausBot | Apache-2.0 | S | Low: DSH schedule service may not expose "still running"; may need a lock file in `state.json` |
| Explicit trigger whitelist (only listed events wake a turn) | OpenMausBot (also DS-Bot's own design note) | Apache-2.0 | S | Low; pairs with `kind` |
| OS sandbox presets per Bot (`read-only` / `workspace-write` / full) | Codex `-s` + `codex sandbox`; harnessdesk backend reuse | Apache-2.0 / MIT | L | High: macOS seatbelt, Linux landlock, Windows; DSH `sandboxPolicy` is the only hook (`folders.js:158`) |
| OTel span export of turns/tool calls | Langfuse, AgentOps | MIT | M | Medium: scrubbing (paths, secrets) before export; `diagnostics.js` already scrubs |
| Datasets + experiments + judge history for prompts | Langfuse | MIT (core) | L | Medium: hosting; `dev/eval/` already has golden + judge |
| `/race` parallel seats with a judge | harnessdesk | MIT | M | Medium: doubles token cost; needs explicit opt-in |
| Room-wide task list with dependencies and claim | Claude Code agent teams | Proprietary (design only) | M | Medium: overlaps with group Goals and handoffs |

---

## 6. What I could not verify

- LobeHub's memory/retrieval internals (user memory extraction pipeline, knowledge-base indexing). The README is marketing-level and the docs site served a migration stub; only the PR-level runtime facts above are verified.
- Letta's trace/observability surface and its subagent implementation (the docs index referenced `/configuration/subagents/` but I did not fetch it).
- Codex sub-agent orchestration (whether `codex` has native subagents comparable to Claude Code) — the CLI lists no `agent`-creation subcommand and I did not read its docs.
- DS-Bot approval audit: `approvals.js` listens to `approval/request` and records outcomes for the UI; I did not confirm whether outcomes are persisted append-only (the ledger modules suggest conversation/message records, not approvals).
- Whether DSH's `agent.followup()` wakes an idle Session by design or by convention — the plugin relies on it (`delivery.js:210`), but DSH's own docs were not readable from the installed asar.
- AutoGen's tracing integration specifics (the docs list "Tracing and Observability"; no page was fetched).
- Langfuse's exact MIT/commercial split for the `ee` folders (the README badge says MIT; the folder split is a known convention, not re-verified here).

**Commands actually run** (for reproducibility): `claude --help`; `codex --help`; `codex exec --help`; `codex queue --help`; `codex sandbox --help`; `wc -l ds-bot/src/host/*.js`; `grep` over `ds-bot/src/host/*.js` for the symbols cited; `node ds-bot/dev/turn-economy.mjs` exists but was **not** run against live data here (numbers quoted are the design note's 2026-11-14 measurement); `curl -sk` fetches of the READMEs/docs/LICENSE files named above.
