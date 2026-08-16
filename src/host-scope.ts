/**
 * 宿主模块解析：从 DSH 宿主进程（dsh CLI）的模块树里解析指定的 dsh-* 包。
 *
 * 为什么必须这么做：这些包里有模块级私有 Symbol / WeakMap 状态
 * （如 dsh-scope 的 kScope）。我们的包如果 import 自己的拷贝，打上的标记
 * 宿主用它那份拷贝就读不出来——曾直接导致 Web UI 无法新建会话
 * （"refusing to compose an unscoped context"）。
 * 通过 createRequire(process.argv[1]) 锚定 CLI 的模块树解析，拿到的就是
 * 宿主进程正在使用的同一个模块实例（Node 按解析后的 URL 缓存模块）。
 * 测试/独立环境下没有宿主进程，回退到本包的拷贝（此时单拷贝，无冲突）。
 *
 * @module dsh-frostfin/host-scope
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Context, Logger } from '@deepseek-ai/cordis'
import type { Scope } from '@deepseek-ai/dsh-scope'

/** dsh-scope 模块面（只用 createScope）。 */
export interface DshScopeModule {
  createScope(ctx: Context, key: object): Scope
}

const cache = new Map<string, Promise<unknown>>()

/**
 * 从宿主模块树解析一个包；失败回退本包拷贝并 warn。
 * @param name - 包名（如 '@deepseek-ai/dsh-scope'）。
 * @param logger - 插件 logger（回退时留痕）。
 * @returns 宿主同款的模块实例。
 */
export function resolveHostModule<T>(name: string, logger: Logger): Promise<T> {
  const hit = cache.get(name)
  if (hit !== undefined) return hit as Promise<T>
  const pending = (async (): Promise<unknown> => {
    const entry = process.argv[1]
    if (entry !== undefined && entry !== '') {
      try {
        const resolved = createRequire(entry).resolve(name)
        logger.info('frostfin: 使用宿主模块树的 %s（%s）', name, resolved)
        return await import(pathToFileURL(resolved).href)
      } catch {
        // 落到回退：当前进程不是 dsh 宿主（如测试），或 CLI 树里找不到该包。
      }
    }
    logger.warn('frostfin: 未能从宿主进程解析 %s，回退到本包拷贝（仅在非宿主环境安全）', name)
    return await import(name)
  })()
  cache.set(name, pending)
  return pending as Promise<T>
}

/** 解析宿主的 dsh-scope（kScope 符号必须与宿主同一份）。 */
export function resolveHostScope(logger: Logger): Promise<DshScopeModule> {
  return resolveHostModule<DshScopeModule>('@deepseek-ai/dsh-scope', logger)
}
