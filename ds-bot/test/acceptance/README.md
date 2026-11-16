# Reality Gate acceptance harness

`npm run test:acceptance` runs one deterministic component-level Chief–Forge–Prism
scenario and writes `reality-gate-evidence.json` beside this file. Its outcome is
`component-verified`, not full AgentLoop or production-model verification.

What is real in the run:

- the DS Bot runtime, team tools, goal/task/work records and `task-detail` projection;
- the official MCP client and loopback server;
- an actual temporary git worktree, source diff, command results and artifact digests;
- one process restart on the same temporary `DSH_HOME`, with the queued Prism handoff
  picked up once on the same goal task identity and attempt.

What is deliberately scripted:

- the DSH AgentLoop is not executed;
- the model choices and DSH Session event stream;
- the in-memory DSH agent handles used by the headless test harness.

What this evidence does not prove:

- that `@deepseek-ai/dsh-agent-loop-testkit` runs DS Bot correctly with real DSH
  Session events;
- that a production model chooses the same tools or completes the same work;
- that Desktop, Web, deployment, payment, or external-message paths work.

Required follow-up gate: run this same scenario through
`@deepseek-ai/dsh-agent-loop-testkit` with the real DS Bot tools and real DSH Session
events before claiming end-to-end AgentLoop or production-model verification. The
current result keeps that gate explicit as `followUpGate.status: "not-run"`.

The harness does not use a model API key, a real `~/.dsh`, the Desktop/Web GUI, an
external message service, a paid operation, or the user's other worktrees. It creates
and removes its own synthetic Git repository and worktree under the OS temp directory.
No commit, push or deployment is made from that worktree.
