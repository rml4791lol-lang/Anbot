# Reuse decision assets

This directory holds the machine-maintainable part of DS-Bot's “Existing Code First” process.

| Asset | Purpose |
|---|---|
| [`code-reuse-registry.json`](code-reuse-registry.json) | Source of record for candidate projects, versions, licenses, source paths, feature decisions, migration and acceptance criteria |
| [`code-reuse-registry.schema.json`](code-reuse-registry.schema.json) | JSON Schema for validating registry structure and required decision fields |
| [`../../CODE_REUSE_MAP.md`](../../CODE_REUSE_MAP.md) | Human-readable feature matrix and final decisions |
| [`../../THIRD_PARTY_COMPONENTS.md`](../../THIRD_PARTY_COMPONENTS.md) | Source-level review ledger and candidate/adoption boundary |
| [`../../THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) | Notice/adoption ledger for new reuse decisions |
| [`../../ARCHITECTURE_DECISIONS.md`](../../ARCHITECTURE_DECISIONS.md) | Accepted ADRs and reopen conditions |
| [`../design/personal-ai-os.md`](../design/personal-ai-os.md) | Target system architecture, runtime profiles and real-task completion criteria |
| [`../plans/2026-11-16-ai-os-reality-harness.md`](../plans/2026-11-16-ai-os-reality-harness.md) | First implementation plan: isolated mock/attached task harness with evidence |

## Update procedure

1. Add or update the candidate in `code-reuse-registry.json`.
2. Pin the exact release tag and inspected commit.
3. Read the license at that commit, including subdirectory and documentation exceptions.
4. Name concrete source and test paths; do not record a candidate from README claims alone.
5. Record the integration mode:
   - A: direct code;
   - B: SDK, official API, protocol or format;
   - C: extracted module with an adapter;
   - D: reference design;
   - E: build in DS-Bot.
6. Fill every feature field: DS-Bot implementation, DSH implementation, candidate, cost, dependencies, compatibility, decision, migration and acceptance.
7. Update the human-readable map, component ledger, ADR and notice ledger in the same change.
8. Run the repository verification before commit.

## Registry invariants

- Every `candidateIds` value in a feature points to an existing candidate.
- Every adopted code path has a matching `NOTICE` entry and a root source path.
- Every feature has one final decision; “research more” is not a final decision.
- A deferred integration has an explicit reopen condition and acceptance test.
- Version/commit fields name what was actually inspected, not only the latest release.
- No credential, cookie, `DSH_HOME` content, private URL or user data is recorded here.

## Current high-value findings

- **DSH is already the runtime.** Hermes Agent, OpenCode, Pi, Goose and LangGraph must not become a second loop.
- **The real tooling drift is MCP.** The DSH client already uses the official SDK, while `local-agents/mcp.js` hand-writes an older protocol. This is the first concrete B-class replacement.
- **Task state is split but not absent.** Group goals, handoffs, the task ledger and resume records already cover most needs. The next task change should be a read model and one durable contract, not another task app.
- **Memory is already a product subsystem.** AgentMemoryRepo format is adopted; OpenViking is an optional external-service candidate only.
- **Temporal and LangGraph are evidence, not dependencies.** Their replay/checkpoint semantics define recovery tests before any cluster or Python runtime is considered.
- **The Control Center belongs in the current client.** Extend existing shell, theme, slots and actions; do not import a dashboard template.
