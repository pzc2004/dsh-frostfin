/**
 * FrostfinAgent：一个 DSH 会话 ↔ 一个 `kimi acp` 子进程 ↔ 一个 ACP 会话。
 *
 * 驱动纪律参照 `deepseek-harness/packages/core/agent-loop/src/agent.ts`，
 * 但"模型调用"换成一次 ACP `session/prompt`：
 * 每条唤醒输入开一个 turn；turn 内首个 step 由转译器 begin() 开启，
 * user/message 紧随其后；ACP session/update 经 translate.ts 纯转译成
 * chunk / assistant/message / tool/call / tool/result / step 边界；
 * prompt 的 stopReason 映射为 turn/end 原因。
 *
 * M3 新增生命周期能力：
 * - kimi 进程死亡后的自动重连（重 spawn + session/load 吞回放）；
 * - `restoreKimiContext()`：resume 时的 load 吞回放；
 * - `attachKimiSession()`：接入既有 kimi 会话，回放按 turn/step 纪律落盘。
 *
 * @module dsh-frostfin/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, errorChain } from '@deepseek-ai/dsh-llm'
import { createScope as createScopeFallback, type Scope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type { PromptResponse, SessionConfigOption, SessionInfo as AcpSessionInfo, SessionUpdate } from '@agentclientprotocol/sdk'
// 类型面引用：让 Context 合并（ctx.get('agentDefaultModel')）生效。
import type {} from '@deepseek-ai/dsh-agent-default-model'
// 类型面引用：让 Context 合并（ctx.get('attachments')，图片附件字节）生效。
import type {} from '@deepseek-ai/dsh-attachment'
import type { AcpProcess } from './acp-process.js'
import type { DshScopeModule } from './host-scope.js'
import { flattenSelectOptions, KIMI_MODEL, KIMI_PROVIDER } from './kimi-route.js'
import type { KimiSessionPrefs } from './kimi-sessions.js'
import type { SshHostEntry } from './ssh-config.js'
import {
  acpStopReason,
  createTranslator,
  toAcpPrompt,
  translateReplay,
  type TranslatedEvent,
  type Translator,
} from './translate.js'

/** Agent 的生命周期相位：idle / 维护任务 / 驱动中。 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'maintenance'; abort: AbortController; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; wakeRequested: boolean }

/** kimi 侧状态快照（状态条端点读取）。 */
export interface KimiStatus {
  model?: string
  /** 模型的显示名（如 "Kimi K3"，来自 configOptions 选项名）。 */
  modelName?: string
  mode?: string
  thinking?: string
  used?: number
  size?: number
  alive: boolean
  cwd?: string
  /** 远程线：远程主机的别名（本地会话为 undefined）。 */
  host?: string
  /** 远程线：ssh 配置里的登录用户（状态条拼 user@host 用；未配置为 undefined）。 */
  hostUser?: string
  /** 是否已绑定 kimi 会话（状态条据此决定未连接时能否自动重连：无绑定保持惰性启动）。 */
  bound: boolean
}

/** 读取取消信号携带的原因（cancel(cause) 中止时一定带原因）。 */
function cancelCauseOf(signal: AbortSignal): AgentCancelCause {
  const reason: unknown = signal.reason
  if (reason !== null && typeof reason === 'object' && 'kind' in reason) {
    return reason as AgentCancelCause
  }
  return { kind: 'user' }
}

/** FrostfinAgent 的构造依赖（由 factory 装配，保持依赖单向）。 */
export interface FrostfinAgentDeps {
  /** 启动一个新 kimi acp 进程并完成握手（不 load 任何既有会话）。 */
  connect: () => Promise<AcpProcess>
  /** kimi 会话绑定的登记出口（写入持久化映射）。 */
  onBind: (kimiSessionId: string) => void
  /**
   * 宿主同款的 createScope（factory 经 host-scope 解析后注入）；
   * 缺省时用本包拷贝——仅测试/非宿主环境安全。
   */
  scopeModule?: DshScopeModule
  /** kimi 会话握手后上报真实模型目录的出口（DSH 模型选择器的数据源）。 */
  publishCatalog?: (options: readonly SessionConfigOption[]) => void
  /** resume 路径传入的既有绑定；新建会话为 undefined。 */
  kimiSessionId?: string
  /** kimi 会话运行档位（模式/thinking）的持久化存储；缺省时重连不重放。 */
  prefs?: KimiSessionPrefs
  /** 远程线：会话的远程 ssh 主机（本地会话为 undefined）。 */
  remoteHost?: SshHostEntry
}

