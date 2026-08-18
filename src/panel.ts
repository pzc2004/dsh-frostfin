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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
import { buildRemoteArgv, checkRemoteHost, remoteTargetOf, sanitizeSessionName } from './remote.js'
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
}

/** kimi 数据目录（$KIMI_CODE_HOME 或 ~/.kimi-code）。 */
function kimiHome(): string {
  const home = process.env.KIMI_CODE_HOME
  return home !== undefined && home.trim() !== '' ? home : join(homedir(), '.kimi-code')
}

/** 包内 assets 目录（lib/panel.js → 包根/assets）。 */
const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

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

/** 跑版本探针并解析（本地与远程共用）。 */
function runKimiVersionProbe(command: string, args: string[]): Promise<KimiVersionInfo> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        resolvePromise({ ok: false, error: `${stdout.trim()} ${stderr.trim()}`.trim() || error.message })
        return
      }
      if (stdout.includes('NO_KIMI')) {
        resolvePromise({ ok: false, error: '找不到 kimi' })
        return
      }
      const current = /^CUR=(.+)$/m.exec(stdout)?.[1]?.trim()
      const latest = /^LAT=(.+)$/m.exec(stdout)?.[1]?.trim()
      resolvePromise({
        ok: true,
        ...current === undefined || current === '' ? {} : { current },
        ...latest === undefined || latest === '' ? {} : { latest },
      })
    })
  })
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
  const probe = versionProbeFor(config)
  const info = host === undefined
    ? await runKimiVersionProbe('sh', ['-c', probe])
    : await runKimiVersionProbe(config.sshCommand, (() => { const t = remoteTargetOf(host); return [...t.sshArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', t.dest, probe] })())
  versionCache.set(key, { at: Date.now(), info })
  return info
}

/** 跑一段 sh 更新流程并汇总结果（本地与远程共用）。 */
function runKimiUpdate(command: string, args: string[]): Promise<UpdateKimiResult> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout.trim()}\n${stderr.trim()}`.trim()
      const version = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(output.split('\n').at(-1) ?? '')?.[1]
      if (error !== null) {
        resolvePromise({ ok: false, output: output !== '' ? output : error.message, ...version === undefined ? {} : { version } })
        return
      }
      if (output.includes('NO_KIMI')) {
        resolvePromise({ ok: false, output: '找不到 kimi（PATH、~/.kimi-code/bin、登录 shell 都没有）' })
        return
      }
      resolvePromise({ ok: true, output, ...version === undefined ? {} : { version } })
    })
  })
}

/** 更新本机 kimi（config.command 是裸名 'kimi' 时走三级解析；自定义命令直接用它）。 */
function updateLocalKimi(config: Config): Promise<UpdateKimiResult> {
  const flow = config.command === 'kimi'
    ? KIMI_UPDATE_FLOW
    : `OUT=$(${config.command} update 2>&1 || true); echo "$OUT"; ${config.command} --version`
  return runKimiUpdate('sh', ['-c', flow])
}

/** 更新一台远程主机的 kimi（经 ssh 跑同一段流程）。 */
function updateRemoteKimi(host: SshHostEntry, config: Config): Promise<UpdateKimiResult> {
  const { dest, sshArgs } = remoteTargetOf(host)
  const flow = config.command === 'kimi'
    ? KIMI_UPDATE_FLOW
    : `OUT=$(${config.command} update 2>&1 || true); echo "$OUT"; ${config.command} --version`
  return runKimiUpdate(config.sshCommand, [...sshArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', dest, flow])
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
      const branch = status.cwd !== undefined ? await gitBranchOf(status.cwd) : undefined
      send(res, 200, { driven: true, ...status, ...branch === undefined ? {} : { branch } })
    },
  })

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
        // 幂等：已绑定过的直接返回既有 DSH 会话。
        const existing = kimiMap.keyOf(kimiSessionId)
        if (existing !== undefined) {
          send(res, 200, { sessionId: existing, reused: true })
          return
        }
        const entry = scanKimiSessions(kimiMap).find(item => item.sessionId === kimiSessionId)
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
    const health = await checkRemoteHost(host, config.sshCommand)
    if (!health.ok) {
      // 失败不缓存——用户在服务器装好 tmux/kimi 后，下一次点击即应重试。
      return { sessions: [], error: health.detail }
    }
    try {
      // 探针会话名带随机后缀：不与历史遗留/并发探针共享 pane（共享会相互串扰——排障实录）。
      const probeSession = sanitizeSessionName(`frostfin-v2-probe-${host.alias}-${randomUUID().slice(0, 8)}`)
      // 只在 command 是默认裸名 'kimi' 时用解析出的绝对路径（显式自定义优先）。
      const kimiCommand = health.kimiPath !== undefined && config.command === 'kimi' ? health.kimiPath : config.command
      const argv = buildRemoteArgv(host, probeSession, `${kimiCommand} ${config.args.join(' ')}`, config.sshCommand)
      const proc = await startAcpProcess({
        command: argv[0]!,
        args: argv.slice(1),
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
        const payload = {
          sessions: sessions.map(session => ({
            sessionId: session.sessionId,
            title: session.title ?? null,
            cwd: session.cwd,
            updatedAt: session.updatedAt ?? null,
          })),
          // 远程 home 给「新建会话」当默认工作区。
          ...health.homeDir === undefined ? {} : { homeDir: health.homeDir },
        }
        remoteListCache.set(host.alias, { at: Date.now(), payload })
        return payload
      } finally {
        // 探针握手的空会话即建即删（不然每次连接都在远程留一个"无标题"垃圾会话）；
        // 探针进程即弃：断 ssh（detach 语义），远程 pane 与 kimi 会话全部保留。
        await proc.deleteSession().catch(() => {})
        await proc.dispose().catch(() => {})
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      // 裸 JSON-RPC internal error 没有任何信息——补上最可能的因由提示。
      const hint = message === 'Internal error' ? '（kimi 在远程拒绝了握手：请在该主机跑一次 kimi 确认登录态）' : ''
      return { sessions: [], error: `连接 ${host.alias} 失败：${message}${hint}` }
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
        const cwd = typeof body.cwd === 'string' && body.cwd.trim() !== ''
          ? body.cwd.trim()
          : (listing.homeDir ?? '/tmp')
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
          const result = await updateLocalKimi(config)
          send(res, result.ok ? 200 : 500, result)
          return
        }
        const host = loadSshHosts(config.sshConfigFile).find(candidate => candidate.alias === alias)
        if (host === undefined) {
          send(res, 404, { error: `ssh 配置里找不到主机 "${alias}"` })
          return
        }
        const result = await updateRemoteKimi(host, config)
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

  logger.info('frostfin: 面板端点已注册（kimi-sessions / open / logo.png / status / pending-questions / answer-question / remote-hosts / remote-sessions / open-remote / new-remote / update-kimi / kimi-version）')
  return () => {
    disposeList()
    disposeLogo()
    disposeStatus()
    disposeOpen()
    disposePending()
    disposeAnswer()
    disposeRemoteHosts()
    disposeRemoteSessions()
    disposeOpenRemote()
    disposeNewRemote()
    disposeUpdateKimi()
    disposeKimiVersion()
  }
}
