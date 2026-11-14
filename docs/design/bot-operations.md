# Bot 运行契约与工具目录

- 状态：生效（随代码同步；名字由 `ds-bot/test/docs-bot-operations.test.js` 锁定）
- 适用：所有 Bot 会话（私聊、群聊、分段）以及给 Bot 写 instructions 的人
- 相关：`docs/plans/2026-10-10-bot-runtime.md`（预设/模型/档位/能力）、`ds-bot/src/host/prompt.js`（运行时规则）

这份文档回答三个问题：Bot 怎么跑起来、31 个工具什么时候用、怎么写一个不跑偏的 Bot。

## 1. 运行契约

**会话层级。** 每个 Bot 有三类会话：自己的私聊、每个群一份、上下文写满后新开的分段（旧分段仍可读）。群会话只渲染该 Bot 的发言，私聊与群互不注入。

**一轮从哪来。** 投递带 `kind`：

| kind | 含义 | 是否叫醒 |
|---|---|---|
| `action` | 要对方做事 | 叫醒（新 turn） |
| `answer` | 要对方回答 | 叫醒（新 turn） |
| `record` | 只记账：profile 更新、停手回执、记忆读写通知 | 入队，不叫醒 |

`record` 在对方下一次 turn 时随队列读到；用户消息永远叫醒。

**信箱 vs 唤醒。** inbox 是记录库，不是投递路由器（inbox is a record store, not a delivery router）。只有静默类消息落信箱：`update`（profile 更新）、`stopped`（停止回执）以及其他 `silent` 投递。它们本来就不叫醒 Bot；落盘成每个 Bot 一份只追加 JSONL（`<DSH_HOME>/bot/inbox/<botId>.jsonl`，默认 `~/.dsh/bot/inbox/<botId>.jsonl`），一条消息一行，重复的 `exchangeId` 不写第二行。已读位置另存 `<botId>.cursor.json`（最后读到的行号），不重写消息行；崩溃后未读不会丢。`reply`、`request`、群 relay 的任务交接与 @ 定向、用户消息（`source.kind === 'user'`）仍走原来的 Session 路由，reply/request 继续用 `followup` 叫醒。每轮开头用 `read_inbox` 看静默通知；通知不是必须逐条回复的请求，没需要自己做的事就继续这一轮原本的工作。

**队列与插队。** 默认 `followup` 进下一轮队列。只有两种插队：用户对已排队消息再按一次 Enter（`steer`），以及带 `steer` 的 Bot→Bot 投递（仅私聊、且该轮还没调过工具）。

**停止。** `stop_bot` 取消对方当前轮并把原因交给它；原因分三类记录：harness 超时 / provider 错误 / 人为停止，不许混写。空回答不叫醒提问方。

**预算。** 每个 Bot 每小时自动开轮上限默认关闭（T6'，按 Bot 开启）；用户消息不受限。

**权限。** Main Bot 可以创建、修改、删除其他 Bot 与群；普通 Bot 只能改自己。能力（MCP/技能包）按 Bot 挂载，改别人的能力需 Main Bot。

## 2. 工具目录（31 个）

### 团队

| 工具 | 何时用 | 何时别用 | 边界 |
|---|---|---|---|
| `list_bots` | 需要知道谁存在、谁在做什么、谁是 Main、模型是什么 | 不要凭记忆列队友 | 返回真实运行状态 |
| `create_bot` | 用户要一个长期专职的 Bot | 一次性活不要建 Bot | 先 `list_bots` 查重；带 name、role、instructions |
| `update_bot` | 改自己或（Main）别人的名字、角色、模型、档位、目录、instructions | 不要用它代替 `create_bot` | 普通 Bot 只能改自己 |
| `list_bot_models` | 要 provider/model 引用、某模型支持的思考档位 | 不要猜模型名 | 档位只有在模型支持时才生效 |
| `message_bot` | 对方必须行动，或它能补上你缺的事实 | 不道谢、不回执、不转发状态 | 对方忙时下一 step 读到；不要轮询 |
| `read_inbox` | 每轮开头看静默通知（profile 更新、停止回执）；有需要自己做的才动手 | 不要用它等 reply/request，那些仍会叫醒你 | 默认只读未读、从旧到新、`limit` ≤ 20；已读位置写在 cursor 文件，不再算未读 |
| `update_team_board` | 交付完、等用户决策、卡住时，把一行写进团队看板自己的那条 | 不要替别的 Bot 写，也不要当日志堆 | 每次整份覆盖自己那一份文件；看板只显示每人最新 3 条；`kind` 只认 delivery / decision / blocked，缺字段存 null |
| `stop_bot` | 对方必须立刻停手 | 不要用它催进度 | 回执走 `record`，不开轮 |

