// /frostfin-sessions 与 /frostfin-attach 无参引导的命令层测试。
// 通过假 commands 服务捕获注册、直接驱动 handler；对端是 scripted ACP 子进程。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootPlugin, invokeCommand } from './helpers.mjs'

async function bootWithAgent(t) {
  const { ctx, stateFile, commands } = await bootPlugin({ permission: 'allow', withCommands: true })
  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: process.cwd() },
  })
  t.after(async () => {
    await handle.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  })
  return { ctx, commands, agent: handle.agent, session: handle.agent.session, stateFile }
}

test('/frostfin-sessions：updatedAt 倒序渲染，已绑定标注，附用法提示', async (t) => {
  const { commands, agent } = await bootWithAgent(t)

  const result = await invokeCommand(commands, 'frostfin-sessions', agent)
  assert.equal(result.kind, 'success')
  const lines = result.text.split('\n')
  // fixture 三条：dead(11:00) > current(10:00，本进程绑定) > 无标题(前一天)
  assert.match(lines[0], /^1\. scripted dead session · .+ · .+ · session_scripted-dead$/)
  assert.doesNotMatch(lines[0], /已绑定/)
  assert.match(lines[1], /^2\. current scripted session · .+ · .+ · scripted-session-1（已绑定）$/)
  assert.match(lines[2], /^3\. \(无标题\) · .+ · .+ · session_no-title$/)
  // 时间是本地可读格式（宽松断言：含年份）
  assert.match(lines[0], /2026/)
  // 底部用法提示
  assert.equal(lines.at(-1), '接入方式：/frostfin-attach <sessionId>')
})

test('/frostfin-sessions：空列表的文案', async (t) => {
  process.env.FROSTFIN_FIXTURE_EMPTY_LIST = '1'
  t.after(() => { delete process.env.FROSTFIN_FIXTURE_EMPTY_LIST })
  const { commands, agent } = await bootWithAgent(t)

  const result = await invokeCommand(commands, 'frostfin-sessions', agent)
  assert.deepEqual(result, { kind: 'success', text: '本机磁盘上没有 kimi 会话。' })
})

test('/frostfin-attach 无参数：不报错，给用法并引导 /frostfin-sessions', async (t) => {
  const { commands, agent } = await bootWithAgent(t)

  const result = await invokeCommand(commands, 'frostfin-attach', agent, '   ')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /\/frostfin-attach <sessionId>/)
  assert.match(result.text, /\/frostfin-sessions/)
})

test('两条命令对非 frostfin 驱动的会话都报清晰错误', async (t) => {
  const { commands } = await bootWithAgent(t)
  const notFrostfin = { id: 'someone-else' }

  const attach = await invokeCommand(commands, 'frostfin-attach', notFrostfin, 'session_x')
  assert.deepEqual(attach, { kind: 'error', text: '当前会话不是 frostfin 驱动的' })
  const list = await invokeCommand(commands, 'frostfin-sessions', notFrostfin)
  assert.deepEqual(list, { kind: 'error', text: '当前会话不是 frostfin 驱动的' })
})

test('/frostfin-mode：无参报当前模式，合法值切换，非法值报错', async (t) => {
  const { commands, agent } = await bootWithAgent(t)

  // 无参查询（进程未起时为"未知"或当前值）
  const current = await invokeCommand(commands, 'frostfin-mode', agent, '')
  assert.equal(current.kind, 'success')
  assert.match(current.text, /frostfin-mode <default\|plan\|auto\|yolo>/)

  // 切换 yolo 后再查应为 yolo
  const switched = await invokeCommand(commands, 'frostfin-mode', agent, 'yolo')
  assert.equal(switched.kind, 'success')
  const after = await invokeCommand(commands, 'frostfin-mode', agent, '')
  assert.match(after.text, /yolo/)

  const bad = await invokeCommand(commands, 'frostfin-mode', agent, 'godmode')
  assert.equal(bad.kind, 'error')
})

test('/frostfin-thinking：无参报当前档位与可选值，合法值切换，非法值报错', async (t) => {
  const { commands, agent } = await bootWithAgent(t)

  // 无参查询：报当前档位（fixture 默认 high）与全部可选值
  const current = await invokeCommand(commands, 'frostfin-thinking', agent, '')
  assert.equal(current.kind, 'success')
  assert.match(current.text, /high/)
  assert.match(current.text, /off \/ low \/ medium \/ high/)

  // 切换 low 后再查应为 low
  const switched = await invokeCommand(commands, 'frostfin-thinking', agent, 'low')
  assert.equal(switched.kind, 'success')
  const after = await invokeCommand(commands, 'frostfin-thinking', agent, '')
  assert.match(after.text, /当前 thinking 档位：low/)

  const bad = await invokeCommand(commands, 'frostfin-thinking', agent, 'ultra')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /off \/ low \/ medium \/ high/)
})

test('/frostfin-plan：一键进 kimi plan 模式，/frostfin-mode 查询印证', async (t) => {
  const { commands, agent } = await bootWithAgent(t)

  const entered = await invokeCommand(commands, 'frostfin-plan', agent, '')
  assert.equal(entered.kind, 'success')
  assert.match(entered.text, /plan/)

  const after = await invokeCommand(commands, 'frostfin-mode', agent, '')
  assert.match(after.text, /plan/)
})

test('kimi 内建命令透传：/usage 作为用户消息发给 kimi 执行', async (t) => {
  const { commands, agent, session } = await bootWithAgent(t)

  const result = await invokeCommand(commands, 'usage', agent, '')
  assert.equal(result.kind, 'success')

  await agent.whenIdle()
  // kimi（fixture）执行了斜杠命令，回复落在会话日志里
  const messages = session.events.filter(e => e.type === 'assistant/message')
  const text = messages.flatMap(e => e.data.message.content).map(b => b.text).join('')
  assert.match(text, /\[executed\] \/usage/)
})

test('kimi 内建命令对非 frostfin 会话给清晰错误', async (t) => {
  const { commands } = await bootWithAgent(t)
  const result = await invokeCommand(commands, 'usage', { id: 'other' }, '')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /月芒霜鳍鲸/)
})
