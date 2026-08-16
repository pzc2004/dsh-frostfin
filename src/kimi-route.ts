/**
 * kimi 路由：向 DSH 模型层声明一条"活的、不需要 API Key"的名义路由。
 *
 * 背景——DSH Web UI 有两道围绕模型层的门禁：
 * 1. 首启引导（onboarding）：没有任何"可用 provider"时反复弹"添加 API Key"
 *    （可用 = 适配器在册且无需凭据或凭据已配置）；
 * 2. 会话的模型路由必须有适配器服务，否则输入框封锁、session.prompt 拒绝。
 * frostfin 的会话由 kimi acp 进程驱动、不经过 DSH 模型层，但门禁不知道。
 * 本模块注册 provider 'kimi-code' 的名义适配器（无目录声明、无需凭据），
 * 把两道门禁喂饱；模型选择器里会诚实显示"Kimi Code（frostfin 驱动）"。
 *
 * 注意：本模块【不动】部署级默认模型选择——那是全局设置，劫持它会让原生
 * 模式的会话也落到名义路由上。frostfin 会话的路由由创建时的种子日志自带
 * （见 factory.ts 的 seed 合成），会话级事实、不影响全局。
 *
 * @module dsh-frostfin/kimi-route
 */

import type { Context, Logger } from '@deepseek-ai/cordis'
import { readFileSync, writeFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionConfigOption, SessionConfigSelectGroup, SessionConfigSelectOption } from '@agentclientprotocol/sdk'

/** frostfin 会话的模型路由 provider id。 */
export const KIMI_PROVIDER = 'kimi-code'
/** 名义模型 id（真实模型由 kimi 自己的配置决定，DSH 侧只是展示）。 */
export const KIMI_MODEL = 'kimi-for-coding'

/** 静态兜底目录（还没有任何 kimi 会话上报过真实模型列表时使用）。 */
const FALLBACK_MODEL: LlmModelInfo = {
  provider: KIMI_PROVIDER,
  id: KIMI_MODEL,
  name: 'Kimi Code（本地 CLI）',
  description: '由本机 kimi acp 进程驱动，无需 API Key；真实模型以 kimi 自身配置为准',
}

/** 拍平 select 选项（ACP 的 SessionConfigOption 允许分组嵌套）。 */
export function flattenSelectOptions(
  options: readonly (SessionConfigSelectOption | SessionConfigSelectGroup)[],
): { value: string; name: string; description?: string }[] {
  const out: { value: string; name: string; description?: string }[] = []
  for (const option of options) {
    if ('value' in option) {
      out.push({
        value: option.value,
        name: option.name,
        ...option.description == null ? {} : { description: option.description },
      })
    } else {
      out.push(...flattenSelectOptions(option.options))
    }
  }
  return out
}

/**
 * kimi 真实模型目录：由 kimi 会话握手后上报的 ACP configOptions 填充
 * （每个 frostfin 会话首 spawn 时发布一次，内容变化时通知订阅者刷新）。
 * 持久化到磁盘——服务重启后选择器不再退回兜底条目。
 */
export class KimiModelCatalog {
  private entries: readonly LlmModelInfo[] = [FALLBACK_MODEL]
  private readonly listeners = new Set<() => void>()

  constructor(private readonly persistFile?: string) {
    if (persistFile !== undefined) this.hydrate()
  }

  /** 启动时从磁盘恢复上次的目录（读失败则保持兜底）。 */
  private hydrate(): void {
    try {
      const raw = JSON.parse(readFileSync(this.persistFile!, 'utf8')) as unknown
      if (Array.isArray(raw) && raw.length > 0) {
        this.entries = raw as LlmModelInfo[]
      }
    } catch {
      // 文件不存在/损坏：保持兜底，首次握手会重建。
    }
  }

  /** 当前目录（适配器的 listModels 读这里）。 */
  models(): readonly LlmModelInfo[] {
    return this.entries
  }

