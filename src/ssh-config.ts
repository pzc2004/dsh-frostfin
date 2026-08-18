/**
 * 远程线：`~/.ssh/config` 的 Host 清单解析（行为对齐 VS Code Remote Explorer）。
 *
 * 纪律：这里只定义"怎么读"，不内置任何真实主机——服务器信息永远来自
 * 用户自己的 ssh 配置（运行时数据），测试全用合成主机名。
 *
 * 解析规则（OpenSSH 语义）：
 * - `Host <别名...>` 分块；含通配符（* / ?）的块跳过（那是默认值块，不是服务器）；
 * - 键大小写不敏感；同一主机内同一键**先出现者胜**（ssh 的 first-obtained-wins）；
 * - 支持 `Include`（相对路径相对当前文件所在目录，~ 开头展开为 home）；
 * - 行内 `#` 注释（引号内的 # 不算）。
 *
 * @module dsh-frostfin/ssh-config
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, dirname } from 'node:path'
import { expandStateFile } from './kimi-sessions.js'

/** 一台 ssh 主机（显示用别名 + 连接参数；未设置的键为 undefined）。 */
export interface SshHostEntry {
  alias: string
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
}

/** 去掉行内注释（尊重单双引号），返回净文本。 */
function stripComment(line: string): string {
  let quote: string | undefined
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

/** 拆分键值：支持 `Key value` 与 `Key=value` 两种分隔（OpenSSH 都接受）。 */
function splitKeyValue(line: string): [string, string] | undefined {
  const match = /^(\S+?)[\s=](.+)$/.exec(line)
  if (match === null) return undefined
  return [match[1], match[2].trim()]
}

/** 去掉值两端的包裹引号。 */
function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}

/**
 * 解析 ssh config 文本为 Host 清单（不展开 Include——见 loadSshHosts）。
 * Host 块之前的全局默认键忽略；一块多别名（Host a b c）每个别名各出一条。
 * @param text - 配置文件内容。
 * @returns 非通配符 Host 条目（按出现顺序）。
 */
export function parseSshConfig(text: string): SshHostEntry[] {
  const entries: SshHostEntry[] = []
  let block: SshHostEntry[] = []
  for (const raw of text.split('\n')) {
    const line = stripComment(raw).trim()
    if (line === '') continue
    const kv = splitKeyValue(line)
    if (kv === undefined) continue
    const [key, value] = [kv[0].toLowerCase(), kv[1]]
    if (key === 'host') {
      block = value.split(/\s+/)
        .filter(alias => alias !== '' && !/[*?]/.test(alias))
        .map(alias => ({ alias }))
      entries.push(...block)
      continue
    }
    const unquoted = unquote(value)
    for (const entry of block) applyValue(entry, key, unquoted)
  }
  return entries
}

/** first-obtained-wins：已设置的键不再覆写；未知键忽略。 */
function applyValue(entry: SshHostEntry, key: string, value: string): void {
  if (key === 'hostname' && entry.hostName === undefined) entry.hostName = value
  else if (key === 'user' && entry.user === undefined) entry.user = value
  else if (key === 'identityfile' && entry.identityFile === undefined) entry.identityFile = expandStateFile(value)
  else if (key === 'port' && entry.port === undefined) {
    const port = Number(value)
    if (Number.isInteger(port) && port > 0 && port < 65536) entry.port = port
  }
}

/** Include 递归深度上限（防御环状 include）。 */
const INCLUDE_DEPTH_MAX = 8

/**
 * 读取一个 ssh config 文件并展开 Include，返回完整 Host 清单。
 * 文件不存在/不可读时按空清单处理（没有配置 = 没有远程主机，不算错误）。
 * @param configPath - 主配置路径（~ 开头展开为 home）。
 */
export function loadSshHosts(configPath = '~/.ssh/config'): SshHostEntry[] {
  const entries: SshHostEntry[] = []
  const walk = (file: string, depth: number): void => {
    if (depth > INCLUDE_DEPTH_MAX) return
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return
    }
    // Include 是文本内嵌：按行扫描，遇到 Include 先冲刷已积累的行再递归。
    let pending: string[] = []
    const flush = (): void => {
      if (pending.length === 0) return
      entries.push(...parseSshConfig(pending.join('\n')))
      pending = []
    }
    for (const raw of text.split('\n')) {
      const line = stripComment(raw).trim()
      const kv = line === '' ? undefined : splitKeyValue(line)
      if (kv === undefined || kv[0].toLowerCase() !== 'include') {
        pending.push(raw)
        continue
      }
      flush()
      for (const pattern of kv[1].split(/\s+/)) {
        if (pattern === '') continue
        const expanded = expandStateFile(pattern)
        const target = isAbsolute(expanded) ? expanded : join(dirname(file), expanded)
        // 通配只支持"目录/*"形态；无匹配静默跳过（ssh 同款宽容）。
        if (target.endsWith('/*')) {
          const dir = target.slice(0, -2)
          if (!existsSync(dir)) continue
          try {
            const names = readdirSync(dir, { withFileTypes: true })
              .filter(entry => entry.isFile())
              .map(entry => entry.name)
              .sort()
            for (const name of names) walk(join(dir, name), depth + 1)
          } catch {
            // 目录不可读：跳过。
          }
        } else {
          walk(target, depth + 1)
        }
      }
    }
    flush()
  }
  walk(expandStateFile(configPath), 0)
  return entries
}
