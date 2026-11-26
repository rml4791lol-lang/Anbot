# The vision of Anbot

English | [中文](vision.zh.md)

This file says what Anbot is meant to be and why. For how to use it, see the [README](../README.md); for the designs that are decided, see [docs/plans/](plans/) (written in Chinese); for how to take part, see [CONTRIBUTING](../CONTRIBUTING.md).

## What Anbot is

Anbot is first a **Personal Agent**: one stable identity with long-term memory and a single working relationship with the user. It removes the friction between intent and outcome—switching devices, explaining the same context again, remembering follow-ups, and moving information between applications. It does more than wait for chat input: with explicit permission it can receive events, follow work through, and let the user inspect, pause, approve or undo consequential actions.

The multi-Bot team is the Personal Agent's internal execution substrate, not a model the user must understand first. Anbot is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) and is open source under the Apache 2.0 license. One or more Main Bots organize the work, every Bot does its own part and talks to the others, and the Organization views expose that work; in ordinary use, however, the user deals with one Personal Agent.

## Two forms

| Form | What it is |
|---|---|
| The `ds-bot` plugin | A standard DSH plugin for DSH Desktop and DSH Web. All the Bot features are here |
| The Anbot desktop app | Opens straight into Anbot itself. It brings a pinned DSH, its own profile and its own data folder, imports a team the user already has in DSH, and installs DSH-compatible plugins, so that Anbot grows its own plugin ecosystem. The plugin can still be used on its own |

Both forms run the same `ds-bot` plugin. The point of the app is that Anbot controls its own profile and interface, free of the limits of DSH's general interface and global settings (see the [DSH concessions](plans/2026-10-13-dsh-concessions.md)).

## Ten core requirements

1. **Personal Agent first, built on DSH, independent of each other, one continuous chat per Bot.** The user gets one stable, long-lived Personal Agent. Underneath it, every Bot is built on DSH, independent of the others, and always has one continuous conversation (including Bots backed by a local agent CLI): no session list, no manual session switching, no manual new-session button, and no parallel sessions inside one Bot. When context fills up, Anbot moves to a fresh part automatically while earlier history stays continuously readable and searchable. Long-running work runs asynchronously in the background so foreground chat stays responsive, while background tasks remain visible, approvable, and stoppable by the user. Parallel work comes from multiple Bots or background tasks, never from splitting one Bot into multiple sessions.
2. **Reliable.** Bots work reliably: they stay aligned with the goal, act on evidence, stay inside their task, and their results can be checked. After long work, an idle-time review can propose reusable skills or project rules; the user approves changes before they are saved.
3. **Memory and persistence.** Bots keep working over time, that is, they have a long-term memory. A Bot can read the other public Bots' memories but not change them (only a Main Bot can change another public Bot's memory). Private memory stays with its Bot and the user. A Bot manages its own memory, and the user can manage each Bot's memory too. A group chat shares one memory among its members.
4. **Levels of rights.** A Main Bot has the highest rights: it creates and changes other Bots. Other Bots can change themselves but not other Bots, and only the user deletes a Bot. There can be more than one Main Bot. Bots can call on each other subject to privacy and approval checks.
5. **Group chats.** Group chats are the core form of Bots working together in Anbot. Bots in a group call on each other, and a group can have an admin Bot. The admin manages the group, adds and removes members, and by default answers the user's messages.
6. **Working folders.** Each Bot can have its own working folder, and a group chat can set one folder for all its members. A Bot can set its own working folder, so one sentence from the user is enough.
7. **Browser.** Each Bot has its own browser, and the browsers do not affect each other. The desktop app supports importing cookies and supported localStorage from files or local browsers.
8. **Interface and motion.** Anbot has a polished interface with smooth motion.
9. **A standalone app.** Anbot is meant to be a standalone app and does not make too many concessions to DSH.
10. **Local agents.** Anbot can bring local agent CLIs in as Bots that call on each other. These use the CLI's own model access, tools and context, not DSH's model-provider implementation.

This direction does not remove existing capabilities. Bot teams, group chats, task trees, browsers, computer use, connectors, memory and approvals can all remain and be upgraded, but each has to serve one goal: make the Personal Agent more reliable at removing real friction. A capability that does not improve that goal does not belong in the default path.

## Principles for trade-offs

- **Correct Bot behavior comes first.** Where a DSH mode or limit does not fit Bots, Anbot does not pile up complexity to stay compatible. Concessions that cannot be avoided go into the [DSH concessions](plans/2026-10-13-dsh-concessions.md), to be removed once the app controls its own profile.
- **Removing friction comes before adding features.** Bot count, message count, proactive actions and token burn do not prove product value; fewer device switches, less repeated context and trusted completion do.
- **Trust comes before autonomy.** Consequential work needs a plan, approval, progress, evidence and an undo path where possible. Proactivity must come from explicit, revocable triggers.
- **Scoped context comes before mass capture.** Context comes from authorized sources, traceable history and on-demand reads, not from recording everything by default.
- **Data stays on the user's computer.** The Personal Agent's teams, chats, memory, approvals and execution evidence live in Anbot's data folder by default. Local models connect through DSH providers; Anbot does not build a second inference engine.
- **Done means checked.** Behavior is covered by tests; interface changes are looked at for real.

## Who sets the direction

The maintainer decides the direction of the product, changes to decided designs, the rules for working together, releases and the architecture. Anyone can do the rest of the work; see [CONTRIBUTING](../CONTRIBUTING.md#how-we-work).
