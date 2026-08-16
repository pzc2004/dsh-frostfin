// M3 探针（一次性）：真实 `kimi acp` 的 session/list 与 session/load 回放形态。
// 用法：node scripts/probe-session-load.mjs <kimi-session-id> [更多 id...]
// 会话 id 从命令行传入，不写死在仓库里。
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const DEAD_SESSIONS = process.argv.slice(2)
if (DEAD_SESSIONS.length === 0) {
  console.error('用法: node scripts/probe-session-load.mjs <kimi-session-id> [...]')
  process.exit(1)
}

/** 压缩 payload 便于肉眼读序列。 */
function brief(update) {
  const out = { sessionUpdate: update.sessionUpdate }
  if ('content' in update && update.content?.type === 'text') {
    const text = update.content.text
    out.text = text.length > 80 ? `${text.slice(0, 80)}…(${text.length}chars)` : text
  }
  for (const key of ['toolCallId', 'title', 'name', 'kind', 'status']) {
    if (update[key] !== undefined && update[key] !== null) out[key] = update[key]
  }
  if (update.rawInput !== undefined) out.rawInput = JSON.stringify(update.rawInput)?.slice(0, 100)
  if (update.rawOutput !== undefined) {
    const raw = JSON.stringify(update.rawOutput) ?? ''
    out.rawOutput = raw.length > 100 ? `${raw.slice(0, 100)}…(${raw.length}chars)` : raw
  }
  if (Array.isArray(update.entries)) out.entries = update.entries.length
  return out
}

const child = spawn('kimi', ['acp'], { stdio: ['pipe', 'pipe', 'inherit'] })
const updates = []
const conn = new ClientSideConnection(
  () => ({
    sessionUpdate(params) {
      updates.push(params.update)
      console.log(`[update#${updates.length}]`, JSON.stringify(brief(params.update)))
    },
    requestPermission() {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    },
  }),
  ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
)

const init = await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
console.log('[initialize] capabilities:', JSON.stringify(init.agentCapabilities))

const list = await conn.listSessions({})
console.log('[session/list] count:', list.sessions.length, 'nextCursor:', list.nextCursor ?? null)
for (const s of list.sessions) {
  const mark = DEAD_SESSIONS.includes(s.sessionId) ? '  <== 探针目标' : ''
  console.log(`  - ${s.sessionId}  cwd=${s.cwd}  title=${JSON.stringify(s.title ?? null)}  updatedAt=${s.updatedAt ?? '?'}${mark}`)
}

for (const sessionId of DEAD_SESSIONS) {
  const info = list.sessions.find(s => s.sessionId === sessionId)
  if (info === undefined) {
    console.log(`\n[load] ${sessionId} 不在 list 里，跳过`)
    continue
  }
  console.log(`\n[load] ${sessionId} 开始（cwd=${info.cwd}）`)
  updates.length = 0
  const t0 = Date.now()
  let firstAt = null
  const watcher = setInterval(() => {
    if (firstAt === null && updates.length > 0) firstAt = Date.now() - t0
  }, 1)
  await conn.loadSession({ sessionId, cwd: info.cwd, mcpServers: [] })
  clearInterval(watcher)
  const total = Date.now() - t0
  console.log(`[load] 返回：共 ${updates.length} 条回放 update；首条到达 ${firstAt ?? 'n/a'}ms；loadSession 总计 ${total}ms`)
  console.log('[load] 类型序列:', updates.map(u => u.sessionUpdate).join(' → ') || '(空)')
}

child.stdin.end()
setTimeout(() => child.kill('SIGKILL'), 3000).unref()
await new Promise(resolve => child.on('close', resolve))
console.log('\n[done] 子进程已退出')
process.exit(0)
