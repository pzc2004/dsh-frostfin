// 模型目录与选择转发：kimi 上报的真实模型进 DSH 选择器；DSH 侧的选择转发给 kimi。
import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bootPlugin, fakeRouteServices, runOneTurn } from './helpers.mjs'

function prompt(text = '打个招呼') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

test('模型目录：kimi 握手上报的真实模型列表进入名义路由的 listModels', async (t) => {
  const routeFakes = fakeRouteServices()
  const { ctx } = await bootPlugin({ advertiseKimiRoute: true, routeFakes })
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })

  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: process.cwd() },
  })
  t.after(async () => { await handle.dispose().catch(() => {}) })

  // 适配器在 fake llm 里；此时还没有任何会话上报——应是兜底条目
  const adapter = routeFakes.llm.adapters.get('kimi-code')
  const before = await adapter.listModels('kimi-code')
  assert.equal(before.length, 1)
  assert.equal(before[0].id, 'kimi-for-coding')

  await runOneTurn(handle.agent, prompt())

  // 首个 prompt 后：fixture 上报的真实模型进入目录
  const after = await adapter.listModels('kimi-code')
  assert.deepEqual(after.map(m => m.id), ['kimi-for-coding', 'kimi-plain', 'relay/deepseek-v4-pro'])
})

test('选择转发：DSH 侧选了 kimi 目录里的模型 → 转发给 kimi 并回写 change 路由头', async (t) => {
  const routeFakes = fakeRouteServices()
  // 用户在 DSH 选择器里挑了 kimi-plain（selectModel 会把它存为部署默认）
  routeFakes.agentDefaultModel.current = { provider: 'kimi-code', model: 'kimi-plain' }
  const { ctx } = await bootPlugin({ advertiseKimiRoute: true, routeFakes })
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })

  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: process.cwd() },
  })
  t.after(async () => { await handle.dispose().catch(() => {}) })

  const events = await runOneTurn(handle.agent, prompt())

  // kimi 侧完成了切换：fixture 在模型被切换过时回显
  const text = events
    .filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  assert.match(text, /（model:kimi-plain）/)

  // 日志回写 change 路由头：选择器此时应显示 kimi-plain
  const headers = events.filter(event => event.type === 'request/header')
  assert.ok(headers.some(event => event.data.reason === 'change'
    && event.data.header.config.model === 'kimi-plain'))
})

test('选择转发：DSH 侧选择不属于 kimi 目录时不转发（匹配不上的模型不污染 kimi）', async (t) => {
  const routeFakes = fakeRouteServices()
  routeFakes.agentDefaultModel.current = { provider: 'deepseek-official', model: 'deepseek-chat' }
  const { ctx } = await bootPlugin({ advertiseKimiRoute: true, routeFakes })
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })

  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: process.cwd() },
  })
  t.after(async () => { await handle.dispose().catch(() => {}) })

  const events = await runOneTurn(handle.agent, prompt())

  // 未转发：fixture 无回显；日志无 change 头
  const text = events
    .filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content)
    .map(block => block.text)
    .join('')
  assert.doesNotMatch(text, /model:/)
  assert.equal(events.filter(event => event.type === 'request/header' && event.data.reason === 'change').length, 0)
})

test('选择转发：DS 组的模型映射到 kimi 目录的同名条目（用户配置里的 relay 模型）', async (t) => {
  const routeFakes = fakeRouteServices()
  // 用户在 DSH 选择器里挑了 DeepSeek 组的 v4-pro
  routeFakes.agentDefaultModel.current = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const { ctx } = await bootPlugin({ advertiseKimiRoute: true, routeFakes })
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })

  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: process.cwd() },
  })
  t.after(async () => { await handle.dispose().catch(() => {}) })

  const events = await runOneTurn(handle.agent, prompt())

  // 后缀匹配命中 relay/deepseek-v4-pro 并真的切给 kimi
  const text = events
    .filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content)
    .map(block => block.text)
    .join('')
  assert.match(text, /（model:relay\/deepseek-v4-pro）/)

  const headers = events.filter(event => event.type === 'request/header')
  assert.ok(headers.some(event => event.data.reason === 'change'
    && event.data.header.config.model === 'relay/deepseek-v4-pro'))
})
