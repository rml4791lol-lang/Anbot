# 团队看板（右侧）接口契约

日期：2026-11-15
前端（签字：前端）↔ 工程师（待签字）

## 文件与导出

- 文件：`ds-bot/src/client/team-board.js`（新文件，前端只写这一个文件 + 不改别人的文件）
- 导出：
  - `TeamBoard`：React 组件（`createElement` 风格）。
  - `TEAM_BOARD_CSS`：样式字符串，由工程师负责挂载（或由组件自身 `installStyles` 注入；二者择一，默认约定**工程师挂载**，组件不重复注入）。
  - `readBoardConfig`：配置读取器（组件内部用，也可被测试直接调用）。
- 构建：`cd ds-bot && node scripts/build-client.mjs`（不另起构建）。

## Props

```js
TeamBoard({
  roster,            // 必需。indexRoster() 之后的快照：{ bots, sections, questions, ready, ... }
  work,              // 必需。work 快照：{ bots: { [botId]: { tool, said, note, target, switching, folder, roomId? } }, approvals: [] }
  onClose,           // 可选。收起按钮回调；不给则不画收起按钮
  configUrl,         // 可选。默认 './team-board.config.json'，相对 DSH Web 源
  now,               // 可选。测试注入的时钟（返回 ms），默认 Date.now
})
```

数据由工程师的挂载层从现有 `roster` / `work` 源（`useRoster` / `useWork`）取快照传入。**组件内部不 fetch state、不 setInterval 轮询**；只读 props。唯一例外是 1 秒的**显示时钟**（只用于刷新「已跑 12s」文案，不取数据，`prefers-reduced-motion` 下不启动；面板关闭或没有在跑 Bot 时不启动）。

## 配置 JSON（热读）

- 路径：`./team-board.config.json`（DSH Web 源根，工程师侧负责静态提供；404 时组件用默认值，不报错）。
- 键：
  ```json
  { "defaultOpen": true, "sort": "section", "density": "two", "showHistory": true }
  ```
  - `defaultOpen`：`true|false`（挂载层决定初始开合，组件不强制）
  - `sort`：`"section"`（按名册分组）| `"role"`（按角色字母序）
  - `density`：`"two"`（宽屏两列，窄屏一列）| `"one"`（始终一列）| `"compact"`（一列紧凑）
  - `showHistory`：`true|false`
- 热读：组件挂载时读一次；`window` focus 时再读（`cache: 'no-store'`）。改配置不需要重启应用。

## 历史记录（可选能力）

- API：`window.dsbot.panelHistory({ limit: 50 })` → `[{ ts, bot, state, doing }]`（Promise）。
- 不存在（`typeof !== 'function'`）→ **整块隐藏**，页面不报错、不白屏。
- 存在但为空/抛错 → 区块显示空态「历史记录还没接上」。
- 组件不写死任何历史数据。

## 状态口径

- `running`：`work.bots[bot.id]` 存在（含 `roomId` 的群聊条目）。
- `waiting`：`roster.questions[part]` 存在，或 `work.approvals` 里有 `botId === bot.id`。
- `idle`：其余。
- 顶部总览三者相加 = 名册内可见 Bot 数；不写死数量。
- 卡片文字：
  - `任务：<workPhrase(doing)>`（无在跑 → `空闲`）
  - `谁：<bot.name> · <已跑 Ns / 等待 Ns>`（灰字、小一号）
- 头像：`mark.js:117` 的 `BotAvatar`（不裸用 `BotMark`、不自绘）。

## 挂载（工程师侧）

1. 在 DSH 右列（`rightbar` 停靠面）注册一个常驻 view，标题「团队」，默认展开，展开时 `ctx.layout.openRightbar(track, false)`，收起时 `closeRightbar()`。
2. 从现有 roster/work 源取快照作为 props 传入；不新建接口、不新建轮询。
3. 静态提供 `team-board.config.json`（可用 profile patch 加静态路由）。
4. 挂 `TEAM_BOARD_CSS`（或让组件自行注入，二选一，写死在这里后不要两边都做）。
5. 不重启 DS Bot 应用由工程师执行；前端只提交分支。

## 前端验收（交付时贴）

- `node scripts/build-client.mjs` 输出（exit 0）；
- 四张截图：1440 展开 / 1440 收起 / 390 宽 / 空态（无 roster 数据时）；
- 面板内 Bot 数与同一时刻 `list_bots` 对齐（抽 3 个贴原文）；
- 空闲→在跑的那一行 300ms 内过渡、在跑行呼吸动画；三张带时间戳的图证明会动。
