# Bot 轮次经济性：量化基线与工单拆分

- 日期：2026-11-14
- 相关：#1567（note 不该开轮）、#1055（per-bot preset，暂不动）
- 状态：设计说明 + 工单草案；T1 代码已在 `fix/system-notes-do-not-open-turns` 上

## 为什么

群里和私聊里都有同一个症状：Bot 回答得很快，但内容浅；用户觉得"没在解决问题，只是在回话"。前几轮把原因归到模型和思考档位，已被实测推翻（同一个 `deepseek-v4.1-flash`，在 DSH 里回答慢而深，在 DS Bot 里几秒就回）。

真正的原因有两层：

1. **消息一投递就开一轮。** `delivery.js` 的 `deliver()` 走 `agent.followup()`，它等于 `send(message, 'next-turn', true)`——不管这条消息有没有问题，都要叫醒一个 Bot、跑一整轮。Bot 之间的回复（"Reply from X"）本身又会被投递给对方，于是每句话都换来一句话。
2. **一轮太贵、太吵。** 群会话每轮注入约 5.5 万字符（OpenViking 上下文 19.5 KB + 技能目录 22.4 KB + AGENTS.md 7.1 KB + 群头 4.7 KB + 记忆注入），而回答平均只有 602 字符。慢的不是思考，是"轮次 × 注入"。

## 今天的量化基线

口径：`~/.dsh/bot/chat-index.sqlite` 里出现过的 12 个 Bot 会话，事件时间落在 2026-11-14（Asia/Shanghai），共 394 轮（392 轮有开轮消息，另 2 轮没有）。复跑：`node ds-bot/dev/turn-economy.mjs --day 2026-11-14`。

| 指标 | 实测 | 说明 |
|---|---|---|
| 总轮次 | 394 | 12 个 Bot 会话 |
| 由 Bot 消息开轮 | **236（59.9%）** | reply 113 / request 98 / update 23 / stopped 2 |
| 由用户开轮 | 54（13.7%） | 真正的人在说话 |
| 由记忆通知开轮 | 84（21.3%） | `ds-bot-memory-update` 53 + `ds-bot-memory-recall` 31 |
| 其余 | 20 | OpenViking 9、question-reply 8、tool-jobs 1、其他 |
| 单轮耗时 | p50 35.4 s / p75 111.7 s / p90 323.9 s | 最长 4278.5 s |
| 工具调用 | 均值 7.9 次/轮 | **113 轮（28.7%）一次工具都没用** |
| 回答正文 | 均值 602 字符/轮 | 13 轮（3.3%）正文为空 |
| 轮内额外注入 | p50 442 / p90 6526 字符 | 不含开轮那条消息本身 |

三个直接读数：

- **六成的轮次是 Bot 之间互相点起来的**，人只占一成四。
- **近三成的轮次没有调用任何工具**，纯文本确认（样本：`Noted. I have my handoff note and carry on from here.`、`...`、`已入库（exit 0，无输出）`×4）。
- **停手回执还在开轮**：今天 `编制官 was stopped before it could answer your message.` 出现 5 次、`审查 …` 2 次，每条都是一轮。

## 已定的行为（T1，已在分支上）

- 没有问题的通知不开轮：`deliver({ silent: true })` 走 `agent.send(message, 'next-turn', false)`，进队列但不叫醒。用于 profile 更新（`roster.js:479`）与停手回执（`tools.js:388`）。
- 空回答不叫醒提问方：`turns.js` 的 `answerSender` 在正文为空且无附件时直接返回。
- 事实先查再答：`prompt.js` 要求涉及版本、路径、能力、自己的模型/通道/档位时先 `list_bots` / `list_bot_models` / `read` / `bash`，查不到就说查不到。
- 不念 plumbing：工具退出码、无输出、已保存、交接条、上下文注入这些不转述给用户。

## 目标指标（下一阶段验收）

