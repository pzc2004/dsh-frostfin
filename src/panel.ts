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

/** 面板行：一个磁盘上的 kimi 会话。 */
export interface KimiSessionEntry {
  sessionId: string
  title: string | null
  cwd: string
  updatedAt: string | null
  archived: boolean
  bound: boolean
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

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 注册面板的端点（宿主缺 webServer 服务时整个跳过，如 headless）。
 * M7 增加问题通道两端点：pending-questions（浏览器轮询待答问题）/
 * answer-question（作答回传）。
 * @returns 撤销全部路由的 disposer。
 */
export function registerPanelRoutes(ctx: Context, logger: Logger, kimiMap: KimiSessionMap, questions: QuestionRegistry): () => void {
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

  logger.info('frostfin: 面板端点已注册（kimi-sessions / open / logo.png / status / pending-questions / answer-question）')
  return () => {
    disposeList()
    disposeLogo()
    disposeStatus()
    disposeOpen()
    disposePending()
    disposeAnswer()
  }
}
