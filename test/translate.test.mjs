// translate.ts 的离线单测：ACP session/update → DSH 会话事件的纯转译。
// 直接驱动构建产物 lib/translate.js，不经任何进程或网络。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acpStopReason, createTranslator, toAcpPrompt } from '../lib/translate.js'

const TURN = 1

/** 取事件类型序列，便于断言次序。 */
function types(events) {
  return events.map(event => event.type)
}

test('agent_message_chunk → assistant/chunk（text-delta，汇入聚合）', () => {
  const translator = createTranslator(TURN)
  translator.begin()
  const events = translator.push({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '你好' },
  })
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], {
    type: 'assistant/chunk',
    turn: TURN,
    step: 1,
    chunk: { type: 'text-delta', index: 1, text: '你好' },
    accumulate: true,
  })
})

test('agent_thought_chunk → assistant/chunk（reasoning-delta）', () => {
  const translator = createTranslator(TURN)
  translator.begin()
  const events = translator.push({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: '先想想' },
  })
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], {
    type: 'assistant/chunk',
    turn: TURN,
    step: 1,
    chunk: { type: 'reasoning-delta', index: 0, text: '先想想' },
    accumulate: true,
  })
})

test('tool_call 到达时先冲刷 assistant/message，再落 tool/call', () => {
  const translator = createTranslator(TURN)
  translator.begin()
  translator.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '读一下文件' } })
  const events = translator.push({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Read file',
    status: 'in_progress',
    rawInput: { path: '/tmp/a.txt' },
  })
  assert.deepEqual(types(events), ['assistant/message', 'tool/call'])
  const message = events[0].message
  assert.equal(message.role, 'assistant')
  assert.deepEqual(message.content, [{ type: 'text', text: '读一下文件' }])
  assert.deepEqual(events[1], {
    type: 'tool/call',
    turn: TURN,
    step: 1,
    callId: 'call-1',
    name: 'Read file',
    arguments: '{"path":"/tmp/a.txt"}',
  })
})

test('流式懒创建：pending 空创建挂起，started 补发带完整入参才落 tool/call', () => {
  const translator = createTranslator(TURN)
  translator.begin()
  translator.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '读一下文件' } })
  // 懒创建：pending、无 rawInput（参数还在流）——不落卡。
  const held = translator.push({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Read file',
    status: 'pending',
    content: [{ type: 'content', content: { type: 'text', text: '{"path' } }],
  })
  assert.deepEqual(types(held), [])
  // started 补发（in_progress + 完整 rawInput）：此刻落卡，完整入参。
  const upgraded = translator.push({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    title: 'Read file',
    status: 'in_progress',
    rawInput: { path: '/tmp/a.txt' },
  })
  assert.deepEqual(types(upgraded), ['assistant/message', 'tool/call'])
  assert.deepEqual(upgraded[1], {
    type: 'tool/call',
    turn: TURN,
    step: 1,
    callId: 'call-1',
    name: 'Read file',
    arguments: '{"path":"/tmp/a.txt"}',
  })
  // 终态：正常落 result + 关 step；全程只落了一条 tool/call。
  const done = translator.push({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: '文件内容' } }],
  })
  assert.deepEqual(types(done), ['tool/result', 'step/end'])
})

test('懒创建直达终态（升级缺席）：防御分支落 call+result', () => {
  const translator = createTranslator(TURN)
  translator.begin()
  translator.push({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Bash',
    status: 'pending',
  })
  const events = translator.push({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    rawInput: { command: 'ls' },
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  })
  assert.deepEqual(types(events), ['tool/call', 'tool/result', 'step/end'])
  assert.equal(events[0].arguments, '{"command":"ls"}')
})

test('tool_call_update 终态 → tool/result；悬挂清零后关闭 step，新内容开新 step', () => {
  const translator = createTranslator(TURN)
  translator.begin()
  translator.push({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Read file',
    status: 'in_progress',
    rawInput: {},
  })
  const events = translator.push({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: '文件内容' } }],
  })
  assert.deepEqual(types(events), ['tool/result', 'step/end'])
  const result = events[0]
  assert.equal(result.callId, 'call-1')
  assert.equal(result.error, undefined)
  assert.equal(result.message.role, 'user')
  assert.equal(result.message.source.kind, 'tool')
  assert.equal(result.message.content[0].type, 'tool-result')
  assert.equal(result.message.content[0].isError, false)
  assert.deepEqual(result.message.content[0].content, [{ type: 'text', text: '文件内容' }])
  assert.deepEqual(events[1], { type: 'step/end', turn: TURN, step: 1 })

  // 工具批次后的文本进入 step 2。
  const next = translator.push({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '读完了' },
  })
  assert.deepEqual(next, [
    { type: 'step/start', turn: TURN, step: 2 },
    {
      type: 'assistant/chunk',
      turn: TURN,
      step: 2,
      chunk: { type: 'text-delta', index: 1, text: '读完了' },
      accumulate: true,
    },
  ])
})

