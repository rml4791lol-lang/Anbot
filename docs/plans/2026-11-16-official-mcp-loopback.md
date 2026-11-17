# 官方 MCP loopback 与只读工具清单

- 日期：2026-11-16
- 相关：Issue #40，#38

## 为什么

本地 Agent Bot 的 loopback MCP 服务原先手写 JSON-RPC/SSE，只实现协议的一小部分。它会把 union、ref 和 const 压平，也没有可跨请求工作的取消路径，已经和官方 MCP 客户端产生真实漂移。这里替换的是传输适配器，不是 DSH 的工具注册、权限或执行链。

## 已定的行为

- 每个本地 Agent Session 仍只有一个 loopback MCP 服务，绑定 `127.0.0.1` 的随机端口和每 Session 一个 32 字节 bearer token。
- 服务使用 `@modelcontextprotocol/server` 2.4.0 与 `@modelcontextprotocol/node` 2.1.2 的 `McpServer`、Streamable HTTP transport 和 JSON Schema 适配器。协议版本由 SDK 协商。
- MCP HTTP 会话有状态，所以初始化后的 `tools/list`、`tools/call`、GET SSE、DELETE 和 `notifications/cancelled` 都落在同一个官方 transport 上。
- `tools/list` 原样发布 DSH 当前 turn 的 `ToolSchema.parameters`，不再压平 union、ref、const 或定义。
- 可调用的桥仍只包含当前 `toolsFor()` 允许的 DS Bot 团队工具和 `approve_agent_action`。清单可见不等于自动把外部 MCP 工具塞进 CLI。
- 工具集合在 turn 之间变化时，现有 MCP 会话会更新或删除已注册工具并发送 `tools/list_changed`；不会为第二套工具注册表保存副本。
- `dsbot://tool-inventory` 是只读 MCP resource。它从同一份 DSH-visible `options.tools` 派生，只列出 `mcp__*` 工具，返回每个工具的 `name`、`schemaHash`、`descriptionHash` 和整体 `revision`。
- hash 使用稳定的键排序 JSON 和 SHA-256。工具顺序、对象键顺序不变时 revision 不变；schema 或 description 变化时 revision 必然变化。
- 未授权请求在任何 MCP dispatch 之前返回 `401`。Host 和 Origin 只接受本机回环。
- DSH 仍是工具注册、授权和执行的唯一事实来源。清单在读取时重新计算，不写入 `state.json`，不复制成持久 registry。

## 不做什么

- 不修改 DSH 源码或安装目录。
- 不新增 Agent Runtime、工具注册表、任务数据库或第二套执行路径。
- 不把 CLI 自己的工具冒充成 DSH MCP 工具。
- 不把 inventory resource 当成调用入口。

## 已知限制

- inventory 只揭示 DSH 当前可见的工具，不能推断 DSH MCP client 的连接重试或最终失败时刻。
- 如果本地 Agent CLI 不读取 MCP resources，它仍可通过 `tools/list` 使用团队工具，但看不到 inventory resource。
- 外部 MCP 工具是否可跨本地 Agent 桥调用仍由 `toolsFor()` 的产品边界决定；本阶段只把真实清单和漂移暴露出来。

## 验证

- 同一服务由 `@modelcontextprotocol/client` 2.2.0（DSH 固定线）和 2.4.0（DS-Bot 连接器线）真实初始化、列工具和调用通过。
- 取消请求会 abort bridge handler、清理 pending call，并保持服务可继续接受请求。
- 回归覆盖 bad token、schema 保真、工具热更新、inventory 稳定性和真实 DSH tool dispatch。

## 变更

- 2026-11-16：用手写 loopback 替换为官方 MCP TypeScript SDK，并加入只读工具清单。
