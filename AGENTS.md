# AGENTS.md — dsh-frostfin（月芒霜鳍鲸）

> 写给 AI 编码代理的项目说明。读者对本项目一无所知。本文所有结论均来自对仓库实际内容的核实（2026-08）。

## 项目概述

**dsh-frostfin** 是一个 DeepSeek Harness（DSH）的 **agent loop 插件**：把 DSH 会话的驱动者整个换成 **Kimi Code 本人**——通过 ACP（Agent Client Protocol，JSON-RPC over stdio）直连 `kimi acp` 子进程，中间没有第二个 agent 转述。

```
用户 ──► DSH Web UI（主题 / 生态 / 会话管理 / 审批）
            │  session events
      frostfin（DSH 插件，占 agent loop 插槽）
            │  ACP（JSON-RPC over stdio）
      kimi acp 子进程 ── 全部思考、工具调用、回话
```

DSH 的架构里 agent loop 本身就是可替换插件（`ctx.agents.setFactory`，全局唯一）。frostfin 注册自己的工厂，把每个 DSH 会话桥接到一个 `kimi acp` 子进程，并把 ACP 事件流实时转译成 DSH 会话事件——流式回话、历史回放、审批弹窗都是 DSH 原生体验。

与 kimi-tide 等方案的区别：那些项目把 Kimi 接在模型层/工具层（DSH 主 loop 不变）；frostfin 把 loop 本身换成 Kimi Code。

**版本基线**：对锁 `@deepseek-ai/dsh@0.1.0-rc.6` 与 Kimi Code 0.36.x，两边都在快速迭代。包管理器为 pnpm，Node.js 要求 ≥ 22.19。

## 技术栈

- **语言**：TypeScript（strict 模式，ESM，`"type": "module"`，`module: NodeNext`），编译目标 ES2022。
- **插件框架**：`@deepseek-ai/cordis` 4.0.1（peer 依赖）——一切注册走 Cordis effect，卸载即撤销。
- **ACP 客户端**：`@agentclientprotocol/sdk`（`ClientSideConnection` + ndjson stdio）。
- **配置模式**：`@deepseek-ai/schemastery`（`src/index.ts` 的 `Config`；package.json 还声明了 zod，但 src 当前未引用）。
- **浏览器半身**：React（TSX，自动 JSX 运行时），react 等平台模块由 DSH 外壳注入（构建时 external）。
- **构建**：`tsc`（宿主半身 src → lib）+ `esbuild`（浏览器半身 src/client → lib/client.js）。
- **测试**：Node 内置 `node:test`，纯 `.mjs` 文件直接驱动构建产物 `lib/`。
- **浏览器实测**：`playwright-core`（仅 `scripts/` 下的手工探针用）。

## 构建与测试命令

```sh
pnpm install        # 安装依赖（pnpm-lock.yaml 锁定）
pnpm build          # = build:host + build:client（完整构建）
pnpm build:host     # 仅 tsc：src/ → lib/（排除 src/client/）
pnpm build:client   # 仅 esbuild：src/client/index.ts → lib/client.js（CJS bundle，包进 window.__ModuleLoader__.load 协议）
pnpm test           # node --test test/*.test.mjs
```

**重要**：测试直接 import `../lib/*.js`（构建产物），改完 `src/` 必须先 `pnpm build` 再 `pnpm test`，否则测的是旧代码。

最近一次验证：`pnpm build` 通过，`pnpm test` 74 个测试全部通过（约 30 秒，含真实子进程的集成测试）。

## 目录结构与模块划分