/**
 * 一个 turn 的落盘器：把转译产物按序写进会话日志，回填
 * assistant/message 与 tool/result 的 sourceEventSeqs。
 * live（runTurn）与回放（attachKimiSession）两条路径共用。
 */
function createSessionCommitter(session: Session): (event: TranslatedEvent) => void {
  const chunkSeqs: number[] = []
  const callSeqs = new Map<string, number>()
  return (event: TranslatedEvent): void => {
    switch (event.type) {
      case 'turn/start':
        session.append('turn/start', { turn: event.turn })
        break
      case 'step/start':
        session.append('step/start', { turn: event.turn, step: event.step })
        break
      case 'step/end':
        session.append('step/end', { turn: event.turn, step: event.step })
        break
      case 'user/message':
        session.append('user/message', event.message, { surfaceOp: 'append' })
        break
      case 'assistant/chunk': {
        const appended = session.append('assistant/chunk', { turn: event.turn, step: event.step, chunk: event.chunk })
        if (event.accumulate) chunkSeqs.push(appended.seq)
        break
      }
      case 'assistant/message':
        session.append('assistant/message', {
          turn: event.turn,
          step: event.step,
          message: event.message,
        }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs.splice(0) })
        break
      case 'tool/call': {
        const appended = session.append('tool/call', {
          turn: event.turn,
          step: event.step,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
        })
        callSeqs.set(event.callId, appended.seq)
        break
      }
      case 'tool/result': {
        // 转译器保证每条 result 都有同 step 的 call 先行（未知 id 会先合成 call）。
        const callSeq = callSeqs.get(event.callId)
        if (callSeq === undefined) throw new Error(`frostfin: tool/result 找不到先行 tool/call（${event.callId}）`)
        session.append('tool/result', {
          turn: event.turn,
          step: event.step,
          message: event.message,
          ...event.error === undefined ? {} : { error: event.error },
        }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
        break
      }
      case 'turn/end':
        session.append('turn/end', { turn: event.turn, reason: event.reason })
        break
    }
  }
}