### 群聊

| 工具 | 何时用 | 何时别用 | 边界 |
|---|---|---|---|
| `create_group` | 需要固定成员的协作空间 | 两人私聊就行时不要建群 | 创建者默认是 admin |
| `update_group` | 改名、改公告、改成员、admin、回复模式、共同工作目录 | 不要用它发消息 | 只有 admin/Main 能改 |
| `delete_group` | 用户明确要归档群 | 不要顺手清理 | 归档不是静默删除 |
| `post_to_group` | 从群外往群里发一条 | 你在群里时直接说话即可 | admin 发帖起新一轮；成员发帖只点名 @ |
| `group_todo` | 群里的任务清单 | 不要拿它当聊天记录 | 与 `group_goal` 的阶段任务分开 |
| `group_relay` | 群中继会话专用 | 参与者不要调 | 每轮只调一次、无参数，然后空回复 |
| `read_group_chat` | 私聊里需要看某个群说过什么 | 不要每轮全量读 | 只读需要的片段 |

### 目标

| 工具 | 何时用 | 何时别用 | 边界 |
|---|---|---|---|
| `group_goal` | 群要跑一个带阶段与验收的目标 | 单个任务不要开 goal | 状态：drafting/active/paused/complete；空闲提醒上限 2 次 |

### 记忆

| 工具 | 何时用 | 何时别用 | 边界 |
|---|---|---|---|
| `remember` | 用户明确说记住、或决定/偏好值得长期保留 | 不要记进度、寒暄、可再查的事实 | 与 dsh-fish-memory 重名风险见 #1561 |
| `recall` | 需要早前结论或用户偏好 | 不要用记忆替代工具取证 | 召回结果要标注来源 |
| `forget` | 用户要求删除，或记忆已过期 | 不要清空别人写的记忆 | 删除不可逆 |
| `read_own_chat` | 需要精确旧措辞、完整清单、旧分段里的细节 | 不要用它重读当前会话已有的内容 | 返回行带锚点，可 `around` |

### 能力（MCP / 技能包）

| 工具 | 何时用 | 何时别用 | 边界 |
|---|---|---|---|
| `list_capabilities` | 看自己或团队已有哪些能力 | 不要假设能力已装 | 名限 32 字符；github/mail 是保留名 |
| `save_capability` | 新增一个 MCP 服务或技能包 | 不要把密钥写进定义 | 密钥用 `$DSH_SECRET_*` 引用 |
| `delete_capability` | 删除能力 | 别人创建的能力不要删 | `createdBy` 决定可编辑 |
| `attach_capability` | 把能力挂到某个 Bot | 不要一次挂全套找感觉 | 每 Bot 独立 reconcile，慢不拖别人 |
| `detach_capability` | 摘掉能力 | 不要拿它当临时禁用 | 摘掉后该 Bot 下一轮不再看到工具 |
| `list_connectors` | 看可用的连接器 | 不要猜连接器 ID | 连接器与能力是两层 |
| `request_connector` | 需要用户授权一个连接器 | 不要替用户点授权 | 授权是用户动作 |

### 交互与密钥

