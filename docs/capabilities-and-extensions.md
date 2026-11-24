# Anbot capabilities and extensions

[Capabilities](../ds-bot/src/host/capabilities.js) manages team-shared skills, MCP servers and packs. [Bot runtime configuration](plans/2026-10-10-bot-runtime.md) describes the current permission and loading rules. [Local Agent adapters](../ds-bot/src/host/local-agents/) connect supported CLIs and account for their distinct tool and Session boundaries.

The Session view records catalog visibility, loader admission and body access separately for Skills. For MCP it records stdio approval, initialization and any observed startup failure. The pinned DSH MCP client can keep tool definitions registered during a disconnect. A successful mount therefore leaves current connection health unverified until the runtime can observe the transport directly. Detaching removes the Session mount, and deleting also removes its catalog entry.

[Native Bot presets](../ds-bot/src/host/bot-presets.js) register Bot-specific compositions in DSH. The roster stores the base ID, revision digest and Bot-specific ID. DSH remains the owner of the source declaration. A changed declaration must be restored before an old binding can be mounted again. The [preset tests](../ds-bot/test/agent-preset.test.js) cover binding, restoration, drift rejection and cleanup after a failed Agent start.

The [engineering recommendations](../ds-bot/src/shared/engineering-presets.js) fill the same editable instructions and Skill shortlist used for any Bot. Debugging, Code review, UI review and Local coordination appear when the live catalog contains their matching [bundled DSH Skills](../ds-bot/src/host/skills/). The native `skill` tool loads each Skill’s full instructions in the Bot’s Session. Local coordination uses the team message and group tools. The user can change the recommendation’s instructions or Skill choices before creating the Bot.

The [implementation plan](superpowers/plans/2026-11-24-ds-bot-harness.md) covers declarative presets, Bot Forge, Anbot Self-Builder and the extension acceptance gates. New references enter this guide once verified. Record their source and license, the native mount or adapted mechanism, its test and how to remove it safely.
