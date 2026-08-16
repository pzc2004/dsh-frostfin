// M7 问题通道：AskUserQuestion 的识别、注册表语义、桥分支与端到端（假 webServer 驱动端点作答）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createPermissionBridge } from '../lib/permission.js'
import { QuestionRegistry, extractQuestionText, isKimiQuestion } from '../lib/question.js'
import { bootPlugin, mockGet, mockPost, mockResponse } from './helpers.mjs'

const QUESTION_PARAMS = {
  sessionId: 's1',
  toolCall: {
    toolCallId: 'tc-q1',
    title: 'AskUserQuestion',
    content: [{ type: 'content', content: { type: 'text', text: '选哪个方案？' } }],
  },
  options: [
    { optionId: 'q0_opt_0', name: '方案甲', kind: 'allow_once', _meta: { description: '甲方案的取舍说明' } },
    { optionId: 'q0_opt_1', name: '方案乙', kind: 'allow_once' },
    { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
  ],
}

const APPROVAL_PARAMS = {
  sessionId: 's1',
  toolCall: { toolCallId: 'tc-1', title: 'Read /tmp/x', kind: 'read', name: 'Read' },
  options: [
    { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ],
}

test('isKimiQuestion：title 与 q*_ 命名空间双条件缺一不可', () => {
  assert.equal(isKimiQuestion(QUESTION_PARAMS), true)
  // 普通工具审批：title 不符。
  assert.equal(isKimiQuestion(APPROVAL_PARAMS), false)
  // 真叫 AskUserQuestion 的工具的普通审批（选项不在 q*_ 命名空间）不误截。
  assert.equal(isKimiQuestion({
    ...QUESTION_PARAMS,
    options: APPROVAL_PARAMS.options,
  }), false)
})

test('extractQuestionText：拼接 content 型 text 部件，缺失兜底空串', () => {
  assert.equal(extractQuestionText(QUESTION_PARAMS), '选哪个方案？')
  assert.equal(extractQuestionText(APPROVAL_PARAMS), '')
})

test('QuestionRegistry：ask 挂起 → list 可见 → answer 应答选中项', async () => {
  const registry = new QuestionRegistry()
  const controller = new AbortController()
  const pending = registry.ask('sess-1', QUESTION_PARAMS, controller.signal)
  const list = registry.list('sess-1')
  assert.equal(list.length, 1)
  assert.equal(list[0].question, '选哪个方案？')
  assert.deepEqual(list[0].options.map(o => o.name), ['方案甲', '方案乙', 'Skip'])
  // 预埋管线：_meta.description 透传（上游 kimi 哪天带上，面板即可渲染）
  assert.equal(list[0].options[0].description, '甲方案的取舍说明')
  assert.equal(list[0].options[1].description, undefined)
  assert.equal(registry.list('sess-2').length, 0)
  // 不属于该问题的 optionId 拒绝作答。
  assert.equal(registry.answer(list[0].id, 'yes'), false)
  assert.equal(registry.answer(list[0].id, 'q0_opt_1'), true)
  assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'q0_opt_1' } })
  assert.equal(registry.list('sess-1').length, 0)
})

test('QuestionRegistry：signal 中止按"用户跳过"取消（fail-closed）', async () => {
  const registry = new QuestionRegistry()
  const controller = new AbortController()
  const pending = registry.ask('sess-1', QUESTION_PARAMS, controller.signal)
  controller.abort()
  assert.deepEqual(await pending, { outcome: { outcome: 'cancelled' } })
  assert.equal(registry.list('sess-1').length, 0)
  // 已中止的信号不再挂起。
  assert.deepEqual(await registry.ask('sess-1', QUESTION_PARAMS, controller.signal), { outcome: { outcome: 'cancelled' } })
})

test('QuestionRegistry：cancelAll 取消全部待答（插件卸载路径）', async () => {
  const registry = new QuestionRegistry()
  const pending = registry.ask('sess-1', QUESTION_PARAMS, new AbortController().signal)
  registry.cancelAll()
  assert.deepEqual(await pending, { outcome: { outcome: 'cancelled' } })
  assert.equal(registry.list('sess-1').length, 0)
})

/** 桥的单测装配：假 agent/logger，approval 调用计数。 */
function bridgeDeps({ questions, ask, approval }) {
  const calls = []
  const ctx = approval === undefined
    ? { get: () => undefined }
    : { get: (name) => name === 'approval' ? { request: async (req) => { calls.push(req); return 'allowed-once' } } : undefined }
  return {
    calls,
    deps: {
      agent: { id: 'sess-1' },
      ctx,
      signal: () => new AbortController().signal,
      logger: { warn: () => {} },
      questions,
      ask,
    },
  }
}

