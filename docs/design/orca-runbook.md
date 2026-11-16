# Orca 运维 Runbook

- 状态：生效（2026-11-14 在 Orca 1.4.258 上逐条实测）
- 机器：`/opt/homebrew/bin/orca` → `/Applications/Orca.app/Contents/Resources/bin/orca`，版本 1.4.258
- 适用：运维 Bot 的 instructions、`orca-cli` 技能、`docs/design/bot-operations.md` §4 的技能映射
- 相关：`docs/design/orca.md`（接入说明）

**结论。** Orca 的诊断与发现类命令是本地读、秒级返回、不弹审批，运维 Bot 可以无人值守直接跑；所有写操作（建/删 worktree、起 agent、改插件、改自动化）要么改磁盘和 git，要么要 `--approve <fingerprint>` 或终端确认，一律交人。§2 标「否」的行不是"危险到不能用"，是"不能由 Bot 自己决定"。

## 1. 实测记录

每条命令用 `timeout 20` 包住，stdout/stderr 重定向、stdin 不接终端。**没有一条超时或挂起**：读命令最长 0.34 s，唯一的 0.41 s 是故意用错名字的错误路径；全部没有审批提示、没有弹出 GUI 窗口。

| 序 | 命令 | 退出码 | 耗时 | stdout 形状 | stderr |
|---|---|---|---|---|---|
| 1 | `orca --version` | 0 | 0.33 s | 单行 `1.4.258`（8 B） | 空 |
| 2 | `orca status` | 0 | 0.34 s | 9 行 `key: value`（320 B） | 空 |
| 3 | `orca status --json` | 0 | 0.20 s | JSON（14,149 B，含 305 条 `capabilities`） | 空 |
| 4 | `orca agent-context` | 0 | 0.28 s | 2 行提示（104 B）：命令数 + 指向 `--json` | 空 |
| 5 | `orca agent-context --json` | 0 | 0.28 s | JSON（309,866 B）：`schemaVersion:1`、`commandCount:328`、`commands[328]` | 空 |
| 6 | `orca skills list` | 0 | 0.30 s | 11 行 `名字: 一句话描述`（5,370 B） | 空 |
| 7 | `orca skills get orca-cli` | 0 | 0.22 s | 350 行 Markdown（YAML front matter + 正文，35,509 B） | 空 |
| 8 | `orca host list` | 0 | 0.22 s | 22 行（1 个 `local` + 21 个 ssh target，2,154 B） | 空 |
| 9 | `orca environment list` | 0 | 0.19 s | `No saved environments.`（23 B） | 空 |
| 10 | `orca worktree list` | 0 | 0.28 s | 2 个 worktree + 末行 `scope: local`（395 B） | 空 |
| 11 | `orca worktree list --json` | 0 | 0.21 s | JSON（3,641 B）：`result.worktrees[] / hostScope / totalCount / truncated` | 空 |
| 12 | `orca worktree current --json`（cwd=仓库根） | 0 | 0.34 s | JSON，`result.worktree.path=<repo-root>` | 空 |
| 13 | `orca worktree current --json`（cwd=普通 git worktree） | 0 | 0.20 s | JSON，`result.worktree.path=<home>`（**不是**该 worktree） | 空 |
| 14 | `orca worktree current --json`（cwd=/tmp） | 1 | 0.20 s | stdout 上是 JSON：`{"ok":false,"error":{"code":"selector_not_found","message":"No Orca workspace contains the current directory: /private/tmp/orca-probe"}}` | 空 |
| 15 | `orca definitely-not-a-command` | 1 | 0.17 s | 空 | `Unknown command: definitely-not-a-command` |
| 16 | `orca skills get not-a-real-skill` | 1 | 0.41 s | 空 | `Unknown skill topic "not-a-real-skill". Available topics: …`（列出全部合法名字） |

探测时的 `orca status` 原文：

```
appRunning: true
pid: 81561
desktopWindowStatus: openable
runtimeState: graph_not_ready
runtimeReachable: true
runtimeConnectionState: workspace-window-closed
runtimeId: 2f2089f3-74d0-4dad-8e0b-b5ab4e9514b0
graphState: unavailable
degraded: Browser automation on this host needs a desktop window, and none is available.
```

两点从这份输出里读出来、别处没有的事实：

1. `graph_not_ready` **不是**读命令的门禁。上面退出码为 0 的读命令都在这个状态、`graphState: unavailable`、`runtimeConnectionState: workspace-window-closed` 下跑通并退出 0。判断能不能用，看读命令自己的退出码，不要看 `runtimeState` 的字符串。
2. `degraded` 只谈了浏览器自动化缺桌面窗口，与 worktree / skills / host 三组读命令无关。

