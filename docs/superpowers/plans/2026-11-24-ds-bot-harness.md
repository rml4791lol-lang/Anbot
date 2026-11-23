# DS Bot Harness Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Work from the frozen integration base, own only the assigned files, and attach verification evidence to every handoff.

**Goal:** Deliver a DSH-native Personal Agent that can carry a real engineering project from intent to a verified result, keep working across interruptions, and let the user understand and take over the work.

**Architecture:** DSH owns native Agent Presets, Sessions, Turns and execution. DS Bot owns the user's goals, project decisions, team roles, task dependencies, handoffs, approvals and evidence. Existing local Agent adapters execute work in scoped workspaces. A specialized Bot and a team project use the same task identity and lifecycle.

**Tech Stack:** Existing Node ESM DS Bot plugin, DSH, React client and Electron app. The product uses its existing local state and Markdown memory.

**Spec:** [Product vision](../../vision.md), [architecture decisions](../../../ARCHITECTURE_DECISIONS.md), [goal behavior](../../plans/2026-11-01-group-goal.md), [Bot runtime configuration](../../plans/2026-10-10-bot-runtime.md) and [local agents](../../plans/2026-11-04-local-agents.md).

## Global constraints

- Baseline is fork `5471b4d3`, fast-forward from fork `origin/dev` `048f223d`. Integrate verified existing preset and Reality Harness work by responsibility. Existing user and parallel worktrees remain separate.
- The bound pinned DSH release determines which APIs exist. Version changes have a distinct compatibility gate and rollback. Use the mock bench with isolated data for deterministic tests. Actual integration runs use test-controlled profiles and worktrees. Never use or alter user DSH data in tests.
- All subagents use `deepseek-v4.1-flash` with `max` reasoning. The maintainer independently verifies gathered evidence, reviews diffs and owns integration decisions. Credentials and private state stay out of prompts, artifacts and commits.
- Each product slice shows actual availability, authorization, execution and verification. Store plans and evidence with their existing owners. Reuse native DSH rather than adding a runtime or an independent policy engine.
- Scope includes engineering, design and orchestration first, with the same assembly model usable for maintenance, research, documentation, QA and operations. Preserve user-configured intent, project objectives, operating constraints and delegation rights across roles, sessions and devices.

## 1. Establish a reproducible integration base

**Files:** `app/package.json`, `app/src/profile.mjs`, `ds-bot/dev/harness/package.json`, `docs/plans/2026-11-16-ai-os-reality-harness.md` and tests associated with the imported changes.

- [ ] Record current fork, DSH pin, preset branch and Reality Harness worktree identity. Extract only reviewed changes with explicit dependency commits and run each slice independently.
- [ ] Establish baseline unit, client freshness and lint checks. Record pre-existing failures and select one real, benign regression with a reproducible check.
- [ ] Verify native Agent Preset creation, missing preset behavior, private/group/relay/fresh-part routing and rollback in an isolated profile. Keep the native chooser and human-readable labels.

## 2. Build professional Bot configuration and single-Bot delivery

**Files:** `ds-bot/src/client/create-bot.js`, `bot-draft.js`, `bot-settings.js`, `capability-settings.js`; `ds-bot/src/host/roster.js`, `capabilities.js`, `skill-shortlist.js`, `local-agents/` and existing capability/preset tests. Paths without a prefix in this section are relative to their stated host or client directory.

- [ ] Express a professional profile as a versioned composition of existing role instructions, native preset, execution mode, supported skills/MCP, permission requirements, expected output and verification. Show declared versus effective capabilities, missing dependency, authorization and source. Apply the same validation when the Main Bot creates a Bot.
- [ ] Resolve defaults across user or team, project, and Bot scope. Users set long-term objectives, project priorities, model or cost limits, delegation limits and when to ask for intervention. A project or Bot can tighten applicable constraints. Record which setting won, and route any permission expansion through its existing approval path.
- [ ] Ship original baseline templates for engineering/debug and review. Make UI and orchestration profiles first-class candidates and validate them by a complete domain task. Keep capacity for research, QA, documentation, operations and custom roles in the existing creation/configuration path. Project and user overrides survive template upgrades.
- [ ] Optional trusted development suites under evaluation: the full Superpowers set and selected Matt Pocock skills. A suite provides discoverable skills, while the per-turn shortlist remains small. Resolve installed skill names against the actual runtime. An external CLI must demonstrably load the selected skills or report the limitation.
- [ ] Run the selected real regression with single engineering Bot and compare with general Bot under the same model/project/permission baseline. Collect reproducibility, patch, regression test, review and independent evidence. Check at least one missing-skill and unsupported-CLI path.

