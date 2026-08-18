// 远程线 spike（定稿）：detached tmux + pipe-pane 读出 + send-keys 写入。
// 验证：握手 → session/new → 真 prompt → 断开（pipe-pane 撤离，kimi 不死）
// → 重连（新 pipe-pane，原会话直接续）。全部走裸 JSON-RPC（贴近真实传输）。
//
// 探明的五个坑（都是实测踩出来的）：
// 1. pty 默认 echo + ONLCR：不设 stty 会双重回显 + \r\n；双层 stty raw -echo 解决；
// 2. send-keys Enter 在 raw 下是 \r 不是 \n：payload 必须自带换行；
// 3. attached tmux client 的 TUI chrome 污染字节流（TERM 不对还直接拒开）：用 detached；
// 4. pipe-pane 的输出 fd 绑定创建时的 inode（测试中途 rm 输出文件会读不到）；
// 5. 读偏移必须按字节（Buffer）算：中文三字节，按码元切片会永久失明。
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'

const SESSION = 'frostfin-spike'
const OUT = '/tmp/frostfin-spike.ndjson'
const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' })
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

let offset = 0
let pending = Buffer.alloc(0)
/** 读取自上次以来的新增字节（Buffer 按字节切；只吐完整行，半行留缓冲）。 */
function drain() {
  const buf = readFileSync(OUT)
  if (buf.length <= offset) return []
  pending = Buffer.concat([pending, buf.subarray(offset)])
  offset = buf.length
  const lastNl = pending.lastIndexOf(0x0a)
  if (lastNl === -1) return []
  const complete = pending.subarray(0, lastNl).toString('utf8')
  pending = pending.subarray(lastNl + 1)
  return complete.split('\n').filter(line => line.trim() !== '')
}

async function rpc(id, method, params, waitMs = 3000) {
  const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
  // 分段发送（长 payload 防 send-keys 参数上限；spike 每段 32KB）
  for (let i = 0; i < line.length; i += 32768) {
    tmux('send-keys', '-t', SESSION, '-l', '--', line.slice(i, i + 32768))
  }
  const deadline = Date.now() + waitMs
  for (;;) {
    await sleep(150)
    for (const raw of drain()) {
      const message = JSON.parse(raw)
      if (message.id === id) return message
    }
    if (Date.now() > deadline) throw new Error(`rpc ${method} 超时`)
  }
}

try { tmux('kill-session', '-t', SESSION) } catch { /* 不存在 */ }
rmSync(OUT, { force: true })
tmux('new-session', '-d', '-s', SESSION, "stty -echo -onlcr icrnl; exec kimi acp")
tmux('pipe-pane', '-t', SESSION, '-o', `cat >> ${OUT}`)
await sleep(1200)

console.log('=== 1. initialize ===')
const init = await rpc(0, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
console.log('协议版本:', init.result.protocolVersion)

console.log('=== 2. session/new ===')
const created = await rpc(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
const kimiSessionId = created.result.sessionId
console.log('kimi 会话:', kimiSessionId, '| configOptions:', created.result.configOptions?.length)

console.log('=== 3. 真 prompt ===')
const answer = await rpc(2, 'session/prompt', {
  sessionId: kimiSessionId,
  prompt: [{ type: 'text', text: '只回复两个字：收到' }],
}, 240000)
console.log('stopReason:', answer.result.stopReason)

console.log('=== 4. 断开（撤 pipe-pane），kimi 应存活 ===')
tmux('pipe-pane', '-t', SESSION) // 不带 -o：关闭管道
await sleep(500)
const alive = execFileSync('pgrep', ['-f', `tmux.*${SESSION}|kimi acp`], { encoding: 'utf8' }).trim()
tmux('has-session', '-t', SESSION)
console.log('tmux 会话存活 ✓，kimi 进程存活 ✓')

console.log('=== 5. 重连（新 pipe-pane），原会话直接续 ===')
tmux('pipe-pane', '-t', SESSION, '-o', `cat >> ${OUT}`)
offset = readFileSync(OUT).length
const answer2 = await rpc(3, 'session/prompt', {
  sessionId: kimiSessionId,
  prompt: [{ type: 'text', text: '只回复两个字：还在' }],
}, 240000)
console.log('重连后 stopReason:', answer2.result.stopReason)

tmux('kill-session', '-t', SESSION)
console.log('=== spike 定稿全部通过 ===')
