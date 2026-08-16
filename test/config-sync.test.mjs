// 模型配置同步：标记块渲染/应用的纯函数测试 + 假服务下的端到端同步。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { applyManagedBlock, cleanKimiConfig, renderManagedBlock, syncKimiConfig } from '../lib/config-sync.js'

const ENTRY = {
  provider: 'deepseek-official',
  type: 'openai',
  baseURL: 'https://api.deepseek.com',
  apiKey: 'sk-test-key',
  models: ['deepseek-v4-pro'],
}

test('renderManagedBlock：供应商与模型都以 kimi 语法渲染', () => {
  const block = renderManagedBlock([ENTRY])
  assert.match(block, /\[providers\."dsh-deepseek-official"\]/)
  assert.match(block, /type = "openai"/)
  assert.match(block, /base_url = "https:\/\/api\.deepseek\.com"/)
  assert.match(block, /api_key = "sk-test-key"/)
  assert.match(block, /\[models\."dsh-deepseek-official\/deepseek-v4-pro"\]/)
  assert.match(block, /provider = "dsh-deepseek-official"/)
  assert.match(block, /model = "deepseek-v4-pro"/)
})

test('applyManagedBlock：追加、替换、移除、无变化返回 null', () => {
  const block = renderManagedBlock([ENTRY])
  // 追加（保留用户已有内容）
  const withUser = 'default_model = "kimi-code/kimi-for-coding"\n'
  const appended = applyManagedBlock(withUser, block)
  assert.ok(appended.startsWith(withUser))
  assert.ok(appended.includes('[providers."dsh-deepseek-official"]'))
  // 无变化 → null
  assert.equal(applyManagedBlock(appended, block), null)
  // 替换（用户改了 key 之后的新块覆盖旧块，用户内容不动）
  const newer = renderManagedBlock([{ ...ENTRY, apiKey: 'sk-new' }])
  const replaced = applyManagedBlock(appended, newer)
  assert.ok(replaced.includes('sk-new'))
  assert.ok(!replaced.includes('sk-test-key'))
  assert.ok(replaced.startsWith(withUser))
  // 移除（无条目时整块删掉）
  const removed = applyManagedBlock(replaced, '')
  assert.ok(!removed.includes('dsh-frostfin managed'))
  assert.ok(removed.startsWith(withUser.trimEnd()))
})

test('syncKimiConfig：假服务下端到端写 kimi 配置；内容不变不写盘', async (t) => {
  const kimiHome = mkdtempSync(join(tmpdir(), 'frostfin-kimi-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })

  ctx.provide('llm', {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] }],
    listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }],
  })
  ctx.provide('settings', {
    describe: () => [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' } }],
  })
  ctx.provide('credentials', {
    resolve: async (ref) => ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-live', source: 'file' } : undefined,
  })
  const logger = { info() {}, warn() {} }

  const first = await syncKimiConfig(ctx, logger, kimiHome)
  assert.equal(first.wrote, true)
  assert.deepEqual(first.providers, ['deepseek-official'])
  const file = join(kimiHome, 'config.toml')
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes('api_key = "sk-live"'))
  assert.ok(text.includes('[models."dsh-deepseek-official/deepseek-v4-pro"]'))
  // 备份已建
  assert.equal(existsSync(`${file}.frostfin.bak`), false) // 首次写入前文件不存在，无备份
  // 第二次：内容不变 → 不写盘
  const second = await syncKimiConfig(ctx, logger, kimiHome)
  assert.equal(second.wrote, false)
  // 第三次：凭据变了 → 写盘并留下备份
  ctx.credentials.resolve = async () => ({ value: 'sk-rotated', source: 'file' })
  const third = await syncKimiConfig(ctx, logger, kimiHome)
  assert.equal(third.wrote, true)
  assert.equal(existsSync(`${file}.frostfin.bak`), true)
  assert.ok(readFileSync(file, 'utf8').includes('sk-rotated'))
})

test('syncKimiConfig：没有已配置凭据的供应商被跳过并说明原因', async (t) => {
  const kimiHome = mkdtempSync(join(tmpdir(), 'frostfin-kimi-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })

  ctx.provide('llm', {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] }],
    listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'x' }],
  })
  ctx.provide('settings', { describe: () => [{ ns: 'llm-deepseek', value: {} }] })
  ctx.provide('credentials', { resolve: async () => undefined })

  const result = await syncKimiConfig(ctx, { info() {}, warn() {} }, kimiHome)
  assert.equal(result.wrote, false)
  assert.equal(result.skipped[0].provider, 'deepseek-official')
})

test('cleanKimiConfig：卸载时移除托管块，用户内容原样保留', async (t) => {
  const kimiHome = mkdtempSync(join(tmpdir(), 'frostfin-kimi-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })

  ctx.provide('llm', {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] }],
    listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'x' }],
  })
  ctx.provide('settings', { describe: () => [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }] })
  ctx.provide('credentials', { resolve: async () => ({ value: 'sk-live', source: 'file' }) })
  const logger = { info() {}, warn() {} }

  // 用户已有内容 + 同步
  const file = join(kimiHome, 'config.toml')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, 'default_model = "kimi-code/kimi-for-coding"\n', 'utf8')
  await syncKimiConfig(ctx, logger, kimiHome)
  assert.ok(readFileSync(file, 'utf8').includes('dsh-frostfin managed'))

  // 卸载清理：块移除，用户行还在
  assert.equal(cleanKimiConfig(logger, kimiHome), true)
  const after = readFileSync(file, 'utf8')
  assert.ok(!after.includes('dsh-frostfin managed'))
  assert.ok(after.includes('default_model = "kimi-code/kimi-for-coding"'))
  // 幂等：再清一次返回 false
  assert.equal(cleanKimiConfig(logger, kimiHome), false)
})