## 3. Connect DSH execution, local agents and human takeover

**Files:** `ds-bot/src/host/{goals,handoffs,requests,resume,tools,task-detail,task-trace,task-verification}.js`, `local-agents/`, `app/src/profile.mjs`, existing Goal and local-agent integration tests.

- [ ] Bind task, plan revision, dispatch attempt, DSH Session, CLI execution id, worktree and source revision. Exercise parallel tasks with independent workspaces. A launch with unconfirmed status must be reconciled before a retry.
- [ ] Reuse DSH Forge/worktree where compatible. Check actual working directory, write scope, cancellation and handoff after restart. Preserve per-Bot and group folder behavior.
- [ ] Verify take over and return on the same worktree. Confirm the worker has stopped before switching write ownership. Revalidate stale evidence against the user's actual modifications on return.
- [ ] Verify DSH Workflow in one specifically allowed bounded node, using native start, events, result and cancellation. Keep project dependencies and restart state in the DS Bot task path. Run real native workflow and at least two distinct configured local Agent executions.

## 4. Make decisions, state and control visible

**Files:** `ds-bot/src/client/{team-overview,team-overview-model,goal,handoff-card,approval-notices,create-bot,bot-settings}.js` and client tests. Follow `docs/design/ui-standard.md`.

- [ ] Show the authoritative goal and constraints, plan revision, owners, dependency edges, progress, relevant approvals, worktrees and verified evidence. Expose the difference between provider facts, Bot report and verified output. Read those states from existing records.
- [ ] Show a portfolio view of project goals, current priorities, competing commitments, open decisions and evidence-backed progress. Preserve the link from a user's correction to each affected running task. A resumed project must retain its owner, next action and escalation rule even if its original Bot is unavailable.
- [ ] Show individual Bot delivery and team workflow through the same task detail. Allow meaningful controls in place or via the existing approval and session surfaces. Show pending vs confirmed stop, and affected work on plan changes.
- [ ] Adopt a product design workflow for the UI Bot: user context, flow audit with screenshots, alternatives, prototype, implementation handoff, visual and keyboard QA. Verify actual Electron, keyboard access and representative narrow view. Record screenshots or demo per project rules.

## 5. Preserve continuity and user control over time

**Files:** `ds-bot/src/host/{parts,steward,prompt,memory,memory-search,memory-entries,project-records}.js`, existing memory and compaction tests, Reality Gate scenarios.

- [ ] Keep durable project/Goal facts distinct from prompt history and long-term memory. Restore objective, acceptance, plan revision, open tasks and evidence anchors after context changes. Preserve recent corrections and project constraints across a handoff to a replacement Bot.
- [ ] Check that each runtime has one active compaction path. Validate steward and CLI continuation. Test billion-context as an optional compatibility path under the actual pin before exposing it.
- [ ] Keep the existing journal-backed memory writer. Validate scope-first retrieval, provenance, recency of decisions, correction, undo and private scope. Compare a read-only retrieval candidate with existing search on Chinese project scenarios before choosing a default.
- [ ] Verify a week-later scenario with new Session, changed instruction and interrupted execution. The responsible Bot should report the current project objective, priority, open decisions and reasons and continue only outstanding work.

## 6. Own plugin lifecycle and architecture documentation

- [ ] Preserve three release routes: application default, bundled optional, and catalog install. Reuse native DSH plugin management and show version, actual availability, conflict, authorization, restart requirement and rollback. Re-run compatibility with the prior profile, existing Bot sessions and workspaces.
- [ ] Keep the architecture guide anchored in source and tests. Record how state and permissions flow, how skill packs are verified, and how to debug and recover. Update affected accepted design and ADR entries with their code changes.
- [ ] Consult upstream implementations by capability and record source, version and license. Superpowers `22f0b463e7a5e579904dd6211a520321035526f7` and Matt Pocock skills `abeeaf95660ba9e8b7c753eb38f441ca707a8823` are MIT reference snapshots. Product Design informs our own UI Bot workflow. Orca `v1.4.272` informs local worker dispatch, ownership, recovery and decision gates. Verify compatibility, dependencies and file-level licensing before bundling and update NOTICE on code reuse.
- [ ] Independently verify real single-Bot and team delivery, native Workflow cancellation, restart recovery, context transition, scoped memory, actual UI and plugin rollback. Run scoped tests plus applicable full suites, client freshness, lint and host smoke. Record command outcomes, exact integrated commit and artifact references.

## Progress record

- 2026-11-24: Opened the maintainer goal, isolated the integration branch, and routed three baseline investigations to DeepSeek V4.1 Flash max. Parallel preset and Reality Harness work has its own worktree. It must be reviewed and integrated by change set.
