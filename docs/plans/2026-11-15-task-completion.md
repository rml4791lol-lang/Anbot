# 任务完成的度量：完成判定、任务台账与 board 归档

- 日期：2026-11-15
- 相关：`src/host/handoffs.js`、`src/host/task-ledger.js`、`src/host/team-board-feed.js`、`dev/tasks.mjs`

## 为什么

11-14 到 11-15 的一轮优化把每轮时长 p90 从 354.4s 压到 76.4s，但同一份数据里轮数从 510 涨到 1078（×2.1），Bot 主动开轮占 96.7%，无工具轮从 23.9% 涨到 40.5%。变好看的时延和想解决的问题（事情有没有做完）不是一回事。

团队里其实已经有两套工程化的任务面，不需要再造第三套：

- `update_team_board`：每个 Bot 一条 entry，最多 3 行，kind 为 `delivery`（做完）/ `decision`（等人拍板）/ `blocked`（卡住），每行带 number 与 evidence。实测只有 1 个 Bot（运维）在用，3 行全是 delivery。
- `group_todo`：群共享待办，可勾选。实测 2 个群共 0 条。

但它们都**不留历史**：board 每次整条覆盖、只显示最新 3 行；todo 勾完可以清空。所以「这周完成了多少」仍然算不出来。缺的不是任务系统，是这两套面的**归档**与**采用率**。

## 已定的行为

1. **两个证据面分开计数，不合成一个完成率**：
   - `delivery` 行：人对「做完了」的声明，带 number 与 evidence。数的是**声明**。
   - `answered` work：handoff 有回复、无挂起子任务。数的是**收尾**。
2. **board 语义不变**：仍是每 Bot 最多 3 行、覆盖写、kind 不变。`writeTeamBoard` 落盘后把每行追加到 `board/archive/<bot>.jsonl`；同一行（bot + at + what + kind）在追加前查重，只写一次。旧归档里已有的重复行在读取时仍然合并。
3. **任务台账只追加**：`<home>/ledger/tasks-<day>.jsonl`，一行一个 `open` / `close` 事件，字段固定，不写正文；`<day>` 按团队配置的时区计算。写失败只 warn，不影响任务。
4. **一个只读报表**：`node dev/tasks.mjs --days N [--now ISO] [--json]`。它扫描台账文件但按 `row.time` 落在窗口内筛选，不靠文件名推断日期。work 段报 opened/closed/answered/abandoned/unclassified/pending、完成率、放弃率、open→close p50/p90；board 段报 delivery/decision/blocked 行数和无时间戳行数。所有比率带分母，m=0 打 `n/a`。
5. **零工具轮不再当质量指标**：它是「开了太多轮」的症状。

## 不做什么

- 不做第三套任务系统，不重写 board 或 group_todo 的语义。
- 不把 `delivery` 行当质量证明：行里的 evidence 是自报的，仍要抽验。
- 不在没有数据时上编排层：Orca 的 worktree / worker 只在「任务互相抢工作区」成为实测瓶颈时才接。
- 不从会话文本反推历史完成率：没有事件类型，反推只能靠措辞。

## 已知限制

- 归档从 2026-11-15 起算；此前只有 board 文件里的最后 3 行（已一次性回填 3 行）。
- `answered` 只说明有回复，不说明任务达成；与 delivery 分开报。
- board 与 todo 都是自报面，采用率低时数字只代表「谁在报」，不代表「谁在做」。
- 跨天的 work 在 `--days` 边界会被截断（open 在窗口外、close 在窗口内时只计入 `closedWithoutOpen`，不进时长）。

## 之后（3 项，每项都有产物）

| # | 做什么 | 产物 | 验收 |
|---|---|---|---|
| 1 | 提高 board 采用率：Bot 收尾时发一条 delivery（instructions 改动） | Bot 指令 diff + 一周 adoption 数 | ≥5 个 Bot 有 delivery 行 |
| 2 | 归因：把 pending/abandoned 的 work 与「没有 delivery 的 Bot」交叉看 | 一份 top-2 归因，各配可复现例子 | 两个原因都能在数据里指到具体 work id |
| 3 | 只在隔离成为瓶颈时接 Orca worktree | 一条端到端记录：派活→worktree→回来→拍板→入账 | 台账里出现第一条带 worktree 的 answered |

止损：两周后若完成率与 delivery 数都没有可测的提升，停在归因，不建编排层。
