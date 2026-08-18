// M3 会话生命周期端到端：映射文件、resume 吞回放、attach 写回放、进程自愈重连。
// 对端是 scripted ACP 子进程（session/list + session/load + 'boom' 崩溃剧本）。
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { foldSurface } from '@deepseek-ai/dsh-session'
import { bootFrostfin, bootPlugin, runOneTurn } from './helpers.mjs'

const DEAD = 'session_scripted-dead'

function prompt(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

const types = (events) => events.map(event => event.type)
// 文件还没创建（尚未有任何写入）按空映射读。
const readMap = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** 一轮已完成 turn 的种子事件（resume 测试的历史）；结尾带 end-seed 标记。 */
function seedTurn() {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type: 'user/message', seq: 2, time: 3, surfaceOp: 'append',
      data: { id: 'm-seed-u', role: 'user', content: [{ type: 'text', text: '历史问题' }], source: { kind: 'user' } },
    },
    {
      type: 'assistant/message', seq: 3, time: 4, surfaceOp: 'append', sourceEventSeqs: [],
      data: {
        turn: 1, step: 1,
        message: { id: 'm-seed-a', role: 'assistant', content: [{ type: 'text', text: '历史回答' }], source: { kind: 'model', provider: 'kimi-acp', model: 'kimi' } },
      },
    },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/end-seed', seq: 6, time: 7, data: {} },
  ]
}

test('首个 prompt 后 kimi 会话绑定写进映射文件（惰性启动）', async () => {
  const { ctx, handle, agent, session, stateFile } = await bootFrostfin('allow')
  // 创建时不写绑定（还没起进程）
  assert.deepEqual(readMap(stateFile), {})
  await runOneTurn(agent, prompt('打个招呼'))
  assert.deepEqual(readMap(stateFile), { [session.id]: { kimiSessionId: 'scripted-session-1' } })
  await handle.dispose()
  await ctx.fiber.dispose()
})

test('resume：spawn 后 session/load 重连并吞掉回放，日志零新增', async () => {
  const dshId = 'test-resume-target'
  const seed = seedTurn()
  const { ctx, stateFile } = await bootPlugin({ permission: 'allow', persistenceSeed: seed })
  // 绑定事实先于 resume 存在（映射文件是 frostfin 的持久化面）。
  writeFileSync(stateFile, JSON.stringify({ [dshId]: { kimiSessionId: DEAD } }))

  const handle = await ctx.agents.resume({ resumeSessionId: dshId })
  const { agent, session } = { agent: handle.agent, session: handle.agent.session }
  // 回放被吞：日志仍是种子那 6 条，没有任何回放事件进来。
  assert.equal(session.events.length, seed.length)
  assert.deepEqual(types(session.events), seed.map(event => event.type))

  // 恢复后继续对话：turn 编号从种子的 turn 1 之后接着走。
  const events = await runOneTurn(agent, prompt('继续'))
  assert.equal(events.at(-1).data.reason.kind, 'completed')
  assert.equal(events.at(-1).data.turn, 2)
  assert.deepEqual(readMap(stateFile), { [dshId]: { kimiSessionId: DEAD } })

  await handle.dispose()
  await ctx.fiber.dispose()
})

test('resume：没有绑定记录的会话明确报错', async () => {
  const { ctx } = await bootPlugin({ permission: 'allow', persistenceSeed: [] })
  await assert.rejects(
    ctx.agents.resume({ resumeSessionId: 'test-never-bound' }),
    /没有 kimi 会话绑定记录/,
  )
  await ctx.fiber.dispose()
})

