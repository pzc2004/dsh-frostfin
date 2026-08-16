/**
 * 模型配置同步：把 DSH 侧已配置的模型供应商（base URL + API key）写进
 * kimi Code 的 config.toml，让 kimi 能直接跑 DSH 里配置的模型。
 *
 * 数据源：DSH 的 llm 目录（listConfigurableProviders + listModels）+ settings
 * 命名空间值（apiKeyEnv / baseURL）+ credentials 服务解析原始 key。
 * 写入方式：标记块（`# >>> dsh-frostfin managed` … `# <<<`）整体替换/追加，
 * 用户自己的配置原样保留；写前备份（config.toml.frostfin.bak）；临时文件
 * + rename 原子写。块内容没变化时不写盘。
 *
 * 安全说明：API key 以明文写入 kimi 的配置文件——与 DSH 自己的
 * .credentials.yaml 同级；这是把用户自己的凭据在用户自己的两个工具间复制，
 * 是本插件的明示行为（README 有声明）。
 *
 * @module dsh-frostfin/config-sync
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Context, Logger } from '@deepseek-ai/cordis'
// 类型面引用：让 Context 合并（ctx.get('llm') / ctx.get('credentials') / ctx.get('settings')）生效。
import type {} from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'

const MANAGED_BEGIN = '# >>> dsh-frostfin managed · 勿手改 >>>'
const MANAGED_END = '# <<< dsh-frostfin managed <<<'

/** 一个待同步的供应商（已解析凭据）。 */
interface ProviderEntry {
  /** DSH 路由 id（如 deepseek-official）。 */
  provider: string
  /** kimi 的 provider type（openai / openai_responses / anthropic）。 */
  type: string
  baseURL: string
  apiKey: string
  /** 该供应商的模型 id 列表。 */
  models: readonly string[]
}

/** 同步模型的缺省上下文窗口（kimi 强制要求 max_context_size）。 */
const DEFAULT_CONTEXT_SIZE = 128_000

/** 一次同步的结果摘要（日志用，不含密钥）。 */
export interface SyncSummary {
  providers: string[]
  models: string[]
  skipped: { provider: string; reason: string }[]
  wrote: boolean
}

/** kimi config.toml 的路径（$KIMI_CODE_HOME 或 ~/.kimi-code）。 */
export function kimiConfigPath(): string {
  const home = process.env.KIMI_CODE_HOME
  return join(home !== undefined && home.trim() !== '' ? home : join(homedir(), '.kimi-code'), 'config.toml')
}

/** DSH 的 api 协议值 → kimi 的 provider type；不认识返回 undefined。 */
function kimiProviderType(provider: string, api: string | undefined): string | undefined {
  if (provider === 'deepseek-official') return 'openai'
  if (api === undefined) return undefined
  if (api.includes('responses')) return 'openai_responses'
  if (api.includes('anthropic')) return 'anthropic'
  if (api.includes('openai')) return 'openai'
  return undefined
}

/** 渲染标记块全文（无条目时返回空串）。 */
export function renderManagedBlock(entries: readonly ProviderEntry[]): string {
  if (entries.length === 0) return ''
  const lines: string[] = [MANAGED_BEGIN]
  for (const entry of entries) {
    const key = `dsh-${entry.provider}`
    lines.push('', `[providers.${JSON.stringify(key)}]`)
    lines.push(`type = ${JSON.stringify(entry.type)}`)
    lines.push(`base_url = ${JSON.stringify(entry.baseURL)}`)
    lines.push(`api_key = ${JSON.stringify(entry.apiKey)}`)
    for (const model of entry.models) {
      lines.push('', `[models.${JSON.stringify(`${key}/${model}`)}]`)
      lines.push(`provider = ${JSON.stringify(key)}`)
      lines.push(`model = ${JSON.stringify(model)}`)
      // kimi 要求每个模型声明正的 max_context_size，否则拒绝切换。
      lines.push(`max_context_size = ${DEFAULT_CONTEXT_SIZE}`)
    }
  }
  lines.push('', MANAGED_END)
  return lines.join('\n')
}

/**
 * 把标记块应用到配置文件文本：有块替换、无块追加、空块移除。
 * @returns 新文本；无变化时返回 null。
 */
export function applyManagedBlock(original: string, block: string): string | null {
  const begin = original.indexOf(MANAGED_BEGIN)
  const end = original.indexOf(MANAGED_END)
  if (block === '') {
    if (begin === -1 || end === -1) return null
    const next = (original.slice(0, begin) + original.slice(end + MANAGED_END.length)).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
    return next === original ? null : next
  }
  const section = `${block}\n`
  if (begin !== -1 && end !== -1) {
    const next = original.slice(0, begin) + section + original.slice(end + MANAGED_END.length).replace(/^\n+/, '')
    return next === original ? null : next
  }
  const base = original.trimEnd()
  return (base === '' ? '' : `${base}\n\n`) + section
}