```
src/                  宿主半身（Node 侧，tsc 编译到 lib/）
  index.ts            插件入口：name/inject/Config/apply；inject = ['agents','sessions','subprocess']
  factory.ts          FrostfinAgentFactory：AgentFactory 实现，占 loop 插槽；按 preset 分发（frostfin → kimi，其他 → 影子原生 loop）
  agent.ts            FrostfinAgent：一个 DSH 会话 ↔ 一个 kimi acp 子进程 ↔ 一个 ACP 会话；turn/step 驱动纪律
  acp-process.ts      kimi acp 子进程管理 + ClientSideConnection 封装（spawn → 握手 → prompt → dispose 阶梯）
  translate.ts        ACP session/update → DSH 会话事件的纯转译层（零 I/O，可单测）
  permission.ts       M2 审批桥：ACP request_permission → DSH ctx.approval（fail-closed）
  question.ts         M7 提问通道：kimi AskUserQuestion 复用审批通道，插件自建模态框闭环
  commands.ts         斜杠命令：/frostfin-* 系列 + /yolo /auto 快捷键 + kimi 内建透传（/compact /status /usage /mcp /tasks /help）
  kimi-route.ts       名义模型路由 provider 'kimi-code'（喂饱 DSH 模型层两道门禁）+ KimiModelCatalog（真实模型目录，持久化）
  kimi-sessions.ts    DSH↔kimi 会话绑定映射（KimiSessionMap）与运行档位记忆（KimiSessionPrefs），JSON 文件存 ~/.frostfin/
  config-sync.ts      把 DSH 已配置的模型供应商同步进 kimi config.toml 的托管标记块
  preset-install.ts   把「月芒霜鳍鲸」preset 复制到 $DSH_HOME/.agent-presets/frostfin
  shadow-native.ts    影子挂载原生 agent-loop（cordis isolate + Proxy 捕获其工厂，供 preset 分发委托）
  host-scope.ts       从宿主进程模块树解析 dsh-* 包（模块私有 Symbol 必须与宿主同一份）
  panel.ts            webServer HTTP 端点：/plugins/frostfin/*（会话列表/打开/状态条/提问/远程主机）
  remote.ts           远程线：ssh+tmux shim 命令构建与远程体检（kimi 养在远程 tmux，断线不死）+ RemoteTransport 传输接口（remoteTransport 分派点，POSIX 唯一实现）
  ssh-config.ts       ~/.ssh/config 解析（OpenSSH/VS Code 语义：Host 块、Include、first-obtained-wins）
src/client/           浏览器半身（React TSX，esbuild 打包；tsc 排除此目录）
  index.ts            槽位注册：会话面板 tab、状态条 dock、提问模态框
  SessionsPanel.tsx   「月芒霜鳍鲸」tab：本地/远程 kimi 会话列表与接入
  StatusDock.tsx      输入框下方状态条（模型/thinking/模式/上下文占用/cwd/git 分支，3 秒轮询）
  QuestionModal.tsx   AskUserQuestion 多选模态框
presets/frostfin/     「月芒霜鳍鲸」preset 定义（preset.yml + agent.cordis.yml，最小 persona 行）
cordis.patch.yml      DSH profile 补丁：insert frostfin 行、agent-presets 默认改为 frostfin、禁用 agent-loop
test/                 node:test 测试（.mjs）+ fixtures/scripted-acp-child.mjs（script 化 ACP 子进程夹具）
scripts/              build-client.mjs 是真构建步骤；probe-*.mjs / spike-*.mjs / ui-*.mjs 是手工探针
docs/                 design-v0.1.md（设计稿）、guide.md（用户手册）、upstream-kimi-acp.md（上游需求清单）
reference/            本地参考仓库（deepseek-harness、kimi-code、kimi-tide），gitignore 排除，仅供对照阅读
lib/                  构建产物，gitignore 排除
assets/               图片素材（含《原神》版权素材，不在 MIT 覆盖范围）
```

## 运行时架构要点

