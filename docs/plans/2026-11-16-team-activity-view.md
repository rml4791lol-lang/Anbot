# 团队动态：真实任务、交接与最近活动的只读视图

- 日期：2026-11-16
- Issue：#39
- 相关：`src/host/team-activity.js`、`src/client/team-activity.js`、`src/host/channel.js`

## 为什么

DS Bot 已经有 room goal、open work、task ledger 和 team board archive，但没有一个面向用户的统一任务面。用户只能从群目标、团队看板和 Bot 活动分别猜当前工作。

本功能只做现有记录的**只读投影**，不新增任务数据库、任务状态机、Agent Runtime 或写路径。

## 数据与语义

- `goal`：来自 `room.goal.stages[].tasks[]`。任务自己的 `status` 优先，缺省时才用 stage 的 `status`。
- `handoff`：来自 `state.works`。`open` 非空显示为 `waiting`，否则显示为 `active`；它没有独立 status，界面保留来源为 `handoff`。
- 最近活动：team board archive 与 task ledger 的真实时间戳和 source kind，只用于七日活动量与活动来源，不代表任务完成率。
- roster：沿用现有 Bot 的 name、role、avatar、Main Bot 权限；缺失 owner 标为 partial，不伪造负责人。
- 读取归档或台账时跳过坏行会留下 source warning，UI 必须显示 partial；不能把损坏数据静默当成完整 live 结果。
- 台账只读七日文件名；board archive 按文件签名缓存，刷新不会每 15 秒重扫不变的整份归档。
- parent/child：只按现有 `parentId` 关联，不在客户端推断新的层级。

## 交互

- 入口：账户菜单 → Team activity。
- 一个页面同时显示 summary、七天活动、roster、role/source/status/attention 筛选、任务列表、来源详情和最近活动。
- 行选中显示 source id、parent/child、群聊、验收、备注、evidence 和 warnings。
- Loading、empty、filtered-empty、no-current-task、partial、stale refresh、error、demo、read-only 和 host-locked 状态都必须显式可见。
- 桌面三栏；移动端单列并只滚动视图内部，不产生页面横向溢出。

## 不做什么

- 不把 board 活动数当完成数。
- 不把 handoff 的 `active/waiting` 改写成 goal status。
- 不新增第二套任务系统，也不绕过现有权限或审批。
