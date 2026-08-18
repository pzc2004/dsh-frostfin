<p align="center"><img src="assets/logo.png" alt="月芒霜鳍鲸 logo" width="180"></p>

# dsh-frostfin（月芒霜鳍鲸）：Kimi Code as DSH Agent Loop

[English](README-en.md) | 中文

> 「受月矩力影响而发生变化的奇妙水生动物。」—— 提瓦特生物志

<p align="center"><img src="assets/frostfin-moonglow.gif" alt="月芒霜鳍鲸（Moonglow Frostfin Whale）" width="720"></p>

**Kimi Code 的大脑，DeepSeek Harness 的躯体。**

frostfin 是一个 DSH loop 插件：把 DSH 会话的驱动者整个换成 **Kimi Code 本人**——通过 ACP（Agent Client Protocol）直连，中间没有第二个 agent 转述。于是你同时拿到两样原本互斥的东西：

- **Kimi 侧**：Kimi Code 原装的 agent loop——为 kimi-for-coding 系列模型调优过的规划、工具编排与 thinking 模式，一个组件都不替换，版本照升；
- **DSH 侧**：DSH 的全部生态——Web UI、主题皮肤、会话管理、轨迹查看、社区插件，以及"一切皆插件、插件皆可逆"的 Cordis 底座。

两边的长处，一头的项目。

<!-- 截图占位：DSH Web UI 中 Kimi Code 流式回话 -->

## 名字的由来

**第一层：鲸与月。** DeepSeek 的图腾是鲸；月之暗面（Moonshot AI）的名字来自 Pink Floyd 的专辑《The Dark Side of the Moon》。这个插件做的事情，字面意思就是：让 DeepSeek 的鲸，被月亮的力量改造。

**第二层：霜鳍鲸是真实存在的。** 霜鳍鲸本种是《原神》挪德卡莱海域的一头鲸，6.0 版本「月之一」进入图鉴[^1][^2]，还在当月的主线过场里跃出过水面[^6]；2026 年 7 月的 6.7 版本「月之八」新增了它的月芒个体——**月芒霜鳍鲸**（Moonglow Frostfin Whale）[^3]，游戏内生物志标注其出现地点为月球地图「霜月」，图鉴写道：「受月矩力影响而发生变化的奇妙水生动物。」[^4]一头普通的水生动物，被月亮的力量改变——我们翻遍词典，找不到比这更精确的隐喻：**鲸还是那头鲸，海还是那片海——但潮汐从此归月亮管。**

**第三层：彩蛋是闭环的。** 月芒霜鳍鲸栖息的「霜月」地图，它的背面正是「月之暗面」区域——两者同属 6.7「月之八」，是同一个版本抵达的[^3][^5]。点亮「月之暗面」的地图时，跳出的成就叫「为你喜爱的色彩」（Any Colour You Like）[^5]——致敬的正是《The Dark Side of the Moon》专辑里的那首曲子。米哈游埋的梗，和月之暗面公司名字的出处，是同一张 1973 年的唱片。三条致敬链，在半个世纪前闭环。

<p align="center"><img src="assets/dark-side-of-the-moon.jpg" alt="月之暗面（霜月背面的区域）" width="640"></p>

<p align="center">
  <img src="assets/frostfin.gif" alt="霜鳍鲸" width="270">
  <img src="assets/frostfin-pink.gif" alt="粉色霜鳍鲸" width="270">
  <img src="assets/frostfin-moonglow.gif" alt="月芒霜鳍鲸" width="270"><br>
  <sub>霜鳍鲸（本种 · 挪德卡莱）｜ 粉色霜鳍鲸（异色个体）｜ 月芒霜鳍鲸（受月矩力影响 · 霜月）<br>形象来自《原神》游戏内生物志，版权属米哈游，仅作命名由来示意</sub>
</p>

图鉴里还有一句挪德卡莱的民话：**「凡是见到粉色霜鳍鲸的人，想要实现的愿望就能成真。」**[^4]愿每个装上这个插件的人，愿望成真。

**关于名字的精确性**：「受月矩力影响而变化」描述的是月芒个体而非本种——所以品牌全称定为**月芒霜鳍鲸**，也就是图鉴那句话真正的主人；包名 `dsh-frostfin` 沿用本种的家族名，短、可检索、生态位靠前。

<details>
<summary>落选的名字（都有各自的道理）</summary>

<p align="center"><img src="assets/moontide-sea.jpg" alt="月荡海（Moontide Sea）" width="640"></p>

