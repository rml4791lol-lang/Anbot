# Anbot architecture

Anbot runs as the local desktop app or as the `ds-bot` plugin inside DeepSeek Harness. [App profile](../app/src/profile.mjs) assembles the pinned Cordis bundles. [Plugin entry](../ds-bot/index.js) mounts the product on DSH's Sessions, tools and model routes. Anbot owns the Bot roster, Goals, handoffs and project evidence. The corresponding decisions are indexed in [ARCHITECTURE_DECISIONS.md](../ARCHITECTURE_DECISIONS.md).

Three rings guide the implementation: a protected kernel with five contracts, two meta engines that consume them, and optional extensions. The [implementation plan](superpowers/plans/2026-11-24-ds-bot-harness.md) records which phases have passed and how. The Phase 0 compatibility boundary covers desktop identity, local paths and distribution only.

[Legacy desktop identity](../app/src/legacy.mjs) retains an existing Electron shell directory and its encryption identity. [Default locations](../app/src/place.mjs) preserve existing locations and give fresh installations their own directories. DSH and the plugin retain their package and protocol identifiers.