## 2. 命令表

| 用途 | 精确命令 | 期望输出形状 | Bot 可无人值守 | 失败模式 |
|---|---|---|---|---|
| 版本自检 | `orca --version` | 单行 `1.4.258` | 是 | 二进制不在 PATH → 127；版本变了要重新对本文 |
| 就绪状态（人读） | `orca status` | 9 行 `key: value`；`appRunning` 与 `runtimeReachable` 是关键 | 是 | app 没起 → `appRunning: false`；runtime 没起 → `runtimeState` 非就绪，**不代表装坏** |
| 就绪状态（机器读） | `orca status --json \| jq -r '.result.runtime.state, .result.runtime.reachable'` | 两行值 | 是 | 同上；不要整段打印 14 KB |
| 命令总数 | `orca agent-context` | 2 行提示 | 是 | 不带 `--json` 时**不输出 schema**，只有提示 |
| 单条命令用法 | `orca agent-context --json \| jq -r '.commands[] \| select(.command=="worktree list") \| .usage'` | 一行 `usage` | 是 | 命令名写错时 jq 过滤出空行、整条管道仍退出 0；先用 `jq -r '.command'` 确认名字存在 |
| 技能目录 | `orca skills list` | 11 行 `名字: 描述` | 是 | 行数会随 Orca 版本增加，别把 11 写死进断言 |
| 技能全文 | `orca skills get orca-cli` | 350 行 Markdown | 是 | 名字不在 `skills list` 里 → 退出 1，stderr 直接给出合法名字清单 |
| 可派活主机 | `orca host list` | 每行末尾带选择器：`--host local`、`--host ssh:<id>` | 是 | ssh 目标 `not connected` 只是当前没连上，不是配置坏了 |
| 已存环境 | `orca environment list` | `No saved environments.` 或列表 | 是 | 本机没有配对 server 时就是这一句，属正常 |
| worktree 列表 | `orca worktree list`（或 `--json`） | 文本：每行 `id::path host=<host> <git ref>`，后接 `displayName/parentWorktreeId/…` 块，末行 `scope:`；JSON：`result.worktrees[]` | 是 | 一页的行数受 `--limit` 限制、各 host 共享同一页（本次 2 行、`truncated:false`）；`scope:` 之外标 `not covered` 的 host 必须另查，空答案不等于没有 |
| 当前 worktree | `orca worktree current --json` | JSON，`result.worktree.path` | 是，**但必须校验 path** | 目录不属于任何 Orca workspace → 退出 1 + `selector_not_found`；未注册的普通 git worktree 会解析到外层 workspace（实测落在 `~`），`ok:true` 也可能答非所问 |
| 建 worktree | `orca worktree create --name <n> [--repo <sel>] [--base-branch <ref>]` | 新目录 + 分支；可能跑 setup hook、可能同时起 agent | 否 | 目录/分支/是否跑 hook 要人定；中途失败可能留半个目录 |
| 删 worktree | `orca worktree rm --worktree <sel>` | 目录被移除 | 否 | 不可逆；新版 host 上分支默认保留、`--delete-branch` 才尝试删，旧 host 沿用旧策略并告警——**不能默认"删了也能原样回来"** |
| 起 agent / 终端 | `orca agent launch --agent <id>`、`orca terminal create` | 新进程或终端 | 否 | 会占账号、终端与模型额度 |
| 定时任务 | `orca automations` 的 `create`、`edit`、`remove`、`run` | 改调度或立即执行 | 否 | `run` 会真的干活并可能推代码 |
| 插件装/启用 | `orca plugin install <src>`、`orca plugin enable <key>` | 代码类插件返回 `approval_required` + 人工 `--approve <fingerprint>` | 否 | 指纹绑定插件、版本、文件与权限，换一样就要新指纹；Bot 不许自己补 `--approve` |
| 打开 GUI | `orca open` | 弹出桌面窗口 | 否 | 无人值守会留下窗口，且把 `desktopWindowStatus` 改成 open |
| 重置 runtime 身份 | `orca serve reset-identity` | 终端里问 `[y/N]` | 否 | 非 TTY 直接失败；会动 runtime 身份，无本地回滚 |
| 账号 | `orca account` 的 `add`、`select`、`rm` | 凭据变更 | 否 | 凭据操作不归 Bot |

## 3. 为什么这么分

只读命令要同时满足四条才算「Bot 可无人值守」，实测全部满足：