/** 从 settings 描述符里取一个命名空间的当前值。 */
function settingsValue(settings: { describe(options?: { redactSecrets?: boolean }): { ns: string; value: unknown }[] }, ns: string): unknown {
  return settings.describe().find(descriptor => descriptor.ns === ns)?.value
}

/** 读取对象路径（settingsPath 是命名空间内的路径段）。 */
function atPath(value: unknown, path: readonly string[]): unknown {
  let cursor = value
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/**
 * 卸载清理：把托管块从 kimi 配置中移除（配置同步的逆操作）。
 * 这是 Cordis 管不到的文件系统副作用，必须由我们自己登记撤销——
 * 可逆性纪律：插件卸载后，kimi 的 config.toml 应与我们从未来过时一致。
 */
export function cleanKimiConfig(logger: Logger, kimiHome?: string): boolean {
  const file = kimiHome === undefined ? kimiConfigPath() : join(kimiHome, 'config.toml')
  if (!existsSync(file)) return false
  const original = readFileSync(file, 'utf8')
  const next = applyManagedBlock(original, '')
  if (next === null) return false
  copyFileSync(file, `${file}.frostfin.bak`)
  const tmp = `${file}.frostfin-tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, file)
  logger.info('frostfin: 已从 kimi 配置移除托管块（%s）', file)
  return true
}

/**
 * 执行一次同步。任何子步骤失败降级为跳过该供应商并 warn，不影响其他。
 * @param kimiHome - 测试可注入的 kimi home（缺省走环境变量规则）。
 */
export async function syncKimiConfig(ctx: Context, logger: Logger, kimiHome?: string): Promise<SyncSummary> {
  const summary: SyncSummary = { providers: [], models: [], skipped: [], wrote: false }
  const llm = ctx.get('llm')
  const credentials = ctx.get('credentials')
  const settings = ctx.get('settings')
  if (llm === undefined || credentials === undefined || settings === undefined) {
    logger.warn('frostfin: 宿主缺 llm/credentials/settings 服务，跳过模型配置同步')
    return summary
  }

  const active = new Set(llm.listProviders().map(provider => provider.id))
  const entries: ProviderEntry[] = []
  for (const row of llm.listConfigurableProviders()) {
    if (!active.has(row.provider)) continue
    try {
      const section = atPath(settingsValue(settings, row.settingsNs), row.settingsPath)
      const record = (section !== null && typeof section === 'object' ? section : {}) as Record<string, unknown>
      const apiKeyEnv = typeof record.apiKeyEnv === 'string' && record.apiKeyEnv !== '' ? record.apiKeyEnv : undefined
      const baseURL = typeof record.baseURL === 'string' && record.baseURL !== '' ? record.baseURL : undefined
      const type = kimiProviderType(row.provider, typeof record.api === 'string' ? record.api : undefined)
      if (type === undefined) {
        summary.skipped.push({ provider: row.provider, reason: '无法映射协议类型' })
        continue
      }
      const url = baseURL ?? (row.provider === 'deepseek-official' ? 'https://api.deepseek.com' : undefined)
      if (url === undefined) {
        summary.skipped.push({ provider: row.provider, reason: '缺 baseURL' })
        continue
      }
      if (apiKeyEnv === undefined) {
        summary.skipped.push({ provider: row.provider, reason: '未配置 apiKeyEnv' })
        continue
      }
      const resolved = await credentials.resolve(apiKeyEnv as CredentialRef)
      if (resolved === undefined) {
        summary.skipped.push({ provider: row.provider, reason: `凭据 ${apiKeyEnv} 未配置` })
        continue
      }
      const models = (await llm.listModels(row.provider)).map(model => model.id)
      if (models.length === 0) {
        summary.skipped.push({ provider: row.provider, reason: '无可见模型' })
        continue
      }
      entries.push({ provider: row.provider, type, baseURL: url, apiKey: resolved.value, models })
      summary.providers.push(row.provider)
      summary.models.push(...models.map(model => `${row.provider}/${model}`))
    } catch (error: unknown) {
      summary.skipped.push({ provider: row.provider, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  const block = renderManagedBlock(entries)
  const file = kimiHome === undefined ? kimiConfigPath() : join(kimiHome, 'config.toml')
  const original = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const next = applyManagedBlock(original, block)
  if (next === null) return summary

  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file)) copyFileSync(file, `${file}.frostfin.bak`)
  const tmp = `${file}.frostfin-tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, file)
  summary.wrote = true
  logger.info('frostfin: 已同步 %d 个供应商、%d 个模型到 kimi 配置（%s）', summary.providers.length, summary.models.length, file)
  return summary
}