| 指标 | 现状 | 目标 | 判据 |
|---|---|---|---|
| Bot 消息开轮占比 | 59.9% | ≤ 35% | 同上口径，按天统计 |
| 无工具轮占比 | 28.7% | ≤ 10% | 同一脚本 |
| stopped/update 类回执开轮 | 25 轮/天 | 0 | 按 source.kind + role 统计 |
| 同一句正文重复 | 4 次/天 | 0 | 同 Bot 最近 3 条去重 |
| 单轮 p90 耗时 | 323.9 s | ≤ 180 s | turn/start→turn/end |
| 轮内注入 p90 | 6526 字符 | ≤ 3000 | 非开轮 user/message 字符数 |

## 工单

依赖用 `←` 表示（左边要等右边）。

### T2 relay 静音规则（reply 113 + request 98）

- 目标：Bot 之间的问答不超过两轮；纯确认不发。
- 改动：`ds-bot/src/host/delivery.js`（投递前查 exchangeId 已回复次数）、`ds-bot/src/host/prompt.js`（Two-Reply Rule）。
- 验收：同一 `exchangeId` 的双向正文 ≤ 2 条；`Noted.` 类纯确认在样本里为 0。
- 依赖：T7。

### T3 记忆通知合并（memory-update 53 + recall 31）

- 目标：记忆读写通知最多每 10 分钟合并成一条，并且不开轮。
- 改动：`ds-bot/src/host/memory.js`（若有）+ 投递侧统一走 `silent: true`。
- 验收：`ds-bot-memory-*` 开轮数 = 0。

### T4 群会话上下文减肥（注入 p90 6526 → ≤ 3000）

- 目标：群头、私聊摘录、技能目录按需注入，不再每轮全量。
- 改动：`ds-bot/src/host/groups.js` / `prompt.js`。
- 验收：群会话一轮的注入字符 p90 ≤ 3000；同一轮回答的工具调用数不下降。

### T5 重复正文抑制

- 目标：同一个 Bot 最近 3 条正文里出现同一句话（≥ 12 字）时不再发。
- 改动：`ds-bot/src/host/turns.js` 发送前比对。
- 验收：样本中 `已入库（exit 0，无输出）` 重复为 0。

### T6 轮次预算

- 目标：每个 Bot 每小时自动开轮（非 user 触发）≤ 6 轮，超出则排队到下一个整点。
- 改动：`ds-bot/src/host/delivery.js`。
- 验收：单 Bot 单小时自动开轮 ≤ 6；用户消息不被限流。

### T7 度量埋点（所有验收的前提）

- 目标：把"这轮是谁点起来的、用了几个工具、正文多长、注入了多少字符"写进 `usage.sqlite` 或单独的 turn 表。
- 改动：`ds-bot/src/host/usage.js`（新建）+ 本文件第一节的统计脚本入库为 `ds-bot/dev/turn-economy.mjs`。
- 验收：`node ds-bot/dev/turn-economy.mjs --day 2026-11-14` 输出与上面基线表一致。

### T8 日报与回归

- 目标：每天 09:00 把六项指标写成一条消息进「内容线」，只报数字和超阈值项。
- 改动：`ds-bot/src/host/schedule` 或 OpenTodo 书记员脚本；不开 agent 轮。
- 依赖：T7。

## 顺序

1. T7（没有度量，其余都无法验收）
2. T1 合入（已完成，等 PR）
3. T2、T3（开轮占比从 59.9% 降下来）
4. T5、T6（兜底）
5. T4（上下文减肥，需要单独文档）
6. T8（有数才报）

## 风险

- T2/T6 可能压掉本该发生的协作：需要"用户点名"与"任务交接"两条豁免。
- T4 动注入面，容易改坏群记忆；先做只读对比（同一轮改动前后回答质量人工抽查 10 条）。
- 本文件里的基线来自本机 12 个会话，不代表所有用户；合入前用 mock 模型跑一遍 smoke。
