// kimi 名义路由 + 惰性启动 + 错误浮现的端到端测试。
import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bootPlugin, fakeRouteServices, runOneTurn } from './helpers.mjs'

test('名义路由：注册适配器，且不碰部署级默认模型', async (t) => {
  const routeFakes = fakeRouteServices()
  const { ctx, fiber } = await bootPlugin({ advertiseKimiRoute: true, routeFakes })
  t.after(async () => {
    try { await fiber.dispose() } catch { /* 已 dispose */ }
    try { await ctx.fiber.dispose() } catch { /* 已 dispose */ }
  })

  // 适配器在册（模型选择器可见、onboarding 的 providerUsable 通过）
  assert.deepEqual([...routeFakes.llm.routes], ['kimi-code'])
  // 部署级默认模型不被劫持：frostfin 会话的路由由种子日志携带（会话级事实）
  assert.deepEqual(routeFakes.agentDefaultModel.current, { provider: 'deepseek-official', model: 'deepseek-chat' })
  assert.deepEqual(routeFakes.agentDefaultModel.saved, [])

  // 卸载插件：适配器释放
  await fiber.dispose()
  assert.deepEqual([...routeFakes.llm.routes], [])
})

test('惰性启动：createAgent 不起 kimi 进程，首个 prompt 后才登记绑定', async (t) => {
  let spawns = 0
  const { ctx } = await bootPlugin({ onSpawn: () => { spawns += 1 } })
  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: process.cwd() },
  })
  t.after(async () => {
    await handle.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  })

  // 创建即返回，没有起进程、没有绑定
  assert.equal(spawns, 0)
  assert.equal(handle.agent.boundKimiSessionId, undefined)

  await runOneTurn(handle.agent, createUserMessage({
    content: [{ type: 'text', text: '打个招呼' }],
    source: { kind: 'user' },
  }))

  // 首个 prompt 触发 spawn + 握手 + 绑定（fixture 的握手会话 id）
  assert.equal(spawns, 1)
  assert.equal(handle.agent.boundKimiSessionId, 'scripted-session-1')
})

test('kimi 未就绪：错误在发送时以对话内指引浮现（turn error + 可见消息）', async (t) => {
  // 指向不存在的命令：spawn 即失败，模拟"kimi 未安装/未就绪"。
  const { ctx } = await bootPlugin({ command: '/nonexistent-kimi-cli' })
  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: process.cwd() },
  })
  t.after(async () => {
    await handle.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  })

  // 创建会话本身不报错（惰性启动）
  const events = await runOneTurn(handle.agent, createUserMessage({
    content: [{ type: 'text', text: '你好' }],
    source: { kind: 'user' },
  }))

  const turnEnd = events.filter(event => event.type === 'turn/end').at(-1)
  assert.equal(turnEnd.data.reason.kind, 'error')
  const guidance = events.find(event => event.type === 'assistant/message')
  assert.ok(guidance !== undefined, '失败时应落一条用户可见的指引消息')
  const text = guidance.data.message.content[0].text
  assert.match(text, /frostfin 暂时无法驱动 kimi Code/)
  assert.match(text, /kimi login/)
})
