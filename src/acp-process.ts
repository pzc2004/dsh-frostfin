/**
 * `kimi acp` 子进程管理 + ACP ClientSideConnection 封装。
 * 生命周期照抄 `deepseek-harness/packages/subagent/subagent-acp/src/run.ts`：
 * spawn → initialize + newSession（与 spawn 失败赛跑）→ prompt →
 * sessionUpdate 回调 → 权限自动应答 → cancel → dispose 阶梯
 * （stdin EOF → 等 disposeEofGraceMs → SIGTERM → 等 disposeGraceMs → SIGKILL → waitForExit）。
 *
 * @module dsh-frostfin/acp-process
 */

import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type Client,
  type ContentBlock as AcpContentBlock,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionInfo,
  type SessionNotification,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'

/** 子进程权限请求的固定应答策略：默认拒绝，或选第一个 allow 选项。 */
export type PermissionPolicy = 'allow' | 'reject' | 'ask'

/** 一个已解析的 kimi acp 进程启动规格（默认值已在 Config 层填好）。 */
export interface AcpProcessSpec {
  /** 要启动的可执行文件（kimi CLI）。 */
  command: string
  /** 传给 {@link command} 的参数。 */
  args: string[]
  /** 子进程与 ACP 会话共用的绝对工作目录。 */
  cwd: string
  /** 权限自动应答策略；'ask' 时由 {@link onRequestPermission} 桥接 DSH 审批。 */
  permission: PermissionPolicy
  /** dispose 第一阶梯：stdin EOF 后等待子进程协作退出的毫秒数。 */
  disposeEofGraceMs: number
  /** dispose 第二阶梯：SIGTERM 后升级 SIGKILL 的毫秒数。 */
  disposeGraceMs: number
  /**
   * 来自 subprocess 接缝（`ctx.subprocess.spawn`）的 spawn 函数，
   * 让子进程共享接缝的进程树级终止与服务托管的生命周期。
   */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** ACP `session/update` 通知的出口（路由由调用方——FrostfinAgent——负责）。 */
  onSessionUpdate: (update: SessionUpdate) => void
  /**
   * M2 审批桥（permission='ask' 时由 factory 注入）。返回 undefined 表示
   * 本桥不接（approval 服务缺失/抛错/答复链不可用），回落到策略自动应答。
   */
  onRequestPermission?: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse | undefined>
  /** 子进程在握手后、非 dispose 发起的退出出口（中止悬挂审批、记日志）。 */
  onExit?: (outcome: SubprocessOutcome) => void
  /** 子进程异步故障出口（spawn 级失败才会走到），供记日志。 */
  onError?: (error: Error) => void
}

/** 一个已握手的 kimi acp 进程及其 ACP 会话。 */
export interface AcpProcess {
  /** ACP 侧的会话 id（子进程命名空间内唯一）。 */
  readonly sessionId: string
  /** 握手/切换后最新一次的 configOptions（含模型/思考/模式选择器快照）。 */
  readonly configOptions: SessionConfigOption[] | undefined
  /** 发起一次 `session/prompt`，resolve 出 stopReason。 */
  prompt(prompt: AcpContentBlock[]): Promise<PromptResponse>
  /**
   * `session/load` 恢复一个既有 kimi 会话。回放经 `onSessionUpdate` 流出，
   * 吞掉还是落盘由调用方决定（resume/重连吞；attach 收集落盘）。
   */
  loadSession(sessionId: string): Promise<void>
  /** `session/set_config_option`：切换模型/思考/模式等（configId 如 'model'）。 */
  setConfigOption(configId: string, value: string): Promise<void>
  /** `session/delete`：删除本会话（预热等一次性会话的清理；不支持时静默）。 */
  deleteSession(): Promise<void>
  /** `session/list`：枚举本机磁盘上的 kimi 会话（第一页；本地会话通常一页装完）。 */
  listSessions(): Promise<SessionInfo[]>
  /** 尽力发送 `session/cancel`（子进程已消失时吞掉错误）。 */
  cancel(): void
  /** 关停阶梯：stdin EOF → EOF 宽限 → terminate()（SIGTERM→SIGKILL）→ 整树退出证明。 */
  dispose(): Promise<void>
}