/** 一个 DSH Agent：把会话的输入驱动给 kimi acp，并把 ACP 流回译进会话日志。 */
export class FrostfinAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase = { kind: 'idle' }
  private activityDone: Promise<void> = Promise.resolve()

  /** agent 级注册边界；生命周期属主在驱动退出后撤销它。 */
  readonly scope: Scope
  readonly ctx: Context

  /** 融合 dispatcher，构造一次，热路径不再分配。 */
  private readonly dispatch: AgentEventDispatch

  /** kimi acp 进程句柄（attachProcess 后可用）。 */
  private acp: AcpProcess | undefined
  /** 当前 turn 的转译器与落盘器；sessionUpdate 回调的路由目标。 */
  private activeTranslator: Translator | undefined
  private activeCommit: ((event: TranslatedEvent) => void) | undefined
  /** 当前 turn 的取消信号（M2 审批桥跟随）；无活动 turn 时为 undefined。 */
  private activeTurnSignal: AbortSignal | undefined
  /** agent 寿命信号：dispose 时中止悬挂的审批等待。 */
  private readonly lifetimeAbort = new AbortController()
  /** 当前 kimi 进程的死亡信号：进程退出时中止悬挂的审批等待；重连后重置。 */
  private processAbort = new AbortController()
  /** kimi 进程是否已退出（等下一个 prompt 触发重连）。 */
  private processDead = false
  /** 进行中的重连（并发 prompt 共享同一次重连）。 */
  private reconnecting: Promise<boolean> | undefined
  /** 绑定的 kimi 会话 id（重连与 resume 的锚点）。 */
  private kimiSessionId: string | undefined
  /** 最近一次起进程/握手失败的原因（惰性启动后把根因带进 turn 错误）。 */
  private lastConnectError: unknown
  /** attach 收集回放的槽；非 undefined 时 sessionUpdate 全部进收集器。 */
  private replayCollector: SessionUpdate[] | undefined
  /** 最近一次 usage_update（上下文占用）。 */
  private lastUsage: { used: number; size: number } | undefined
  /** config_option_update 推送的最新选择器快照（覆盖进程握手时的）。 */
  private liveConfigOptions: SessionConfigOption[] | undefined
  private lastTurn: number

  constructor(
    private readonly pluginCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    private readonly deps: FrostfinAgentDeps,
  ) {
    this.dispatch = agentEvents(pluginCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    // 续接已有日志时从最后的 turn/start 恢复计数（resume 路径靠它接着编号）。
    let lastTurn = 0
    for (const event of session.events) {
      if (event.type === 'turn/start') lastTurn = event.data.turn
    }
    this.lastTurn = lastTurn
    this.kimiSessionId = deps.kimiSessionId
    // 优先用宿主同款的 createScope（符号一致）；测试环境缺省时用本包拷贝。
    const createScope = deps.scopeModule?.createScope ?? createScopeFallback
    this.scope = createScope(pluginCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  /** 提交相位并发布外部可见的状态跃迁。 */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  /** 挂接已握手的 kimi acp 进程（创建事务里调用一次）。 */
  attachProcess(acp: AcpProcess): void {
    this.acp = acp
  }

  /** 远程线：会话的远程 ssh 主机（本地会话为 undefined）。 */
  get remoteHost(): SshHostEntry | undefined {
    return this.deps.remoteHost
  }

  /** 登记新 kimi 会话的绑定（新建会话握手成功后调用一次）。 */
  bindKimiSession(kimiSessionId: string): void {
    this.kimiSessionId = kimiSessionId
    this.deps.onBind(kimiSessionId)
  }

  /** 当前绑定的 kimi 会话 id（诊断与测试用）。 */
  get boundKimiSessionId(): string | undefined {
    return this.kimiSessionId
  }

  /** M2 审批桥应跟随的信号：寿命信号 ⊗ 进程信号 ⊗（进行中的）turn 信号。 */
  approvalSignal(): AbortSignal {
    const parts = [this.lifetimeAbort.signal, this.processAbort.signal]
    if (this.activeTurnSignal !== undefined) parts.push(this.activeTurnSignal)
    return AbortSignal.any(parts)
  }

  /** 寿命终点：dispose 流程里中止一切悬挂的审批等待。 */
  abortLifetime(): void {
    if (!this.lifetimeAbort.signal.aborted) {
      this.lifetimeAbort.abort(new Error(`agent "${this.id}" 的 kimi acp 生命周期结束`))
    }
  }

  /** 拆卸当前 kimi 进程（重连后是最新的那个；dispose 流程的进程拆除环节）。 */
  async disposeProcess(): Promise<void> {
    await this.acp?.dispose()
  }

  /** kimi 进程退出（非 dispose 发起）：标记死亡、中止悬挂审批；下一个 prompt 触发重连。 */
  handleProcessExit(proc: AcpProcess): void {
    // 旧进程的迟到通知不能误伤重连后的新进程。
    if (this.acp !== proc) return
    this.processDead = true
    if (!this.processAbort.signal.aborted) {
      this.processAbort.abort(new Error(`agent "${this.id}" 的 kimi acp 进程退出`))
    }
  }

  /** ACP `session/update` 入口：回放收集优先，其次路由给当前 turn 的转译器。 */
  handleSessionUpdate(update: SessionUpdate): void {
    // 状态条数据：usage_update（上下文占用）与 config_option_update（模型/模式/思考联动）。
    if (update.sessionUpdate === 'usage_update') {
      this.lastUsage = { used: update.used, size: update.size }
    } else if (update.sessionUpdate === 'config_option_update') {
      this.liveConfigOptions = update.configOptions
    }
    if (this.replayCollector !== undefined) {
      this.replayCollector.push(update)
      return
    }
    const translator = this.activeTranslator
    const commit = this.activeCommit
    // 没有活动 turn 的更新（resume/重连的吞回放路径）直接丢弃。
    if (translator === undefined || commit === undefined) return
    for (const event of translator.push(update)) commit(event)
  }

  /**
   * 切换 kimi 的权限模式（default/plan/auto/yolo）。
   * 透传 ACP `session/set_config_option`（configId='mode'），成功后记入档位存储
   * （kimi 不持久化模式——进程重启即归零，靠我们在重连后重放）。
   */
  async setKimiMode(mode: string): Promise<void> {
    const acp = await this.ensureProcess()
    await acp.setConfigOption('mode', mode)
    if (this.kimiSessionId !== undefined) this.deps.prefs?.set(this.kimiSessionId, { mode })
  }

  /** 确保 kimi 进程已启动（查询类命令在惰性启动之前的预热）。 */
  async ensureKimiProcess(): Promise<void> {
    await this.ensureProcess()
  }

  /**
   * 切换 kimi 的 thinking 档位（off/low/medium/high……以当前模型支持为准）。
   * 透传 ACP `session/set_config_option`（configId='thinking'）。
   */
  async setKimiThinking(level: string): Promise<void> {
    const acp = await this.ensureProcess()
    await acp.setConfigOption('thinking', level)
    if (this.kimiSessionId !== undefined) this.deps.prefs?.set(this.kimiSessionId, { thinking: level })
  }

  /**
   * 重放档位：session/load 之后把用户记住的模式/thinking 重新 set 给 kimi。
   * 单项失败静默跳过（如模型换了、旧 thinking 档位不再支持），不阻断重连。
   */
  private async applyKimiPrefs(acp: AcpProcess): Promise<void> {
    if (this.deps.prefs === undefined || this.kimiSessionId === undefined) return
    const pref = this.deps.prefs.get(this.kimiSessionId)
    if (pref === undefined) return
    for (const [configId, value] of [['mode', pref.mode], ['thinking', pref.thinking]] as const) {
      if (value === undefined) continue
      try {
        await acp.setConfigOption(configId, value)
      } catch {
        // 档位对当前模型/版本不再有效：跳过，kimi 保持它自己的默认。
      }
    }
  }

  /** 当前模型支持的 thinking 档位；模型不支持（kimi 不下发该选择器）时为 undefined。 */
  getKimiThinkingOptions(): string[] | undefined {
    const options = this.liveConfigOptions ?? this.acp?.configOptions
    const thinking = options?.find(candidate => candidate.id === 'thinking')
    if (thinking === undefined || !('options' in thinking)) return undefined
    return flattenSelectOptions(thinking.options).map(option => option.value)
  }

  /** kimi 侧状态快照（面板状态条读取；进程未起时 alive=false 其余缺省）。 */
  getKimiStatus(): KimiStatus {
    const options = this.liveConfigOptions ?? this.acp?.configOptions
    const pick = (id: string): string | undefined => {
      const option = options?.find(candidate => candidate.id === id)
      if (option === undefined || !('currentValue' in option)) return undefined
      return typeof option.currentValue === 'string' ? option.currentValue : undefined
    }
    const model = pick('model')
    // 显示名映射：用模型选项的 name（"Kimi K3"），而不是裸 id。
    let modelName: string | undefined
    const modelOption = options?.find(candidate => candidate.id === 'model')
    if (model !== undefined && modelOption !== undefined && 'options' in modelOption) {
      modelName = flattenSelectOptions(modelOption.options).find(option => option.value === model)?.name
    }
    return {
      model,
      modelName,
      mode: pick('mode'),
      thinking: pick('thinking'),
      used: this.lastUsage?.used,
      size: this.lastUsage?.size,
      alive: this.acp !== undefined && !this.processDead,
      cwd: this.session.header.cwd,
      bound: this.kimiSessionId !== undefined,
      ...this.deps.remoteHost === undefined ? {} : {
        host: this.deps.remoteHost.alias,
        ...this.deps.remoteHost.user === undefined ? {} : { hostUser: this.deps.remoteHost.user },
      },
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // 唤醒输入不能加入一个已中止的活动，归入下一 turn。在插入前捕获，
    // 使 splice 观察者触发的重入 cancel 不能重分类它。
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    this.inbox.append(wakingAfterAbort ? 'next-turn' : target, message)
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    this.send(message, 'next-step', true)
  }

  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = { kind: 'maintenance', abort: new AbortController(), wakeRequested: false }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await task(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle' })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * 列出本机磁盘上的 kimi 会话（/frostfin-sessions 的数据源）。
   * 进程不可用时走重连逻辑；连不上就抛错，不静默返回空。
   * @returns ACP session/list 第一页的会话条目。
   */
  async listKimiSessions(): Promise<AcpSessionInfo[]> {
    const acp = await this.ensureProcess()
    return acp.listSessions()
  }

  /**
   * 恢复绑定的 kimi 会话上下文：session/load 并吞掉回放
   * （DSH 日志里已有历史，回放只为让 kimi 进程恢复上下文）。
   * resume 与重连共用。无绑定时是 no-op。
   */
  async restoreKimiContext(): Promise<void> {
    if (this.kimiSessionId === undefined) return
    const acp = this.acp
    if (acp === undefined) throw new Error(`agent "${this.id}" 的 kimi acp 进程不可用`)
    await acp.loadSession(this.kimiSessionId)
    // 重放用户记住的模式/thinking（kimi 不持久化，进程重启即归零）。
    await this.applyKimiPrefs(acp)
  }

  /**
   * 接入一个既有 kimi 会话（斜杠命令 /frostfin-attach 的语义本体）：
   * session/load 收集回放，按 turn/step 纪律写入 DSH 日志，然后接管对话。
   * 经 runMaintenance 占住 idle 相位，与驱动器互斥。
   * 防御：本会话已有对话历史（含此前 attach 写入的回放）时拒绝——
   * 创建时绑定的空白 kimi 会话不算内容，允许被 attach 替换。
   * @param kimiSessionId - 目标 kimi 会话 id（session_ 前缀）。
   * @returns 写入的回放 turn 数。
   */
  attachKimiSession(kimiSessionId: string): Promise<number> {
    const hasContent = this.session.events.some(event => event.type === 'turn/start')
    if (this.kimiSessionId !== undefined && hasContent) {
      return Promise.reject(new Error(`该会话已绑定 kimi 会话 "${this.kimiSessionId}" 且已有对话历史，不能 attach`))
    }
    return this.runMaintenance(async () => {
      // 进程死了也能 attach：重连一个干净进程后直接 load 目标会话。
      const acp = await this.ensureProcess()
      const collector: SessionUpdate[] = []
      this.replayCollector = collector
      try {
        await acp.loadSession(kimiSessionId)
      } catch (error: unknown) {
        throw new Error(`kimi 会话 "${kimiSessionId}" 接入失败：${errorChain(error)}`, { cause: error })
      } finally {
        this.replayCollector = undefined
      }
      const events = translateReplay(collector, this.lastTurn + 1)
      const commit = createSessionCommitter(this.session)
      let turns = 0
      for (const event of events) {
        if (event.type === 'turn/start') turns += 1
        commit(event)
      }
      this.lastTurn += turns
      this.bindKimiSession(kimiSessionId)
      // 接入的 kimi 会话若此前记过档位（模式/thinking），一并重放。
      await this.applyKimiPrefs(acp)
      return turns
    })
  }

  /** 启动一个驱动器；非 idle 时按需把唤醒闩在活动上。 */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // 维护与已中止的驱动无法消化这次唤醒：闩住，收敛时重放。存活驱动
      // 自己会认领排队的工作；disposed 闩不闩——拆卸不等任何新轮次。
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    const abort = new AbortController()
    this.setPhase({ kind: 'running', abort, wakeRequested: false })
    this.pluginCtx.agents.withInitiator(this, () => this.drive(abort)).then(driver.resolve, driver.reject)
  }

  /** 驱动循环：每条排队输入一个 turn，直到收件箱排空或取消。 */
  private async drive(abort: AbortController): Promise<void> {
    const { signal } = abort
    try {
      while (this.inbox.hasPending) {
        signal.throwIfAborted()
        const turn = this.lastTurn + 1
        // turn/start 先于认领（agent-loop 的次序：claimed 事件落在打开的 turn 里）。
        this.session.append('turn/start', { turn })
        const messages = this.inbox.claim('next-turn', turn)
        // 防御：hasPending 为真时 claim 必然拿到至少一条消息；万一空了，关好 turn 再退出。
        if (messages.length === 0) {
          this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
          this.lastTurn = turn
          break
        }
        await this.runTurn(turn, messages, signal)
        this.lastTurn = turn
      }
    } catch {
      // runTurn 内部已把 turn 级失败落盘并经 agent/error 上报；取消在此收敛。
    } finally {
      if (this.phase.kind === 'running') {
        const wakeRequested = this.phase.wakeRequested
        this.setPhase({ kind: 'idle' })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  /** 一个 turn 的主体 = 一次 ACP session/prompt（turn/start 由 drive 落盘）。 */
  private async runTurn(turn: number, messages: UserMessage[], signal: AbortSignal): Promise<void> {
    const translator = createTranslator(turn)
    const commit = createSessionCommitter(this.session)
    let reason: TurnEndReason
    try {
      // 首 step 开启 → user/message 落盘（agent-loop 的次序），然后才发起 prompt。
      for (const event of translator.begin()) commit(event)
      for (const message of messages) {
        this.session.append('user/message', message, { surfaceOp: 'append' })
      }
      // 首个 turn 把模型路由写进日志：apiproxy 的模型选择与 routable 检查读这里
      // （frostfin 会话由 kimi 驱动，路由恒为 kimi-code；resume 的会话日志里已有，不重复写）。
      if (this.session.requestHeader() === undefined) {
        this.session.append('request/header', {
          header: { config: { provider: KIMI_PROVIDER, model: KIMI_MODEL } },
          reason: 'initial',
        })
      }
      const response = await this.prompt(translator, commit, messages, signal)
      reason = acpStopReason(response.stopReason, cancelCauseOf(signal))
    } catch (error: unknown) {
      if (signal.aborted) {
        reason = { kind: 'aborted', reason: cancelCauseOf(signal) }
      } else {
        // 一切失败都结构化：压平成 UNKNOWN 码的失败事实。
        reason = { kind: 'error', error: { message: errorChain(error), code: 'UNKNOWN' } }
        // 把失败变成用户在对话里可见、可操作的指引（惰性启动后，kimi 未登录等
        // 环境问题在这里第一次浮现——与 kimi CLI 本身"发送时才报错"的逻辑一致）。
        const text = 'frostfin 暂时无法驱动 kimi Code：' + errorChain(error) + '\n\n'
          + '常见原因与处理：\n'
          + '- 未登录 kimi Code：在终端运行 `kimi login` 完成登录，然后回到这里重新发送。\n'
          + '- kimi 版本过旧或没有 acp 子命令：升级 kimi Code 后重试。\n\n'
          + '会话没有丢失——修好之后直接再发一条消息即可。'
        const chunkEvent = this.session.append('assistant/chunk', {
          turn,
          step: translator.currentStep,
          chunk: { type: 'text-delta', index: 0, text },
        })
        this.session.append('assistant/message', {
          turn,
          step: translator.currentStep,
          message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'kimi-acp', model: 'kimi' } }),
        }, { surfaceOp: 'append', sourceEventSeqs: [chunkEvent.seq] })
        this.dispatch.emit('agent/error', { turn, step: translator.currentStep, error })
      }
    } finally {
      this.activeTranslator = undefined
      this.activeCommit = undefined
      this.activeTurnSignal = undefined
      // reason 在 try 正常完成与 catch 里都有赋值；走到 finally 必然已赋值。
      for (const event of translator.close(reason!)) commit(event)
    }
  }

  /** 发起 ACP prompt；本地取消立即以 cancelled 结算，不等子进程协作。 */
  private async prompt(
    translator: Translator,
    commit: (event: TranslatedEvent) => void,
    messages: UserMessage[],
    signal: AbortSignal,
  ): Promise<PromptResponse> {
    // 已中止的信号不再向 kimi 发起空转的 prompt（throwIfAborted 由 runTurn 归类为 aborted）。
    signal.throwIfAborted()
    const blocks = await toAcpPrompt(messages, async (ref) => {
      const store = this.pluginCtx.get('attachments')
      if (store === undefined) return undefined
      try {
        const stored = await store.readImage(ref)
        return { data: Buffer.from(stored.data).toString('base64'), mimeType: ref.mediaType }
      } catch {
        return undefined
      }
    })
    const acp = await this.ensureProcess()
    await this.syncModel(acp)
    this.activeTranslator = translator
    this.activeCommit = commit
    this.activeTurnSignal = signal
    const onAbort = (): void => { acp.cancel() }
    const settled = Promise.withResolvers<PromptResponse>()
    const onAbortSettle = (): void => { settled.resolve({ stopReason: 'cancelled' }) }
    signal.addEventListener('abort', onAbort, { once: true })
    signal.addEventListener('abort', onAbortSettle, { once: true })
    try {
      try {
        return await Promise.race([acp.prompt(blocks), settled.promise])
      } catch (error: unknown) {
        if (signal.aborted) throw error
        // 进程死亡/连接断裂级的失败：重连一次并重试这个 prompt（进程自愈）。
        const recovered = await this.tryReconnect()
        if (!recovered) throw error
        const retry = this.acp
        if (retry === undefined) throw error
        return await Promise.race([retry.prompt(blocks), settled.promise])
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      signal.removeEventListener('abort', onAbortSettle)
    }
  }

  /** 拿到一个可用的 kimi 进程：活着直接用；死了（且重连失败）抛出带根因的清晰错误。 */
  private async ensureProcess(): Promise<AcpProcess> {
    if (this.acp !== undefined && !this.processDead) return this.acp
    if (await this.tryReconnect()) {
      // tryReconnect 成功必然已挂好新进程。
      return this.acp!
    }
    const root = this.lastConnectError !== undefined ? `：${errorChain(this.lastConnectError)}` : ''
    throw new Error(`agent "${this.id}" 的 kimi acp 进程不可用${root}`)
  }

  /**
   * 模型同步（每个 prompt 前执行，尽量不让它阻断对话）：
   * 1. 把 kimi 握手时上报的真实模型目录发布给 DSH 的模型选择器；
   * 2. 把 DSH 侧的模型选择转发给 kimi（selectModel 会把用户选择存为部署默认，
   *    读它即得"用户最近的选择"；只在模型属于 kimi 目录时转发）；
   * 3. kimi 侧实际模型与日志里的路由不一致时，记一条 change 路由头
   *    （在 turn 内调用，满足 request/* 事件的 turn 闭合不变量）。
   */
  private async syncModel(acp: AcpProcess): Promise<void> {
    const options = acp.configOptions
    if (options !== undefined) this.deps.publishCatalog?.(options)
    const modelOption = options?.find(option => option.id === 'model')
    if (modelOption === undefined || !('options' in modelOption)) return
    const choices = flattenSelectOptions(modelOption.options)
    let current = modelOption.currentValue
    const picked = this.pluginCtx.get('agentDefaultModel')?.currentSelection()
    if (picked !== undefined && picked.model !== current) {
      // 转发规则：kimi-code 路由的模型直取；其他 provider 的模型在 kimi 目录里
      // 找同名/后缀匹配（用用户的 kimi 配置跑对应模型，如 DS 组 → relay 同名条目）；
      // 匹配不上则不转发，kimi 保持它自己的模型。
      const target = picked.provider === KIMI_PROVIDER
        ? (choices.some(option => option.value === picked.model) ? picked.model : undefined)
        : choices.find(option => option.value === picked.model)?.value
          ?? choices.find(option => option.value.endsWith(`/${picked.model}`))?.value
      if (target !== undefined && target !== current) {
        try {
          await acp.setConfigOption('model', target)
          current = target
        } catch (error: unknown) {
          this.pluginCtx.logger('frostfin').warn(`agent "${this.id}" 切换 kimi 模型失败：${errorChain(error)}`)
        }
      }
    }
    const logged = this.session.requestHeader()?.config
    if (logged !== undefined && logged.provider === KIMI_PROVIDER && logged.model !== current) {
      this.session.append('request/header', {
        header: { config: { provider: KIMI_PROVIDER, model: current } },
        reason: 'change',
      })
    }
  }

  /**
   * 重连 kimi 进程：拆除旧进程 → 重 spawn → 有绑定时 session/load 吞回放。
   * 记忆化：并发调用共享同一次重连。
   * @returns 是否重连成功（没有绑定/没有旧进程的冷失败返回 false）。
   */
  private tryReconnect(): Promise<boolean> {
    this.reconnecting ??= this.reconnect()
    return this.reconnecting
  }

  private async reconnect(): Promise<boolean> {
    try {
      // 旧进程可能还吊着：走一遍关停阶梯（幂等，已死则快返回）。
      await this.acp?.dispose()
      const acp = await this.deps.connect()
      this.acp = acp
      this.processAbort = new AbortController()
      this.processDead = false
      try {
        await this.restoreKimiContext()
      } catch (error: unknown) {
        // load 失败的进程不留：回收后把错误上抛给调用方（turn error / attach 报错）。
        await acp.dispose()
        this.acp = undefined
        this.processDead = true
        throw error
      }
      // 惰性启动（新建会话创建时不再起进程）：首个可用进程在此登记绑定。
      if (this.kimiSessionId === undefined) this.bindKimiSession(acp.sessionId)
      this.lastConnectError = undefined
      return true
    } catch (error: unknown) {
      this.lastConnectError = error
      this.pluginCtx.logger('frostfin').warn(`agent "${this.id}" 的 kimi acp 重连失败：${errorChain(error)}`)
      return false
    } finally {
      this.reconnecting = undefined
    }
  }
}
