# 聊天主流程降噪

- 日期：2026-11-16
- 状态：已实现
- 目标：让主对话优先展示用户需要判断、确认或继续的内容，把 Bot 内部协作和运行统计移到可查的位置。

## 问题

Bot 私聊里会混入三类与用户决策无直接关系的内容：

- Bot 之间的消息、回复和 stop 通知；
- 定时任务触发时写给模型的原始 prompt；
- 每轮结束后的 token / 费用统计。

这些内容和真正的回复挨在一起，用户需要反复跳过它们，长对话里尤其明显。

## 行为

- Bot-to-Bot 的通知、`message_bot` 和 `stop_bot` 不再作为普通消息行出现，而是一个低对比度的 `Bot exchange` 展开行。折叠时只显示涉及的 Bot 名称；展开后显示去掉 `[Message from …]` 等内部头的正文，并提供 `Open bot exchange` 入口。
- 定时任务触发不再进入聊天记录。任务本身仍在 `Details → Scheduled tasks` 可查；任务执行产生的用户可见回答或卡片照常显示。
- DSH 的每轮 usage / cost trigger 从 turn tail 隐藏，保留结束时间。用量仍在 `Details` 的 `RunStats` 和 `Usage` 页。
- 如果某个 DSH 版本把 schedule 或 relay 当成 user-message node 渲染，DS Bot 的 user-message cell 也会忽略它；群成员的 `post` 仍然是正常群消息。
- 模型把 `[SCHEDULE CHANGE]`、`[SCHEDULE REMINDER]`、`[Your profile was updated …]` 等内部控制行回显到回复或侧栏预览时，去掉这些行，不把它们当成答案。
- 失败、审批、停止、重试等需要用户知道状态的行保持原样；卡片和真正的用户可见回复不被隐藏。
- 思考过程继续由现有 `Show thinking` 开关控制；开关关闭时不会渲染，打开时仍是折叠的 details。

## 不做什么

- 不修改 DSH，不依赖 DSH 安装目录里的文件。
- 不删除任务、exchange、usage 数据，也不改变它们的查询接口。
- 不隐藏群聊里成员真实发出的消息。