- **换 loop = 换工厂**：`ctx.agents.setFactory(factory)` 全局唯一，`cordis.patch.yml` 同时禁用 `agent-loop` 行。所有入口（Web host、headless 等）都经 `ctx.agents.create()/resume()`，换工厂即全入口换驱动。
- **惰性启动**：新建会话不起 kimi 进程；首个 prompt 才 spawn + ACP 握手（initialize + newSession）+ 登记绑定。kimi 未登录/未装不挡开会话，问题在发送时以对话内指引浮现。
- **进程自愈**：kimi 进程崩溃后，下一个 prompt 自动重连（重 spawn + `session/load` 吞回放）。远程会话经 ssh+tmux 复挂活 pane。
- **preset 分发**：`shadow-native.ts` 在 cordis isolate 里挂原生 agent-loop 并**捕获**其工厂（不占工厂位）；「月芒霜鳍鲸」preset 的会话走 kimi，其他 preset 委托原生 loop，互不干扰。会话创建后驱动方锁定，不静默换脑。
- **关停阶梯**（照抄 DSH subagent-acp）：stdin EOF → 等 `disposeEofGraceMs` → SIGTERM → 等 `disposeGraceMs` → SIGKILL → 整树退出证明。
- **面板端点**（`src/panel.ts`，webServer 服务缺失的 headless 宿主自动跳过）：`GET kimi-sessions`、`POST open`、`GET status`、`GET/POST pending-questions/answer-question`、`GET remote-hosts`、`GET remote-sessions`、`POST open-remote`、`POST new-remote`、`POST update-kimi`、`GET kimi-version`、`GET logo.png`。
- **运行时数据**：`~/.frostfin/`（kimi-sessions.json 绑定映射、kimi-session-prefs.json 档位记忆、model-catalog.json 模型缓存）——卸载插件时刻意保留，重装可续。

## 开发约定（代码风格）

- **注释与文档用中文**，标识符用英文。每个源文件开头有 `@module dsh-frostfin/<名>` 的文档块，说明职责与设计依据。
- **可逆性纪律**：一切注册走 `ctx.effect(..., 'frostfin.xxx()')`（带命名标签），卸载即撤销；文件系统副作用 Cordis 管不到，必须自己登记撤销（参考 `config-sync.ts` 摘除托管块、`preset-install.ts` 只删自己写的文件）。
- **照抄纪律**：生命周期与事件顺序照抄 DSH 原生实现并注明出处（如「顺序照抄 agent-loop 的构造函数」）。对照物在 `reference/deepseek-harness/packages/core/agent-loop/src/agent.ts`——事件顺序：step 内先 chunk、再 assistant/message、再 tool/call、再 tool/result，工具全终态后 step/end。
- **fail-closed**：审批桥接不上（approval 服务缺失/抛错/unavailable）一律回落 `cancelled`，绝不在拿不准时放行；提问通道跳过/取消按「用户未作答」处理，绝不伪造选择；读不到图片字节时放文本占位，绝不静默丢图。
- **服务访问**：`inject` 只声明必需服务（agents/sessions/subprocess）；其余一律 `ctx.get()` 延迟读取（代码注释称「postmortem 0001」教训）。类型面引用用 `import type {} from '...'` 让 Context 合并生效。
- **宿主模块解析**：含模块级私有 Symbol/WeakMap 的 dsh-* 包（dsh-scope 的 kScope、agent-loop）必须经 `host-scope.ts` 从宿主进程模块树解析，否则宿主读不到标记（曾导致「refusing to compose an unscoped context」）。
- **不在会话日志写自定义事件**：DSH 持久层拒读不带 `ignorable` 标记的未知事件（会让日志永远不可恢复）——绑定事实存插件自己的映射文件（`kimi-sessions.ts` 头部注释有详述）。
- **严格 TypeScript**：`strict: true`、`noImplicitAny: true`；可选字段用条件展开（`...x === undefined ? {} : { x }`）而非传 undefined，是仓库里的通行写法。
- **shell 安全**：远程 shim 作为单个 argv 元素经 ssh 逐字传递（无 shell 拼接）；tmux 会话名白名单化（`sanitizeSessionName`）。

## 测试说明

- 运行：`pnpm build && pnpm test`。全部**离线**：不依赖真 kimi、不碰网络、不写真实 `~/.frostfin`（每次测试用 `mkdtemp` 的独立 stateFile）。
- 两类测试：
  - **纯转译单测**（如 `translate.test.mjs`、`ssh-config.test.mjs`）：直接驱动 `lib/` 里的纯函数。
  - **端到端集成测试**（`integration/lifecycle/permission/question/commands/remote` 等）：经 `test/helpers.mjs` 的 `bootPlugin()` 装配真实 Cordis 服务 + frostfin 插件，子进程是 `test/fixtures/scripted-acp-child.mjs`——一个 script 化的 ACP agent（协议面与 kimi acp 一致：握手/prompt/流式 update/权限请求/cancel/load 回放；prompt 含 'boom' 模拟崩溃）。