  /** 订阅目录变化（用于触发 DSH 侧的模型目录刷新）。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 从 ACP configOptions 发布模型列表；内容无变化时不通知。 */
  publish(options: readonly SessionConfigOption[]): void {
    const modelOption = options.find(option => option.id === 'model')
    if (modelOption === undefined || !('options' in modelOption)) return
    const next = flattenSelectOptions(modelOption.options).map(option => ({
      provider: KIMI_PROVIDER,
      id: option.value,
      name: option.name,
      ...option.description === undefined ? {} : { description: option.description },
    }))
    if (next.length === 0) return
    const before = JSON.stringify(this.entries)
    const after = JSON.stringify(next)
    if (before === after) return
    this.entries = next
    if (this.persistFile !== undefined) {
      try {
        writeFileSync(this.persistFile, after, 'utf8')
      } catch {
        // 持久化失败不影响内存态。
      }
    }
    for (const listener of this.listeners) listener()
  }
}

/**
 * 名义路由适配器：只回答元信息，从不真正发请求。
 * stream() 被调到说明有组件绕过了 frostfin 的 loop——fail loud，不静默出错。
 */
export class KimiRouteAdapter extends LlmAdapter {
  constructor(private readonly catalog: KimiModelCatalog) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Kimi Code（frostfin 驱动）' }
  }

  /** 模型目录 = kimi 上报的真实模型列表（未上报前用兜底条目）。 */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.catalog.models())
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error(
      '「Kimi Code」路由只在「月芒霜鳍鲸」模式的会话里可用（那种会话由本机 kimi 进程驱动，不需要模型凭据）。'
      + '当前会话是原生 loop 驱动：请在模型选择器里改选一个真实模型（如 DeepSeek 官方），或把会话模式切到「月芒霜鳍鲸」。',
    )
  }
}

/**
 * 在 apply() 中以 ctx.effect 调用：注册名义适配器，目录变化时触发
 * 注册表的 adapters-updated（UI 的模型目录随之重拉）。
 * 宿主缺 llm 服务时降级为仅警告的 no-op。
 */
export function registerKimiRoute(ctx: Context, logger: Logger, catalog: KimiModelCatalog): () => Promise<void> {
  const llm = ctx.get('llm')
  if (llm === undefined) {
    logger.warn('frostfin: 宿主没有 llm 服务，跳过 kimi 路由注册（Web UI 的模型门禁可能仍会拦截输入）')
    return async () => {}
  }
  // 适配器注册随本插件 fiber 撤销（dispose 幂等，重复释放安全）。
  const release = llm.registerAdapter([KIMI_PROVIDER], new KimiRouteAdapter(catalog))
  const unsubscribe = catalog.onChange(() => {
    try {
      release.replace([KIMI_PROVIDER])
    } catch {
      // 注册已随插件卸载释放；迟到的目录变化不再需要通知。
    }
  })
  logger.info('frostfin: kimi-code 名义路由已注册')
  return async () => {
    unsubscribe()
    release()
  }
}

/**
 * 新建 frostfin 会话的种子日志：一个只携带 kimi-code 路由的闭合空 turn
 * （turn/start → request/header → turn/end）。不变量要求 request/* 事件必须在
 * 打开的 turn 内，而种子是创建时携带日志事实的唯一合法通道。
 * 效果：frostfin 会话从诞生起模型选择就是 kimi-code（日志层事实），
 * 不必碰部署级默认模型——原生模式的会话完全不受影响。
 */
export function frostfinRouteSeed(): SessionEvent[] {
  const time = Date.now()
  return [
    { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
    {
      type: 'request/header', seq: 1, time: time + 1,
      data: { header: { config: { provider: KIMI_PROVIDER, model: KIMI_MODEL } }, reason: 'initial' },
    },
    { type: 'turn/end', seq: 2, time: time + 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}
