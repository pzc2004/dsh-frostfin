// M4 分发器测试：preset 路由（frostfin/未指明 → kimi；其他 → 原生委托）。
// 直接构造 FrostfinAgentFactory（不经 apply），原生工厂用假身注入。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import { FrostfinAgentFactory } from '../lib/factory.js'
import { KimiSessionMap } from '../lib/kimi-sessions.js'
import { FIXTURE, localSpawn } from './helpers.mjs'

async function bootDispatcher() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.provide('subprocess', { spawn: localSpawn })
  const stateFile = join(mkdtempSync(join(tmpdir(), 'frostfin-test-')), 'kimi-sessions.json')
  const nativeCalls = []
  const holder = { factory: undefined, nativeResume: 0 }
  // 在带 inject 的插件上下文里构造工厂（属性访问的 inject 纪律）。
  await ctx.plugin({
    name: 'dispatch-test',
    inject: ['agents', 'sessions', 'subprocess'],
    apply(pluginCtx) {
      const factory = new FrostfinAgentFactory(pluginCtx, {
        command: process.execPath,
        args: [FIXTURE],
        permission: 'allow',
        disposeEofGraceMs: 2000,
        disposeGraceMs: 1000,
        stateFile,
        advertiseKimiRoute: false,
        dispatchNative: true,
        installPreset: false,
      }, new KimiSessionMap(stateFile))
      factory.setNativeFactory(Promise.resolve({
        createAgent: async (ownerCtx, options) => {
          nativeCalls.push(options)
          return { agent: { id: options.sessionId }, dispose: async () => {} }
        },
        resume: async (ownerCtx, options) => {
          holder.nativeResume += 1
          return { agent: { id: options.resumeSessionId }, dispose: async () => {} }
        },
      }))
      pluginCtx.agents.setFactory(factory)
      pluginCtx.effect(() => () => factory.disposeAll(), 'test.disposeAll')
      holder.factory = factory
    },
  })
  return { ctx, factory: holder.factory, nativeCalls, resumeCount: () => holder.nativeResume }
}

test('分发：标准 preset 委托原生工厂，frostfin/未指明走 kimi 路径', async (t) => {
  const { ctx, nativeCalls } = await bootDispatcher()
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })

  // 标准模式 → 原生委托
  await ctx.agents.create({ sessionId: 'native-1', meta: { agentPreset: 'standard', cwd: process.cwd() } })
  assert.equal(nativeCalls.length, 1)
  assert.equal(nativeCalls[0].sessionId, 'native-1')

  // frostfin preset → kimi 路径（惰性：不起进程即建好）
  const kimiHandle = await ctx.agents.create({ sessionId: 'kimi-1', meta: { agentPreset: 'frostfin', cwd: process.cwd() } })
  assert.equal(nativeCalls.length, 1)
  assert.equal(kimiHandle.agent.boundKimiSessionId, undefined)
  await kimiHandle.dispose()

  // 未指明 preset（headless/CLI 形态）→ kimi 路径
  const plainHandle = await ctx.agents.create({ sessionId: 'kimi-2', meta: { cwd: process.cwd() } })
  assert.equal(nativeCalls.length, 1)
  await plainHandle.dispose()
})

test('分发：resume 按 kimi 绑定路由（无绑定 → 原生委托）', async (t) => {
  const { ctx, resumeCount } = await bootDispatcher()
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })

  await ctx.agents.resume({ resumeSessionId: 'never-kimi' })
  assert.equal(resumeCount(), 1)
})
