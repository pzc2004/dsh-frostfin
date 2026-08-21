/**
 * Web 面板的宿主端点：
 * - GET  /plugins/frostfin/kimi-sessions —— 扫描本机磁盘上的 kimi 会话
 *   （session_index.jsonl + 各会话的 state.json），标注 frostfin 绑定状态；
 * - POST /plugins/frostfin/open { kimiSessionId } —— 幂等打开：已绑定的返回
 *   既有 DSH 会话；否则新建 frostfin 会话并 attach（历史回放进日志）。
 *
 * @module dsh-frostfin/panel
 */

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Logger } from '@deepseek-ai/cordis'
// 类型面引用：让 Context 合并（ctx.get('webServer') / ctx.get('agentPresets')）生效。
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { FrostfinAgent } from './agent.js'
import { FROSTFIN_PRESET_ID } from './preset-install.js'
import type { KimiSessionMap } from './kimi-sessions.js'
import type { QuestionRegistry } from './question.js'
import { startAcpProcess } from './acp-process.js'
import { expandRemoteHome, hostDriverFor, sanitizeSessionName, shQuote, type HostDriver } from './remote.js'
import { loadSshHosts, type SshHostEntry } from './ssh-config.js'
import type { Config } from './index.js'

/** 面板行：一个磁盘上的 kimi 会话。 */
export interface KimiSessionEntry {
  sessionId: string
  title: string | null
  cwd: string
  updatedAt: string | null
  archived: boolean
  bound: boolean
}

/** 远程行：一台远程主机上的 kimi 会话（ACP session/list 条目）。 */
export interface RemoteSessionItem {
  sessionId: string
  title: string | null
  cwd: string
  updatedAt: string | null
  /** 疑似被活 TUI 持有（同工作区有前台 kimi 在 tmux 里跑）——面板接入前要用户确认。 */
  held?: boolean
  /** 已绑定到某 DSH 会话时的会话 id（面板显示「已接入/打开」并隐藏删除；服务端据此幂等）。 */
  boundDshId?: string
}

/** kimi 数据目录（$KIMI_CODE_HOME 或 ~/.kimi-code）。 */
function kimiHome(): string {
  const home = process.env.KIMI_CODE_HOME
  return home !== undefined && home.trim() !== '' ? home : join(homedir(), '.kimi-code')
}

/** 包内 assets 目录（lib/panel.js → 包根/assets）。 */
const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

/**
 * Kimi Coding 订阅配额（cc-switch 同款数据源：GET /coding/v1/usages）。
 * key 从 kimi 自己的 config.toml 读（官方渠道那条 provider；relay 渠道不匹配官方域名、天然跳过）。
 */

/** 配额窗口（5 小时 / 周 / 月；percent 为已用百分比）。 */
export interface BalanceWindow {
  id: 'fiveHour' | 'week' | 'month'
  percent: number
  limit?: number
  remaining?: number
  resetsAt?: string
}

/** kimi config.toml 里官方渠道的 api_key（读不到返回 undefined——余额段自动隐藏）。 */
export function kimiCodingKeyOf(tomlText: string): string | undefined {
  // provider 块形如 [providers."name"]（config-sync 的机器写格式）；逐块取 base_url/api_key。
  const blockRe = /\[providers\.(?:("?)([\w.-]+)\1)\]([\s\S]*?)(?=\n\[|\s*$)/g
  for (const match of tomlText.matchAll(blockRe)) {
    const body = match[3] ?? ''
    const baseUrl = /base_url\s*=\s*"([^"]*)"/.exec(body)?.[1] ?? ''
    // 官方 Kimi Coding 渠道（api.kimi.com / api.moonshot）；relay 等内部渠道不匹配。
    if (!/api\.kimi\.com|api\.moonshot/.test(baseUrl)) continue
    const key = /api_key\s*=\s*"([^"]+)"/.exec(body)?.[1]
    if (key !== undefined && key !== '') return key
  }
  return undefined
}

/** 配额 key 的读取顺序：环境变量 → kimi config.toml 官方渠道；都没有返回 undefined。 */
function codingKeyOf(): string | undefined {
  const fromEnv = process.env.KIMI_CODING_API_KEY
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  try {
    return kimiCodingKeyOf(readFileSync(join(kimiHome(), 'config.toml'), 'utf8'))
  } catch {
    return undefined
  }
}

/** 把 /coding/v1/usages 的响应解析成配额窗口。 */
export function parseKimiUsage(body: unknown): BalanceWindow[] {
  if (body === null || typeof body !== 'object') return []
  const root = body as Record<string, unknown>
  const windows: BalanceWindow[] = []
  const num = (value: unknown): number | undefined => {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    return Number.isFinite(n) ? n : undefined
  }
  const push = (id: BalanceWindow['id'], detail: unknown): void => {
    if (detail === null || typeof detail !== 'object') return
    const d = detail as Record<string, unknown>
    const limit = num(d.limit)
    // 两种形态对齐：官方 used/limit（decimal 字符串）与第三方 limit/remaining（数字）。
    const used = num(d.used)
    const remaining = num(d.remaining)
    if (limit === undefined || limit <= 0) return
    const usedAbs = used ?? (remaining !== undefined ? limit - remaining : undefined)
    if (usedAbs === undefined) return
    windows.push({
      id,
      percent: Math.round((Math.max(usedAbs, 0) / limit) * 100),
      limit,
      ...remaining !== undefined ? { remaining } : {},
      ...typeof d.resetTime === 'string' ? { resetsAt: d.resetTime } : {},
    })
  }
  /** 官方形态：window { duration, timeUnit }（proto 枚举）。 */
  const idOfWindow = (window: unknown): BalanceWindow['id'] | undefined => {
    if (window === null || typeof window !== 'object') return undefined
    const w = window as Record<string, unknown>
    const duration = num(w.duration)
    const unit = typeof w.timeUnit === 'string' ? w.timeUnit : ''
    if (duration === 300 && unit === 'TIME_UNIT_MINUTE') return 'fiveHour'
    if (duration === 7 && unit === 'TIME_UNIT_DAY') return 'week'
    if (duration === 30 && unit === 'TIME_UNIT_DAY') return 'month'
    return undefined
  }
  /** 第三方形态：直接给秒数。 */
  const idOfSeconds = (seconds: unknown): BalanceWindow['id'] | undefined => {
    if (seconds === 18_000) return 'fiveHour'
    if (seconds === 604_800) return 'week'
    if (seconds === 2_592_000) return 'month'
    return undefined
  }
  const limits = Array.isArray(root.limits) ? root.limits : []
  for (const entry of limits) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = idOfWindow(record.window) ?? idOfSeconds(record.window ?? record.duration ?? record.windowSeconds)
    if (id === undefined) continue
    push(id, record.detail)
  }
  // 兜底形态：limits[0] 是 5 小时（无窗口标注时）；usage 是周限额。
  if (!windows.some(w => w.id === 'fiveHour') && limits[0] !== null && typeof limits[0] === 'object') {
    push('fiveHour', (limits[0] as Record<string, unknown>).detail)
  }
  if (!windows.some(w => w.id === 'week')) push('week', root.usage)
  return windows
}