- `dsh-moontide`（月潮）——月引潮汐、潮载鲸；后来才知道，6.7 的月球地图上真有一片海叫月荡海（Moontide Sea）[^5]
- `dsh-moonwhale`（月鲸）——两个吉祥物直接合体，最直白
- `dsh-moonsea`（月海）——月球暗面的真实天文学术语，最大气
</details>

[^1]: [生物志：霜鳍鲸 · B站原神 Wiki](https://wiki.biligame.com/ys/%E7%94%9F%E7%89%A9%E5%BF%97%EF%BC%9A%E9%9C%9C%E9%B3%8D%E9%B2%B8)（出现地点：挪德卡莱；实装版本：月之一）
[^2]: [「月之一」版本更新专题（官方公告全文）· B站原神 Wiki](https://wiki.biligame.com/ys/%E6%9C%88%E4%B9%8B%E4%B8%80%E7%89%88%E6%9C%AC%E3%80%8C%E3%80%8E%E7%A9%BA%E6%9C%88%E4%B9%8B%E6%AD%8C%C2%B7%E5%91%88%E7%A4%BA%E3%80%8F%E9%9B%AA%E6%B5%AA%E4%B8%8E%E8%8B%8D%E6%9E%97%E4%B9%8B%E8%88%9E%E3%80%8D%E6%9B%B4%E6%96%B0%E4%B8%93%E9%A2%98)（第 9 条：新增野生生物含「霜鳍鲸」）
[^3]: [「月之八」版本更新专题（官方公告全文）· B站原神 Wiki](https://wiki.biligame.com/ys/%E6%9C%88%E4%B9%8B%E5%85%AB%E7%89%88%E6%9C%AC%E3%80%8C%E3%80%8E%E7%A9%BA%E6%9C%88%E4%B9%8B%E6%AD%8C%C2%B7%E8%B0%90%E8%B0%9F%E3%80%8F%E6%98%A0%E5%A4%8F%EF%BC%81%E5%BD%92%E4%B9%A1%EF%BC%9F%E5%8D%83%E7%81%B5%E8%8A%82%EF%BC%81%E3%80%8D%E6%9B%B4%E6%96%B0%E4%B8%93%E9%A2%98)（第 8 条：新增野生生物「月芒霜鳍鲸」）
[^4]: [生物志：月芒霜鳍鲸 · B站原神 Wiki](https://wiki.biligame.com/ys/%E7%94%9F%E7%89%A9%E5%BF%97%EF%BC%9A%E6%9C%88%E8%8A%92%E9%9C%9C%E9%B3%8D%E9%B2%B8)（出现地点：霜月；实装版本：月之八；粉色霜鳍鲸民话出处）
[^5]: [成就集「无束的残月」 · B站原神 Wiki](https://wiki.biligame.com/ys/%E6%97%A0%E6%9D%9F%E7%9A%84%E6%AE%8B%E6%9C%88)（成就「为你喜爱的色彩」：点亮月之暗面的地图；同集多处成就文本出现「月荡海」）
[^6]: [主线任务「月亮升起的地方」 · B站原神 Wiki](https://wiki.biligame.com/ys/%E6%9C%88%E4%BA%AE%E5%8D%87%E8%B5%B7%E7%9A%84%E5%9C%B0%E6%96%B9)（过场文本："霜鳍鲸从水面下跃出"）

## 工作原理

```
你 ──► DSH Web UI（主题 / 生态 / 会话管理 / 审批）
          │  session events
    frostfin（DSH 插件，占 agent loop 插槽）
          │  ACP（JSON-RPC over stdio）
    kimi acp 子进程 ── 全部思考、工具调用、回话
```

DSH 的架构里 agent loop 本身就是一个可替换插件（`ctx.agents.setFactory`）。frostfin 注册自己的工厂，把每个 DSH 会话桥接到一个 `kimi acp` 子进程，并把 ACP 的事件流实时翻译成 DSH 的会话事件——所以打字机效果的流式回话、历史回放、审批弹窗，全部是 DSH 原生体验。

**和已有方案的区别**：kimi-tide 等项目把 Kimi 接在模型层或工具层——DSH 的主 loop 不变，Kimi 是被调用的客体；frostfin 把 loop 本身换成 Kimi Code——你在 DSH 里对话的对象**就是** kimi 本人。

## 功能

以下每一项都经过自动化测试（单测 + 端到端，不经真 kimi）与浏览器实测：

- **loop 桥**：DSH 会话由 kimi acp 子进程驱动——流式回话、思考块、工具调用、计划块全部是 DSH 原生渲染，turn/step 事件纪律与原生 loop 逐事件对齐
- **审批桥**：kimi 的工具审批请求落到 DSH 原生审批弹窗（生态首个）——弹窗的命令预览与工具卡片 callId 对齐，点"允许"就是放行那一次调用
- **提问通道**：kimi 的 AskUserQuestion 在 DSH 里弹出插件自建的多选模态框——ACP 没有提问 RPC，kimi 复用审批通道传问题，而 DSH 审批弹窗带不回"选了第几项"，故问题单开一路，与权限策略无关；跳过/取消按 kimi 语义的"用户未作答"处理，绝不伪造选择
- **图片输入**：输入区粘贴图片直达 kimi（DSH 附件存储读字节 → base64 → ACP image 块，kimi 侧自动做格式门控与压缩）；读不到字节时放文本占位，绝不静默丢图
- **会话生命周期**：DSH 重启恢复、kimi 进程崩溃自愈（下一个 prompt 自动重连）、接入任意既有 kimi 会话（`/frostfin-attach` 或「月芒霜鳍鲸」tab 一键接入，历史回放进 DSH 日志）；权限模式与 thinking 档位按 kimi 会话记忆，进程重启后自动重放
- **模式分发**：新增「月芒霜鳍鲸」模式并设为默认——它走 kimi，标准模式走原生 loop，互不干扰；会话创建后驱动方就锁定，不会静默换脑
- **模型层打通**：选择器显示 kimi 的真实模型列表，选择即切换；DSH 里配置的模型（如 DeepSeek）自动同步进 kimi 配置，kimi 直接能跑
- **状态条与斜杠命令**：输入框下方实时显示 kimi 的模型 / thinking 档位 / 权限模式 / 上下文占用 / 工作目录与 git 分支；`/frostfin-mode`、`/frostfin-thinking`、`/frostfin-plan`、`/yolo`、`/auto` 直接切换；kimi 内建的 `/compact` `/status` `/usage` `/mcp` `/tasks` `/help` 原样透传执行；命令菜单里插件命令带 `[frostfin]` 标签、kimi 命令带 `[kimi]` 标签，与 DSH 宿主命令一眼区分
- **goal 与 plan**：DSH 的 `/goal` 可直接驱动 kimi 会话（宿主层轮次驱动器，卡片可暂停/编辑/删除）；kimi 的 plan 模式经 `/frostfin-mode plan` 生效（引擎级只读，不是提示词约定）
- **可逆性**：卸载即撤销一切注册（含同步进 kimi `config.toml` 的托管块，你的 kimi 配置原样恢复）；`~/.frostfin/` 下的会话绑定与模型缓存刻意保留，重装可续——想彻底清除：`rm -rf ~/.frostfin`

## 权限模式看哪边

frostfin 会话里**只需要管 kimi 的权限模式**（`/frostfin-mode <default|plan|auto|yolo>`，快捷键 `/yolo`、`/auto`、`/frostfin-plan`）。DSH 侧的两个开关基本不用管，但各有一个例外：

- 输入区的「Workspace Write」沙箱选择器约束的是 DSH 原生工具的文件边界；kimi 的工具跑在 kimi 自己的进程里，DSH 沙箱管不到。**怎么选**：留在默认的 workspace-write 即可（read-only 同样无害，两者对 kimi 都是摆设）；**唯一要避开 danger-full-access**——它会把会话的 approval policy 改成 `never`，往 kimi 的对话里注入一条英文策略通知，且在插件配置 `permission: 'ask'` 时让后续所有审批被自动拒绝（弹窗不再出现）。
- DSH 的 approval policy（ask / never）只在插件配置 `permission: 'ask'` 时出现在应答链上。kimi 侧的精度：auto 模式全部自批（连 AskUserQuestion 都会被引擎拒绝）；yolo 模式绝大部分自批，但访问敏感文件（.env、SSH 密钥、凭据）和 .git 控制目录时**仍会发问**——这两条 ask 策略排在 yolo 自批之前。

同理，DSH 的 `/plan` 只对原生 loop 会话有效（提示词约定）；kimi 会话的 plan 模式请用 `/frostfin-plan`——引擎级只读：plan 模式下 kimi 的权限策略链直接拒绝 Write/Edit 等变更工具（计划文件除外），不依赖模型自觉。

**怎么选**：

- **日常开发：`/yolo`**——绝大多数工具自批，只有碰 .env、SSH 密钥、凭据、.git 控制目录时才打断你。摩擦最低且留着安全兜底；模式按会话持久化，设一次就一直有效（含 DSH 重启后）。
- **想逐步审阅：`default`**——每个变更工具都弹窗。注意 DSH 弹窗只有"允许/拒绝"，给不了 kimi 的"本会话允许"，所以同类工具会逐次问；嫌烦就回 yolo。
- **只要方案不动手：`/frostfin-plan`**——引擎级只读，计划写完交你审。
- **无人值守：`/auto`**——全部自批，连提问工具都会被拒（它不会来烦你），配合 DSH 的 `/goal` 跑长任务最合适；别把敏感目录暴露给它。

## 安装

### 1. 安装 Kimi Code 并登录

macOS / Linux（官方脚本，无需 Node.js）：

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

Windows（PowerShell；首次启动前需安装 [Git for Windows](https://gitforwindows.org/)，kimi 以自带的 Git Bash 作为 shell 环境）：

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

装完运行一次 `kimi`，在 TUI 里用 `/login` 登录（Kimi Code OAuth 或 Moonshot 开放平台 API key）。frostfin 通过 `kimi acp` 子进程驱动，登录态直接复用，无需额外配置。

### 2. 安装 DSH

需要 Node.js ≥ 22.19：

```sh
npx @deepseek-ai/dsh web   # Web UI 默认在 http://127.0.0.1:3080
```

对锁版本 `@deepseek-ai/dsh@0.1.0-rc.x`（见「状态」一节）。

### 3. 安装本插件

```sh
# 克隆并构建
git clone https://github.com/pzc2004/dsh-frostfin.git
cd dsh-frostfin && pnpm install && pnpm build

# 装进 DSH 的 web profile
npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-frostfin

# 重启 dsh web 生效
npx @deepseek-ai/dsh web
```

装好后：新模式「月芒霜鳍鲸」自动成为默认模式；会话视图环多出「月芒霜鳍鲸」tab（kimi 会话列表，一键接入）；无需任何模型配置——DSH 的模型门禁由名义路由喂饱。**完整功能手册（面板/远程/命令/权限模式/FAQ）见 [docs/guide.md](docs/guide.md)。**

**headless 也想要**：`npx @deepseek-ai/dsh plugin --profile headless add /path/to/dsh-frostfin`

**卸载**：`npx @deepseek-ai/dsh plugin --profile web remove dsh-frostfin`——卸载会自动撤销一切注册，并把同步进 kimi `config.toml` 的托管块摘除（你的 kimi 配置原样恢复）。`~/.frostfin/` 下的会话绑定与模型缓存会保留以便重装续聊；想彻底清除再 `rm -rf ~/.frostfin`。

## 平台支持

在 macOS 上完整开发与验证。Linux 应无差别（POSIX 语义主场）。**Windows 未验证**：已知前置是 kimi Code 本身需要 Git Bash（`KIMI_SHELL_PATH` 可指定），其余风险点（进程终止语义、宿主模块解析）待实测——欢迎 Windows 用户反馈。

## 路线图

- ~~远程 kimi 会话接入~~（**已落地**）：服务器上的 Kimi Code 会话已纳入本地 DSH 管理——读 `~/.ssh/config` 列出主机（VS Code 同款语义），一键连接即经 ssh+tmux 拉起远程 `kimi acp`（断线或本地关闭都不杀远程进程，重连原会话直接续）；远程会话按 主机 → 工作区 → 会话 三级展示、一键接入。前置：服务器装有 tmux 与 kimi 并完成 `/login`（缺失时面板会给出明确指引）。
- **后续候选**：ControlMaster 连接复用、远程状态进状态条、kimi ACP 与 DSH 的上游诉求（见 [docs/upstream-kimi-acp.md](docs/upstream-kimi-acp.md) 与 [docs/upstream-dsh.md](docs/upstream-dsh.md)）。

## 状态

可用但早期。质量基线：58 个自动化测试（纯转译单测 + 驱动 script 化 ACP 子进程的端到端，不经真 kimi）+ 浏览器实测（流式回话、审批弹窗、提问模态框、图片理解、状态条、斜杠命令）。对锁 `@deepseek-ai/dsh@0.1.0-rc.6` 与 kimi Code 0.36.x——两边都在快速迭代，升级请当作主动动作。设计稿见 [docs/design-v0.1.md](docs/design-v0.1.md)（M1-M3 时代写成，M4+ 的实现笔记在代码注释里）。

## License

代码以 [MIT](LICENSE) 发布。`assets/` 与本文档中的《原神》相关素材（图鉴形象、地图与区域照片；logo 为基于游戏形象的二次创作）版权归米哈游 / HoYoverse 所有，仅作命名由来示意，不在 MIT 覆盖范围内。
