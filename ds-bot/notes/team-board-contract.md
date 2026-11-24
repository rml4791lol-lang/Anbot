# 团队看板（右侧）接口契约

日期：2026-11-15
前端（签字：前端）↔ 工程师（签字：工程师，2026-11-15）

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
  { "defaultOpen": false, "sort": "section", "density": "two", "showHistory": true }
  ```
  - `defaultOpen`：`true|false`（挂载层决定初始开合，组件不强制）
  - `sort`：`"section"`（按名册分组）| `"role"`（按角色字母序）
  - `density`：`"two"`（宽屏两列，窄屏一列）| `"one"`（始终一列）| `"compact"`（一列紧凑）
  - `showHistory`：`true|false`
- 热读：组件挂载时读一次；`window` focus 时再读（`cache: 'no-store'`）。改配置不需要重启应用。

## 历史记录（可选能力，尚未接上）

- ~~API：`window.dsbot.panelHistory({ limit: 50 })`~~ **已废止**：窗口加载的是 DSH Web，Electron `preload.cjs` 不在这条页面里，`window.dsbot` 不存在（Antbot 2026-11-15 核过，全仓 0 命中）。
- 真实读路径：插件自己的 `api/bot` 端点 `call('panel-history', { limit })` → `{ ok, value: { lines: [{ ts, bot, state, doing }] } }`，按 `ts` 倒序，默认 200、上限 2000。
- 落盘：`<DSH_HOME>/bot/panel-history.jsonl`，追加写，同一 Bot 连续同一 `doing` 不重复写；20MB 滚动到 `panel-history.1.jsonl`，最多保留 2 个文件。
- 组件当前读 `window.dsbot.panelHistory`，不存在 → **整块隐藏**，页面不报错、不白屏。这与「历史未接上时隐藏」的约定一致，先按此交付；端点分支合入后由前端把读取处换成上面的调用即可。
- 组件不写死任何历史数据。

## 签字

- 前端（2026-11-15）：组件 + 契约说明。
- 工程师（2026-11-15）：数据与挂载半边——roster/work 快照接入、配置路由、CSS 挂载、右列注册；历史按上面「尚未接上」处理。契约接受，接口字段按本文件为准。

## 工程师实现记录（2026-11-15）

- 挂载文件：`ds-bot/src/client/team-board-host.js`，导出 `TeamBoardHost`、`TEAM_BOARD_CONFIG_URL`、`openTeamBoard(layout)`。
- 注册：`ds-bot/src/client/index.js` 的 `installShell` 里 `shadow('rightbar', { id: 'bot-team-board', inject: face }, TeamBoardHost)`；roster/work 用 `useSyncExternalStore` 从 `face().hooks` 取快照，没有新接口、没有新轮询。
- 开合：挂载时读配置，`defaultOpen` 为真则 `ctx.layout.openRightbar(true, false)`；收起按钮走 `actions.closeTeamBoard()` → `ctx.layout.closeRightbar()`。
- 配置：GET `/api/bot/team-board.config.json`（`ds-bot/src/host/channel.js`），内容 = 默认值合并 `<DSH_HOME>/bot/team-board.config.json`；文件缺失/坏 JSON 回落默认值，`cache-control: no-store`，改文件后组件下次 focus 就读到，不用重启。**路径与契约里的 `./team-board.config.json` 不同**，挂载层显式传 `configUrl`，组件默认值不再使用。
- CSS：`[TEAM_BOARD_CSS, 'team-board']` 加入 `index.js` 的编译样式表清单，组件不重复注入。
- 未验证：右列实际渲染效果（需用户重启应用后看图）；DSH `rightbar` 停靠面在 0.2.2-rc.1 上的多 entry 行为未自测。

## 开合协调（2026-11-22）

- board 的开合状态放进共享 `ui.teamBoardOpen`，挂载层只读该状态并调用 `openTeamBoard` / `closeTeamBoard`，不再各存一份本地状态。
- 右侧同一时间只放一个面：打开 board 会关闭 Bot/群详情、设置和其它覆盖层；打开详情或设置会关闭 board。这样不会再出现 board 被详情栏压成窄缝。
- `defaultOpen` 仍可配置，但只在没有详情或设置面板时生效。

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