/** 配额缓存（60 秒 TTL；key 层面的单条）。 */
let balanceCache: { at: number; windows: BalanceWindow[] } | undefined

/** 查 Kimi Coding 订阅配额；没 key 或查询失败返回 undefined（状态条对应段自动隐藏）。 */
async function kimiBalanceOf(): Promise<BalanceWindow[] | undefined> {
  if (balanceCache !== undefined && Date.now() - balanceCache.at < 60_000) return balanceCache.windows
  let key: string | undefined
  try {
    key = codingKeyOf()
  } catch {
    return undefined
  }
  if (key === undefined) return undefined
  try {
    const response = await fetch('https://api.kimi.com/coding/v1/usages', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return undefined
    const windows = parseKimiUsage(await response.json())
    const result = windows.length === 0 ? undefined : windows
    if (result !== undefined) balanceCache = { at: Date.now(), windows: result }
    return result
  } catch {
    return undefined
  }
}

/** git 分支查询的缓存（按 cwd，5 秒 TTL——轮询场景下不打爆 git）。 */
const branchCache = new Map<string, { branch: string | undefined; at: number }>()

/** 读一个目录的 git 当前分支；非 git 目录或超时返回 undefined。 */
function gitBranchOf(cwd: string): Promise<string | undefined> {
  const cached = branchCache.get(cwd)
  if (cached !== undefined && Date.now() - cached.at < 5000) return Promise.resolve(cached.branch)
  return new Promise((resolvePromise) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 1500 }, (error, stdout) => {
      const branch = error !== null ? undefined : stdout.trim()
      branchCache.set(cwd, { branch, at: Date.now() })
      resolvePromise(branch)
    })
  })
}

/** 扫描本机磁盘上的 kimi 会话（索引 + state.json 富化），updatedAt 倒序。 */
export function scanKimiSessions(kimiMap: KimiSessionMap, cap = 50): KimiSessionEntry[] {
  const indexFile = join(kimiHome(), 'session_index.jsonl')
  if (!existsSync(indexFile)) return []
  const entries: KimiSessionEntry[] = []
  for (const line of readFileSync(indexFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const index = JSON.parse(line) as { sessionId?: string; sessionDir?: string; workDir?: string }
      if (typeof index.sessionId !== 'string' || typeof index.sessionDir !== 'string') continue
      let state: { title?: string; updatedAt?: string; archived?: boolean } = {}
      const stateFile = join(index.sessionDir, 'state.json')
      try {
        state = JSON.parse(readFileSync(stateFile, 'utf8')) as typeof state
      } catch {
        // state.json 缺失/损坏：用索引里的信息兜底。
      }
      // updatedAt 缺失时用 state.json 的文件 mtime 兜底（不再显示"时间未知"）。
      let updatedAt = typeof state.updatedAt === 'string' ? state.updatedAt : null
      if (updatedAt === null) {
        try {
          updatedAt = statSync(stateFile).mtime.toISOString()
        } catch {
          // 文件也没有：保持 null。
        }
      }
      entries.push({
        sessionId: index.sessionId,
        title: typeof state.title === 'string' && state.title !== '' ? state.title : null,
        cwd: typeof index.workDir === 'string' ? index.workDir : '',
        updatedAt,
        archived: state.archived === true,
        bound: kimiMap.hasValue(index.sessionId),
      })
    } catch {
      // 单行损坏跳过，不影响其他会话。
    }
  }
  entries.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  return entries.slice(0, cap)
}

/** 读 POST 的 JSON body（有界 64KiB）。 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 65_536) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** kimi 更新结果（update-kimi 端点响应）。 */
interface UpdateKimiResult {
  ok: boolean
  output: string
  version?: string
}

/** kimi 路径的三级解析（command -v → 官方默认位 → 登录 shell 兜底），与远程体检同款。 */
const KIMI_RESOLVE = 'K=$(command -v kimi 2>/dev/null || true); [ -z "$K" ] && [ -x "$HOME/.kimi-code/bin/kimi" ] && K="$HOME/.kimi-code/bin/kimi"; [ -z "$K" ] && K=$($SHELL -lc "command -v kimi" 2>/dev/null || true)'

/** 更新流程：kimi update → 遇"该平台不支持自动更新"回退官方安装脚本 → 报告版本。 */
const KIMI_UPDATE_FLOW = `${KIMI_RESOLVE}; [ -z "$K" ] && { echo NO_KIMI; exit 1; }; OUT=$("$K" update 2>&1 || true); echo "$OUT"; echo "$OUT" | grep -q "Auto-update is not supported" && { curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash; }; "$K" --version`

/** 版本探针：当前版本（kimi --version）+ 最新版本（npm registry）。 */
const KIMI_VERSION_PROBE = `${KIMI_RESOLVE}; [ -z "$K" ] && { echo NO_KIMI; exit 1; }; echo "CUR=$("$K" --version 2>/dev/null | head -1)"; echo "LAT=$(curl -fsSL --max-time 10 https://registry.npmjs.org/@moonshot-ai/kimi-code/latest 2>/dev/null | grep -o '"version": *"[^"]*"' | head -1 | grep -o '[0-9.]*')"`

/** kimi-version 端点响应。 */
interface KimiVersionInfo {
  ok: boolean
  current?: string
  latest?: string
  error?: string
}

/** 跑版本探针并解析（本地/远程同一驱动面）。 */
async function runKimiVersionProbe(driver: HostDriver, probe: string): Promise<KimiVersionInfo> {
  const { stdout, stderr, error } = await driver.execProbe(probe, 30_000)
  if (error !== null) {
    return { ok: false, error: `${stdout.trim()} ${stderr.trim()}`.trim() || error.message }
  }
  if (stdout.includes('NO_KIMI')) {
    return { ok: false, error: '找不到 kimi' }
  }
  const current = /^CUR=(.+)$/m.exec(stdout)?.[1]?.trim()
  const latest = /^LAT=(.+)$/m.exec(stdout)?.[1]?.trim()
  return {
    ok: true,
    ...current === undefined || current === '' ? {} : { current },
    ...latest === undefined || latest === '' ? {} : { latest },
  }
}

