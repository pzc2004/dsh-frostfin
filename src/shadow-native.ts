/**
 * 影子挂载原生 loop：在 isolate 隔离域里挂载 AgentLoop，用 facade 拦截它对
 * `agents.setFactory` 的注册——原生工厂被【捕获】为委托对象，而不是占住
 * 全进程唯一的工厂位。这是"月芒霜鳍鲸模式"（按 preset 分发 loop）的机制底座。
 *
 * 三个已验证的机制要点（spike: scripts/spike-shadow.mjs / spike-isolate.mjs）：
 * 1. 遮蔽必须走 `ctx.isolate(name)` + `provide`；`extend()` 的普通遮蔽不被
 *    inject 承认；
 * 2. shim 不能是包裹真服务的 Proxy——cordis 会按追踪元数据拆包回真身；
 *    这里用"目标是纯对象、get 转发真身"的 Proxy 绕过拆包；
 * 3. AgentLoop 模块必须解析自宿主的模块树（它内部用的 dsh-scope kScope
 *    是模块私有 Symbol；用我们拷贝的话，原生 agent 的 scope 标记宿主读不到，
 *    preset 组合会拒绝——与 host-scope.ts 同源的问题）。
 *
 * @module dsh-frostfin/shadow-native
 */

import type { Context, Fiber, Logger } from '@deepseek-ai/cordis'
import type { AgentFactory, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { resolveHostModule } from './host-scope.js'

/** 影子挂载的产出：原生工厂（就绪 Promise）与整棵影子的拆卸句柄。 */
export interface NativeShadow {
  /** AgentLoop 完成自注册后 resolve 出原生工厂；在此之前创建原生会话应等待它。 */
  readonly factory: Promise<AgentFactory>
  /** 拆卸整棵影子（AgentLoop 随之卸载）。 */
  readonly dispose: () => Promise<void>
}

/** AgentLoop 包默认导出的模块面（宿主模块树解析，类型在此处放宽为插件形态）。 */
interface AgentLoopModule {
  default: unknown
}

/** cordis 插件入口参数形态。 */
type PluginEntry = Parameters<Context['plugin']>[0]

/**
 * 挂载影子里的原生 loop。
 * @param ctx - frostfin 插件上下文（真 agents 注册表从这里读）。
 * @param logger - 插件 logger。
 * @returns 捕获结果；宿主缺依赖服务时影子纤维保持 PENDING，cordis 反应式激活后工厂就绪。
 */
export async function mountNativeShadow(ctx: Context, logger: Logger): Promise<NativeShadow> {
  const real: AgentRegistry = ctx.agents
  const captured = Promise.withResolvers<AgentFactory>()
  // AgentLoop 必须来自宿主模块树（要点 3）。
  const AgentLoopClass = (await resolveHostModule<AgentLoopModule>('@deepseek-ai/dsh-agent-loop', logger)).default as PluginEntry

  // 纯对象做 target 的 Proxy：避开 cordis 对"被追踪服务"的拆包（要点 2）。
  const shimTarget = Object.create(null) as Record<PropertyKey, unknown>
  const shim = new Proxy(shimTarget, {
    get(_target, prop) {
      if (prop === 'setFactory') {
        return (factory: AgentFactory) => {
          captured.resolve(factory)
          // 撤销器不动真注册表——影子拆卸时原生工厂随 AgentLoop 一起消失。
          return () => {}
        }
      }
      const value = Reflect.get(real, prop)
      return typeof value === 'function' ? value.bind(real) : value
    },
  })

  // 隔离域遮蔽（要点 1）：影子里的 agents 解析到 shim，其余服务穿透到宿主真身；
  // 缺依赖时纤维停在 PENDING，cordis 会在依赖就绪后反应式激活。
  const shadow = ctx.isolate('agents')
  shadow.provide('agents', shim)
  const fiber: Fiber = shadow.plugin(AgentLoopClass, { agents: [] })
  void Promise.resolve(fiber).catch((error: unknown) => {
    captured.reject(error instanceof Error ? error : new Error(String(error)))
  })

  return {
    factory: captured.promise,
    dispose: async () => {
      await fiber.dispose()
      logger.info('frostfin: 影子里的原生 loop 已卸载')
    },
  }
}
