// M2 审批桥端到端：假 approval 服务覆盖 allowed-once / rejected / unavailable，
// 以及 ask 无 approval 服务的回落路径；对端是 scripted ACP 子进程。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bootFrostfin, runOneTurn } from './helpers.mjs'

function prompt(text = '打个招呼') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

const types = (events) => events.map(event => event.type)

test('ask + allowed-once：走完整工具剧本，审批请求的 callId 与落盘 tool/call 对齐', async () => {
  const captured = []
  const { ctx, handle, agent, session } = await bootFrostfin('ask', {
    request: async (req) => { captured.push(req); return 'allowed-once' },
  })

  const events = await runOneTurn(agent, prompt())
  assert.deepEqual(types(events), [
    'turn/start',            // 种子前奏（空 turn 1，携带路由）
    'request/header',
    'turn/end',
    'session/end-seed',
    'agent/inbox/spliced',
    'turn/start',
    'agent/inbox/spliced',
    'step/start',
    'user/message',
    'assistant/chunk',
    'assistant/chunk',
    'assistant/chunk',
    'assistant/message',
    'tool/call',
    'tool/result',
    'step/end',
    'step/start',
    'assistant/chunk',
    'assistant/message',
    'step/end',
    'turn/end',
  ])
  assert.deepEqual(session.events.at(-1).data.reason, { kind: 'completed' })

  // 审批请求事实：agent 本人、工具名、callId、理由、未中止的信号。
  assert.equal(captured.length, 1)
  const req = captured[0]
  assert.equal(req.agent, agent)
  assert.equal(req.toolName, 'Read')
  assert.equal(req.callId, 'tc-1')
  assert.equal(req.reason, 'Read /tmp/x / kind=read')
  assert.ok(req.signal instanceof AbortSignal)
  assert.equal(req.signal.aborted, false)
  // UI 命令预览契约：审批的 callId 必须与落盘 tool/call 的 callId 一致。
  const call = session.events.find(event => event.type === 'tool/call')
  assert.equal(call.data.callId, req.callId)

  await handle.dispose()
  await ctx.fiber.dispose()
})

test('ask + rejected：选中 reject 选项，kimi 走拒绝剧本，无工具事件', async () => {
  const { ctx, handle, agent, session } = await bootFrostfin('ask', {
    request: async () => 'rejected',
  })

  const events = await runOneTurn(agent, prompt())
  assert.equal(types(events).includes('tool/call'), false)
  assert.deepEqual(session.events.at(-1).data.reason, { kind: 'completed' })
  const message = session.events.find(event => event.type === 'assistant/message')
  assert.deepEqual(message.data.message.content, [{ type: 'text', text: 'permission-rejected' }])

  await handle.dispose()
  await ctx.fiber.dispose()
})

test('ask + unavailable：回落 fail-closed（cancelled），turn 以 aborted 收尾', async () => {
  const { ctx, handle, agent, session } = await bootFrostfin('ask', {
    request: async () => 'unavailable',
  })

  const events = await runOneTurn(agent, prompt())
  assert.equal(types(events).includes('tool/call'), false)
  assert.equal(session.events.at(-1).data.reason.kind, 'aborted')

  await handle.dispose()
  await ctx.fiber.dispose()
})

test('ask 但宿主没有 approval 服务：同样回落为 cancelled', async () => {
  const { ctx, handle, agent, session } = await bootFrostfin('ask', undefined)

  const events = await runOneTurn(agent, prompt())
  assert.equal(session.events.at(-1).data.reason.kind, 'aborted')

  await handle.dispose()
  await ctx.fiber.dispose()
})

test('审批悬挂时取消 turn：审批信号随之中止，请求按 cancelled 结算', async () => {
  let seen
  const seenPromise = new Promise(resolve => { seen = resolve })
  let settled
  const settledPromise = new Promise(resolve => { settled = resolve })
  const { ctx, handle, agent, session } = await bootFrostfin('ask', {
    request: (req) => {
      seen(req)
      return new Promise(resolve => {
        req.signal.addEventListener('abort', () => { settled('cancelled'); resolve('cancelled') }, { once: true })
      })
    },
  })

  agent.followup(prompt())
  const req = await seenPromise
  assert.equal(req.signal.aborted, false)
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  // 审批桥的信号合并了 turn 信号：turn 一取消，悬挂的审批立刻按 cancelled 结算。
  assert.equal(await settledPromise, 'cancelled')
  assert.deepEqual(session.events.at(-1).data.reason, { kind: 'aborted', reason: { kind: 'user' } })

  await handle.dispose()
  await ctx.fiber.dispose()
})

test('reject 策略：不经审批桥，直接 cancelled（M1 行为回归）', async () => {
  let asked = 0
  const { ctx, handle, agent, session } = await bootFrostfin('reject', {
    request: async () => { asked++; return 'allowed-once' },
  })

  await runOneTurn(agent, prompt())
  assert.equal(asked, 0)
  assert.equal(session.events.at(-1).data.reason.kind, 'aborted')

  await handle.dispose()
  await ctx.fiber.dispose()
})