/** 版本探针缓存（60 秒；本地键为 ''）。 */
const versionCache = new Map<string, { at: number; info: KimiVersionInfo }>()

/** 按配置生成版本探针文本（默认裸名走三级解析；自定义命令直接调用）。 */
function versionProbeFor(config: Config): string {
  if (config.command === 'kimi') return KIMI_VERSION_PROBE
  return `echo "CUR=$(${config.command} --version 2>/dev/null | head -1)"; echo "LAT=$(curl -fsSL --max-time 10 https://registry.npmjs.org/@moonshot-ai/kimi-code/latest 2>/dev/null | grep -o '\"version\": *\"[^\"]*\"' | head -1 | grep -o '[0-9.]*')"`
}

/** 查某处的 kimi 当前/最新版本（带缓存与失败直返）。 */
async function kimiVersionOf(host: SshHostEntry | undefined, config: Config): Promise<KimiVersionInfo> {
  const key = host?.alias ?? ''
  const cached = versionCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < 60_000) return cached.info
  const info = await runKimiVersionProbe(hostDriverFor(host, config.sshCommand), versionProbeFor(config))
  versionCache.set(key, { at: Date.now(), info })
  return info
}

/** 跑一段 sh 更新流程并汇总结果（本地/远程同一驱动面）。 */
async function runKimiUpdate(driver: HostDriver, flow: string): Promise<UpdateKimiResult> {
  const { stdout, stderr, error } = await driver.execProbe(flow, 300_000)
  const output = `${stdout.trim()}\n${stderr.trim()}`.trim()
  const version = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(output.split('\n').at(-1) ?? '')?.[1]
  if (error !== null) {
    return { ok: false, output: output !== '' ? output : error.message, ...version === undefined ? {} : { version } }
  }
  if (output.includes('NO_KIMI')) {
    return { ok: false, output: '找不到 kimi（PATH、~/.kimi-code/bin、登录 shell 都没有）' }
  }
  return { ok: true, output, ...version === undefined ? {} : { version } }
}