/** 有界的整树退出等待：轮询句柄的树存活，直到退出或超时。 */
async function treeExitsWithin(child: SubprocessHandle, ms: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 进程外 agent 的协作式关停阶梯，只用接缝的公开动词；直到整树静止才 resolve：
 * stdin EOF（子进程冲刷持久化、收割自己的孙进程的窗口），然后 terminate()
 * 升级（SIGTERM → spec 宽限 → SIGKILL）及其整树退出证明。
 */
export async function disposeAcpChild(child: SubprocessHandle, eofGraceMs: number): Promise<void> {
  // spawn 失败没有进程可拆；观察其 rejection，避免 finally 里的处置抛成 unhandled。
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  child.stdin?.end()
  if (await treeExitsWithin(child, eofGraceMs)) return
  // terminate() 自己有有界的 SIGTERM→SIGKILL 计时器；随后的无界等待是进程
  // 属主的退出证明，不是第二个可能溢出的派生宽限。
  child.terminate()
  await child.waitForExit()
}

/** ACP authRequired 的 JSON-RPC 错误码（见 ACP 协议：-32000 保留给 auth required）。 */
const ACP_AUTH_REQUIRED_CODE = -32000

/**
 * 把裸命令名解析成绝对路径：launchd/系统服务环境的 PATH 往往没有用户级 bin
 * （比如 kimi 的默认安装位 ~/.kimi-code/bin），先探常见位置再退到 PATH 扫描。
 */
function resolveCommand(command: string): string {
  if (command.includes('/') || command.includes('\\')) return command
  const candidates = [join(homedir(), '.kimi-code', 'bin', command)]
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir !== '') candidates.push(join(dir, command))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return command
}

/** 判断握手失败是否因为 kimi 未登录。 */
function isAuthRequired(error: unknown): boolean {
  return error instanceof RequestError && error.code === ACP_AUTH_REQUIRED_CODE
}

/** 把 unknown 的抛出值归一成 Error。 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * 启动一个 kimi acp 子进程并完成 initialize + newSession 握手。
 * 握手失败（含未登录）会先收割进程再 reject。
 * @param spec - 已解析的启动规格与回调。
 * @returns 就绪的进程句柄。
 */
