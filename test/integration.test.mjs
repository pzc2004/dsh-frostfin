// M1 端到端验证：真实 Cordis 服务（SessionStore + AgentRegistry）+ frostfin 工厂，
// 驱动 test/fixtures 里的 scripted ACP 子进程，断言落盘的事件次序与内容。
// 不经真 kimi，覆盖：ACP 握手、sessionUpdate 路由、turn/step 纪律、dispose 阶梯。
// （fixture 每次 prompt 先发 request_permission；permission=allow 时自动放行。）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bootFrostfin, bootPlugin } from './helpers.mjs'

test('frostfin 接管工厂：一个 prompt 走完 turn/step 全纪律并停稳', async () => {
  const { ctx, handle, agent, session } = await bootFrostfin('allow')

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '打个招呼' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()

  const events = session.events.map(event => event.type)
  assert.deepEqual(events, [
    'turn/start',            // 种子前奏：闭合空 turn 1，只携带 kimi-code 路由
    'request/header',
    'turn/end',
    'session/end-seed',      // 种子自动封口
    'agent/inbox/spliced',   // followup 进收件箱
    'turn/start',            // turn 2（首个 live turn）
    'agent/inbox/spliced',   // 本轮认领队列消息
    'step/start',            // step 1
    'user/message',
    'assistant/chunk',       // reasoning-delta 想一下
    'assistant/chunk',       // text-delta 你好，
    'assistant/chunk',       // text-delta 世界
    'assistant/message',     // tool_call 到达前的聚合冲刷
    'tool/call',
    'tool/result',
    'step/end',
    'step/start',            // step 2
    'assistant/chunk',       // text-delta 读完了
    'assistant/message',     // close 时的聚合冲刷
    'step/end',
    'turn/end',
  ])

  const byType = (type) => session.events.filter(event => event.type === type)
  // turn 括号与结束原因（种子占了 turn 1，首个 live turn 是 turn 2）
  assert.deepEqual(session.events.at(-1).data, { turn: 2, reason: { kind: 'completed' } })
  // 种子里的 request/header：路由指向 kimi-code 名义路由
  const header = byType('request/header')[0]
  assert.equal(header.data.reason, 'initial')
  assert.equal(header.data.header.config.provider, 'kimi-code')
  // step 编号从 1 开始、严格顺序
  assert.deepEqual(byType('step/start').map(event => event.data.step), [1, 2])
  // 聚合消息：reasoning 在前、text 在后，文本完整拼合
  const messages = byType('assistant/message')
  assert.deepEqual(messages[0].data.message.content, [
    { type: 'reasoning', text: '想一下' },
    { type: 'text', text: '你好，世界' },
  ])
  assert.deepEqual(messages[1].data.message.content, [{ type: 'text', text: '读完了' }])
  // assistant/message 的 sourceEventSeqs 引用本 step 的 chunk seq
  assert.ok(messages[0].sourceEventSeqs.length === 3)
  // 工具调用与结果
  const call = byType('tool/call')[0]
  assert.equal(call.data.name, 'Read')
  assert.equal(call.data.arguments, '{"path":"/tmp/x"}')
  const result = byType('tool/result')[0]
  assert.equal(result.data.message.source.callId, call.data.callId)
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.deepEqual(result.data.message.content[0].content, [{ type: 'text', text: '文件内容' }])

  // dispose：agent 出注册表、子进程被收割
  await handle.dispose()
  assert.equal(ctx.agents.get(session.id), undefined)
  assert.equal(ctx.sessions.get(session.id), undefined)

  await ctx.fiber.dispose()
})

test('图片块：经 attachments 服务读字节，以 ACP image 块送达 kimi', async () => {
  const reads = []
  const { ctx, fiber } = await bootPlugin({
    attachments: {
      readImage: async (ref) => { reads.push(ref); return { ref, data: Buffer.from('hi') } },
    },
  })
  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: process.cwd() },
  })
  const { agent } = handle

  agent.followup(createUserMessage({
    content: [
      { type: 'text', text: '看图说话' },
      { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 2, width: 1, height: 1 } },
    ],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()

  // 附件服务被调用了一次（按引用读字节）。
  assert.equal(reads.length, 1)
  assert.equal(reads[0].attachmentId, 'att-1')
  // kimi 侧收到 image 块：'hi' 的 base64 是 'aGk='（长度 4）。
  const echo = agent.session.events.find(event =>
    event.type === 'assistant/message' && event.data.message.content.some(part => part.text?.includes('[image]')))
  assert.ok(echo !== undefined, '应有图片回显消息')
  assert.ok(echo.data.message.content.some(part => part.text === '[image] image/png 4'))

  await handle.dispose()
  await ctx.fiber.dispose()
})