test('失败的工具调用落 isError 的 tool/result 并携带 error 事实', () => {
  const translator = createTranslator(TURN)
  translator.begin()
  translator.push({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-9',
    title: 'Bash',
    status: 'in_progress',
  })
  const events = translator.push({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-9',
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: 'boom' } }],
  })
  assert.deepEqual(types(events), ['tool/result', 'step/end'])
  assert.deepEqual(events[0].error, { name: 'ToolError', code: 'FROSTFIN_TOOL_FAILED' })
  assert.equal(events[0].message.content[0].isError, true)
})

test('非终态 tool_call_update 不落盘', () => {
  const translator = createTranslator(TURN)
  translator.begin()
  translator.push({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 't', status: 'pending' })
  assert.deepEqual(translator.push({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'in_progress' }), [])
})

test('未知 toolCallId 的终态更新先合成 tool/call 再落 tool/result', () => {
  const translator = createTranslator(TURN)
  translator.begin()
  const events = translator.push({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-x',
    status: 'completed',
    title: 'Late call',
    rawInput: { a: 1 },
  })
  assert.deepEqual(types(events), ['tool/call', 'tool/result', 'step/end'])
  assert.equal(events[0].callId, 'call-x')
  assert.equal(events[1].callId, 'call-x')
})

test('close：冲刷聚合消息、给悬挂调用合成错误结果、关 step、落 turn/end', () => {
  const translator = createTranslator(TURN)
  translator.begin()
  translator.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想' } })
  translator.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '说' } })
  translator.push({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 't', status: 'in_progress' })
  const events = translator.close({ kind: 'completed' })
  // 悬挂调用的合成 result 在本 step 内，且 thought+text 已在 tool/call 前冲刷过。
  assert.deepEqual(types(events), ['tool/result', 'step/end', 'turn/end'])
  assert.equal(events[0].message.content[0].isError, true)
  assert.deepEqual(events[0].error, { name: 'AbortError', code: 'FROSTFIN_TOOL_INCOMPLETE' })
  assert.deepEqual(events[2], { type: 'turn/end', turn: TURN, reason: { kind: 'completed' } })
  // close 幂等；closed 后的迟到更新被丢弃。
  assert.deepEqual(translator.close({ kind: 'completed' }), [])
  assert.deepEqual(translator.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '迟到' } }), [])
})

test('close 时 assistant/message 把 reasoning 排在 text 前', () => {
  const translator = createTranslator(TURN)
  translator.begin()
  translator.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正文' } })
  translator.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '推理' } })
  const events = translator.close({ kind: 'completed' })
  assert.deepEqual(types(events), ['assistant/message', 'step/end', 'turn/end'])
  assert.deepEqual(events[0].message.content, [
    { type: 'reasoning', text: '推理' },
    { type: 'text', text: '正文' },
  ])
  assert.deepEqual(events[0].message.source, { kind: 'model', provider: 'kimi-acp', model: 'kimi' })
})

test('stopReason 映射（照抄 subagent-acp run.ts）', () => {
  assert.deepEqual(acpStopReason('end_turn', { kind: 'user' }), { kind: 'completed' })
  assert.deepEqual(acpStopReason('cancelled', { kind: 'user' }), { kind: 'aborted', reason: { kind: 'user' } })
  assert.deepEqual(acpStopReason('max_tokens', { kind: 'user' }), { kind: 'max-tokens' })
  // DSH TurnEndReason 没有 refusal 变体 → error。
  assert.equal(acpStopReason('refusal', { kind: 'user' }).kind, 'error')
  assert.equal(acpStopReason('max_turn_requests', { kind: 'user' }).kind, 'error')
  assert.equal(acpStopReason('某个未来变体', { kind: 'disposed' }).kind, 'error')
})

test('toAcpPrompt 只保留文本块', async () => {
  const messages = [{
    id: 'm1',
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: '第一段' },
      { type: 'tool-result', toolCallId: 'x', content: [], isError: false },
      { type: 'text', text: '第二段' },
    ],
  }]
  assert.deepEqual(await toAcpPrompt(messages), [
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ])
})

const IMAGE_BLOCK = {
  type: 'image',
  attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 2, width: 1, height: 1 },
}

test('toAcpPrompt 图片块：有 resolver 时字节转 base64 透传', async () => {
  const messages = [{
    id: 'm1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '看图' }, IMAGE_BLOCK],
  }]
  const blocks = await toAcpPrompt(messages, async (ref) => {
    assert.equal(ref.attachmentId, 'att-1')
    return { data: 'aGk=', mimeType: ref.mediaType }
  })
  assert.deepEqual(blocks, [
    { type: 'text', text: '看图' },
    { type: 'image', data: 'aGk=', mimeType: 'image/png' },
  ])
})

test('toAcpPrompt 图片块：无 resolver 或读取失败时变文本占位（不静默丢图）', async () => {
  const messages = [{
    id: 'm1', role: 'user', source: { kind: 'user' },
    content: [IMAGE_BLOCK],
  }]
  assert.deepEqual(await toAcpPrompt(messages), [
    { type: 'text', text: '[图片不可用：读取失败或宿主无附件服务]' },
  ])
  assert.deepEqual(await toAcpPrompt(messages, async () => { throw new Error('存储校验失败') }), [
    { type: 'text', text: '[图片不可用：读取失败或宿主无附件服务]' },
  ])
})
