# 给 DSH（DeepSeek Harness）的上游需求清单

> 背景：frostfin（dsh-frostfin）把 Kimi Code 作为 DSH 的 agent loop 驱动。以下是在集成中逐条验证过、只能由 DSH 侧补齐的能力缺口。kimi ACP 侧的需求另见 [upstream-kimi-acp.md](upstream-kimi-acp.md)。

## 1. 审批结果词汇表缺"本会话允许"

- **现状**：`ApprovalOutcome` 是封闭四值枚举（`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，`dsh-user-approval`），`ApprovalRequest` 没有选项字段。ACP 客户端（kimi）的审批请求是三选项（once / for this session / reject），经 DSH 弹窗应答时"本会话允许"永远选不到，同类工具逐次弹窗。
- **建议**：`ApprovalRequest` 增加选项列表，`ApprovalOutcome` 增加"session 级允许"（或泛化为选中项回传），web 弹窗渲染第三个按钮。

## 2. 空白会话切换 preset 不重跑工厂

- **现状**：空白会话切 preset 时宿主只 `recompose` 插件组合（`apiproxy/src/api-proxy.ts` 的 `agentPresets.select`，"the agent and the session survive"），**agent 不重建**。对"按 preset 分发 loop"的插件（frostfin），这意味着 UI 显示的模式与实际驱动者错位。
- **建议**：空白会话切 preset 时官方重跑 `AgentFactory`（或提供正式的 agent-swap API），避免插件侧用宿主内部件（`detachAgentKeepSession`/`publishAgentOnly` 这类非公开面）实现。

## 3. 会话级模型目录 / ReactLoopAgent 导出

- **现状**（rc.6 时代）：模型目录与默认模型是部署级状态；loop 插件若要自带模型面（frostfin 的 KimiModelCatalog），只能走"名义路由 + 部署级默认模型"的间接路径。`ReactLoopAgent` 未导出，影子挂载只能靠 isolate+Proxy 捕获。
- **建议**：会话级模型目录接口；`ReactLoopAgent` 正式导出（供 preset 分发的委托方复用）。

## 4. 工具调用入参没有更正途径

- **现状**：`tool/call` 事件落盘即不可变（`dsh-session` 的 `surfaceOp` 只有文本区间 replace，无工具卡更正）。流式 ACP agent（kimi）先发空入参的懒创建、后补发完整 `rawInput`，客户端没有事件类型能把补发落到已渲染的卡片上。
- **建议**：支持 `tool/call` 的更正事件（或允许 surfaceOp replace 作用于工具卡入参）。

## 5. 侧栏工作区分组不支持远程/虚拟工作区

- **现状**：`workspaceRegistry.create(path)` 会 `stat` 校验路径必须在**本地**存在（`packages/workspace/workspace/src/index.ts:158-163`）。远程会话（cwd 是远程路径）无法注册工作区，侧栏全部掉进「未分组」。且 `sidebar.workspaces` 槽位是 single 独占（`ui-sidebar/src/client/index.ts:48`），插件无法添加自定义分组。
- **建议**：工作区记录支持免 stat 的虚拟/远程路径（title 可自定义，如 `主机名 · 远程路径`）；或 `sidebar.workspaces` 开放为多源 list 槽位。
