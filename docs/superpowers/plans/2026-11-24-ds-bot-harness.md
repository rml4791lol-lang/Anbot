# Anbot Harness Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Work from the frozen integration base, own only the assigned files, and attach verification evidence to every handoff.

**Goal:** Deliver a DSH-native Personal Agent that can carry a real engineering project from intent to a verified result, keep working across interruptions, and let the user understand and take over the work.

**Architecture:** DSH/Cordis owns native Presets, Sessions, Turns and execution. Anbot owns project intent, task identity, approvals, evidence and operator control. The target protected kernel exposes five typed contracts. Bot Forge and Anbot Self-Builder use those contracts, as do optional extensions. The default chat is concise, with an on-demand X-Ray workspace for plans, execution, evidence and control.

**Tech Stack:** Existing Node ESM DS Bot plugin, DSH, React client and Electron app. The product uses its existing local state and Markdown memory.

**Spec:** [Product vision](../../vision.md), [architecture decisions](../../../ARCHITECTURE_DECISIONS.md), [goal behavior](../../plans/2026-11-01-group-goal.md), [Bot runtime configuration](../../plans/2026-10-10-bot-runtime.md) and [local agents](../../plans/2026-11-04-local-agents.md).

## Global constraints

- Baseline is fork `5471b4d3`, fast-forward from fork `origin/dev` `048f223d`. Integrate verified existing preset and Reality Harness work by responsibility. Existing user and parallel worktrees remain separate.
- The bound pinned DSH release determines which APIs exist. Version changes have a distinct compatibility gate and rollback. Use the mock bench with isolated data for deterministic tests. Actual integration runs use test-controlled profiles and worktrees. Never use or alter user DSH data in tests.
- All subagents use `deepseek-v4.1-flash` with `max` reasoning. The maintainer independently verifies gathered evidence, reviews diffs and owns integration decisions. Credentials and private state stay out of prompts, artifacts and commits.
- Each product slice shows actual availability, authorization, execution and verification. Store plans and evidence with their existing owners. Reuse native DSH rather than adding a runtime or an independent policy engine.
- Scope includes engineering, design and orchestration first, with the same assembly model usable for maintenance, research, documentation, QA and operations. Preserve user-configured intent, project objectives, operating constraints and delegation rights across roles, sessions and devices.

## Phase 0 · Brand and distribution

- [x] Switch visible identity, metadata, downloads, feedback, release workflow and update source to `rml4791lol-lang/Anbot`. Retain historical attribution and compatibility identifiers where needed. Verify the private release channel and configuration overrides with no embedded credential.
- [x] Verify existing shells, project/data locations and legacy environment keys, including isolated runs. Rebuild the client and app, run lint and unit tests, and smoke the real pinned DSH host and desktop where supported. Capture evidence and commit separately.
- [x] Seed [architecture](../../architecture.md), [extensions](../../capabilities-and-extensions.md) and [development](../../development-and-runbook.md) from verified paths. This plan is the sole phase and progress ledger.

## Phase 1A · Protected kernel, two-layer UI and one real bug

- [ ] Freeze narrow TypeScript contracts and integration tests before assigning disjoint file scopes. Define configuration/security (nested merge, protected provider fields, workspace sandbox and dangerous-command confirmation); context (append-only history and separate projection); state/memory/checkpoints (one writer and paired conversation/workspace revision); execution/worktree (structured provider facts, cancellation and reconciliation); extensions/view (mount, availability, unmount and evidence).
- [ ] Reuse native DSH preset registration, Session and tool policy. Connect a bounded native Workflow with actual start, terminal and cancellation events. Display observed installed/signed-in, skill/plugin load, and worktree created/session ready/turn started states. Expose blocked reason, explicit model retry, bounded resume, and supported cost/cache counters.
- [ ] Assemble Bots dynamically from preset, instructions, skills, execution route, workspace policy and validation. Built-in development, UI and coordination combinations use the same format as custom Bots.
- [ ] Keep the default chat concise: fold intermediate work, show inline diffs, jump between question and latest reply, preserve file references on copy, guard an active task on close, and allow asynchronous questions without stopping independent tasks. X-Ray shows editable Spec and checklist, actual executor, probes, context budget, checkpoints, evidence and controls. Take over and return the same worktree after execution has stopped.
- [ ] Compare a general Bot and a debugging preset on the same real defect. Verify reproducing, fixing, regression testing, and human edits before return in isolated data and worktrees. Inspect actual Electron at desktop and narrow viewports, with screenshots and keyboard interaction. Commit Phase 1A only after this gate.

## Phase 1B · Bot Forge and Anbot Self-Builder

