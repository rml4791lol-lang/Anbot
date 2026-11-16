# Orca 接入说明

- 状态：已装可用（2026-11-14 安装并验证）
- 机器：`/opt/homebrew/bin/orca` 1.4.258；应用 `/Applications/Orca.app`
- 来源：`brew install --cask stablyai/orca/orca`（stablyai/orca，MIT）

## 1. 它是什么

Orca 是一个并行 agent 工作台：给每个仓库开 worktree、在 worktree 里跑 agent（Claude Code / Codex / 其他 CLI）、采集终端输出、把 review 与 issue 链接到 workspace，并能在多台 host 之间派活。对 Bot 来说，它提供的是**进程与工作区的编排层**，不是模型。

## 2. CLI 能做什么（已核实）

| 组 | 命令 | 用途 |
|---|---|---|
| 启动 | `orca open` / `serve` / `status` | 打开 GUI / 起无头 runtime / 查就绪状态 |
| 诊断 | `orca diagnostics memory` | 内存快照，含受管终端 |
| 发现 | `orca agent-context` | 打印机器可读的命令 schema，给 agent 用 |
| 检索 | `orca search` | 全文搜索某台 host 上的 agent 会话 |
| 账号 | `orca account add/list/select/rm` | 管受管 agent 账号 |
| 技能 | `orca skills list/get/install/update/share` | 版本匹配的技能指南（`get` 直接输出 Markdown） |
| 主机 | `orca host list/rm` | 可派活的目标机器 |
| 环境 | `orca environment add/list/show/rm` | 远程 runtime 配对 |
| 插件 | `orca plugin …` | 插件目录、安装、校验、开发 |
| 运行时 | `orca vm recipe doctor` / `vm env doctor` | 校验环境配方 |
| 自动化 | `orca automations list/show/create/edit/remove/run/runs` | 定时任务与历史 |

## 3. Bot 能做什么、不能做什么

能做：

- 用 `orca status` 判断运行时是否就绪；用 `orca serve` 起无头 runtime。
- 用 `orca agent-context` 取命令 schema，避免猜参数。
- 用 `orca skills get <name>` 拉版本匹配的操作指南（比记忆可靠）。
- 用 `orca automations create` 建定时任务；用 `runs` 查历史。
- 用 `orca search` 找回某台 host 上的旧 agent 会话。

不要做：

- 不要 `plugin install` / `enable` 需要 `--approve` 的代码而不问用户。
- 不要直接操作别的项目 worktree（只碰当前任务授权的工作区）。
- 不要用 Orca 的 GUI 自动化替代本可脚本化的动作；GUI 只走 `orca-computer-use` 技能。
- 不要把 Orca 当模型通道——它调度 agent CLI，不提供推理。

## 4. 和现有技能的关系

本机已装两个 Orca 技能：`orca-cli`（命令行操作）与 `orca-computer-use`（GUI 控制）。需要编排多个 worker 时用 `orchestration` 技能，不要自己拼 `tmux`。

## 5. 验证方式

```bash
orca --version          # 1.4.258
orca status             # 显示 app/runtime/graph 就绪状态
orca agent-context | head -40
```

装完没跑过 `orca open` 时，`status` 可能报 runtime 未起；这不代表装坏，用 `orca serve` 或 `orca open` 再查。