- 写新测试时用 `helpers.mjs` 的现成件：`bootPlugin`（装配台，可注入假 approval/commands/webServer/persistence 服务）、`bootFrostfin`、`runOneTurn`、`fakeCommands`/`fakeWebServer`/`mockResponse` 等。测试环境默认关闭 `dispatchNative/installPreset/syncModels/primeCatalog`（不碰真实文件系统与影子 loop）。
- `scripts/probe-*.mjs` 与 `spike-*.mjs` 是**手工开发探针**（playwright 驱动真实 DSH 实例），不属于自动化测试套件，不要指望它们在无 DSH 环境运行。
- 浏览器实测（流式、审批弹窗、模态框、状态条）目前是手工质量基线的一部分，无自动化 E2E。

## 安全注意事项

- **凭据明文落盘（明示行为）**：`config-sync.ts` 把 DSH 侧模型供应商的 API key 明文写进 kimi 的 `config.toml` 托管块（`# >>> dsh-frostfin managed` 标记之间）——与 DSH 自己的 `.credentials.yaml` 同级，README 已声明。写前备份（`config.toml.frostfin.bak`），临时文件 + rename 原子写，内容不变不写盘，卸载自动摘除。
- **权限双轨**：frostfin 会话只需管 kimi 的权限模式（`/frostfin-mode <default|plan|auto|yolo>`）。yolo 模式下 kimi 访问敏感文件（.env、SSH 密钥、凭据）和 .git 控制目录仍会发问。插件配置 `permission: 'ask'` 时审批才桥到 DSH 弹窗，且桥不上时 fail-closed 拒绝。
- **DSH 侧陷阱**：输入区沙箱选择器对 kimi 是摆设（kimi 工具跑在自己进程里），但**绝不能切 danger-full-access**——它会把 approval policy 改成 never，往 kimi 对话注入英文通知，并在 ask 策略下让后续审批全部自动拒绝。
- **环境继承**：kimi 子进程显式继承父进程环境（`acp-process.ts` 注释有设计说明；subprocess 接缝默认会洗刷凭证形变量，显式传入的 env 在洗刷后合并）。
- **远程面**：ssh 主机信息永远来自用户自己的 `~/.ssh/config`（代码不内置任何真实主机）；远程服务器会留下 `frostfin-*` tmux 会话与 `/tmp/frostfin-*` fifo。
- **素材版权**：`assets/` 与文档中的《原神》素材版权归米哈游/HoYoverse，不在 MIT 覆盖范围，勿挪作他用。

## 部署（装进 DSH）

```sh
git clone https://github.com/pzc2004/dsh-frostfin.git
cd dsh-frostfin && pnpm install && pnpm build
npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-frostfin   # headless profile 同理
npx @deepseek-ai/dsh web    # 重启生效
```

安装时 `cordis.patch.yml` 生效：插入 frostfin 插件行、把「月芒霜鳍鲸」设为默认模式、禁用原生 agent-loop。package.json 的 `dsh.client.inject` 声明浏览器半身注入点。卸载（`dsh plugin --profile web remove dsh-frostfin`）自动撤销一切注册并摘除 kimi 配置托管块。前置条件：本机已装 Kimi Code 并 `/login`（登录态由 `kimi acp` 子进程直接复用）。

## 进一步阅读

- `README.md` / `README-en.md`：项目简介、功能清单、权限模式详解、安装步骤。
- `docs/guide.md`：完整用户手册（面板/远程/命令/FAQ）。
- `docs/design-v0.1.md`：M1-M3 时代设计稿（ACP→DSH 事件映射表等；M4+ 实现笔记在代码注释里）。
- `docs/upstream-kimi-acp.md`：对 kimi ACP 适配器的上游需求清单。
- `reference/deepseek-harness`：DSH 源码对照（本地参考，非依赖）；接口结论以其 rc.6 时代代码为准。
