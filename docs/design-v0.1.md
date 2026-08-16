# Moonglow Frostfin · 月芒霜鳍鲸 — 骨架设计稿 v0.1

> 受月矩力影响的鲸。DeepSeek Harness 的 loop 插件：让 DSH 会话的驱动者直接是 Kimi Code 本人。
>
> 本文所有接口结论均已对照 `reference/deepseek-harness` 本地源码核实（2026-08-15，`@deepseek-ai/dsh@0.1.0-rc.6` 时代）。

## 1. 目标形态

```
你 ──► DSH Web UI（主题 / 生态 / 会话管理 / 审批）
          │  session events (SSE mux)
    frostfin（DSH 插件，占 loop 插槽）
          │  ACP (JSON-RPC over stdio)
    kimi acp 子进程 ── 全部思考、工具调用、回话
```

非目标：不做 TUI 套娃、不做 DSH 主 agent 的"下属"、不动 kimi-code 源码（不 fork）。

## 2. DSH 侧已核实的接缝（生死题答案）

**换 loop = 换工厂。** 全仓库只有一个负载接缝：

- `AgentFactory` 接口：`packages/core/agent/src/index.ts:183`（`createAgent(ownerCtx, options)` / `resume(...)`）
- 注册点：`ctx.agents.setFactory(factory)`，`packages/core/agent/src/index.ts:372`——全局唯一，重复注册抛错；返回 disposer，随 Cordis effect 自动撤销
- 所有消费者都走 `ctx.agents.create()/resume()`：Web host、ACP server、headless runner、subagent 续聊——换掉工厂等于全入口换驱动
- 配置机制：profile 的 `cordis.patch.yml` 里把 `agent-loop` 行 `disabled: true`，`insert` 自己的行（补丁语义：按 id 整行替换/禁用）

**契约：往会话日志写标准事件。** Web UI 不看 Cordis 事件，只看会话日志（`ctx.sessions` → `session/event` → SSE）。frostfin 的核心工作就是把 ACP 流转译成这套词表：

| 必须写的事件 | 时机 |
|---|---|
| `turn/start` / `turn/end` | 每轮括弧，`TurnEndReason: completed/aborted/blocked/error/max-tokens` |
| `step/start` / `step/end` | 每个 step 括弧（turn 内 1..n 编号） |
| `user/message` | 用户输入落盘（surface 事件） |
| `assistant/chunk` | 每个流式增量（`StreamChunk`: text-delta / reasoning-delta / tool-call-delta…）**不可省**，UI 打字机效果靠它 |
| `assistant/message` | 聚合完成的消息（surface 事件，带 `sourceEventSeqs`） |
| `tool/call` / `tool/result` | 工具调用与结果（surface 事件；result 必须有同 step 的 call 先行） |

纪律由 `packages/core/session/src/invariant.ts` 强制：seq 严格递增、turn/step 不嵌套不越界。参照物：`packages/core/agent-loop/src/agent.ts` 是唯一完整实现，照抄它的事件顺序。

**现成参照实现（都在仓库里）：**

- `packages/subagent/subagent-acp/src/run.ts`——ACP 客户端完整生命周期：spawn → `initialize` + `newSession` → `prompt` → `sessionUpdate` 折叠 → 权限自动应答 → cancel → dispose 阶梯（stdin EOF → 等 6s → SIGTERM → 等 3s → SIGKILL → waitForExit）。直接可模仿
- `packages/acp/acp/src/index.ts`——反向参照（dsh 当 ACP server）：`session/new` → `ctx.agents.create()`，`session/prompt` → `agent.followup()` + `whenIdle()`
- `packages/bundle/headless/tests/headless.spec.ts:59`——最小替代工厂骨架（测试里的 scripted Agent）
- `packages/test-support/acp-snapshot`——keyless 的 scripted ACP 子进程，可直接拿来给 frostfin 写测试

## 3. 组件划分（frostfin 包内）

单一包 `@frostfin/dsh-frostfin`（先不进 monorepo），命名空间插件形态：

```
src/
  index.ts        # name/inject/Config/apply；apply 里 ctx.effect(() => ctx.agents.setFactory(factory))
  factory.ts      # FrostfinAgentFactory implements AgentFactory
  agent.ts        # FrostfinAgent implements Agent（复用 dsh-agent 的 Inbox）
  acp-process.ts  # kimi acp 子进程管理 + ClientSideConnection 封装
  translate.ts    # ACP session/update → DSH session 事件映射（纯函数，可单测）
  permission.ts   # ACP session/request_permission → ctx.approval 桥（M2）
  config.ts       # schemastery Config
cordis.patch.yml  # disabled: agent-loop + insert frostfin 行
package.json      # "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }，peer: @deepseek-ai/cordis
```

