# Bot 优化：按效果评测，加一条自采日志

> 状态：草案（#5 预注册判决时才冻结）。当前版本吸收了 m01519 的追加要求：评测看效果与整体，并有一份自己收集的日志驱动改进，但不复制 Hermes 式的自我进化。

## 0. 先说结论

只靠裁判读文本打分，会把 Bot 优化成"看起来有理有据"，而不是"事情做成了"。所以评测拆两层：

1. **效果层**：每条任务的 `expect` 转成机械判据（文件在不在、命令退出码、页面里有没有那段字、链接是否 200），由脚本跑，不经过任何模型。
2. **质量层**：裁判做**配对比较**（同一任务的两个回答，交换顺序各判一次），不判绝对分；用于比较 prompt/instructions 的改动。

日志由 **host 代码写**，不由模型写；模型只能读。改进建议走"证据 → 提议 → 独立裁判 + 人批准"的闸门，禁止自动改 prompt。

## 1. 为什么不能只信裁判（二阶）

| 一阶做法 | 二阶后果 |
|---|---|
| 用 5 分 rubric 判回答质量 | 优化目标变成"读起来像好答案"：多写小标题、多贴命令、多自称已核对；实际没做也会拿高分 |
| 24 条样本判绝对分 | 信噪比不够；只有 ≥10pp 的差异可检出，`prompt 重排`这种小改动永远"无显著差异" |
| 让 agent 自己评估自己、自己改自己 | 与 Hermes 同款漂移：评分口径和写作口径一起变，没人能证伪 |
| 用与 Bot 同厂商的模型当裁判 | 同源偏好；换厂商（claude 判 deepseek 产出）才勉强算独立 |

## 2. 效果层：把 expect 变成可执行检查

每条 golden 任务新增可选字段 `checks`：

```json
{"kind":"file_exists","path":"内容/2026-11-14/x.md"}
{"kind":"grep","path":"...","pattern":"..."}
{"kind":"exit_zero","cmd":"node dev/foo.mjs --check"}
{"kind":"http_ok","url":"https://..."}
```

规则：

- `checks` 为空 → 该任务只进质量层，不进效果层，分母里写明。
- 效果层是**二元**的：全部 checks 通过算 1，否则 0。不做部分分。
- 危险操作（写、删、跑网络）默认不执行；`exit_zero` 只允许列在 `dev/eval/checks.allow` 里的命令。
- 效果层的改动（新增 check）要先跑"旧回答对旧 check"，确认现在确实是 0 分，否则这个 check 没有区分力。
- 2026-11-15 覆盖：24 条里 12 条有 checks（11 条 `1.1`、1 条 `1.2` 之后全部按需 bump）；分母按 §10 取 12。
- 2026-11-20 修正基线答案：g05 改用同一会话 turn 78 的压缩/技能回答（原文件误抽到 turn 79），g12 补上样本选择偏差；当前 `node dev/eval/judge.mjs --checks` = **12/12**。
- 2026-11-15 更正 g04：旧 check 用 `记住|记忆` 对不上它的 expect（三条都不要求这个词），改为 `state\.json|指令` + `三类|拍板|卡住|交付物`，答案实际满足。这是判据写错，不是把红改绿。

## 3. 质量层：配对比较，不判绝对分

- 输入：同一任务的两份回答（A 现网、B 改动后），顺序随机，裁判不知道哪份是哪份。
- 每个样本跑两次（AB / BA），两次结论相反 → 记 tie，不进分子分母。
- 主指标：胜率 = wins / (wins + losses)，报告 95% 区间；tie 单独报。
- 裁判模型必须与 Bot 模型不同厂商；当前 Bot 跑 `deepseek-v4.1-flash`，裁判用 `claude` CLI（`claude -p`，已验证可跑、单条 10–15s）。

## 4. 自采日志（ledger）

写入方是 host 代码（`ds-bot/src/host/ledger.js`），**不是模型**。append-only，一天一个文件：

```
~/.dsh/bot/ledger/YYYY-MM-DD.jsonl
```

每轮一行，字段固定：

