# Anbot

[English](README.md) | 中文 · [文档导航](docs/README.md) · [愿景](docs/vision.zh.md) · [已知问题](docs/known-issues.zh.md) · [参与开发](CONTRIBUTING.zh.md)

![版本](https://img.shields.io/badge/版本-v0.0.1-green) ![许可](https://img.shields.io/badge/许可-Apache_2.0-green) ![Bot 团队](https://img.shields.io/badge/team-multi--agent-2F6BFF)

**Anbot 是一个开源的多 Agent 工作台：一支持久在线的 Bot 团队，在你的真实工作区里干活。** 主 Bot 拆任务，专业 Bot 接活，团队共享记忆、群聊和同一个工作区。它让你看见理解了什么、谁在做、改了哪些文件、凭什么算完成；你可以随时暂停、接管这个工作区自己改，再交回去。

它有三种形态：Windows、macOS、Linux 桌面应用，插件，Docker；团队、聊天、记忆、凭据和执行记录都留在你自己的电脑上。

> 首个公开版本 v0.0.1 已发布，见[最新发布页](https://github.com/rml4791lol-lang/Anbot/releases/latest)。本版附带 `Anbot-0.0.1-win-x64.exe`（含 `.exe.blockmap`）、`Anbot-0.0.1-mac-arm64.zip`、`Anbot-0.0.1-mac-x64.zip` 与 `Anbot-0.0.1-android.apk`，以及 `latest.yml` 和 `SHA256SUMS.txt`（校验和覆盖 APK 与各桌面包）。本次发布不含 Linux 安装包：Linux 从源码构建，见下文。本次发布不含 iOS 可安装包。也可以从源码构建，或作为 DSH 插件安装。

> **实用资料：** [30 篇任务指南](https://rml4791lol-lang.github.io/Anbot/guides/) 覆盖任务、集成、对比和常见问题；[3,000 个场景页](https://rml4791lol-lang.github.io/Anbot/playbooks/) 覆盖 100 个任务 × 30 种团队、平台、数据、工具和交付约束。[关于 Anbot](https://rml4791lol-lang.github.io/Anbot/about/)

## 关键事实

- **开源：** Apache 2.0。应用和插件代码开源；预设、技能和 MCP/插件索引可读、可换。
- **形态：** 一支持久在线的 Bot 团队：主 Bot、专业 Bot、群聊、共享记忆。
- **多 Agent：** Bot 之间互相发消息、共享上下文、并行干活；Git 团队工作区里的新 Bot 自动得到自己的 worktree。
- **工作区：** 真实目录。X-Ray、检查点、接管和高危审批，让工作看得见、退得回。
- **数据：** 本地优先。团队、聊天、记忆、凭据和执行记录留在你的电脑上；模型请求发给你配置的服务商。

## 这支 Bot 团队实际能做什么

Anbot 不是一个聊天窗口加一个助手，而是一支多 Agent 团队：主 Bot 拆任务，专业 Bot 接活，群聊共享上下文，工作落在真实目录里。下面这些是让团队跑得下去的部分：

| 会卡住的地方 | Bot 团队怎么处理 |
|---|---|
| 看不出 Bot 理解了什么 | **X-Ray** 展开任务目标与约束、可直接改的子任务清单、实际执行者、当前生效的模型与权限、上下文预算、工作区状态和检查点。默认仍是对答，需要时一键打开。 |
| 需要自己动手改 | **接管与交回** 先等执行器确认停止；你持有工作区时新消息被拒绝；交回时核对还是同一个 Session、同一个工作区。Anbot 自己的 Bot 和 Codex、Claude Code、OpenCode 等本地智能体都支持。 |
| 长任务失败或跑偏 | **检查点** 把某一刻的对话进度和工作区文件成对保存：可只读预览，可恢复成一个新的可写工作区，原工作区和之后的修改都保留；检查点之后的记忆写入可以逐条撤销。 |
| 不知道实际加载了什么 | **运行态探针** 报告当前 Session 实际加载的技能、插件和 MCP，实际生效的沙箱权限，上次请求走的模型，本地智能体是否安装并登录。探测不到时显示「未验证」，不猜。 |
| 看不见上下文压力 | **上下文视图** 显示当前压力、可用窗口、检查阈值，以及模型看到的每段内容来自哪些原始记录。 |
| 新建专业 Bot 太慢 | **十套专业预设** 直接填好角色、工作方法、推荐技能、工作区与权限策略、验收标准和交付格式；每一项都可以改。 |
| 多个 Bot 并行会踩文件 | **自动 worktree**：Git 团队工作区里的新 Bot 自动得到自己的 linked worktree。 |
| 一条命令可能毁掉工作 | **高危审批** 覆盖递归删除、破坏性 Git 操作、推送、磁盘操作和提权；执行前让你批准一次。 |
| 模型中途失败 | **失败处理** 换模型重试这一轮；重启后自动续跑一次被打断的工作，再被打断就暂停等你在 X-Ray 里继续。 |
| 技能自己长出来 | **不自动建技能**：普通对话和一次性经验不会生成或更新技能，也不弹审批；只有你明确提出才走审批。 |

## 三个实际工作流

**在一个真实仓库里修失败测试。** 把仓库和失败的测试交给 Anbot。X-Ray 里有子任务清单、实际执行者和权限；跑之前先存一个检查点。它在真实目录里改文件，把 diff 和测试输出作为证据给你看。修错了，可以换模型重试这一轮，或者恢复检查点。

**接管一份写了一半的文档。** 让 Anbot 暂停。执行器确认停止后，打开同一个工作区自己改；你持有期间新消息会被拒绝。改完交回，Anbot 核对还是同一个 Session、同一个工作区，再继续。

**一步建一个代码审查 Bot。** 新建 Bot 时选「代码审查」预设。它填好角色、工作方法、推荐技能、工作区、权限、验收标准和交付格式；你可以改任何一项，然后直接跑。

## 安装

### 前置依赖

- Node.js 22.19 或更高版本（推荐 24），npm 11 或更高版本，以及 Git。app 的 lockfile 由 npm 11 生成；npm 10 会在 `npm ci` 时报 lockfile 不同步。
- macOS：Xcode Command Line Tools（`xcode-select --install`）。
- Linux：`build-essential` 与 `python3`（Debian/Ubuntu：`sudo apt-get install build-essential python3`）。
- Windows：Visual Studio Build Tools 的「使用 C++ 的桌面开发」工作负载，以及 Python 3。

在代理或镜像网络后安装前，先设置 `npm_config_proxy` / `npm_config_https_proxy`；Electron 下载设置 `ELECTRON_MIRROR`，electron-builder 自身工具下载设置 `ELECTRON_BUILDER_BINARIES_MIRROR`。

### 桌面应用（Windows、macOS、Linux）

v0.0.1 的预编译包见[最新发布页](https://github.com/rml4791lol-lang/Anbot/releases/latest)：Windows 安装包、macOS zip（arm64 与 x64）与 Android APK。本次发布不含 Linux 安装包，可用下面的步骤从源码构建。不发布 iOS 包。从源码构建：

```sh
git clone https://github.com/rml4791lol-lang/Anbot.git
cd Anbot
sh scripts/setup.sh        # 安装 ds-bot、link、app 依赖，生成 client.js
(cd app && npm run build && npm run pack)
```

Windows 上把 `sh scripts/setup.sh` 换成 `pwsh scripts/setup.ps1`。

产物在 `app/dist-pack/`。桌面应用自带锁定版本的 DSH，不需要先装 DSH；第一次启动时可以从你现有的 DSH 里复制 Bot 团队。

`scripts/setup.sh` 按 lockfile 安装插件、手机链路和桌面应用依赖，重新生成 `ds-bot/client.js` 与 `ds-bot/link.js`，并校验已提交的 bundle 与 `src/client` 一致；重复执行是安全的。`--plugin-only` 跳过桌面应用依赖，`--without-harness` 跳过仅测试用的 DSH 包。

### 什么时候必须重新构建客户端 bundle

`ds-bot/client.js` 与 `ds-bot/link.js` 已提交进仓库。Git clone 或 `npm pack` 安装会直接使用它们；只有改动 `ds-bot/src/client/` 或 `link/src/` 下的内容后才需要重新构建：

```sh
(cd ds-bot && npm run build)
node scripts/build-client.mjs --check   # 已提交 bundle 过期时退出 1
```

单元测试在 `client.js` 过期时也会失败。不跑构建步骤，也可以用已提交的 bundle 跑插件测试，或把插件打成 tgz 装进 DSH。

### 签名与 Gatekeeper

从源码构建不需要任何证书。本地编译出的 app 不带 macOS `quarantine` 属性，Gatekeeper 不会按「未识别开发者」拦截。预编译 macOS zip 采用 ad-hoc 签名（identity `-`），不公证，也不需要 Apple Developer 账号；见[签名与信任说明](docs/dev/release-signing.md)。本源码构建流程不会对 app 做签名。

**作为 DSH 插件**

先装好 DSH，并在 DSH 里配好至少一个模型。Anbot 直接使用 DSH 里的模型。

```sh
git clone https://github.com/rml4791lol-lang/Anbot.git
cd Anbot/ds-bot && npm pack
dsh plugin --profile web add ./ds-bot-*.tgz
```

`--profile` 换成要装的 profile 名字，比如 `desktop`。用 DSH Desktop 的话，也可以在**插件**页添加这个 tgz 文件并启用。

**Docker（NAS、Linux 服务器）**

见 [`docker/README.md`](docker/README.md)。

## 配置

最简单的方式是直接和你的 Main Bot 对话，让它帮你创建和配置其他 Bot 与群聊。

**设置**默认打开**概览**总控台，汇总待处理事项、团队卡片、近 7 天用量与各功能区入口；按 `⌘K` / `Ctrl+K`（或点顶部搜索栏）可直接搜到任意设置项、Bot、群聊或模型。各大类在一页内滚动并附顶部锚点：

- **通用**与**外观**（实时预览、8 种界面语言、主题、布局与动效）
- **模型**：服务商 · 本地智能体 · Bot 模型 · DeepSeek 服务
- **团队**：Bot · 群聊 · 定时任务
- **连接**：连接器 · IM · 手机 · API
- **工具**：电脑操控 · 浏览器 · 能力 · 密钥
- **用量**与**关于 Anbot**（含**反馈**）

在独立桌面应用中，可以用 ChatGPT 套餐为 Bot 提供模型，无需 OpenAI API 密钥。在**设置 → 模型 → 服务商**展开 **OpenAI**（或通过**添加服务商 → 常用服务商**选择它），然后选择**使用 ChatGPT 登录**。这需要系统提供的安全存储。如何启用套餐用量并选择模型，见[模型说明](ds-bot/README.md#models)。

> **网页搜索提示**：Anbot 会把 `auto` 搜索 provider 选为整个 profile 的后端。禁用 `web-search-auto` 时，须同时为该 profile 指定另一个已注册的搜索 provider。详见[网页搜索说明](ds-bot/README.md#web-search)和[恢复步骤](docs/known-issues.zh.md#关掉web-search-auto后所有会话的网页搜索都失败)。

## 功能

### 浏览器远程访问（预览）

无需安装 App，也能在浏览器里使用手机端界面。在电脑上打开 **设置 → 手机**，开启手机访问并显示配对码，然后选择 **Open in a browser** 或 **Copy browser link**；也可以在网页里粘贴配对链接。浏览器作为一台额外设备，经已有的端到端加密链路配对；在电脑的已配对设备列表里移除即可撤销访问。

中转服务器需要部署网页构建：在 `mobile/` 运行 `npm ci && npm run export:web`，启动[中转服务器](link/README.md)时把 `DSBOT_LINK_WEB_DIR` 设为 `mobile/dist` 的绝对路径。localhost 以外使用 HTTPS/WSS。浏览器存储由 IndexedDB 中不可导出的密钥进行 AES-GCM 加密，但浏览器仍运行服务器提供的网页，请只使用可信的服务器。敏感操作需要改用手机 App 或电脑；网页没有后台通知。详见[设计与安全限制](docs/plans/2026-11-17-web-remote.md)。

### 本地 API 与 MCP

本机的其他智能体（Claude Desktop、Cursor、Codex、Antigravity 或你自己的脚本与本地服务）可以通过统一的本地 API 网关调用你的 Bot 和群聊。打开 **设置 → 连接 → API** 开启服务（默认关闭，仅监听 `127.0.0.1:17830`），按能力域与目标范围创建可撤销的 Bearer 令牌；令牌只在创建时展示一次并仅存哈希，隐私 Bot 默认彻底隔离，仅在显式二次确认后才对指定令牌开放。

同一本地网关同时提供版本化 `/v1/*` REST + SSE、MCP Streamable HTTP（`/mcp`）、可单独开关的 OpenAI 兼容层（`/compat/openai/v1/*`）以及薄层命令行（`ds-bot mcp` stdio 桥、`ds-bot send`、`ds-bot event`）。旧版 `mcp.json` 配置与 `npx -p ds-bot ds-bot-mcp` 命令自动平滑迁移与兼容。详见[设计](docs/plans/2026-11-21-external-api.md)。

### Bot

每个 Bot 都是持久化身份，对外始终只有一条连续对话——没有会话列表，也不用手动切会话或开新会话。上下文快满时系统自动压缩或换段，历史记录持续可读可搜。每个 Bot 拥有自己保存的配置（模型、思考强度、指令、工作文件夹和权限预设），不同于 DSH 的安装 profile。

每个 Bot 可以单独设置工作文件夹和权限，换文件夹直接和它说一声就行；一个 Bot 同时负责几个项目时，可以再给它加几个额外工作文件夹，它在这些文件夹里同时干活。Bot 干活时前台始终能接话：耗时的终端命令会自动转入后台执行；Bot 也能主动启动后台任务，或在它正忙时你发新消息把正在做的活顺手转到后台继续跑。你可以在顶栏灵动岛查看进度、批复权限、发追问或停止，在详情页「任务」标签查看任务记录，或在手机端管理活跃任务，也可以输入 `/side` 开侧边对话顺手问一句。Bot 还支持长期记忆、在回复里绘制交互式图表/表格/表单、定时任务，并可在侧边栏按工作收进折叠分组。

![bot 详情页：模型、记忆、用量](docs/images/details.zh.png)

### Main Bot

Main Bot 是你的团队总管，拥有创建和修改其他 Bot、管理群聊的高权限（删除 Bot 和修改 Main Bot 身份仅限用户操作）。首次打开时默认带有一个 Main Bot **Chief**——有问题或想搭建团队，直接找它即可。

在**设置 → 团队 → Bot**中可以给 Chief 改名或换头像，不会改变它的 Main Bot 身份。

### 群聊

每个群聊都有一名管理员，默认由管理员回复你的消息并用 `@名字` 调度成员，控制多 Bot 协作的费用。你也可以直接 `@` 任意成员，或通过输入框 **+ → 引用对话** 带入另一段对话作为上下文。

在**设置 → 团队 → 群聊**中选择群聊，可以设置或移除群头像。没有照片时，群聊会显示成员头像拼图。

同一条消息点到的多个成员会并行开工、实时回报进度，共享群记忆、群工作文件夹、群任务面板（`group_task`）和群共享待办（`group_todo`）。做大任务时，群聊可以运行 **Goal**（`/goal`）：管理员先和你对齐完成标准，拆分成阶段派给成员，每段带证据验收后再推进。

![群聊：管理员 Chief 把活派给写手和程序员](docs/images/group.zh.png)

### 隐私 Bot

把私密工作交给一个 Bot 时，可在它的设置里打开**隐私**并指定独立的工作文件夹。其他 Bot 读不到它的文件夹、记忆和聊天记录，它向其他 Bot 发消息或写外部文件都必须经你批准。即使删掉它，原有文件夹和记录也会继续受保护，直到你在设置里手动解除。

隐私 Bot 不能担任 Main Bot，也不能加入群聊。这道边界只隔离团队内的其他 Bot，不是操作系统沙箱：终端和联网权限仍会生效，模型服务商也会收到对话内容。

### 本地智能体

可直接把电脑上已安装的编程 Agent CLI（Claude Code、Codex CLI、Cursor CLI、GitHub Copilot、Devin CLI、OpenCode、Gemini CLI、Antigravity、Kimi CLI、Kilo CLI 及自定义 CLI）接入为 Bot。它使用 CLI 自己的登录、套餐、模型、工具和上下文，同时照常参与私聊、群聊、派活和记忆。

由于使用 CLI 自己的工具，Anbot 里的共享能力和连接器不会传给它，切换运行方式会新开一段对话；只有完全拒绝 MCP 服务的 CLI 才拿不到团队工具。注意 Cursor CLI 会把最后一次选中的模型存为全局默认（`~/.cursor`），不想改终端默认时保持「CLI 默认」即可。

### 浏览器

每个 Bot 有独立的浏览器和登录态，桌面应用支持从文件或本机浏览器（Chrome/Edge、Safari、Brave、Arc、Firefox、Zen 等）导入 Cookie 及受支持的 `localStorage`。需要交互式操作网页时，在 DSH profile 里将 `browserPlugin` 设为 `refs`、`script` 或 `task` 并重启 Anbot；**设置 → 工具 → 浏览器**提供配置指引和按站点操作授权。发帖、上传、下载、删除默认需要你批准；登录、验证码和付款会交还由你操作。

内嵌浏览器面板仅桌面应用和 DSH Desktop 可用（DSH Web 没有）；仅桌面应用会在退出后保留登录态并支持导入 Cookie。

### 电脑操控

在 **设置 → 工具 → 电脑操控** 开启后，可按 Bot 设置权限档位（只看、后台操作、可以动前台）和允许操作的应用；操作时屏幕顶部显示指示条，随时可暂停或接管；系统设置、密码管理器等敏感应用永不授权。

所有 Bot 共用你的桌面，同一时间只有一个 Bot 可占用指定应用或前台鼠标。Windows 上 Chrome/Electron 应用通常需要「可以动前台」，且无法操控管理员权限应用；macOS 需要 14+ 并授予辅助功能与屏幕录制权限；Linux 支持 X11（Wayland 受限）。

### 连接器、能力与功能包

- **设置 → 连接 → 连接器**：接入 GitHub、Gmail、QQ 邮箱、163 等邮箱及远程 MCP 服务（支持浏览器 OAuth 登录或固定 Header/Key），或从 Claude Desktop、Cursor、VS Code 导入配置。凭据存在受保护/可加密的密钥库中（**设置 → 工具 → 密钥**），发邮件默认需要确认。
- **设置 → 工具 → 能力**：管理团队共享的 MCP 服务、技能和能力包。每个 Bot 可按项设为**常驻**（每轮加载）、**清单**（提示词仅占一行索引，任务需要时由 Bot 用 `use_pack` / `drop_pack` 按会话装卸）或**关**；Bot 添加的本地命令必须经你批准才能运行。

### 联网搜索与 DeepSeek 服务

- **联网搜索**：`auto` 搜索坚持使用发起会话自己的模型路由与 Key（绝不借用其他路由的 Key），支持同源 DeepSeek 官方 Search API，不可用时回退至无 Key 搜索。如需所有模型统一使用官方 Search / Fetch API，可在 **插件 → 网页搜索** 打开 **Use the new Web Search API**。
- **DeepSeek 服务**（**设置 → 模型 → DeepSeek 服务**）：在 **设置 → 模型 → 服务商** 配好 DeepSeek API Key 后，可为任意主模型单独开启文档/图片识别（`read_document`）、DeepSeek 朗读与 DeepSeek 听写。各项默认关闭，按自己的 API Key 用量计费。

### Office 文件

Bot 可直接创建、检查和编辑 Word（`.docx`）、PowerPoint（`.pptx`）与 Excel（`.xlsx`）文档，并将页面渲染为图片核对排版。桌面应用自带完整离线运行时；DSH Web 仅支持检查和编辑已有文档，从零创建与页面渲染需使用桌面应用或 DSH Desktop。

### 手机 App 与浏览器远程访问

通过端到端加密链路（Noise IK）在 Android App 或浏览器里远程操控电脑上的 Bot 团队——电脑仅向外连接，不需要公网 IP 或开放端口。在 **设置 → 连接 → 手机** 开启手机访问，用手机 App 扫码即可配对。本次发布不含 iOS 可安装包：iOS 需要 Apple Developer 账号，仓库目前还没有。见 [`mobile/README.md`](mobile/README.md)。

无需安装 App 也可使用**浏览器远程访问（预览）**：在同一配对页点 **Open in a browser** 或 **Copy browser link**。自建中转服务器与安全限制见 [`link/README.md`](link/README.md) 和 [`docs/plans/2026-11-17-web-remote.md`](docs/plans/2026-11-17-web-remote.md)。

### IM

在 **设置 → 连接 → IM**，可将任意 Bot 或群聊绑定到微信、飞书、钉钉、企业微信、QQ、Telegram、Discord 或 Slack。电脑运行时即可在聊天软件里对话、群内 `@` 机器人、回复提问卡和审批卡。

微信仅支持与扫码账号私聊；微信与 QQ 有平台回复时间窗；微信、QQ、钉钉不支持卡片按钮，按编号回复即可；密钥卡不允许在聊天软件中填写。

### 用量与外观

在 **设置 → 用量** 按时间、Bot、模型查看 Token 消耗。在 **设置 → 外观** 选择内置主题、强调色、气泡或平铺布局与宽度滑块、界面动效档位及头像动画三档，支持实时预览和 8 种界面语言。

![用量页](docs/images/usage.zh.png)

## 数据

所有数据都留在你自己的电脑上：桌面应用存在首次启动选定的数据目录（旧安装沿用 `~/.ds-bot`），插件版存在 DSH 主目录（默认 `~/.dsh`）的 `bot/` 和 `sessions/` 下。卸载应用或插件不会删除这些数据。Anbot 不上传这些内容；模型请求发给你配置的模型服务商。

## 还没做完的

- **协调层**：你对 Main Bot 说一个目标，它自己拆任务、选 Bot、准备工作区、跟踪依赖、汇总验收。派活目前仍要你自己安排。
- **多 Bot 工作流视图**：一张图看到所有 Bot 的依赖、进度和审批。
- **Bot 锻造器与自举工程器**：用对话组装新 Bot、让 Anbot 改自己的代码。
- **代码签名与分发**：v0.0.1 附带 Windows 安装包（`Anbot-0.0.1-win-x64.exe`），在 CI 上用项目自签 PFX 做 Authenticode 签名（SHA-256 摘要 + RFC 3161 时间戳）；证书为项目自签（CN=Anbot Release Signing），非商业 CA 颁发，其他机器上 SmartScreen 仍显示未知发布者。macOS zip 为 ad-hoc 签名、未公证。Android APK 用上传密钥签名（v1 JAR + v2 + v3）。另附 `latest.yml` 与 `SHA256SUMS.txt`，校验和覆盖 APK 与各桌面包。本次发布不含 Linux 安装包，也不附 `latest-linux.yml`，Linux 目标只从源码构建。本次发布不含 iOS 可安装包：尚无 Apple Developer 账号，不构建也不上传 `.ipa`。Windows 安装包走 electron-updater 自动下载安装；macOS 不自动更新，发现新版后只打开 Releases 下载页手动替换。各平台信任状态、首次安装放行步骤与 Android 上传密钥见[签名与信任说明](docs/dev/release-signing.md)。

## Anbot 和 Grok Bot、大厂 Agent 怎么比

最接近的产品是 Grok Bot：两者都是长期在线的 Bot 团队，有记忆、群聊和审批。区别在归谁：Grok Bot 把团队跑在 SpaceXAI 云端的电脑上，是付费测试；Anbot 是 Apache 2.0，把团队跑在你的真实工作区里，你可以接管。

| | Anbot | Grok Bot | 大厂 Agent |
|---|---|---|---|
| 来源 | Apache 2.0；代码和扩展索引开放 | 闭源 | 闭源 |
| 形态 | 多 Agent 团队：主 Bot、专业 Bot、群聊 | 长期在线的 Bot 团队 | 单个 Agent 或厂商子 Agent |
| 活在哪 | 你的真实工作区；桌面应用、DSH profile 或 Docker | 它自己的云端电脑，24/7 | 厂商云沙箱，或厂商 CLI |
| 数据 | 本地优先 | 云端 | 多在厂商云或账号里 |
| 模型 | 任何 DSH provider，包括本地模型 | Grok | 厂商模型 |
| 控制 | X-Ray、检查点、接管与交回 | 审批；工作在它的云端电脑上 | 计划与审批，因产品而异 |
| 扩展 | 开放的预设、技能、MCP、插件 | 厂商预设和例程 | 厂商市场或 SDK |
| 可用性（2026-11） | 公开 v0.0.1 | 付费测试 | 付费订阅 |

这里的大厂 Agent 指 OpenAI 的 Agent、Anthropic 的 Claude Code、Google 的 Gemini CLI、Microsoft 的 Copilot Agent。它们强在单 Agent 执行和产品集成；运行时、模型和扩展面归厂商。Anbot 把代码、模型选择和扩展面保持开放。

以上是定位对比，不是逐项功能审计；各家当前能力以官方为准。

## 常见问题

**Anbot 是什么？**
Anbot 是一个开源的多 Agent 工作台：一支持久在线的 Bot 团队，在你的真实工作区里干活。主 Bot 拆任务，专业 Bot 接活，团队共享记忆、群聊和同一个工作区。它有桌面应用、插件和 Docker 三种形态。

**Anbot 是 Grok Bot 的替代吗？**
是，如果你想要一支持久在线的 Bot 团队，但不想把运行时和工作区交给厂商云。Grok Bot 是付费测试，跑在 SpaceXAI 云端的电脑上；Anbot 是 Apache 2.0，把团队跑在你的真实工作区里，你可以接管。见上面的对比。

**和 OpenAI、Anthropic、Google、Microsoft 的 Agent 比呢？**
它们强在单 Agent 执行和产品集成，但运行时、模型和扩展面都归厂商。Anbot 开源、多 Agent：模型服务商由你选，工作区留在本机，代码和扩展索引开放。见上面的对比。

**数据会上传吗？**
不会。团队、聊天、记忆、凭据和执行记录留在本机；模型请求只发给你配置的模型服务商，Anbot 不上传工作区。

**能用哪些模型？**
DSH 里配置的模型，包括通过 DSH provider 接入的本地模型。桌面应用还可以用 ChatGPT 套餐登录 OpenAI 模型，不需要 API key。

**能装在哪些平台？**
桌面应用支持 Windows、macOS、Linux；插件跑在 DSH Desktop 和 DSH Web；Docker 跑在 NAS 或 Linux 服务器。v0.0.1 另发 Android APK，没有 Linux 安装包和 iOS 包。

**开源吗？**
Apache 2.0。

## 文档与开发

- 文档总导航与架构速览：[`docs/README.md`](docs/README.md)
- 插件内部结构与配置项：[`ds-bot/README.md`](ds-bot/README.md)
- 桌面应用结构与打包：[`app/README.md`](app/README.md)
- 开发环境、测试与协作规范：[`CONTRIBUTING.zh.md`](CONTRIBUTING.zh.md)
- 版本更新日志：[`CHANGELOG.md`](CHANGELOG.md)
- 安全问题请按 [`SECURITY.md`](SECURITY.md) 私下报告，不要开公开 Issue。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：Anbot 建在 DSH 的插件系统上，每个 Bot 都在 DSH Session 里运行，使用 DSH 提供的工具与模型访问。模型 Bot 走 DSH 的 Agent 循环与模型服务；本地智能体 Bot 使用自己 CLI 的工具与模型访问。辅助模型调用（记忆整理、上下文管家、交接、侧边对话等）在 Agent 循环之外进行；网页搜索 / 抓取以及 DeepSeek OCR、TTS、ASR 等直连服务由对应服务接口直接请求，并非全部由 DSH 提供。
- [Fei2411 与 DS Bot 贡献者](https://github.com/Fei2411/DS-Bot)：Anbot 基于 DS Bot 开发，保留了它的 Bot 团队、群聊、浏览器、电脑操控、IM、连接器与 Office 能力，并在此基础上加强了两个方向：执行是否可信，以及你能否随时接管。
- [esbuild](https://esbuild.github.io/)：用来打包插件的界面代码。
- 下面这些项目公开的设计思路也留在了 Anbot 里。Anbot 参考了它们的设计，没有使用它们的代码：
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo)：Bot 记忆的 Markdown 格式：一行一条 `[key: value]` 元数据，外加链接各主题文件的 `MEMORY.md` 索引。
  - [OpenAI Codex](https://github.com/openai/codex)：压缩时把用户原话留在摘要旁边的 checkpoint，以及搜索聊天记录用的消息锚点。
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot)：群聊轮流发言与 `@` 接力。
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) 和 [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode)：每个成员在每个群聊一个 Session，交接时带上用户之前的原话。
  - [OpenCode](https://github.com/sst/opencode)、[goose](https://github.com/block/goose)、[pi](https://github.com/badlogic/pi-mono)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)：长对话什么时候压缩，交接笔记写哪些内容。
  - [obelisk](https://github.com/tommy0103/obelisk)：用 SQLite FTS5 全文索引按 BM25 排序搜索 Bot 自己的聊天。
- 每一位试用过 Anbot、提出过问题、报告过错误的人。

## 许可

[Apache License 2.0](LICENSE)。按“原样”提供，不附带任何担保。用到的第三方代码和它的许可见 [NOTICE](NOTICE)。

## 声明

Anbot 是独立的社区项目，**不是 DeepSeek 官方产品**，与 DeepSeek 没有隶属、认可或赞助关系。“DeepSeek”“DeepSeek Harness”等名称是各自所有者的商标，这里只用来说明本插件和什么一起用。

Bot 会消耗你自己的模型额度，也会按你的要求读写文件、运行命令。重要的操作请自己检查。
