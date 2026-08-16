/**
 * 「月芒霜鳍鲸」preset 的安装器：把包内的 preset 目录复制到 DSH 用户根
 * （$DSH_HOME/.agent-presets/frostfin，缺省 ~/.dsh/.agent-presets/frostfin），
 * 让模式下拉里出现这个选项。卸载时移除——但只移除内容与我们写入一致的
 * 文件；用户改过的文件保留（不覆盖、不删除用户的劳动）。
 *
 * @module dsh-frostfin/preset-install
 */

import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from '@deepseek-ai/cordis'

/** 包内 preset 源目录（lib/preset-install.js → 包根/presets）。 */
const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'presets')

/** frostfin preset 的 id（目录名，也是 dispatch 的路由键）。 */
export const FROSTFIN_PRESET_ID = 'frostfin'

/** DSH home：$DSH_HOME 或 ~/.dsh（对齐 dsh-home-paths 的规则）。 */
function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  return resolve(fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh'))
}

/** 用户 preset 根目录下 frostfin 预设的目标目录。 */
export function presetTargetDir(): string {
  return join(dshHome(), '.agent-presets', FROSTFIN_PRESET_ID)
}

/** 目标文件内容与包内源一致（我们写的，可以安全移除）。 */
function matchesSource(name: string, target: string): boolean {
  try {
    return readFileSync(join(SOURCE, FROSTFIN_PRESET_ID, name), 'utf8')
      === readFileSync(join(target, name), 'utf8')
  } catch {
    return false
  }
}

/**
 * 安装 preset；返回撤销句柄（移除我们安装且未被用户改动的文件，
 * 目录空了连同 `.agent-presets` 之外的 frostfin 目录一起删）。
 */
export function installPreset(logger: Logger): () => void {
  const target = presetTargetDir()
  const files = ['agent.cordis.yml', 'preset.yml'] as const
  if (existsSync(target) && files.every(name => !matchesSource(name, target) && existsSync(join(target, name)))) {
    logger.warn('frostfin: preset 目录 %s 已存在且内容被修改过，跳过安装（分发路由仍按 id 生效）', target)
    return () => {}
  }
  cpSync(join(SOURCE, FROSTFIN_PRESET_ID), target, { recursive: true })
  logger.info('frostfin: 已安装「月芒霜鳍鲸」preset 到 %s', target)
  return () => {
    for (const name of files) {
      if (matchesSource(name, target)) rmSync(join(target, name))
    }
    try {
      rmSync(target, { recursive: false })
    } catch {
      // 目录里还有用户自己的文件：保留目录，不强行清理。
    }
  }
}
