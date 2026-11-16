# Reality Gate acceptance harness

`npm run test:acceptance` runs one deterministic Chief–Forge–Prism scenario and writes
`reality-gate-evidence.json` beside this file.

What is real in the run:

- the DS Bot runtime, team tools, goal/task/work records and `task-detail` projection;
- the official MCP client and loopback server;
- an actual temporary git worktree, source diff, command results and artifact digests;
- one process restart on the same temporary `DSH_HOME`, with the queued Prism handoff
  picked up once on the same goal task identity and attempt.

What is deliberately scripted:

- the model choices and DSH Session event stream;
- the in-memory DSH agent handles used by the headless test harness.

The harness does not use a model API key, a real `~/.dsh`, the Desktop/Web GUI, an
external message service, a paid operation, or the user's other worktrees. It creates
and removes its own synthetic Git repository and worktree under the OS temp directory.
No commit, push or deployment is made from that worktree.