test('attach：回放按合法 turn/step 结构落盘，seq 连续，surface 可折叠', async (t) => {
  const { ctx, handle, agent, session, stateFile } = await bootFrostfin('allow')
  t.after(async () => {
    await handle.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  })
  const before = session.events.length

  const turns = await agent.attachKimiSession(DEAD)
  assert.equal(turns, 2)
  const events = session.events
  assert.deepEqual(types(events.slice(before)), [
    'turn/start',            // turn 1（回放第一轮）
    'step/start',
    'user/message',
    'assistant/chunk',       // （回放）想一下
    'assistant/chunk',       // （回放）你好，世界
    'assistant/message',
    'step/end',
    'turn/end',
    'turn/start',            // turn 2（回放第二轮，含工具调用）
    'step/start',
    'user/message',
    'assistant/chunk',       // （回放）我来读
    'assistant/message',
    'tool/call',
    'tool/result',           // 回放无工具输出 → 占位文本
    'step/end',
    'step/start',            // turn 2 step 2
    'assistant/chunk',       // （回放）读完了
    'assistant/message',
    'step/end',
    'turn/end',
  ])
  // seq 从 0 连续；surface 折叠不抛错。
  for (const [index, event] of events.entries()) assert.equal(event.seq, index)
  assert.doesNotThrow(() => foldSurface(events))
  // 种子前奏 + 两个回放 turn 都以 completed 收尾。
  const ends = events.filter(event => event.type === 'turn/end')
  assert.deepEqual(ends.map(event => event.data.reason), [{ kind: 'completed' }, { kind: 'completed' }, { kind: 'completed' }])
  // 回放工具结果的占位内容。
  const result = events.find(event => event.type === 'tool/result')
  assert.equal(result.data.message.content[0].content[0].text, '(replayed history: tool output not retained by kimi)')
  // attach 后绑定改写为目标会话。
  assert.deepEqual(readMap(stateFile), { [session.id]: { kimiSessionId: DEAD } })

  // 重复 attach 报错；attach 后继续对话从 turn 4 接着编号（种子前奏占 turn 1）。
  await assert.rejects(agent.attachKimiSession(DEAD), /已绑定/)
  const after = await runOneTurn(agent, prompt('继续'))
  assert.equal(after.at(-1).data.reason.kind, 'completed')
  assert.equal(after.at(-1).data.turn, 4)
})

test('进程自愈：崩溃的 turn 记 error，下一个 prompt 自动重连并跑通', async (t) => {
  const { ctx, handle, agent, session } = await bootFrostfin('allow')
  t.after(async () => {
    await handle.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  })

  await runOneTurn(agent, prompt('正常一'))
  assert.equal(session.events.at(-1).data.reason.kind, 'completed')

  // 'boom' 让 fixture 直接 exit(1)：这个 turn 以 error 收尾。
  await runOneTurn(agent, prompt('boom'))
  assert.equal(session.events.at(-1).data.reason.kind, 'error')

  // 进程已死：下一个 prompt 自动重连（重 spawn + load 吞回放）并正常完成。
  await runOneTurn(agent, prompt('正常二'))
  assert.equal(session.events.at(-1).data.reason.kind, 'completed')
  // 重连的回放被吞：整本日志没有任何回放标记文本。
  const replayed = session.events.filter(event =>
    event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes('回放')))
  assert.equal(replayed.length, 0)
})

test('档位重放：切到 yolo 后进程崩溃重连，kimi 侧模式不丢', async (t) => {
  const { ctx, handle, agent, session } = await bootFrostfin('allow')
  t.after(async () => {
    await handle.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  })

  await runOneTurn(agent, prompt('正常一'))
  await agent.setKimiMode('yolo')
  await agent.setKimiThinking('low')
  assert.equal(agent.getKimiStatus().mode, 'yolo')
  assert.equal(agent.getKimiStatus().thinking, 'low')

  // 'boom' 杀死 fixture 进程；新进程的握手会把模式归零（fixture 默认 default/high）。
  await runOneTurn(agent, prompt('boom'))
  assert.equal(session.events.at(-1).data.reason.kind, 'error')

  // 自动重连 + session/load + 档位重放：yolo/low 应该还在。
  await runOneTurn(agent, prompt('正常二'))
  assert.equal(session.events.at(-1).data.reason.kind, 'completed')
  assert.equal(agent.getKimiStatus().mode, 'yolo')
  assert.equal(agent.getKimiStatus().thinking, 'low')
})