- [ ] Ship the two meta engines as declarative presets with actual scoped Cordis tools. Bot Forge inventories runtime facts, composes a preset, registers an authorized lightweight Skill or Hook, validates it in an isolated trial and iterates from an imported trace.
- [ ] Self-Builder reads this repository, architecture/extensions docs, the live Cordis tree and sanitized diagnostics. Require a shadow worktree, Spec, build/test/Playwright evidence and isolated preview. Provide explicit integration and rollback, with stronger validation for kernel changes. Add creation mode with conversation, configuration diff, probe and trial panels, plus routing from a failed chat.
- [ ] Run a Forge create/trial/refine cycle and a real Self-Builder improvement through preview and rollback. Capture evidence and commit. Phase 1A must already have passed.

## Phase 2 · Context, memory, Repo Wiki and LSP

- [ ] Keep DSH history immutable, protect stable prefix semantics, and verify the separate context projection, token budget, compaction and cross-segment handoff after restart. Keep authority for active project decisions and in-flight task facts in the existing records.
- [ ] Evaluate `billion-context` against the pinned runtime and shutdown/uninstall behavior. Use native mounting only when the frozen seam and permission boundaries hold. If the dependency is unavailable or incompatible, implement the smallest native equivalent at the seam. Record why, the substitution tests and a future adapter entry in the extension ledger. Use the same decision rule for other tools. Qoder CLI is outside integration scope.
- [ ] Implement incremental Git-backed Repo Wiki and on-demand LSP lookup. Verify scoped, source-linked project memory, separate personal preferences, correction and undo, and explicit handling of memories created after a restored conversation/workspace checkpoint.
- [ ] Run pressure, prefix integrity, restart/segment continuation, and plugin removal verification against real runtime. Commit the passing phase.

## Phase 3 · Multi-Bot coordination and scheduling

- [ ] Reuse native local SDKs and Orca's applicable dispatch, reconciliation and workspace patterns. Bind task and attempt to checked-out revision, worktree, DSH Session and local execution. Enforce deduplication and conflicting writer control. Supply allowed parent skills/plugins only when actual child availability is proved.
- [ ] Expose dependencies, approvals, task nodes and direct navigation to individual execution. Support staged Goals, an idle local queue and thin state/approval/reply integration ports. Preview unmerged changes before cleanup.
- [ ] Use at least two real local Agents on a real project and demonstrate conflicting dispatch refusal, stop, user takeover/return, restart and final independently verified evidence. Commit the passing phase.

## Phase 4 · Code, evidence and documentation audit

- [ ] Review the full diff, prune only task-owned dead code, temporary processes and worktrees, verify generated files and durable compatibility. Check each documentation path and command, and verify the Self-Builder reads the committed versions.
- [ ] Run applicable full build, lint, unit, integration, native runtime, desktop and E2E checks. Record phase hashes, exact commands and evidence artifacts here, and deliver on a clean local branch. Remote writes, Release publication and external system changes require confirmation.

## Integration rules

- Preserve accepted and verified commits. Do not combine product changes with Phase 0. Commit using Conventional Commits after independent review and checks.
- Dispatch `deepseek-v4.1-flash` at `max` only. Include exact write boundaries, contract context and verification commands. Keep existing parallel worktrees separate and independently verify a change before reuse.
- Real DSH, local CLI and desktop runs are required for core acceptance. Deterministic fixture checks complement them. Use native substitutes for unavailable nonessential integrations and record evidence, without claiming that the external tool itself ran.
- Record reference source, pinned revision, license and integration decision for code reuse. Engineering candidates include Superpowers and Matt Pocock, UX patterns from Product Design, and local worker behavior from Orca. Continue the remaining phases locally unless an external credential is necessary or an authorized remote action is the next step.

## Progress record

- 2026-11-24: Opened the maintainer goal, isolated the integration branch, and routed three baseline investigations to DeepSeek V4.1 Flash max. Parallel preset and Reality Harness work has its own worktree. It must be reviewed and integrated by change set.

- 2026-11-24: Pre-brand baseline at `5471b4d3`: 2,763 tests passed, 3 skipped; client bundle freshness and lint passed. Phase 0 edits are in the integration worktree. The independent Anbot repository already exists and is private. Phase 0 verification is in progress. No phase implementation commit has been accepted yet.

- 2026-11-24 · Phase 0 local gate: client build and freshness check, plugin lint, and 2,765 plugin tests passed (3 skipped). App suite: 478 passed (3 skipped), including legacy shell/data defaults and the release contract. The real pinned DSH Web host passed all 52 bench steps with a fixture model, and its processes stopped. With Node 24, the macOS arm64 package built and checked out-of-tree with the rebuilt client. The real Electron app sent and received a chat, hid and reopened its window, and quit cleanly. Anbot branding verified in `/tmp/dsbot-maintainer-checks.2Tpi2B/anbot-phase0-chat.png`. Platform-specific signing and the private GitHub release remain remote gates. The in-repo release and updater point to Anbot; an authenticated manual download or explicit feed is required for its private repository.
- The publishing worker's DeepSeek V4.1 Flash provider returned HTTP 502. Implementation was reviewed, corrected and verified locally by the maintainer.
