/**
 * FrostfinAgentFactory：DSH 的 AgentFactory 实现，替换 agent-loop 占住 loop 插槽。
 * 创建/恢复事务的顺序照抄 `deepseek-harness/packages/core/agent-loop/src/index.ts`：
 * 准备 session → 构造 agent →（仅 resume）启动 kimi 进程并 session/load 吞回放
 * → await setup → 进注册表（session 先、agent 后）→ 宣告 → agent/session-start。
 * 任一步失败按相反序拆除，不发布半个生命周期。
 * 新建会话不起进程（惰性启动）：首个 prompt 才 spawn + 握手 + 登记绑定。
 *
 * @module dsh-frostfin/factory
 */

import type { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type { AgentFactory, AgentHandle, AgentOptions, AgentSetup, CreateAgentOptions, ResumeAgentOptions, SessionStartSource } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { startAcpProcess, type AcpProcess } from './acp-process.js'
import { FrostfinAgent } from './agent.js'
// 类型面引用：让 Context 合并（ctx.get('sessionPersistence')）生效。
import type {} from '@deepseek-ai/dsh-session-persistence'
import { resolveHostScope, type DshScopeModule } from './host-scope.js'
import type { Config } from './index.js'
import type { KimiSessionMap, KimiSessionPrefs } from './kimi-sessions.js'
import type { KimiModelCatalog } from './kimi-route.js'
import { createPermissionBridge } from './permission.js'
import type { QuestionRegistry } from './question.js'
import { remoteTransport, sanitizeSessionName } from './remote.js'
import { loadSshHosts, type SshHostEntry } from './ssh-config.js'
import { FROSTFIN_PRESET_ID } from './preset-install.js'
import { frostfinRouteSeed } from './kimi-route.js'

/** setupSpawnAndPublish 的归一包：create/resume 两条路径的差异已各自解析完。 */
interface PublishPlan {
  readonly sessionId: SessionId
  readonly agentOptions: AgentOptions
  readonly setup: AgentSetup | undefined
  readonly signal: AbortSignal | undefined
  /** resume 路径的既有绑定；新建会话为 undefined（握手后登记新 id）。 */
  readonly kimiSessionId: string | undefined
  /** 远程线：会话的远程 ssh 主机；本地会话为 undefined。 */
  readonly remoteHost: SshHostEntry | undefined
  readonly source: SessionStartSource
}

/** 工厂级属主：跟踪全部存活 agent 的拆卸闭包，插件卸载时统一停掉。 */
export class FrostfinAgentFactory implements AgentFactory {
  private readonly live = new Set<() => Promise<void>>()
  /** 宿主同款的 dsh-scope（kScope 符号必须与宿主同一份，见 host-scope.ts）。 */
  private readonly hostScope: Promise<DshScopeModule>
  /**
   * 影子挂载捕获的原生工厂（M4 分发）；未设置时所有会话都走 kimi 路径。
   * Promise 形态：影子纤维等依赖就绪后才完成自注册。
   */
  private nativeFactory: Promise<AgentFactory> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly kimiMap: KimiSessionMap,
    private readonly catalog: KimiModelCatalog,
    private readonly prefs?: KimiSessionPrefs,
  ) {
    this.hostScope = resolveHostScope(ctx.logger('frostfin'))
  }

  /** 接线影子挂载捕获的原生工厂（index.ts 在 apply 时调用）。 */
  setNativeFactory(factory: Promise<AgentFactory>): void {
    this.nativeFactory = factory
  }

  /**
   * 分发规则：preset 是「月芒霜鳍鲸」（frostfin）或未指明（headless/CLI 路径）
   * → kimi 驱动；其他 preset → 影子里的原生 loop。
   */
  private routesToKimi(options: CreateAgentOptions): boolean {
    const preset = (options.meta as { agentPreset?: string } | undefined)?.agentPreset
    return preset === undefined || preset === FROSTFIN_PRESET_ID
  }

  /** 取原生工厂；未挂载或未就绪时给清晰错误。 */
  private async native(): Promise<AgentFactory> {
    if (this.nativeFactory === undefined) {
      throw new Error('frostfin: 原生 loop 未挂载（dispatchNative 被关闭），该 preset 的会话无法创建')
    }
    return await this.nativeFactory
  }

  /** 同步触发器（index.ts 注入）：真正起 kimi 进程前刷新 kimi 配置。 */
  private syncTrigger: (() => void) | undefined

  /** 接线模型配置同步触发器。 */
  setSyncTrigger(trigger: () => void): void {
    this.syncTrigger = trigger
  }

  /** M7 待答问题注册表（index.ts 注入）：AskUserQuestion 的插件自建 UI 通道。 */
  private questions: QuestionRegistry | undefined

  /** 接线待答问题注册表。 */
  setQuestionRegistry(questions: QuestionRegistry): void {
    this.questions = questions
  }

  /** 按别名解析 ssh 主机（读 ~/.ssh/config 或其 Config 指向的文件）；找不到给清晰错误。 */
  private resolveHost(alias: string): SshHostEntry {
    const found = loadSshHosts(this.config.sshConfigFile).find(host => host.alias === alias)
    if (found === undefined) {
      throw new Error(`frostfin: ssh 配置里找不到主机 "${alias}"（${this.config.sshConfigFile} 中没有对应 Host 块）`)
    }
    return found
  }

  /** 体检过的主机与其 kimi 路径（每 DSH 进程缓存；失败不缓存——装好后下次即过）。 */
  private readonly remoteHealth = new Map<string, string | undefined>()

  /**
   * 首次连接某主机前体检（ssh 认证 → tmux → kimi 路径解析），失败抛带人话的错。
   * @returns 解析出的 kimi 绝对路径（PATH 裸名可用时为 undefined）。
   */
  private async checkRemoteCached(host: SshHostEntry): Promise<string | undefined> {
    if (!this.remoteHealth.has(host.alias)) {
      const health = await remoteTransport.check(host, this.config.sshCommand)
      if (!health.ok) throw new Error(`frostfin: ${health.detail}`)
      this.remoteHealth.set(host.alias, health.kimiPath)
    }
    return this.remoteHealth.get(host.alias)
  }

  /**
   * 在一个调用方给的会话 id 上创建 agent 及其 kimi acp 进程。
   * @param ownerCtx - 拥有本次事务与存活句柄的调用方上下文。
   * @param options - 会话身份、元数据、agent 选项与可选 setup。
   * @returns 发布完成的句柄。
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    // M4 分发：非 frostfin preset 的会话委托给影子里的原生 loop。
    if (!this.routesToKimi(options)) {
      const native = await this.native()
      return native.createAgent(ownerCtx, options)
    }
    const session = this.ctx.sessions.prepare(options.sessionId, {
      // 新建 frostfin 会话自带路由种子（调用方给了种子——如 fork——则尊重之）。
      seed: options.seed ?? frostfinRouteSeed(),
      ...options.meta === undefined ? {} : { meta: options.meta },
    })
    // 远程线：meta.frostfinHost 标记远程会话（面板/命令接入远程 kimi 时给出）。
    const hostAlias = (options.meta as { frostfinHost?: string } | undefined)?.frostfinHost
    return this.setupSpawnAndPublish(ownerCtx, session, {
      sessionId: options.sessionId,
      agentOptions: options.agentOptions ?? {},
      setup: options.setup,
      signal: options.signal,
      kimiSessionId: undefined,
      remoteHost: hostAlias === undefined ? undefined : this.resolveHost(hostAlias),
      source: 'startup',
    })
  }

  /**
   * 恢复一个 frostfin 驱动过的持久化会话：从映射文件取出 kimi 会话 id，
   * spawn 新进程后 `session/load` 重连（回放吞掉——DSH 日志里已有历史）。
   * @param ownerCtx - 调用方上下文。
   * @param options - 持久化会话身份、agent 选项与可选 setup。
   * @returns 发布完成的句柄。
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    // M4 分发：没有 kimi 绑定的会话默认委托原生 loop 恢复——但 frostfin preset 的
    // 会话绑定丢失（映射被清/kimi 会话被删）时给明确错误，不静默换驱动。
    const kimiSessionId = this.kimiMap.get(options.resumeSessionId)
    if (kimiSessionId === undefined && this.nativeFactory !== undefined) {
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence !== undefined) {
        const preparation = await persistence.prepare(options.resumeSessionId, options.signal)
        try {
          const session = preparation.session
          let preset = session.header.agentPreset
          for (let index = session.events.length - 1; index >= 0 && preset === undefined; index -= 1) {
            const event = session.events[index]
            if (event?.type === 'agent-preset/selected') preset = (event.data as { agentPreset: string }).agentPreset
          }
          if (preset === FROSTFIN_PRESET_ID) {
            throw new Error(
              `frostfin: 会话 "${options.resumeSessionId}" 由 kimi 驱动过，但绑定记录已丢失或其 kimi 会话已被删除，无法恢复。`
              + '请新建会话，或从「月芒霜鳍鲸」面板重新接入一个 kimi 会话。',
            )
          }
        } finally {
          preparation[Symbol.dispose]()
        }
      }
      const native = await this.native()
      return native.resume(ownerCtx, options)
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    if (kimiSessionId === undefined) {
      throw new Error(`frostfin: 会话 "${options.resumeSessionId}" 没有 kimi 会话绑定记录——只有 frostfin 驱动过的会话才能 resume`)
    }
    const preparation = await persistence.prepare(options.resumeSessionId, options.signal)
    try {
      // 远程线：绑定里记着主机别名就按远程恢复（别名失效给清晰错误）。
      const hostAlias = this.kimiMap.getHost(options.resumeSessionId)
      return await this.setupSpawnAndPublish(ownerCtx, preparation.session, {
        sessionId: options.resumeSessionId,
        agentOptions: options.agentOptions ?? {},
        setup: options.setup,
        signal: options.signal,
        kimiSessionId,
        remoteHost: hostAlias === undefined ? undefined : this.resolveHost(hostAlias),
        source: 'resume',
      })
    } finally {
      preparation[Symbol.dispose]()
    }
  }

  /** 启动一个 kimi acp 进程（新建握手）；agent 的进程重连也走这里。 */
  private async startProcess(agent: FrostfinAgent): Promise<AcpProcess> {
    // 起进程前刷新 kimi 配置（DSH 模型同步只在内容变化时写盘）。
    this.syncTrigger?.()
    const logger = this.ctx.logger('frostfin')
    let command = this.config.command
    let args = this.config.args
    // 远程线：远程会话改走 ssh+tmux 的 shim 通道（先体检；tmux 会话名按 DSH
    // 会话 id 稳定——重连复挂同一个活着的 pane，kimi 进程状态不丢）。
    // 会话名带传输版本（v2=fifo 中继）：传输形态变更时绝不错挂旧形 pane
    //（旧 pane 的输入管道不同，写上去了无人读——线上排障实录）。
    const remote = agent.remoteHost
    if (remote !== undefined) {
      // 体检 + kimi 路径解析：非交互 ssh 的 PATH 常缺交互式配置，
      // 默认安装位（~/.kimi-code/bin）解析出绝对路径优先于裸名。
      const kimiPath = await this.checkRemoteCached(remote)
      // 只在 command 是默认裸名 'kimi' 时用解析出的绝对路径（显式自定义的命令优先——
      // 测试拿它指向夹具）。
      const kimiCommand = kimiPath !== undefined && this.config.command === 'kimi' ? kimiPath : this.config.command
      const argv = remoteTransport.buildArgv(remote, sanitizeSessionName(`frostfin-v2-${agent.id}`), `${kimiCommand} ${this.config.args.join(' ')}`, this.config.sshCommand)
      command = argv[0]!
      args = argv.slice(1)
    }
    let proc: AcpProcess | undefined
    proc = await startAcpProcess({
      command,
      args,
      // 远程会话：spawn 的 cwd 必须本地存在（用宿主 cwd），ACP 会话的 cwd 走
      // sessionCwd（会话 header.cwd 本就是远程路径）。本地会话两者一致。
      cwd: remote !== undefined ? process.cwd() : (agent.session.header.cwd ?? process.cwd()),
      sessionCwd: agent.session.header.cwd ?? process.cwd(),
      permission: this.config.permission,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spec => this.ctx.subprocess.spawn(spec),
      onSessionUpdate: update => { agent.handleSessionUpdate(update) },
      // M2 审批桥常装：普通审批在 ask 策略下桥到 ctx.approval（其他策略桥内交还
      // 自动应答）；M7 的 AskUserQuestion 与策略无关，总进插件自建 UI 通道。
      onRequestPermission: createPermissionBridge({
        agent,
        ctx: this.ctx,
        signal: () => agent.approvalSignal(),
        logger,
        questions: this.questions,
        ask: this.config.permission === 'ask',
      }),
      onExit: (outcome) => {
        // 非 dispose 发起的进程退出：标记死亡（下一个 prompt 触发重连），
        // 悬挂的审批按取消处理。
        logger.warn(
          `agent "${agent.id}" 的 kimi acp 进程退出（code=${String(outcome.exitCode)} signal=${String(outcome.signal)}）`,
        )
        agent.handleProcessExit(proc!)
      },
      onError: (error) => { logger.warn(`agent "${agent.id}" 的 kimi acp 进程异常：${error.message}`) },
    })
    return proc
  }

  /** 构造 agent、起进程、（resume 时）重连上下文、setup、发布——create/resume 共用的事务。 */
  private async setupSpawnAndPublish(
    ownerCtx: Context,
    session: Session,
    plan: PublishPlan,
  ): Promise<AgentHandle> {
    if (plan.signal?.aborted) {
      throw new Error(`agent "${plan.sessionId}" creation aborted`, { cause: plan.signal.reason })
    }
    const agent = new FrostfinAgent(this.ctx, plan.sessionId, plan.agentOptions, session, {
      connect: (): Promise<AcpProcess> => this.startProcess(agent),
      onBind: (kimiSessionId) => { this.kimiMap.set(plan.sessionId, kimiSessionId, plan.remoteHost?.alias) },
      publishCatalog: (options) => { this.catalog.publish(options) },
      scopeModule: await this.hostScope,
      prefs: this.prefs,
      ...plan.kimiSessionId === undefined ? {} : { kimiSessionId: plan.kimiSessionId },
      ...plan.remoteHost === undefined ? {} : { remoteHost: plan.remoteHost },
    })

    let acp: AcpProcess | undefined
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let unfollowOwner: (() => Promise<void> | void) | undefined
    let disposing: Promise<void> | undefined
    // 反向拆卸（记忆化，竞争的属主等待同一份静止）：
    // 停驱动 → 关 kimi 进程 → 撤销 scope → 出注册表 → 解簿记。
    const dispose = (ownerTriggered = false): Promise<void> => (disposing ??= (async () => {
      agent.cancel({ kind: 'disposed' })
      agent.abortLifetime()
      await agent.whenIdle()
      // 拆的是 agent 当前持有的进程（自愈重连后可能已不是创建时的那个）。
      await agent.disposeProcess()
      try {
        await agent.scope.dispose()
      } finally {
        try {
          detachAgent?.()
          detachSession?.()
        } finally {
          this.live.delete(dispose)
          if (!ownerTriggered) await unfollowOwner?.()
        }
      }
    })())

    try {
      if (plan.kimiSessionId === undefined) {
        // 新建会话：惰性启动——创建时不起 kimi 进程（kimi 未登录/未装不该挡住
        // 开会话）。首个 prompt 时由 agent 的 ensureProcess 起进程、握手并登记
        // 绑定；环境问题在发送时以对话内指引的形式浮现。
      } else {
        acp = await this.startProcess(agent)
        agent.attachProcess(acp)
        // resume：load 既有 kimi 会话，吞掉回放（DSH 日志里已有历史）。
        try {
          await agent.restoreKimiContext()
        } catch (error: unknown) {
          throw new Error(
            `frostfin: kimi 会话 "${plan.kimiSessionId}" 恢复失败（不存在或已被删除）：${errorChain(error)}`,
            { cause: error },
          )
        }
      }
      // M1 简化：spawn 与 setup 的等待不熔断 caller signal，只在边界上检查。
      ownerCtx.fiber.assertActive()
      await plan.setup?.(agent.ctx)
      if (plan.signal?.aborted) {
        throw new Error(`agent "${plan.sessionId}" creation aborted`, { cause: plan.signal.reason })
      }
      ownerCtx.fiber.assertActive()

      // 发布：先进注册表（拿到 detach 能力），再宣告，最后 session-start。
      detachSession = agent.ctx.sessions.enter(session)
      detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent)
      unfollowOwner = ownerCtx.effect(() => () => {
        // 属主卸载与句柄拆卸共享同一份静止边界。
        if (disposing !== undefined) return
        return dispose(true)
      }, `frostfin.lifecycle(${plan.sessionId})`)
      this.live.add(dispose)
      agent.ctx.sessions.announce(session)
      this.ctx.agents.announce(agent)
      emitAgentEvent(this.ctx, agent, 'agent/session-start', { source: plan.source })
      return { agent, dispose }
    } catch (error: unknown) {
      // 回滚：dispose 是幂等记忆化的，未发布的 detach/unfollow 是 undefined，安全。
      await dispose()
      throw error
    }
  }

  /** 插件卸载边界：停掉本工厂创建的全部存活 agent。 */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.live].map(dispose => dispose()))
  }
}