test('桥分支：问题进注册表、不碰 approval；与权限策略无关（ask=false 也截）', async () => {
  const registry = new QuestionRegistry()
  const { calls, deps } = bridgeDeps({ questions: registry, ask: false, approval: {} })
  const bridge = createPermissionBridge(deps)
  const pending = bridge(QUESTION_PARAMS)
  // 挂起在注册表里，approval 没被调用。
  assert.equal(calls.length, 0)
  const list = registry.list('sess-1')
  assert.equal(list.length, 1)
  registry.answer(list[0].id, 'q0_opt_0')
  assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'q0_opt_0' } })
})

test('桥分支：非问题请求在 ask=false 时交还自动应答（undefined）', async () => {
  const registry = new QuestionRegistry()
  const { calls, deps } = bridgeDeps({ questions: registry, ask: false, approval: {} })
  const bridge = createPermissionBridge(deps)
  assert.equal(await bridge(APPROVAL_PARAMS), undefined)
  assert.equal(calls.length, 0)
  assert.equal(registry.list('sess-1').length, 0)
})

test('桥分支：非问题请求在 ask=true 时走 approval 服务', async () => {
  const registry = new QuestionRegistry()
  const { calls, deps } = bridgeDeps({ questions: registry, ask: true, approval: {} })
  const bridge = createPermissionBridge(deps)
  assert.deepEqual(await bridge(APPROVAL_PARAMS), { outcome: { outcome: 'selected', optionId: 'yes' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].toolName, 'Read')
})

/** 等条件成立（轮询 20ms，至多 5 秒）。 */
async function waitFor(check, what) {
  const deadline = Date.now() + 5000
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('e2e：kimi 提问 → 注册表挂起 → 端点作答 → kimi 收到选中项（approval 全程未被调用）', async () => {
  const approvalCalls = []
  const { ctx, handle, agent, webServer } = await (async () => {
    const boot = await bootPlugin({
      permission: 'ask',
      approval: { request: async (req) => { approvalCalls.push(req); return 'allowed-once' } },
      withWebServer: true,
    })
    const handle = await boot.ctx.agents.create({
      sessionId: `test-${crypto.randomUUID()}`,
      meta: { cwd: process.cwd() },
    })
    return { ...boot, handle, agent: handle.agent }
  })()

  const pendingRoute = webServer.routes.get('/plugins/frostfin/pending-questions')
  const answerRoute = webServer.routes.get('/plugins/frostfin/answer-question')
  assert.ok(pendingRoute !== undefined && answerRoute !== undefined)

  agent.followup(createUserMessage({ content: [{ type: 'text', text: '帮我提问一下' }], source: { kind: 'user' } }))

  // 等问题挂起（进程 spawn + 握手 + prompt 到位需要时间）。
  const question = await waitFor(() => {
    const res = mockResponse()
    pendingRoute.handler(mockGet(`/plugins/frostfin/pending-questions?sessionId=${agent.id}`), res)
    return res.body.questions[0]
  }, '待答问题出现')
  assert.equal(question.question, '选哪个方案？')
  assert.deepEqual(question.options.map(o => o.name), ['方案甲', '方案乙', 'Skip'])
  assert.equal(question.options[0].description, '甲方案的取舍说明')

  // 作答"方案乙"。
  const answerRes = mockResponse()
  await answerRoute.handler(mockPost({ id: question.id, optionId: 'q0_opt_1' }), answerRes)
  assert.equal(answerRes.status, 200)

  await agent.whenIdle()
  const echo = agent.session.events.find(event =>
    event.type === 'assistant/message' && event.data.message.content.some(part => part.text?.includes('[answer]')))
  assert.ok(echo !== undefined, '应有回显消息')
  assert.ok(echo.data.message.content.some(part => part.text === '[answer] q0_opt_1'))
  assert.equal(approvalCalls.length, 0, '问题不应触碰 approval 服务')

  await handle.dispose()
  await ctx.fiber.dispose()
})

test('e2e：普通审批请求不被问题通道误截（回归）', async () => {
  const approvalCalls = []
  const { ctx, handle, agent, webServer } = await (async () => {
    const boot = await bootPlugin({
      permission: 'ask',
      approval: { request: async (req) => { approvalCalls.push(req); return 'allowed-once' } },
      withWebServer: true,
    })
    const handle = await boot.ctx.agents.create({
      sessionId: `test-${crypto.randomUUID()}`,
      meta: { cwd: process.cwd() },
    })
    return { ...boot, handle, agent: handle.agent }
  })()

  agent.followup(createUserMessage({ content: [{ type: 'text', text: '打个招呼' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  // 普通审批走了 approval 服务，问题列表始终为空。
  assert.equal(approvalCalls.length, 1)
  const pendingRoute = webServer.routes.get('/plugins/frostfin/pending-questions')
  const res = mockResponse()
  pendingRoute.handler(mockGet(`?sessionId=${agent.id}`), res)
  assert.deepEqual(res.body.questions, [])

  await handle.dispose()
  await ctx.fiber.dispose()
})
