# 给 kimi Code ACP 适配器的上游需求清单

> 背景：frostfin（dsh-frostfin）把 Kimi Code 作为 DeepSeek Harness 的 agent loop 驱动，全程经 ACP（`kimi acp` 子进程）对接。以下是集成中逐条验证过、**只能由 kimi 侧补齐**的能力缺口。代码位置基于 kimi-code 仓库 `packages/acp-adapter`（0.36.x）。所有条目都不需要改 ACP 协议本身，只是适配器层的映射/转发补全。

## 1. AskUserQuestion 的 description / header 在适配器丢失（我们最想要的一条）

- **现状**：工具侧的完整参数是 `{label, description}` 选项 + `question.header`（`agent-core/src/tools/builtin/collaboration/ask-user.ts:34-47`）。但适配器映射时只把 `label` 抄进 `PermissionOption.name`（`acp-adapter/src/question.ts:54-57`），`description` 不到线上；`header` 同样未发出——`handleQuestion` 的 toolCall 只有写死的 title 和问题正文（`acp-adapter/src/session.ts:1404-1411`）。
- **影响**：ACP 客户端（Zed、我们的 DSH 模态框）只能渲染选项标题，描述的权衡说明全部丢失。
- **建议**：`PermissionOption._meta.description` 携带选项描述；`header` 走 request 级 `_meta`。`_meta` 是 ACP 预留扩展位，向后兼容。
- **我方已就绪**：渲染管线已预埋（`_meta.description` → 模态框选项副行），上游带上即可显示，客户端零改动。

## 2. 后台任务状态不进 ACP 流

- **现状**：任务列表只有 `/tasks` 内建命令的文本回复（`session.ts:876-880`，`formatTasksReport` :1531）。宿主想做"N 个后台任务在跑"的常驻指示，唯一的手段是注入 `/tasks` prompt 轮询——会话忙时撞 `TURN_AGENT_BUSY`，闲时污染对话历史。
- **建议**：任务起止/状态迁移时推送 `session/update`（可挂 `_meta`），或新增 `session/list_tasks` RPC。

## 3. 子代理（AgentSwarm）活动被整体过滤

- **现状**：prompt 事件循环里每一类事件都被 `isFromMainAgent` 门控（`session.ts:994-995` 及 1070/1088/1100/1159 等处），子代理的 turn、工具调用、流式输出全部不到客户端。宿主只能看到父 `Agent`/`AgentSwarm` 调用的一张卡片和最终聚合结果。
- **影响**：多子代理并行执行时客户端完全无感知，无法展示嵌套活动。
- **建议**：子代理事件以"展示用"更新转发（带 `agentId` 与父 `toolCallId`，不参与父 prompt 的 settle）。过滤的初衷（`session.ts:1660-1666`：防止子代理的 `turn.ended` 错误结束父 prompt）与转发展示并不矛盾。

## 4. goal 模式经 ACP 不可达

- **现状**：ACP 内建斜杠命令白名单只有 6 个（`builtin-commands.ts:3-29`：compact/status/usage/mcp/tasks/help），`/goal` 不在其中；未识别命令在 `slash.ts:61` 直接返回 unknown，不会发给模型。kimi 引擎侧有完整的 goal 工具链（CreateGoal/GetGoal/UpdateGoal），但 ACP 面上没有创建/管理入口，宿主也读不到 goal 的状态与预算。
- **建议**：goal 作为内建命令（或技能命令）暴露；goal 状态变化推送 `session/update`。

## 5. 多问题 / 多选降级（次要）

- **现状**：`handleQuestion` 对多问题只取第一个、`multiSelect` 降级为单选（`session.ts:1383-1396`）；线上 `q{n}_opt_*` 命名空间已预留多问题形态。
- **建议**：一次请求携带全部问题（`q1_opt_*`、`q2_opt_*` …），客户端即可分组渲染，无需改线格式。

## 6. 会话没有跨进程活性保护（远程/多客户端场景的实坑）

- **现状**：kimi 会话落盘（`agent-core/src/session/store/session-store.ts`）没有任何锁或独占打开；`session/load` 也不介意目标会话正被另一个进程持有。两个进程加载同一会话时，内存态各自独立、JSONL 交错追加、state 文件互相覆盖——不崩但历史分叉。真实场景：TUI 里开着的会话被 ACP 客户端（如本插件）再接入，或两个 ACP 客户端抢同一会话。
- **建议**：会话级锁文件（load 时占用、冲突报错），或 `session/list` / `session/load` 响应携带 `live`/`locked` 标志，让客户端至少能提示"该会话正被占用"。

## 7. steer（运行中注入）在 ACP 面上不存在

- **现状**：kimi 引擎原生支持 steer——`klient` 的 agent facade 有 `steer(input)`（`packages/klient/src/core/facade/agent.ts:45`），TUI 的 Ctrl+S 就走它：输入注入正在运行的 turn，下一个 step 边界（当前 tool call / thinking 段结束）即生效。但 ACP 面上没有任何 steer 通道（acp-server/acp-adapter 全文无 steer）；运行中再发 `session/prompt` 会被 `assertNoActiveTurn()` 直接拒绝（`acp-server/src/session.ts` 的 `driveTurn`）。
- **影响**：ACP 客户端做不了"运行中插话"——只能排队等当前轮跑完，或 cancel 当前轮再开新轮（留中止痕迹，语义也不等价）。
- **建议**：新增 `session/steer` 扩展方法（或 `session/prompt` 携带 `mode`），适配器转发给引擎的 `agent.steer()`。引擎是现成的，只差暴露。

---

另有一份 DSH（DeepSeek Harness）侧的上游清单（审批结果词汇表缺"本会话允许"、空白会话切 preset 不重跑工厂等），与 kimi 无关，不在此列。
