/**
 * DSH 会话 id → kimi ACP 会话 id 的持久化映射（JSON 文件）。
 *
 * 为什么不在会话日志里写自定义事件：DSH 的 `Session.append` 没有给信封写
 * `ignorable: true` 的入口，而持久层（session-persistence coordinator）在
 * reload 时会拒读任何不在 KNOWN_SESSION_EVENT_TYPES 且不带 ignorable 的事件
 * ——一条不带标记的自定义事件会让整个日志永远不可恢复。所以绑定事实存到
 * frostfin 自己的映射文件里。
 *
 * @module dsh-frostfin/kimi-sessions
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 展开路径开头的 `~` 为 home 目录。 */
export function expandStateFile(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** 一个 DSH 会话对应一个 kimi 会话的映射表（惰性读盘，写时整体覆写）。 */
export class KimiSessionMap {
  private readonly map = new Map<string, string>()
  private loaded = false

  constructor(private readonly file: string) {}

  /** 读取一个 DSH 会话绑定的 kimi 会话 id；没有记录时返回 undefined。 */
  get(dshSessionId: string): string | undefined {
    this.load()
    return this.map.get(dshSessionId)
  }

  /** 反查：一个 kimi 会话 id 是否已被某个 DSH 会话绑定。 */
  hasValue(kimiSessionId: string): boolean {
    this.load()
    for (const value of this.map.values()) {
      if (value === kimiSessionId) return true
    }
    return false
  }

  /** 反查绑定关系：kimi 会话 id → DSH 会话 id（没有记录时返回 undefined）。 */
  keyOf(kimiSessionId: string): string | undefined {
    this.load()
    for (const [key, value] of this.map) {
      if (value === kimiSessionId) return key
    }
    return undefined
  }

  /** 记录一条绑定并落盘（临时文件 + rename，避免半截文件）。 */
  set(dshSessionId: string, kimiSessionId: string): void {
    this.load()
    this.map.set(dshSessionId, kimiSessionId)
    this.persist()
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      // 文件不存在（首次使用）或不可读都按空映射起步；写入时会覆盖重建。
      return
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') this.map.set(key, value)
      }
    } catch {
      // 损坏的映射文件按空映射处理（resume 会以"没有绑定记录"明确报错）。
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(this.map), null, 2)}\n`, 'utf8')
    renameSync(tmp, this.file)
  }
}

/**
 * 一个 kimi 会话的运行档位：权限模式 / thinking 档位。
 * kimi 侧不持久化这些（set_config_option 是进程内状态），kimi 进程重启即归零；
 * 我们按 kimi 会话 id 记住用户的选择，重连/resume 后重放。
 */
export interface KimiSessionPref {
  mode?: string
  thinking?: string
}

/** kimi 会话 id → 运行档位 的持久化映射（与 KimiSessionMap 同套落盘纪律）。 */
export class KimiSessionPrefs {
  private readonly map = new Map<string, KimiSessionPref>()
  private loaded = false

  constructor(private readonly file: string) {}

  /** 读一个 kimi 会话的档位；没有记录时返回 undefined。 */
  get(kimiSessionId: string): KimiSessionPref | undefined {
    this.load()
    return this.map.get(kimiSessionId)
  }

  /** 合并写入一个档位补丁并落盘（只写给出的字段）。 */
  set(kimiSessionId: string, patch: KimiSessionPref): void {
    this.load()
    this.map.set(kimiSessionId, { ...this.map.get(kimiSessionId), ...patch })
    this.persist()
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const pref = value as Record<string, unknown>
          this.map.set(key, {
            ...typeof pref.mode === 'string' ? { mode: pref.mode } : {},
            ...typeof pref.thinking === 'string' ? { thinking: pref.thinking } : {},
          })
        }
      }
    } catch {
      // 损坏的档位文件按空映射处理（重放跳过，kimi 保持它自己的默认）。
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(this.map), null, 2)}\n`, 'utf8')
    renameSync(tmp, this.file)
  }
}