| 工具 | 何时用 | 何时别用 | 边界 |
|---|---|---|---|
| `ask_user` | 需要用户选一个方向 | 不要用长文本列 8 个选项 | 调用即结束本轮，答案下一条消息到 |
| `show_view` | 图表、表格、确认卡比文字更清楚 | 不要每答都用 | 仅私聊；视图入参 ≤ 8 KB |
| `request_secret` | 需要 key/token/密码 | 绝不让用户把密钥贴在聊天里 | 你通过 `$DSH_SECRET_<NAME>` 使用，永不打印 |
| `list_secrets` | 看已有哪些密钥 | 不要枚举值 | 只列名字 |
| `read_browser` | 需要看用户浏览器里的页面 | 不要用于绕过登录 | 仅 Desktop profile 提供 |

## 3. 写 Bot instructions 的模板

八段，缺哪段就补哪段；全局规则不要抄进来（`prompt.js` 已有），这里只放这个 Bot 独有的事实。

1. 身份与边界：你是谁、负责什么、不管什么、向谁交回。
2. 工作循环：Ask → Plan → Evidence → Act → Verify → Report。
3. 证据：本领域哪些事实必须查（命令、路径、版本、报价、平台规则），去哪查。
4. 停止：什么情况直接交回、什么情况问用户、什么情况不发文本。
5. 交付（DoD）：产物格式、字数、必含字段、可检查的验收条件。
6. 协作：和谁交接、交给谁、交什么格式。
7. 记忆：这个领域什么值得记、什么不该记。
8. 失败：工具失败怎么办、连续失败几次停。

DoD 必须可检查：写成「≤260 字、按 3.5 字/秒、误差 ≤1 秒」而不是「写得好一点」。

## 4. 技能与能力

技能有两层，别混：

- **工作区技能**：`~/.dsh/skills/<name>/SKILL.md`，由 harness 注入目录（每个会话一次，约 22 KB），Bot 用 `skill` 工具加载全文。`standard` 预设带 `tool-skill`，所以每个 Bot 技术上都能用。
- **能力技能**：DS-Bot 的 `capability`，`kind: 'skill'`，内容内联存在状态库，按 Bot 挂载（`save_capability` → `attach_capability`）。适合私有、需要按 Bot 隔离的流程。

现状（2026-11-14 实测）：4 个 Bot 会话里技能目录各注入 1 次，`skill` 调用 0 次——目录是白给的 token，没人用。问题不在权限，在没人教。

规则：

1. 任务与技能描述匹配时，先 `skill` 加载再动手；不匹配不要加载。
2. 每个 Bot 只在自己的 instructions 里列 3–5 个常用技能，不要抄全局目录。
3. 私有流程用能力技能挂载，不要往 `~/.dsh/skills` 里塞。

推荐映射（写进各自 instructions，不写进全局 prompt）：

| Bot | 常用技能 |
|---|---|
| 参谋 / 运营 | `deep-research`、`content-competitor-research` |
| 写手 / 制片 | `zh-short-video-script`、`zh-short-video-render`、`zh-douyin-content` |
| 课件 / 编制官 | `office-pptx`、`html-ppt`、`ppt-studio` |
| 前端 | `frontend-ui-engineering`、`impeccable`、`design-qa` |
| 工程师 | `test-driven-development`、`graphlint`、`code-review-and-quality` |
| 审查 | `code-review-and-quality`、`zh-code-review` |
| 运维 | `orca-cli`、`observability-and-instrumentation` |

Orca 的实测命令表与安全分级在 [`docs/design/orca-runbook.md`](orca-runbook.md)：运维 Bot 无人值守只跑只读的发现与诊断命令（`status`、`agent-context`、`skills list/get`、`host list`、`environment list`、`worktree list/current`）；建删 worktree、起 agent、动插件与自动化一律交人。

度量：`turn-economy` 统计每个会话的 `skill` 调用次数；连续 7 天为 0 的 Bot 先改 instructions，再谈加技能。

## 5. 同步规则

- 新增或改名工具：改 `ds-bot/src/host/constants.js` 的 `TEAM_TOOLS`，再改本文件的表格；测试会比对两边。
- 工具语义变了：改本文件对应行的「何时用/何时别用」，提交信息写明行为变化。
- 契约变了（kind、队列、停止、预算）：先改本文件 §1，再改代码，再补测试。
