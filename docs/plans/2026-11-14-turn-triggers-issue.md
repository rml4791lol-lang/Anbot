# Issue 提案：哪些事件可以开一轮，哪些轮次可以通知

> 目标仓库：`rml4791lol-lang/DS-Bot`。未提交，先给你过一遍；确认后我再按 issue 模板贴上去。
> 这里只提结构策略，不碰 #1055（per-Bot preset）——那是另一层。

## 现状

Bot 的一轮（turn）由投递（deliver）触发，而投递的 `role` 只影响正文长得像什么，不影响"要不要开轮"：

- `ds-bot/src/host/delivery.js:38` —— `role === 'update'` 只是把正文换成 `[Your profile was updated — follow the latest version]`，投递本身照旧进 inbox，于是模型被叫醒，看到的是"一条没有问题的通知"，只能回一句确认。
- `ds-bot/src/host/roster.js:479` —— `void rt.deliver({ toId: bot.id, text: notes.join('\n'), role: 'update' })` 是 profile 更新的唯一调用方，每次改 Bot 设置都会走这条。
- `ds-bot/src/host/tools.js:388` —— `role: 'stopped'` 同样每次新投递、必开新轮，没有去重。
- 对比：重复投递路径 **有** 去重（`ds-bot/src/host/resume.js:280` `taken` + `inbox.nextStep/nextTurn` 的 exchangeId 集合，:294 `steer: false, resent: true`），说明"同一条消息不该开两轮"这件事在代码里已有先例，只是没推广到系统通知。

## 实测（本机，2026-11-14）

- 今天 bot 侧共 207 轮：人触发 82 轮、自动触发 125 轮（60%）。自动触发来源：`bot` 54、`plugin:openviking-memory` 45、`time-context` 32、`dsh-mnemon` 31、`plugin:dsh-project-memory` 12、`user-question-reply` 6。
- 435 条 assistant 正文里，7 条无中文（`...` ×3、`Noted. I have my handoff note and carry on from here.` ×2、DSML 标签泄漏 1），`已入库（exit 0，无输出）` 重复 4 次、`已入库（exit 0，无输出，按约定视为成功）` 重复 3 次。
- 2086 轮里只有 4 轮被 steer 裁断；**没有一条消息是在 turn 空闲时到达的**——到达即排队，等上一轮跑完（用户消息中位等待 107.5s，p90 384.5s）。所以"回复排队"不是投递慢，是单轮太长、开轮太多。

## 提案

**A. 系统通知不进 turn。** `role: 'update' | 'stopped'` 只写进 transcript（或标记为非 turn 的 note），不投递到 inbox。要 Bot 针对它做事的场合，由调用方显式升级成一次带问题的投递。

**B. 通知层判空。** 一轮结束只有产出可执行内容才通知用户；正文是回执、确认、"收到，按新版本执行"这类，就静默收尾。判据建议放在 `ds-bot/src/host/delivery.js` 出站侧，而不是靠 prompt 里写"不要回复"——现在是后者，模型可违反。

**C. 开轮触发器白名单。** 只允许这几类开轮：用户消息、群内轮次、另一 Bot 带结果的显式转交、工具任务产出非空结果。其余（profile 更新、上下文/记忆注入、时间上下文、别的 Bot 的纯回执）只入 transcript。不在白名单里的原因，投递调用点必须显式写出来。

## 为什么值得做

同一份上下文，开轮次数直接决定"用户看到多少句没信息量的话"和"下一条消息等多久"。本机 60% 的轮次是自动触发，其中一大半（125 轮里的约 108）来自注入与 bot 互投——这些轮次没有用户问题要回答，却要和用户消息共享队列。

## 参考

- 上游已有 #1055（per-Bot preset）、#1522（DSML 收尾标签泄漏）、#1486（空闲窗口探测频率）、#1554（团队级回复风格），本提案与它们不重叠。
- 同类产品 OpenMausBot 把这三件事写成了规格：主动性只走显式触发器白名单、只有非空结果才发"Finished"。可作设计参考，不是要移植它的实现。