export async function startAcpProcess(spec: AcpProcessSpec): Promise<AcpProcess> {
  // 诊断走父进程 stderr（'inherit'）；只有 ACP 协议帧走管道。
  // 接缝默认会洗刷父进程环境（凭证形变量与 DSH_*）；M1 按设计直接把
  // process.env 作为显式 env 传入——显式条目在接缝的洗刷之后合并，
  // 净效果即"原样继承父进程环境"。后续里程碑引入 env 配置项后收敛。
  const child = spec.spawn({
    argv: [resolveCommand(spec.command), ...spec.args],
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs: spec.disposeGraceMs,
    env: { ...process.env },
  })
  if (child.stdin === undefined || child.stdout === undefined) {
    throw new Error('frostfin: subprocess 实现丢掉了管道协议流')
  }
  // spawn 级失败表现为 done reject，进入握手赛跑；干净退出绝不能赢得赛跑，
  // 所以成功臂永远 park。（连接会因为流关闭而终止，从而界住一个不开口的子进程。）
  const spawnFailed: Promise<never> = child.done.then(
    () => new Promise<never>(() => {}),
    (err: unknown) => Promise.reject(toError(err)),
  )
  spawnFailed.catch(() => { /* 由握手赛跑观察；不会 unhandled */ })

  // 握手回滚与发布后的句柄共享同一份进程拆除。
  let processDisposal: Promise<void> | undefined
  const disposeProcess = (): Promise<void> => (processDisposal ??= disposeAcpChild(child, spec.disposeEofGraceMs))

  const makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate(params: SessionNotification): Promise<void> {
      spec.onSessionUpdate(params.update)
      return Promise.resolve()
    },
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      // M2 审批桥先行；桥不接（undefined）时回落到策略自动应答。
      // 策略逻辑同 M1：allow 选第一个 allow_once / allow_always 选项；
      // 其余（含 ask 的回落）答 cancelled——fail-closed，子进程不得继续。
      if (spec.onRequestPermission !== undefined) {
        const bridged = await spec.onRequestPermission(params)
        if (bridged !== undefined) return bridged
      }
      if (spec.permission === 'allow') {
        const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
        if (allow !== undefined) {
          return { outcome: { outcome: 'selected', optionId: allow.optionId } }
        }
      }
      return { outcome: { outcome: 'cancelled' } }
    },
  })

  const conn = new ClientSideConnection(
    makeClient,
    ndJsonStream(
      NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
  )

  let sessionId: string | undefined
  let configOptions: SessionConfigOption[] | undefined
  try {
    await Promise.race([
      (async (): Promise<void> => {
        await conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          // 不声明任何可选客户端能力（无 fs、无 terminal）：kimi 在自己的进程里自足，
          // fs/read_text_file 等反向 RPC 不会路由到本客户端。
          clientCapabilities: {},
        })
        const session = await conn.newSession({ cwd: spec.cwd, mcpServers: [] })
        sessionId = session.sessionId
        configOptions = session.configOptions ?? undefined
      })(),
      spawnFailed,
    ])
  } catch (error: unknown) {
    await disposeProcess()
    if (isAuthRequired(error)) {
      throw new Error('frostfin: kimi acp 要求登录态——请先运行 `kimi login` 完成认证', { cause: error })
    }
    throw toError(error)
  }
  if (sessionId === undefined) throw new Error('frostfin: ACP 握手完成但没有拿到会话 id')
  let remoteSessionId = sessionId

  let disposal: Promise<void> | undefined
  // 子进程在握手后退出：非 dispose 发起的退出要通知出去（悬挂的审批等需要中止）；
  // 接缝契约里 done 仅对 spawn 级失败 reject，正常/异常关闭都是 resolve。
  void child.done.then(
    (outcome) => { if (disposal === undefined) spec.onExit?.(outcome) },
    (error: unknown) => { spec.onError?.(toError(error)) },
  )

  return {
    get sessionId() { return remoteSessionId },
    get configOptions() { return configOptions },
    prompt: prompt => conn.prompt({ sessionId: remoteSessionId, prompt }),
    async loadSession(targetSessionId: string): Promise<void> {
      await conn.loadSession({ sessionId: targetSessionId, cwd: spec.cwd, mcpServers: [] })
      remoteSessionId = targetSessionId
    },
    async setConfigOption(configId: string, value: string): Promise<void> {
      const response = await conn.setSessionConfigOption({ sessionId: remoteSessionId, configId, value })
      // 响应携带切换后的完整快照（模型/思考/模式可能联动变化）。
      configOptions = response.configOptions ?? undefined
    },
    async deleteSession(): Promise<void> {
      // kimi 对 session/delete 的支持是可选能力；不存在或失败都静默（调用方是一次性场景）。
      const optional = conn as unknown as { deleteSession?: (params: { sessionId: string }) => Promise<unknown> }
      await optional.deleteSession?.({ sessionId: remoteSessionId }).catch(() => {})
    },
    async listSessions(): Promise<SessionInfo[]> {
      const response = await conn.listSessions({})
      return response.sessions
    },
    cancel(): void {
      void conn.cancel({ sessionId: remoteSessionId }).catch(() => { /* 子进程已消失 / 会话不在 */ })
    },
    dispose(): Promise<void> {
      disposal ??= disposeProcess()
      return disposal
    },
  }
}