| 字段 | 含义 |
|---|---|
| `ts` | 轮开始时间（ms） |
| `bot`, `room`, `session`, `turn` | 身份与定位 |
| `seed.kind`, `seed.role`, `seed.form` | 谁开轮（user / bot / schedule / memory…）与角色（reply/request/update/stopped） |
| `tools[]`, `tool_errors` | 工具名列表与失败数 |
| `files[]` | 本轮 write/edit 触及的路径（哈希，不存内容） |
| `tokens{in,out,cache_read}`, `duration_ms` | 成本与时长 |
| `final_chars`, `final_hash` | 回答长度与哈希（不存正文） |
| `outcome` | `reply` / `silent` / `aborted` / `error` |
| `reactions[]` | 之后 30 分钟内同 room 的用户消息：`correct` / `reask` / `none`，由时段扫描回填 |

不采集：消息正文、文件内容、用户原文。需要复盘失败样本时，另存首尾 200 字到一个受控目录（默认关）。

为什么由 host 写：模型写日志会顺手美化（把猜测写成"已核对"），日志一旦被优化对象污染，就不能当证据。

## 5. 改进回路（每周一次）

```
ledger 日文件
  → digest.mjs：机械统计（轮次来源、噪音轮、工具失败、纠正率、耗时分布）
  → 失败样本 20 条（按 outcome=error / 高纠正率 / 零工具长文筛）
  → proposals/NNN-<slug>.md：假设、证据 id、要改的 prompt/instructions 段、预期指标、回滚方式
  → 独立裁判读证据给"支持/反对/证据不足"
  → 人批准 → 改 → 下一周同口径对照
```

硬规则：

- 任何改动必须能指出"改前哪几条 ledger 记录说明它有问题"。
- 提议文件必须写回滚方式；没有回滚方式的提议不入队。
- 评测集（golden.jsonl）与裁判 rubric 不接受模型自行修改，只能由人改。
- 一周内没有证据的改动，默认不改。

## 6. 与 Hermes 式自我进化的区别

| Hermes 式 | 本方案 |
|---|---|
| 模型自己总结、自己改、自己判分 | 日志由 host 写，裁判换厂商，人批准 |
| 改的是"感觉" | 改的是有证据的具体段落 |
| 无回滚 | 每条提议带回滚 |
| 改了无法比较 | 配对比较 + 预注册主指标 |

## 7. 工单调整

- 02 裁判运行器：加 `--pair` 模式（A/B 目录）与顺序交换；rubric 保留，但只用于配对，不输出绝对分排名。
- 新增 **10 自采日志**：`ledger.js` + 关轮钩子 + 回填 reactions + 单测（用假 session 事件驱动）。
- 新增 **11 每周 digest 与提议**：`digest.mjs` + `proposals/` 模板 + 生成失败样本清单。
- 08 生产指标：改为消费 ledger，不再重复扫 session 文件。
- 03 裁判稳定性：改为"旧 vs 旧"配对，一致率 ≥80% 才允许用裁判下结论。

## 8. 开源参照（均在本机核实过仓库与机制）

| 项目 | 核实到的事实 | 借什么 | 不借什么 |
|---|---|---|---|
| SWE-bench（6.2k star） | README 明写 "SWE-bench uses Docker for reproducible evaluations"；判据是容器里跑测试：修复后 FAIL_TO_PASS 全过、PASS_TO_PASS 不退 | 效果层的判据形态：只认跑出来的结果，不认描述；每条 check 必须"改前为假、改后为真"才有区分力 | Docker 沙箱（我们的效果层只跑只读检查与白名单命令） |
| promptfoo（27k star） | 断言是声明式列表（contains / regex / is-json / javascript），逐条对输出求值 | `checks` 字段的形状：类型 + 参数 + 期望，一条一条可列举 | 它的执行编排与云服务 |
| Langfuse（37k star） | trace → observation → score；分数挂在具体 observation 上，不挂在会话上；数据集可复用 | ledger 的粒度：一行一轮，分数/反应挂到那一轮，不挂"整段对话" | 自托管整套平台、OTel 管线 |
| Phoenix（12k star） | OpenTelemetry 原生，按 span 记录评估 | span 化思路：轮 → 工具调用 → 结果，父子关系 | 引入 OTel 依赖 |
| Darwin Gödel Machine（2.5k star） | README 明写 agent 改自己的代码、每条改动用编码基准验证，且需要 Docker 沙箱 | 闸门形态：基线快照 → 改动 → 同口径复跑 → 谱系留档 | 自动改自身代码、无人批准 |