/** 更新 kimi（本地/远程同一段流程，差异在驱动层；config.command 是裸名 'kimi' 时走三级解析，自定义命令直接用它）。 */
function updateKimiOn(host: SshHostEntry | undefined, config: Config): Promise<UpdateKimiResult> {
  const flow = config.command === 'kimi'
    ? KIMI_UPDATE_FLOW
    : `OUT=$(${config.command} update 2>&1 || true); echo "$OUT"; ${config.command} --version`
  return runKimiUpdate(hostDriverFor(host, config.sshCommand), flow)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 注册面板的端点（宿主缺 webServer 服务时整个跳过，如 headless）。
 * M7 增加问题通道两端点：pending-questions（浏览器轮询待答问题）/
 * answer-question（作答回传）。远程线增加 remote-hosts（ssh 配置里的
 * 服务器清单）/ remote-sessions（懒连接列出远程 kimi 会话）/ open-remote（接入）。
 * @returns 撤销全部路由的 disposer。
 */
export function registerPanelRoutes(ctx: Context, logger: Logger, kimiMap: KimiSessionMap, questions: QuestionRegistry, config: Config): () => void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    logger.info('frostfin: 宿主没有 webServer 服务，面板端点不注册')
    return () => {}
  }

  const disposeList = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/kimi-sessions',
    handler: (_req, res) => {
      send(res, 200, { sessions: scanKimiSessions(kimiMap) })
    },
  })

  // 面板 logo（我们自己的界面元素，静态资源）。
  const disposeLogo = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/logo.png',
    handler: (_req, res) => {
      const file = join(ASSETS, 'logo.png')
      if (!existsSync(file)) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' })
      res.end(readFileSync(file))
    },
  })

  // 会话状态条数据：kimi 侧模型/模式/思考/上下文占用（仅 frostfin 驱动的存活会话）。
  /** 远程 git 分支缓存（host:cwd → 30 秒）。 */
  const remoteBranchCache = new Map<string, { at: number; branch: string | undefined }>()
  const remoteBranchOf = async (alias: string, cwd: string): Promise<string | undefined> => {
    const key = `${alias}:${cwd}`
    const cached = remoteBranchCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.branch
    const host = loadSshHosts(config.sshConfigFile).find(candidate => candidate.alias === alias)
    const branch = host === undefined ? undefined : await hostDriverFor(host, config.sshCommand).probeGitBranch(cwd)
    remoteBranchCache.set(key, { at: Date.now(), branch })
    return branch
  }
  const disposeStatus = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/status',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const agent = ctx.agents.get(sessionId as SessionId)
      if (!(agent instanceof FrostfinAgent)) {
        send(res, 200, { driven: false })
        return
      }
      const status = agent.getKimiStatus()
      // 分支：本地会话查本地 git；远程会话经 ssh 查远程 git（30 秒缓存——状态条 3 秒轮询不锤 ssh）。
      let branch: string | undefined
      if (status.cwd !== undefined) {
        branch = status.host === undefined
          ? await gitBranchOf(status.cwd)
          : await remoteBranchOf(status.host, status.cwd)
      }
      // Kimi Coding 订阅配额（5h/周/月，60 秒缓存；没 key 自动隐藏）。
      const balance = await kimiBalanceOf()
      send(res, 200, {
        driven: true,
        ...status,
        ...branch === undefined ? {} : { branch },
        ...balance === undefined ? {} : { balance },
      })
    },
  })

  /**
   * 重连 kimi 进程（状态条对当前打开会话的自动重连，或用户手动重试）。
   * 有绑定才重连——无绑定的全新会话保持惰性启动，不因为被看一眼就起进程。
   * 失败不抛 HTTP 错：{ ok: false, error } 让状态条显示并走冷却重试。
   */
  const disposeReconnect = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/reconnect',
    handler: async (req, res) => {
      try {
        const body = await readBody(req) as { sessionId?: unknown }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const agent = ctx.agents.get(sessionId as SessionId)
        if (!(agent instanceof FrostfinAgent)) {
          send(res, 404, { ok: false, error: '会话不存在或不是 frostfin 驱动' })
          return
        }
        if (agent.boundKimiSessionId === undefined) {
          send(res, 200, { ok: false, skipped: 'no-binding' })
          return
        }
        await agent.ensureKimiProcess()
        send(res, 200, { ok: true })
      } catch (error: unknown) {
        send(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  /**
   * 切换 kimi 的 thinking 档位 / 权限模式（输入区工具行按钮的数据面）。
   * 只放行这两个 configId；值合法性由 kimi 侧校验（不在其可选行里会报错）。
   */
  const disposeSetConfig = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/set-config',
    handler: async (req, res) => {
      try {
        const body = await readBody(req) as { sessionId?: unknown; configId?: unknown; value?: unknown }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const configId = typeof body.configId === 'string' ? body.configId : ''
        const value = typeof body.value === 'string' ? body.value : ''
        const agent = ctx.agents.get(sessionId as SessionId)
        if (!(agent instanceof FrostfinAgent)) {
          send(res, 404, { ok: false, error: '会话不存在或不是 frostfin 驱动' })
          return
        }
        if (configId !== 'thinking' && configId !== 'mode') {
          send(res, 400, { ok: false, error: '只支持 thinking / mode' })
          return
        }
        if (configId === 'thinking') await agent.setKimiThinking(value)
        else await agent.setKimiMode(value)
        send(res, 200, { ok: true })
      } catch (error: unknown) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  /**
   * 把接入的会话归进 cwd 对应的工作区（侧边栏分组）：
   * workspaceRegistry.create 按 canonical path 幂等复用工作区，attachSession
   * 校验会话头 cwd 精确匹配后挂入（attach 本身幂等，重复调用是 no-op——
   * 愈合归组修复前接入的会话）。best effort：服务缺席/目录消失/校验失败
   * 都不影响接入，只记 warn。远程会话不调——workspace 的 realpath 校验
   * 绑死本机文件系统，远程归组是 DSH 上游缺口。
   */
  interface WorkspaceRegistryLike {
    create(path: string): Promise<{ attachSession(id: SessionId): Promise<void> }>
  }
  const groupIntoWorkspace = async (sessionId: SessionId, cwd: string): Promise<void> => {
    try {
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      if (registry === undefined) return
      const workspace = await registry.create(cwd)
      await workspace.attachSession(sessionId)
      logger.info('frostfin: 会话 %s 已归入工作区 %s', sessionId, cwd)
    } catch (error: unknown) {
      logger.warn('frostfin: 会话 %s 归入工作区（%s）失败，留在未分组：%s', sessionId, cwd, error instanceof Error ? error.message : String(error))
    }
  }
  const disposeOpen = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/open',
    handler: async (req, res) => {
      try {
        const body = await readBody(req) as { kimiSessionId?: unknown }
        const kimiSessionId = body.kimiSessionId
        if (typeof kimiSessionId !== 'string' || !kimiSessionId.startsWith('session_')) {
          send(res, 400, { error: 'kimiSessionId 必须是 session_ 开头的 kimi 会话 id' })
          return
        }
        const entry = scanKimiSessions(kimiMap).find(item => item.sessionId === kimiSessionId)
        // 幂等：已绑定过的直接返回既有 DSH 会话（顺带补挂工作区——愈合归组修复前接入的会话）。
        const existing = kimiMap.keyOf(kimiSessionId)
        if (existing !== undefined) {
          if (entry !== undefined && entry.cwd !== '') await groupIntoWorkspace(existing as SessionId, entry.cwd)
          send(res, 200, { sessionId: existing, reused: true })
          return
        }
        const cwd = entry !== undefined && entry.cwd !== '' ? entry.cwd : process.cwd()
        const sessionId = `session-${randomUUID()}` as SessionId
        const handle = await ctx.agents.create({
          sessionId,
          meta: { cwd, agentPreset: FROSTFIN_PRESET_ID },
          setup: async (agentCtx) => {
            // 与 apiproxy 的创建流一致：把 frostfin preset 组合进 agent 作用域。
            await ctx.get('agentPresets')?.mount(agentCtx, FROSTFIN_PRESET_ID)
          },
        })
        if (!(handle.agent instanceof FrostfinAgent)) {
          throw new Error('新建会话未路由到 frostfin（请检查月芒霜鳍鲸模式是否启用）')
        }
        const turns = await handle.agent.attachKimiSession(kimiSessionId)
        await groupIntoWorkspace(sessionId, cwd)
        logger.info('frostfin: 面板接入 kimi 会话 %s → DSH 会话 %s（%d 个回放 turn）', kimiSessionId, sessionId, turns)
        send(res, 200, { sessionId, reused: false, replayTurns: turns })
      } catch (error: unknown) {
        send(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // M7 问题通道：浏览器轮询某会话的待答问题（仅 frostfin 驱动的存活会话）。
  const disposePending = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/pending-questions',
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const agent = ctx.agents.get(sessionId as SessionId)
      if (!(agent instanceof FrostfinAgent)) {
        send(res, 200, { questions: [] })
        return
      }
      send(res, 200, { questions: questions.list(sessionId) })
    },
  })

  // M7 问题通道：作答回传（optionId 必须属于该问题的选项，否则 400）。
  const disposeAnswer = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/answer-question',
    handler: async (req, res) => {
      try {
        const body = await readBody(req) as { id?: unknown; optionId?: unknown }
        if (typeof body.id !== 'string' || typeof body.optionId !== 'string') {
          send(res, 400, { error: '需要 { id, optionId }' })
          return
        }
        if (!questions.answer(body.id, body.optionId)) {
          send(res, 404, { error: '问题不存在/已作答，或选项不属于该问题' })
          return
        }
        send(res, 200, { ok: true })
      } catch (error: unknown) {
        send(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // 远程线：ssh 配置里的服务器清单（面板"远程"大区数据源）。
  const disposeRemoteHosts = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/remote-hosts',
    handler: (_req, res) => {
      const hosts = loadSshHosts(config.sshConfigFile).map(host => ({ alias: host.alias }))
      send(res, 200, { hosts })
    },
  })

  /**
   * 远程会话列表：体检 → spawn 探针（ssh+tmux shim）→ session/list → 即弃探针
   * （远程 pane 留着， kimi 不死）。结果按主机缓存 15 秒——懒连接但不至每次轮询重连。
   */
  const remoteListCache = new Map<string, { at: number; payload: { sessions: RemoteSessionItem[]; error?: string; homeDir?: string } }>()
  const listRemote = async (host: SshHostEntry): Promise<{ sessions: RemoteSessionItem[]; error?: string; homeDir?: string }> => {
    const cached = remoteListCache.get(host.alias)
    if (cached !== undefined && Date.now() - cached.at < 15_000) return cached.payload
    const driver = hostDriverFor(host, config.sshCommand)
    const health = await driver.check()
    if (!health.ok) {
      // 失败不缓存——用户在服务器装好 tmux/kimi 后，下一次点击即应重试。
      return { sessions: [], error: health.detail }
    }
    // 探针会话名的随机段放在 alias 前面：sanitize 截断 48 字符时长 alias 会把尾部随机段
    // 吃掉，探针撞名共享 pane（相互串扰）。随机段在前则截断只砍 alias。
    const probeSession = sanitizeSessionName(`frostfin-v2-probe-${randomUUID().slice(0, 8)}-${host.alias}`)
    try {
      // 只在 command 是默认裸名 'kimi' 时用解析出的绝对路径（显式自定义优先）。
      const kimiCommand = health.kimiPath !== undefined && config.command === 'kimi' ? health.kimiPath : config.command
      const spawnSpec = driver.agentSpawnSpec(probeSession, kimiCommand, config.args)
      const proc = await startAcpProcess({
        command: spawnSpec.command,
        args: spawnSpec.args,
        // 本地 spawn 的 cwd 必须本地存在；newSession 的 cwd 必须是远程存在的
        // 路径（远程 home 必然存在）——两者解耦，混用会 ENOENT/internal error。
        cwd: process.cwd(),
        sessionCwd: health.homeDir ?? '/tmp',
        permission: 'allow',
        disposeEofGraceMs: config.disposeEofGraceMs,
        disposeGraceMs: config.disposeGraceMs,
        spawn: spec => ctx.subprocess.spawn(spec),
        onSessionUpdate: () => {},
      })
      try {
        const sessions = await proc.listSessions()
        // 双写防护提示：同工作区有活 kimi（tmux 前台）的会话打 held 标记，
        // 面板接入前弹确认——两个进程共写一份会话记录会交错分叉。
        const liveCwds = await driver.probeLiveCwds()
        const payload = {
          sessions: sessions
            // 探针自己的握手会话（无标题、即弃即删）不进列表——不然每次连接都闪现一条垃圾。
            .filter(session => session.sessionId !== proc.sessionId)
            .map(session => {
              // 绑定态标注（只认本台主机的绑定）：面板据此显示「已接入/打开」、
              // 隐藏删除；open-remote/delete-session 的服务端守卫也用同一事实源。
              const boundDshId = kimiMap.keyOf(session.sessionId)
              return {
                sessionId: session.sessionId,
                title: session.title ?? null,
                cwd: session.cwd,
                updatedAt: session.updatedAt ?? null,
                ...boundDshId !== undefined && kimiMap.getHost(boundDshId) === host.alias ? { boundDshId } : {},
                ...liveCwds.includes(session.cwd) ? { held: true as const } : {},
              }
            }),
          // 远程 home 给「新建会话」当默认工作区。
          ...health.homeDir === undefined ? {} : { homeDir: health.homeDir },
        }
        remoteListCache.set(host.alias, { at: Date.now(), payload })
        return payload
      } finally {
        // 探针握手的空会话即建即删（不然每次连接都在远程留一个"无标题"垃圾会话）。
        await proc.deleteSession().catch(() => {})
        await proc.dispose().catch(() => {})
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      // 裸 JSON-RPC internal error 没有任何信息——补上最可能的因由提示。
      const hint = message === 'Internal error' ? '（kimi 在远程拒绝了握手：请在该主机跑一次 kimi 确认登录态）' : ''
      return { sessions: [], error: `连接 ${host.alias} 失败：${message}${hint}` }
    } finally {
      // 探针 pane 收尾覆盖一切 outcome（含握手失败——kimi 未登录时 startAcpProcess
      // 抛错但 pane 已经建好）。killSession 永不 reject。
      await driver.killSession(probeSession)
    }
  }

  const disposeRemoteSessions = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/remote-sessions',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const alias = url.searchParams.get('host') ?? ''
      const host = loadSshHosts(config.sshConfigFile).find(candidate => candidate.alias === alias)
      if (host === undefined) {
        send(res, 404, { sessions: [], error: `ssh 配置里找不到主机 "${alias}"` })
        return
      }
      send(res, 200, await listRemote(host))
    },
  })

  // 远程线：接入一个远程 kimi 会话（远程 cwd 来自列表缓存/实时列表）。
  const disposeOpenRemote = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/open-remote',
    handler: async (req, res) => {
      try {
        const body = await readBody(req) as { host?: unknown; kimiSessionId?: unknown }
        const alias = typeof body.host === 'string' ? body.host : ''
        const kimiSessionId = typeof body.kimiSessionId === 'string' ? body.kimiSessionId : ''
        const host = loadSshHosts(config.sshConfigFile).find(candidate => candidate.alias === alias)
        if (host === undefined || !kimiSessionId.startsWith('session_')) {
          send(res, 400, { error: '需要合法的 { host, kimiSessionId }（session_ 开头）' })
          return
        }
        // 幂等：该 kimi 会话已绑定过——同主机直接返回既有 DSH 会话；
        // 绑在别处（另一台主机/本地）拒绝——两个 DSH 会话驱动同一 kimi 会话 = 双写分叉。
        const existing = kimiMap.keyOf(kimiSessionId)
        if (existing !== undefined) {
          if (kimiMap.getHost(existing) === alias) {
            send(res, 200, { sessionId: existing, reused: true })
            return
          }
          send(res, 409, { error: `该 kimi 会话已绑定在别处（${kimiMap.getHost(existing) ?? '本地'}）的 DSH 会话上` })
          return
        }
        const listing = await listRemote(host)
        const entry = listing.sessions.find(item => item.sessionId === kimiSessionId)
        if (entry === undefined) {
          send(res, 404, { error: listing.error ?? `主机 ${alias} 上找不到 kimi 会话 ${kimiSessionId}` })
          return
        }
        const sessionId = `session-${randomUUID()}` as SessionId
        const handle = await ctx.agents.create({
          sessionId,
          // frostfinHost 是 frostfin 的私有 meta 键（工厂在 createAgent 里按它解析远程主机）；
          // DSH 的 meta 类型面是封闭形，这里按扩展键显式断言。
          meta: { cwd: entry.cwd, agentPreset: FROSTFIN_PRESET_ID, frostfinHost: alias } as { readonly cwd: string; readonly agentPreset: string },
          setup: async (agentCtx) => {
            await ctx.get('agentPresets')?.mount(agentCtx, FROSTFIN_PRESET_ID)
          },
        })
        if (!(handle.agent instanceof FrostfinAgent)) {
          throw new Error('新建会话未路由到 frostfin（请检查月芒霜鳍鲸模式是否启用）')
        }
        const turns = await handle.agent.attachKimiSession(kimiSessionId)
        // 接入改变了绑定态——失效列表缓存，下次列表该行带「已接入」。
        remoteListCache.delete(alias)
        logger.info('frostfin: 面板接入远程 kimi 会话 %s@%s → DSH 会话 %s（%d 个回放 turn）', kimiSessionId, alias, sessionId, turns)
        send(res, 200, { sessionId, reused: false, replayTurns: turns })
      } catch (error: unknown) {
        send(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // 远程线：在某台主机上新建 kimi 会话（不带 kimiSessionId 的远程绑定——
  // 首个 prompt 时才真正 spawn，kimi 会话在远程随之创建）。
  const disposeNewRemote = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/new-remote',
    handler: async (req, res) => {
      try {
        const body = await readBody(req) as { host?: unknown; cwd?: unknown }
        const alias = typeof body.host === 'string' ? body.host : ''
        const host = loadSshHosts(config.sshConfigFile).find(candidate => candidate.alias === alias)
        if (host === undefined) {
          send(res, 404, { error: `ssh 配置里找不到主机 "${alias}"` })
          return
        }
        const listing = await listRemote(host)
        if (listing.error !== undefined) {
          send(res, 502, { error: listing.error })
          return
        }
        const rawCwd = typeof body.cwd === 'string' && body.cwd.trim() !== ''
          ? body.cwd.trim()
          : (listing.homeDir ?? '/tmp')
        // 展开 ~：kimi 校验远程 cwd 必须真实存在，而 JSON-RPC 参数不经 shell、~ 不会展开（实测）。
        const cwd = expandRemoteHome(rawCwd, listing.homeDir)
        const sessionId = `session-${randomUUID()}` as SessionId
        const handle = await ctx.agents.create({
          sessionId,
          // frostfinHost 是 frostfin 的私有 meta 键（工厂在 createAgent 里按它解析远程主机）；
          // DSH 的 meta 类型面是封闭形，这里按扩展键显式断言。
          meta: { cwd, agentPreset: FROSTFIN_PRESET_ID, frostfinHost: alias } as { readonly cwd: string; readonly agentPreset: string },
          setup: async (agentCtx) => {
            await ctx.get('agentPresets')?.mount(agentCtx, FROSTFIN_PRESET_ID)
          },
        })
        if (!(handle.agent instanceof FrostfinAgent)) {
          throw new Error('新建会话未路由到 frostfin（请检查月芒霜鳍鲸模式是否启用）')
        }
        logger.info('frostfin: 面板新建远程会话 → DSH 会话 %s（主机 %s，工作区 %s）', sessionId, alias, cwd)
        send(res, 200, { sessionId, cwd })
      } catch (error: unknown) {
        send(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  /**
   * 删除 kimi 会话（本地/远程共用）：起一个一次性 kimi acp 探针执行 session/delete，
   * 自删握手会话后收尸；远程探针 pane 在任何 outcome 下都杀（含握手失败）。
   * 已绑定 DSH 的会话服务端直接 409（面板侧也拦，双保险）。kimi 太旧不支持
   * session/delete 时给 409 + 人话指引。
   */
  const disposeDeleteSession = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/delete-session',
    handler: async (req, res) => {
      try {
        const body = await readBody(req) as { host?: unknown; kimiSessionId?: unknown }
        const kimiSessionId = typeof body.kimiSessionId === 'string' ? body.kimiSessionId : ''
        if (!kimiSessionId.startsWith('session_')) {
          send(res, 400, { error: 'kimiSessionId 必须是 session_ 开头的 kimi 会话 id' })
          return
        }
        // 绑定守卫：已接入 DSH 的会话不删（先删 DSH 侧对应会话）。
        if (kimiMap.keyOf(kimiSessionId) !== undefined) {
          send(res, 409, { error: '该会话已接入 DSH——请先在左侧会话列表删除对应会话' })
          return
        }
        const alias = typeof body.host === 'string' && body.host !== '' ? body.host : undefined
        const host = alias === undefined
          ? undefined
          : loadSshHosts(config.sshConfigFile).find(candidate => candidate.alias === alias)
        if (alias !== undefined && host === undefined) {
          send(res, 404, { error: `ssh 配置里找不到主机 "${alias}"` })
          return
        }

        // 组装探针 spawn：远程走 ssh+tmux shim（体检解析 kimi 绝对路径），本地直起——驱动层收口。
        const driver = hostDriverFor(host, config.sshCommand)
        const health = await driver.check()
        if (!health.ok) {
          send(res, 502, { error: health.detail })
          return
        }
        const kimiCommand = health.kimiPath !== undefined && config.command === 'kimi' ? health.kimiPath : config.command
        const probeSession = sanitizeSessionName(`frostfin-v2-probe-${randomUUID().slice(0, 8)}-${host?.alias ?? 'local'}`)
        const spawnSpec = driver.agentSpawnSpec(probeSession, kimiCommand, config.args)
        try {
          const proc = await startAcpProcess({
            command: spawnSpec.command,
            args: spawnSpec.args,
            cwd: process.cwd(),
            // 远程握手 cwd 用远程 home（必然存在）；本地用本机 home。
            sessionCwd: health.homeDir ?? (host === undefined ? homedir() : '/tmp'),
            permission: 'allow',
            disposeEofGraceMs: config.disposeEofGraceMs,
            disposeGraceMs: config.disposeGraceMs,
            spawn: spec => ctx.subprocess.spawn(spec),
            onSessionUpdate: () => {},
          })
          try {
            const deleted = await proc.deleteSessionById(kimiSessionId)
            if (!deleted) {
              send(res, 409, { error: 'kimi 拒绝了删除（会话可能已不存在；若 kimi 版本太旧不支持 session/delete，先点「更新 kimi」）' })
              return
            }
            logger.info('frostfin: 面板删除 kimi 会话 %s（%s）', kimiSessionId, host === undefined ? '本地' : host.alias)
            // 远程列表有 15 秒缓存——删掉它的缓存，删完立即可见。
            if (host !== undefined) remoteListCache.delete(host.alias)
            send(res, 200, { ok: true })
          } finally {
            await proc.deleteSession().catch(() => {})
            await proc.dispose().catch(() => {})
          }
        } finally {
          // 探针 pane 收尾覆盖一切 outcome（含握手失败——pane 已建但 startAcpProcess 抛错）。
          // 本地探针无 pane，killSession 是静默 no-op。
          await driver.killSession(probeSession)
        }
      } catch (error: unknown) {
        send(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  /**
   * 传文件到远程会话的服务器（后端 scp）：body { sessionId, paths: string[], dest? }。
   * 只收本地存在的普通文件；dest 默认 /tmp/frostfin-uploads（白名单绝对路径字符）。
   * 任务是异步的：POST 立即回 jobId，进度走 GET upload-progress 轮询
   * （大文件传几分钟，同步 POST 会挂着超时）。
   */
  interface UploadJob {
    state: 'running' | 'done' | 'error'
    bytesDone: number
    bytesTotal: number
    fileIndex: number
    fileCount: number
    currentFile: string
    files: string[]
    error?: string
    updatedAt: number
  }
  const uploadJobs = new Map<string, UploadJob>()

  const disposeUploadRemote = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/upload-remote',
    handler: async (req, res) => {
      try {
        const body = await readBody(req) as { sessionId?: unknown; paths?: unknown; dest?: unknown }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const agent = ctx.agents.get(sessionId as SessionId)
        if (!(agent instanceof FrostfinAgent)) {
          send(res, 404, { ok: false, error: '会话不存在或不是 frostfin 驱动' })
          return
        }
        const host = agent.remoteHost
        if (host === undefined) {
          send(res, 400, { ok: false, error: '本地会话无需上传——文件本来就在本机' })
          return
        }
        const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string' && p !== '') : []
        if (paths.length === 0) {
          send(res, 400, { ok: false, error: 'paths 不能为空' })
          return
        }
        const missing = paths.filter(p => !existsSync(p) || !statSync(p).isFile())
        if (missing.length > 0) {
          send(res, 400, { ok: false, error: `不是本地存在的普通文件：${missing.join('、')}` })
          return
        }
        const dest = typeof body.dest === 'string' && body.dest.trim() !== '' ? body.dest.trim() : '/tmp/frostfin-uploads'
        if (!/^\/[\w./-]+$/.test(dest)) {
          send(res, 400, { ok: false, error: '目标目录必须是安全的绝对路径（仅字母数字与 ./-_）' })
          return
        }
        // 顺带清扫 10 分钟前的旧任务（注册表是进程内存，不持久化）。
        const now = Date.now()
        for (const [id, job] of uploadJobs) {
          if (now - job.updatedAt > 600_000) uploadJobs.delete(id)
        }
        const jobId = randomUUID()
        const job: UploadJob = { state: 'running', bytesDone: 0, bytesTotal: 0, fileIndex: 0, fileCount: paths.length, currentFile: '', files: [], updatedAt: now }
        uploadJobs.set(jobId, job)
        send(res, 200, { ok: true, jobId })
        void hostDriverFor(host, config.sshCommand, config.scpCommand).uploadLocal(paths, dest, (progress) => {
          Object.assign(job, progress, { updatedAt: Date.now() })
        }).then((files) => {
          job.state = 'done'
          job.files = files
          job.updatedAt = Date.now()
          logger.info('frostfin: 面板上传 %d 个文件到 %s:%s', files.length, host.alias, dest)
        }).catch((error: unknown) => {
          job.state = 'error'
          job.error = error instanceof Error ? error.message : String(error)
          job.updatedAt = Date.now()
          logger.warn('frostfin: 面板上传失败（%s:%s）：%s', host.alias, dest, job.error)
        })
      } catch (error: unknown) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  /** 上传进度轮询：GET /plugins/frostfin/upload-progress?jobId=… → 任务快照。 */
  const disposeUploadProgress = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/upload-progress',
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const job = uploadJobs.get(url.searchParams.get('jobId') ?? '')
      if (job === undefined) {
        send(res, 404, { ok: false, error: '任务不存在（可能已过期清扫）' })
        return
      }
      send(res, 200, { ok: true, ...job })
    },
  })

  /**
   * 传文件选择器的目录列举：GET /plugins/frostfin/ls?dir=…（缺省主目录；支持 ~ 展开）。
   * 只允许主目录子树——本机 HTTP 没有会话鉴权，不能给浏览器侧任意探盘的口子。
   * 排序：目录按名称；文件按 mtime 新的在前（「下载里最新的几个」是主要场景）。
   */
  const disposeLs = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/ls',
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const raw = url.searchParams.get('dir') ?? '~'
      const expanded = raw === '~' ? homedir() : raw.startsWith(`~${sep}`) || raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
      const dir = resolve(expanded)
      const home = homedir()
      if (dir !== home && !dir.startsWith(home + sep)) {
        send(res, 403, { ok: false, error: '只允许浏览主目录以内的路径' })
        return
      }
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch (error: unknown) {
        send(res, 400, { ok: false, error: `目录读不到：${error instanceof Error ? error.message : String(error)}` })
        return
      }
      const dirs: string[] = []
      const files: { name: string; size: number; mtime: number }[] = []
      for (const name of names) {
        try {
          const st = statSync(join(dir, name)) // statSync 跟随软链；断链/无权限的条目直接跳过
          if (st.isDirectory()) dirs.push(name)
          else if (st.isFile()) files.push({ name, size: st.size, mtime: st.mtimeMs })
        } catch { /* 跳过坏条目 */ }
      }
      dirs.sort((x, y) => x.localeCompare(y))
      files.sort((x, y) => y.mtime - x.mtime)
      const truncated = dirs.length > 500 || files.length > 500
      send(res, 200, {
        ok: true,
        dir,
        parent: dir === home ? null : dirname(dir),
        dirs: dirs.slice(0, 500),
        files: files.slice(0, 500),
        truncated,
      })
    },
  })

  /**
   * 工作区文件面（文件树 tab 与 @ 补全共用）：
   * - GET /plugins/frostfin/files?sessionId&dir —— 单层列举（dir 相对会话 cwd，缺省根）
   * - GET /plugins/frostfin/complete?sessionId&q —— 递归模糊搜索（相对路径子串，剪枝重型目录）
   * 范围锁在会话 cwd 子树内；本地 sh、远程 ssh 经 driver.execProbe 跑同一段
   * POSIX 脚本（一视同仁）。尺寸用 wc -c 拿（绕开 GNU/BSD stat 的格式分歧）。
   */
  const workspaceOf = (sessionId: string): { cwd: string; driver: HostDriver } | undefined => {
    const agent = ctx.agents.get(sessionId as SessionId)
    if (!(agent instanceof FrostfinAgent)) return undefined
    const status = agent.getKimiStatus()
    if (status.cwd === undefined || status.cwd.trim() === '') return undefined
    const host = status.host === undefined ? undefined : loadSshHosts(config.sshConfigFile).find(candidate => candidate.alias === status.host)
    if (status.host !== undefined && host === undefined) return undefined
    return { cwd: status.cwd.replace(/\/+$/, ''), driver: hostDriverFor(host, config.sshCommand) }
  }
  const NOENT = '__FROSTFIN_NOENT__'
  const disposeFiles = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/files',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const ws = workspaceOf(url.searchParams.get('sessionId') ?? '')
      if (ws === undefined) {
        send(res, 404, { ok: false, error: '会话不存在、不是 frostfin 驱动或暂无工作区' })
        return
      }
      const rel = posix.normalize(url.searchParams.get('dir') ?? '.')
      if (rel.startsWith('/') || rel === '..' || rel.startsWith('../')) {
        send(res, 403, { ok: false, error: '只允许浏览会话工作区以内的路径' })
        return
      }
      const abs = rel === '.' ? ws.cwd : `${ws.cwd}/${rel}`
      const script = [
        `cd ${shQuote(abs)} 2>/dev/null || { echo ${NOENT}; exit 0; }`,
        // * 之外补两个点文件 glob；无匹配时 glob 保持字面，-e 闸跳过。
        `for f in * .[!.]* ..?*; do [ -e "$f" ] || continue; if [ -d "$f" ]; then printf 'd\\t%s\\n' "$f"; else s=$(wc -c < "$f" 2>/dev/null || echo 0); printf 'f\\t%s\\t%s\\n' "$s" "$f"; fi; done`,
      ].join('\n')
      const probe = await ws.driver.execProbe(script, 15_000)
      if (probe.error !== null) {
        send(res, 502, { ok: false, error: probe.stderr.trim() || probe.error.message })
        return
      }
      if (probe.stdout.includes(NOENT)) {
        send(res, 404, { ok: false, error: `目录不存在：${rel}` })
        return
      }
      const dirs: string[] = []
      const files: { name: string; size: number }[] = []
      for (const line of probe.stdout.split('\n')) {
        const parts = line.split('\t')
        if (parts[0] === 'd' && parts.length >= 2) dirs.push(parts.slice(1).join('\t'))
        else if (parts[0] === 'f' && parts.length >= 3) {
          const size = Number(parts[1]!.trim())
          files.push({ name: parts.slice(2).join('\t'), size: Number.isFinite(size) ? size : 0 })
        }
      }
      dirs.sort((x, y) => x.localeCompare(y))
      files.sort((x, y) => x.name.localeCompare(y.name))
      const parent = rel === '.' ? null : posix.dirname(rel)
      send(res, 200, { ok: true, dir: rel, parent, dirs, files })
    },
  })
  const disposeComplete = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/complete',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const ws = workspaceOf(url.searchParams.get('sessionId') ?? '')
      if (ws === undefined) {
        send(res, 404, { ok: false, error: '会话不存在、不是 frostfin 驱动或暂无工作区' })
        return
      }
      const q = (url.searchParams.get('q') ?? '').trim()
      if (q === '') {
        send(res, 200, { ok: true, entries: [] })
        return
      }
      // 远端 grep 粗筛（200 行）→ 本地排名（basename 命中优先、短路径优先）取前 20。
      const script = [
        `cd ${shQuote(ws.cwd)} 2>/dev/null || { echo ${NOENT}; exit 0; }`,
        `find . \\( -name .git -o -name node_modules -o -name .next -o -name dist -o -name __pycache__ -o -name .venv -o -name venv -o -name target -o -name .cache \\) -prune -o -type f -print 2>/dev/null | grep -i -F -e ${shQuote(q)} | head -200`,
      ].join('\n')
      const probe = await ws.driver.execProbe(script, 20_000)
      if (probe.error !== null) {
        send(res, 502, { ok: false, error: probe.stderr.trim() || probe.error.message })
        return
      }
      if (probe.stdout.includes(NOENT)) {
        send(res, 404, { ok: false, error: '工作区目录不存在' })
        return
      }
      const lq = q.toLowerCase()
      const entries = probe.stdout.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('./'))
        .map(line => line.slice(2))
        .filter(path => path !== '' && !path.includes('\t'))
        .map(path => ({ path, dir: posix.dirname(path) === '.' ? '' : posix.dirname(path), name: posix.basename(path) }))
        .sort((a, b) => {
          const tierA = a.name.toLowerCase().includes(lq) ? 0 : 1
          const tierB = b.name.toLowerCase().includes(lq) ? 0 : 1
          return tierA - tierB || a.path.length - b.path.length || a.path.localeCompare(b.path)
        })
        .slice(0, 20)
      send(res, 200, { ok: true, entries })
    },
  })

  // 更新 kimi Code 到最新版：无 host 更新本机，有 host 经 ssh 更新对应服务器。
  // 优先 `kimi update`；遇到"该平台不支持自动更新"（如 Linux 原生包）回退官方安装脚本。
  const disposeUpdateKimi = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/update-kimi',
    handler: async (req, res) => {
      try {
        const body = await readBody(req) as { host?: unknown }
        const alias = typeof body.host === 'string' && body.host !== '' ? body.host : undefined
        if (alias === undefined) {
          const result = await updateKimiOn(undefined, config)
          // 更新成功后失效版本缓存——客户端紧接着的刷新要看到新版本。
          if (result.ok) versionCache.delete('')
          send(res, result.ok ? 200 : 500, result)
          return
        }
        const host = loadSshHosts(config.sshConfigFile).find(candidate => candidate.alias === alias)
        if (host === undefined) {
          send(res, 404, { error: `ssh 配置里找不到主机 "${alias}"` })
          return
        }
        const result = await updateKimiOn(host, config)
        if (result.ok) versionCache.delete(alias)
        send(res, result.ok ? 200 : 500, result)
      } catch (error: unknown) {
        send(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // kimi 版本探针：当前版本 + 最新版本（本地/远程共用，60 秒缓存）。
  const disposeKimiVersion = webServer.register({
    kind: 'exact',
    path: '/plugins/frostfin/kimi-version',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const alias = url.searchParams.get('host') ?? ''
      const host = alias === '' ? undefined : loadSshHosts(config.sshConfigFile).find(candidate => candidate.alias === alias)
      if (alias !== '' && host === undefined) {
        send(res, 404, { ok: false, error: `ssh 配置里找不到主机 "${alias}"` })
        return
      }
      send(res, 200, await kimiVersionOf(host, config))
    },
  })

  logger.info('frostfin: 面板端点已注册（kimi-sessions / open / logo.png / status / reconnect / set-config / pending-questions / answer-question / remote-hosts / remote-sessions / open-remote / new-remote / delete-session / upload-remote / upload-progress / ls / files / complete / update-kimi / kimi-version）')
  return () => {
    disposeList()
    disposeLogo()
    disposeStatus()
    disposeReconnect()
    disposeSetConfig()
    disposeOpen()
    disposePending()
    disposeAnswer()
    disposeRemoteHosts()
    disposeRemoteSessions()
    disposeOpenRemote()
    disposeNewRemote()
    disposeDeleteSession()
    disposeUploadRemote()
    disposeUploadProgress()
    disposeLs()
    disposeFiles()
    disposeComplete()
    disposeUpdateKimi()
    disposeKimiVersion()
  }
}