- `inject = ['agents', 'sessions', 'subprocess', 'settings']`（`llm`/`tools`/`systemPrompt` 不注入——模型和工具都在 kimi 侧；`sessionPersistence` 用 `ctx.get()` 读，不注入）
- `Config` 字段：`command`（默认 `kimi`）、`args`（默认 `['acp']`）、`env`、`permission`（`allow|reject|ask`，M2 才实现 ask）、`disposeEofGraceMs`、`disposeGraceMs`
- 每个 DSH 会话 ↔ 一个 `kimi acp` 子进程 ↔ 一个 ACP session。FrostfinAgent 持有进程句柄，`dispose()` 走 subagent-acp 的关停阶梯

## 4. ACP → DSH 事件映射表

| ACP `session/update` | DSH session 事件 |
|---|---|
| `agent_message_chunk` | `assistant/chunk`（text-delta） |
| `agent_thought_chunk` | `assistant/chunk`（reasoning-delta） |
| `tool_call`（新建） | `tool/call` |
| `tool_call_update`（完成/失败） | `tool/result` |
| `plan` | v0.1 落为 `assistant/chunk` 文本；后续接 `packages/plan` |
| prompt 完成（`stopReason`） | `turn/end`：`end_turn→completed`，`cancelled→aborted`，`max_tokens→max-tokens`，其余→`error`（照抄 run.ts:135 的映射） |
| `session/request_permission`（反向 RPC） | v0.1 按 config 策略自动应答；M2 桥到 `ctx.approval` |
| `fs/read_text_file` / `fs/write_text_file`（反向 RPC） | v0.1 拒绝（kimi 侧本地执行）；后续映射 DSH fs 策略 |

## 5. 里程碑

- **M1 对话贯通**：禁用 agent-loop → frostfin 接管工厂 → DSH Web UI 里输入，kimi 流式回话逐字渲染（无审批桥，permission=allow）。验收：`assistant/chunk` 打字机效果出现，刷新页面后历史可从日志回放
- **M2 审批桥**：`session/request_permission` → `ctx.approval`（DSH 原生审批 UI）。**这是无人做过的映射**（subagent-acp 只自动应答），单独一个里程碑
- **M3 会话生命周期**：`resume` → ACP `session/load`；`cancel` → ACP `session/cancel`；DSH 重启后 kimi 会话重连；dispose 阶梯。**会话接力**：frostfin 创建的会话是磁盘上的真实 kimi 会话（已实证：CLI `kimi -S session_<id>` 可续聊，ID 需带 `session_` 前缀）——M3 顺手支持"按 kimi 会话 ID 把既有会话接进 DSH"，语义是接力而非双开（一个 kimi 会话同一时刻只能被一个进程驱动）。
- **M4 打磨**：`provider`/`model`/`cwd` 三个 prompt 变量补注册（agent-loop 原有的，替代品必须自己供）；设置命名空间；错误分类；kimi 版本检查

M1 的测试：照 `acp-snapshot` 写一个 scripted ACP child，无需真 kimi 即可跑 CI。

## 6. 风险与未决（按优先级）

1. **审批桥无先例**（M2）：DSH 的审批挂在 `tools/pre-execute` → `ctx.approval`，外部 agent 不触发这条链，要自己构造 approval 请求对象。开工 M2 前先读 `packages/interaction/`
2. **一进程一工厂**：想"这个会话用 kimi、那个会话用 DeepSeek 原生 loop"，得在 factory 内部按 `CreateAgentOptions`（如 `meta.agentPreset`）自己分发——v0.1 不做，全局替换
3. **会话日志版本纪律**：`SESSION_FORMAT_VERSION = 0`，自定义事件类型不在 `KNOWN_SESSION_EVENT_TYPES` 里会被后端拒读，除非事件信封带 `ignorable: true`。v0.1 只用标准事件，不自定义
4. **插件形态陷阱**（postmortem 0001）：命名空间插件**不能**再 `export default`（loader 会静默丢弃 name/inject/Config）；不注入的服务用 `ctx.get()` 读，不能 `ctx.xxx`
5. **kimi 侧 ACP 覆盖度**：`terminal/*` 反向 RPC 未实现（kimi 本地跑 shell，符合预期）；`fs/*` 会路由给客户端——v0.1 直接拒绝即可，kimi 有本地兜底（待实测确认）
6. **双 rc 依赖**：dsh 0.1.0-rc.6 + kimi-code 0.36.x 都在剧烈变动。锁版本，升级是主动动作

## 7. 明确不做（v0.1）

- 不做 SDK 进程内融合（ACP 边界先跑通，确认价值再谈深融合）
- 不做工具热插拔（那是 v0.3 远景，且取决于 kimi v2 引擎动态工具注册这个未验证问题）
- 不做 per-session loop 选择
- 不做 Windows 适配（先 POSIX；subagent-acp 的进程组杀法在 Windows 要换 Job Objects）