结论：借 schema 与判据形态，不引入任何运行时依赖。

## 9. 上下文与工具是产出上限（m01549 的推论）

Bot 每轮能做什么，由这一轮**给了什么上下文、开着哪些工具**决定。因此 ledger 必须记这两项，否则"回答变好"无法归因：

| 新增字段 | 含义 |
|---|---|
| `context.bytes` | 本轮系统提示 + instructions + 各注入源的字符数，按来源分组（system / instructions / injected / history） |
| `context.sources[]` | 注入源名称与字节数（如 openviking-context 19,488、skills 22,383、AGENTS.md 7,061） |
| `tools.offered[]` | 本轮实际可调用的工具名集合 |
| `tools.used[]` | 实际调用过的工具名与次数 |

对照规则：**任何 prompt/instructions 改动，必须在 ledger 里同时给出改动前后的 context.bytes 与 tools.offered 差异**，否则只算"观感变化"，不算"能力变化"。

## 10. 分母口径（写死，避免第二次翻车）

- 轮次：按 `turn/start` 计；跨天按事件时间过滤，`[dayStart, dayEnd)`。
- 效果层：分母是"有 checks 的任务数"。
- 质量层：分母是"两次判定一致的非 tie 样本数"。
- 纠正率：分母是"有用户后续消息的轮数"，不是全部轮数。
- 所有报表必须同时打印分母；分母为 0 时输出 `n/a`，不许输出 0%。

## 11. 失败归类：过程失败先于内容失败（2026-11-20）

§2 的效果层只能看到「磁盘上留下了什么」，§4 的 ledger 记了 `outcome` 但不归因。两者之间缺一层：**这个失败是 harness 没让它做完，还是它做完了但做错**。前者改 harness，后者才可能值得训权重。

运行：`node dev/eval/failures.mjs --answers dev/eval/answers/base [--judge <judge.mjs --out 文件>]`，实现在 `dev/eval/failures.mjs`，单测 `test/eval-failures.test.js`。

判定口径（按顺序命中第一条）：

| class | kind | 触发 |
|---|---|---|
| `repeat-call` | process | 同一调用重复、检测到循环 |
| `tool-blocked` | process | permission denied、不在 `checks.allow`、工具被禁用 |
| `step-limit` | process | 达到步数上限 |
| `context-limit` | process | 上下文窗口、截断 |
| `turn-crash` | process | 回合失败、模型错误、流中断、超时 |
| `no-delivery` | process | 没有交付，且认不出原因 |
| `wrong-delivery` | content | 交付了，且没命中上面任何一条 |

规则：

- 「交付了」由裁判判定；没有裁判结果时退化为「答案文件非空」。
- 通过了 checks 的任务不算失败，不归类。没有 checks 的 12 条，在裁判结果出来之前一律落到 `content/wrong-delivery`，报表里要注明这是保守值。
- **过程失败未清零之前，不做任何 SFT / LoRA / RL。**
- 连着两轮只有 `content/wrong-delivery`，才说明是能力上限，才进入 §5 的提议队列去讨论训练或改 prompt。

2026-11-20 首次基线：`failures: 14/24, process 0, content 14`。过程失败为 0 不代表 harness 没有过程失败——静态答案档案里根本看不到一轮卡死的回合。要看到它，得让 §4 的 ledger 每轮多记一个终止原因（`delivered | max-steps | blocked-tool | context-full | repeat-call | error`），并把 ledger 日文件作为 `failures.mjs` 的输入源，取代对答案文本的正则匹配。这是下一张工单，未做。
