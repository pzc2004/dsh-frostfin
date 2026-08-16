// Spike v2：isolate + 外观对象（facade）遮蔽。
// 教训：v1 用 Proxy 包裹真服务会被 cordis 的追踪机制拆回真身（symbols.tracker
// 解包），所以 shim 改成不带追踪元数据的纯外观对象——方法逐个绑真身委托，
// 只有 setFactory 被拦截。
// 运行：node scripts/spike-shadow.mjs

import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore from '@deepseek-ai/dsh-session'

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)

// spike 环境里没有 llm/tools/systemPrompt 真身，provide 最小假身
// （真实宿主里这三个服务存在，只有 agents 需要遮蔽）。
ctx.provide('llm', {})
ctx.provide('tools', {})
ctx.provide('systemPrompt', { variable() {} })

// 外观 shim：纯对象、无 cordis 追踪元数据；方法绑真身，setFactory 被拦截。
const captured = { factory: undefined }
const real = ctx.agents
const shim = Object.create(null)
for (const key of ['create', 'resume', 'get', 'list', 'enter', 'announce', 'register', 'withInitiator', 'isOwnedBy']) {
  const value = real[key]
  if (typeof value === 'function') shim[key] = value.bind(real)
}
shim.setFactory = (factory) => {
  captured.factory = factory
  return () => {}
}

const shadow = ctx.isolate('agents')
shadow.provide('agents', shim)

const fiber = await shadow.plugin(AgentLoop, { agents: [] })
// FiberState: PENDING=0, LOADING=1, ACTIVE=2
assert.equal(fiber.state, 2, `AgentLoop 应激活（ACTIVE=2），实际 ${fiber.state}`)
assert.ok(captured.factory !== undefined, 'AgentLoop 的 setFactory 应被 shim 捕获')
assert.equal(typeof captured.factory.createAgent, 'function')
assert.equal(typeof captured.factory.resume, 'function')

// 真注册表的工厂位仍是空的：frostfin 注册不抛错即证明遮蔽成功。
const ourFactory = {
  createAgent: async () => { throw new Error('frostfin factory') },
  resume: async () => { throw new Error('frostfin factory') },
}
ctx.agents.setFactory(ourFactory)

// 拆影子：AgentLoop 撤销，真注册表的工厂不受影响。
await fiber.dispose()
await assert.rejects(ctx.agents.create({ sessionId: 'probe' }), /frostfin factory/)

await ctx.fiber.dispose()
console.log('SPIKE OK：facade 遮蔽成功——原生工厂被捕获，真注册表无冲突。')