1. 不写磁盘、不动 git、不改 Orca 调度或插件状态（`worktree list/current`、`host list`、`environment list`、`skills list/get`、`agent-context`、`status`、`--version`）。
2. 不需要 `--approve` 或终端里回答问题。探测全程无 TTY，这些命令都在 0.35 s 内退出 0；反过来，schema 明确写了两类会卡人的地方：代码类插件 `approval_required` + `--approve <fingerprint>`，`serve reset-identity` 在终端里问 `[y/N]`。
3. 单次耗时 < 2 s（实测 0.17–0.41 s），外面再套 `timeout 20` 足够。
4. 退出码有语义：0 成功，1 带可判定的错误（stderr 文本，或 stdout 上的 `ok:false` + `error.code`）。

写操作至少违反其中一条：`worktree create/rm`、`agent launch`、`terminal create` 落盘或起进程；`automations *` 改调度；`plugin install/enable` 要指纹；`open` 弹窗；`serve reset-identity`、`account *` 要人。

## 4. 运维 Bot 接到 Orca 任务时怎么走

1. **看状态，不修状态。** 先 `orca status`（机器读用 `--json` + jq）。`runtimeReachable: false` 或 `appRunning: false` → 停，把状态行原样交回；不要用 `orca serve` / `orca open` 去"修好它"——起 runtime、开窗口是人的动作。
2. **先查现成命令，不猜参数。** 在 §2 找；找不到名字就 `orca agent-context --json | jq` 查 `usage`，或 `orca skills get <name>` 拉操作指南（`skills list` 里有 11 个，`orca-cli` 是最全的一个）。
3. **按 §2 的「是/否」决定停在哪。** 只跑标「是」的行；标「否」的，输出一份方案交人：完整命令、会改什么（目录/分支/调度/插件）、怎么回滚。不要"先跑了再问"。
4. **执行读命令并留证据。** 每条都 `timeout 20 orca …`，记录**退出码 + 原始 stdout 前若干行**；`worktree current` 必须把 `result.worktree.path` 和预期目录比对一次，别只看 `ok:true`（实测未注册的普通 git worktree 会解析到外层 workspace）。
5. **报告并明确边界。** 交回：命令、退出码、关键字段（`runtimeReachable`、`scope:`、`ok:false` 的 `error.code`）、以及"本次没有执行任何写操作"。失败一次就把原始错误贴回来，不要换一条命令重试第二次。

## 5. 回滚 / 空操作

- §2 标「是」的 11 条全是只读：不改 worktree、不改 git、不写 Orca 状态；跑完不需要回滚，重复跑也安全。
- 越界跑了写操作之后，顺序是**先停、再报、最后才恢复**，不要连着删：
  - `worktree rm` 之后：先 `git branch --list <name>` 看分支在不在（新版 host 默认保留，旧 host 看旧策略）；在 → `orca worktree create --name <同名> --branch <同名> --base-branch <ref>` 或 `git worktree add <path> <branch>` 恢复；不在 → 从 reflog 找，交人判断。恢复后 `git -C <path> log -1` 验证。
  - `plugin install/enable --approve` 之后：`orca plugin disable <key>`，确认没有别的东西依赖它，再 `orca plugin uninstall <key>`。
  - `automations create` 之后：`orca automations remove <id>`；`automations run` 触发的动作没有通用回滚，按它自己的产物处理。
  - `orca serve reset-identity`、`account *` 之后：没有本地回滚，直接交人。
- 空操作是正常答案：`orca worktree current` 在非 Orca workspace 目录退出 1（`selector_not_found`）、`orca environment list` 返回 `No saved environments.`、ssh 目标显示 `not connected`——这些都不需要"修"，原样写进报告即可。不要为了凑一个成功结果去切 cwd、建 workspace 或连主机。

## 6. 未验证

- 没有实跑任何写命令（`worktree create/rm`、`agent launch`、`terminal create`、`plugin install/enable`、`automations *`、`open`、`serve reset-identity`、`account *`）：只从 `agent-context --json` 读了它们的 `usage` 和 `notes`，退出码未测。
- `orca serve` 起无头 runtime 未测：本机 app 已在运行（pid 81561），要测得先停 app，会影响用户。
- 21 个 ssh target 全部 `not connected`，跨 host 的 `worktree list --host ssh:<id>` 未测。
- `graphState: unavailable` / `runtimeState: graph_not_ready` 对编排类命令（`agent launch`、`automations run`）的影响未测；只测了读命令不受影响。
- Orca 内嵌浏览器与 `orca computer`（GUI）未测，按设计走 `orca-computer-use` 技能。
- 未在别的 Orca 版本上验证；升级后重跑 §1 的 16 条。
