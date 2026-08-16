/**
 * 斜杠命令注册：frostfin 自带命令（/frostfin-* 系列）+ kimi 内建命令透传
 * （/compact /status /usage /mcp /tasks /help）+ 模式快捷键（/yolo /auto /frostfin-plan）。
 * 描述标签约定：[frostfin] = 插件命令，[kimi] = kimi 原生透传，无标签 = DSH 宿主命令。
 *
 * @module dsh-frostfin/commands
 */

import type { Context, Logger } from '@deepseek-ai/cordis'
// 类型面引用：让 Context 合并（ctx.get('commands')）生效。
import type {} from '@deepseek-ai/dsh-commands'
import type { SessionInfo as AcpSessionInfo } from '@agentclientprotocol/sdk'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { FrostfinAgent } from './agent.js'
import type { KimiSessionMap } from './kimi-sessions.js'

/** 列表渲染的行数上限。 */
const SESSION_LIST_MAX = 20

/** 把 ACP updatedAt（ISO 8601）转成本地可读时间；缺失/非法给占位文本。 */
function formatSessionTime(updatedAt: string | null | undefined): string {
  if (updatedAt === undefined || updatedAt === null) return '时间未知'
  const time = new Date(updatedAt)
  if (Number.isNaN(time.getTime())) return '时间未知'
  return time.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 渲染 /frostfin-sessions 的输出：updatedAt 倒序、最多 20 条，每条一行。
 * @param sessions - ACP session/list 的原始条目。
 * @param isBound - 某 kimi 会话是否已被 frostfin 绑定（行尾标注"已绑定"）。
 */
function formatKimiSessionList(sessions: readonly AcpSessionInfo[], isBound: (kimiSessionId: string) => boolean): string {
  if (sessions.length === 0) {
    return '本机磁盘上没有 kimi 会话。'
  }
  const sorted = [...sessions]
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, SESSION_LIST_MAX)
  const lines = sorted.map((session, index) => {
    const title = session.title ?? ''
    const bound = isBound(session.sessionId) ? '（已绑定）' : ''
    return `${index + 1}. ${title === '' ? '(无标题)' : title} · ${formatSessionTime(session.updatedAt)} · ${session.cwd} · ${session.sessionId}${bound}`
  })
  lines.push('', '接入方式：/frostfin-attach <sessionId>')
  return lines.join('\n')
}

/**
 * 注册全部斜杠命令（宿主缺 commands 服务时整体跳过，如 headless 精简组合）。
 * 注册走 Cordis effect，卸载即全部撤销。
 */
export function registerSlashCommands(ctx: Context, logger: Logger, kimiMap: KimiSessionMap): void {
  const commands = ctx.get('commands')
  if (commands === undefined) {
    logger.info('宿主没有 commands 服务，/frostfin-attach 与 /frostfin-sessions 不注册')
    return
  }
  ctx.effect(() => {
    const disposeAttach = commands.register({
      name: 'frostfin-attach',
      description: '[frostfin] 接入一个既有 kimi 会话：/frostfin-attach session_xxx',
      input: { hint: 'session_ 开头的 kimi 会话 id' },
      handler: async (invocation) => {
        const { agent } = invocation
        if (!(agent instanceof FrostfinAgent)) {
          return { kind: 'error' as const, text: '当前会话不是 frostfin 驱动的' }
        }
        const kimiSessionId = invocation.rawInput.trim()
        if (kimiSessionId === '') {
          return {
            kind: 'success' as const,
            text: '用法：/frostfin-attach <sessionId>。先跑 /frostfin-sessions 列出本机可接入的 kimi 会话。',
          }
        }
        if (!kimiSessionId.startsWith('session_')) {
          return { kind: 'error' as const, text: '用法：/frostfin-attach session_xxx（kimi 会话 id 以 session_ 开头）' }
        }
        try {
          const turns = await agent.attachKimiSession(kimiSessionId)
          return { kind: 'success' as const, text: `已接入 kimi 会话 ${kimiSessionId}，回放写入 ${turns} 个 turn` }
        } catch (error: unknown) {
          return { kind: 'error' as const, text: `接入失败：${error instanceof Error ? error.message : String(error)}` }
        }
      },
    })
    const disposeSessions = commands.register({
      name: 'frostfin-sessions',
      description: '[frostfin] 列出本机磁盘上的 kimi 会话（按更新时间倒序）',
      handler: async (invocation) => {
        const { agent } = invocation
        if (!(agent instanceof FrostfinAgent)) {
          return { kind: 'error' as const, text: '当前会话不是 frostfin 驱动的' }
        }
        try {
          const sessions = await agent.listKimiSessions()
          return { kind: 'success' as const, text: formatKimiSessionList(sessions, id => kimiMap.hasValue(id)) }
        } catch (error: unknown) {
          return { kind: 'error' as const, text: `列出 kimi 会话失败：${error instanceof Error ? error.message : String(error)}` }
        }
      },
    })
    const disposeMode = commands.register({
      name: 'frostfin-mode',
      description: '[frostfin] 查看/切换 kimi 的权限模式：/frostfin-mode <default|plan|auto|yolo>',
      input: { hint: 'default | plan | auto | yolo' },
      handler: async (invocation) => {
        const { agent } = invocation
        if (!(agent instanceof FrostfinAgent)) {
          return { kind: 'error' as const, text: '当前会话不是 frostfin 驱动的' }
        }
        const mode = invocation.rawInput.trim()
        if (mode === '') {
          return { kind: 'success' as const, text: `当前 kimi 权限模式：${agent.getKimiStatus().mode ?? '未知'}。用法：/frostfin-mode <default|plan|auto|yolo>` }
        }
        if (!['default', 'plan', 'auto', 'yolo'].includes(mode)) {
          return { kind: 'error' as const, text: `未知模式 "${mode}"（可选：default / plan / auto / yolo）` }
        }
        try {
          await agent.setKimiMode(mode)
          return { kind: 'success' as const, text: `已切换 kimi 权限模式 → ${mode}` }
        } catch (error: unknown) {
          return { kind: 'error' as const, text: `切换失败：${error instanceof Error ? error.message : String(error)}` }
        }
      },
    })
    const disposeThinking = commands.register({
      name: 'frostfin-thinking',
      description: '[frostfin] 查看/切换 kimi 的 thinking 档位：/frostfin-thinking <off|low|medium|high>',
      input: { hint: 'off | low | medium | high（以模型支持为准）' },
      handler: async (invocation) => {
        const { agent } = invocation
        if (!(agent instanceof FrostfinAgent)) {
          return { kind: 'error' as const, text: '当前会话不是 frostfin 驱动的' }
        }
        const level = invocation.rawInput.trim()
        let supported = agent.getKimiThinkingOptions()
        if (supported === undefined) {
          // 惰性启动：进程未起时还没有选择器快照，先起进程再读（与切换同路径）。
          try {
            await agent.ensureKimiProcess()
            supported = agent.getKimiThinkingOptions()
          } catch (error: unknown) {
            return { kind: 'error' as const, text: `kimi 进程未就绪：${error instanceof Error ? error.message : String(error)}` }
          }
        }
        if (level === '') {
          const current = agent.getKimiStatus().thinking ?? '未知'
          return {
            kind: 'success' as const,
            text: supported === undefined
              ? '当前模型不支持 thinking 档位调节'
              : `当前 thinking 档位：${current}（可选：${supported.join(' / ')}）`,
          }
        }
        if (supported === undefined) {
          return { kind: 'error' as const, text: '当前模型不支持 thinking 档位调节' }
        }
        if (!supported.includes(level)) {
          return { kind: 'error' as const, text: `未知档位 "${level}"（可选：${supported.join(' / ')}）` }
        }
        try {
          await agent.setKimiThinking(level)
          return { kind: 'success' as const, text: `已切换 kimi thinking 档位 → ${level}` }
        } catch (error: unknown) {
          return { kind: 'error' as const, text: `切换失败：${error instanceof Error ? error.message : String(error)}` }
        }
      },
    })
    // kimi ACP 内建命令的透传（/compact /status /usage /mcp /tasks /help）：
    // 把原文作为用户消息发给 kimi，由 kimi 的适配器识别并执行——回复即结果。
    const KIMI_BUILTINS: readonly { name: string; description: string; hint?: string }[] = [
      { name: 'compact', description: '[kimi] 压缩当前会话的上下文', hint: '可选的自定义摘要指令' },
      { name: 'status', description: '[kimi] 显示 kimi 会话状态' },
      { name: 'usage', description: '[kimi] 显示 kimi 会话的 token 用量' },
      { name: 'mcp', description: '[kimi] 显示 kimi 的 MCP 服务器状态' },
      { name: 'tasks', description: '[kimi] 列出 kimi 的后台任务' },
      { name: 'help', description: '[kimi] 显示 kimi 可用命令' },
    ]
    const disposeBuiltins = KIMI_BUILTINS.map(builtin => {
      // 名称被宿主/其他插件占用时跳过（不因为一个冲突拖垮整组注册）。
      try {
        return commands.register({
          name: builtin.name,
          description: builtin.description,
          ...builtin.hint === undefined ? {} : { input: { hint: builtin.hint } },
          handler: async (invocation) => {
            const { agent } = invocation
            if (!(agent instanceof FrostfinAgent)) {
              return { kind: 'error' as const, text: `/${builtin.name} 只在「月芒霜鳍鲸」模式（kimi 驱动）的会话里可用` }
            }
            // 透传给 kimi：作为普通用户消息发出，kimi 适配器识别斜杠并执行。
            agent.followup(createUserMessage({
              content: [{ type: 'text', text: `/${builtin.name}${invocation.rawInput.trim() === '' ? '' : ` ${invocation.rawInput.trim()}`}` }],
              source: { kind: 'user' },
            }))
            return { kind: 'success' as const, text: `已交给 kimi 执行 /${builtin.name}` }
          },
        })
      } catch (error: unknown) {
        logger.warn('frostfin: 命令 /%s 注册失败（%s），跳过', builtin.name, error instanceof Error ? error.message : String(error))
        return () => {}
      }
    })
    // 模式快捷键：/yolo /auto 一键切 kimi 权限模式。
    const MODE_SHORTCUTS = ['yolo', 'auto'] as const
    const disposeShortcuts = MODE_SHORTCUTS.map(mode => {
      try {
        return commands.register({
          name: mode,
          description: `[kimi] 切换 kimi 权限模式到 ${mode}（= /frostfin-mode ${mode}）`,
          handler: async (invocation) => {
            const { agent } = invocation
            if (!(agent instanceof FrostfinAgent)) {
              return { kind: 'error' as const, text: `/${mode} 只在「月芒霜鳍鲸」模式的会话里可用` }
            }
            try {
              await agent.setKimiMode(mode)
              return { kind: 'success' as const, text: `已切换 kimi 权限模式 → ${mode}` }
            } catch (error: unknown) {
              return { kind: 'error' as const, text: `切换失败：${error instanceof Error ? error.message : String(error)}` }
            }
          },
        })
      } catch {
        logger.warn('frostfin: 命令 /%s 已被占用，跳过快捷键注册', mode)
        return () => {}
      }
    })
    // plan 快捷键：/plan 是 DSH plan-mode 在会话组合里注册的命令（standard 等 preset
    // 生效；frostfin 组合刻意不含它——kimi 看不到 DSH 的提示词与工具），不能抢名，
    // 用 /frostfin-plan 直达 kimi 的引擎级 plan 模式。
    const disposePlan = (() => {
      try {
        return commands.register({
          name: 'frostfin-plan',
          description: '[frostfin] 进入 kimi 的 plan 模式（= /frostfin-mode plan；引擎级只读）',
          handler: async (invocation) => {
            const { agent } = invocation
            if (!(agent instanceof FrostfinAgent)) {
              return { kind: 'error' as const, text: '/frostfin-plan 只在「月芒霜鳍鲸」模式的会话里可用' }
            }
            try {
              await agent.setKimiMode('plan')
              return { kind: 'success' as const, text: '已切换 kimi 权限模式 → plan' }
            } catch (error: unknown) {
              return { kind: 'error' as const, text: `切换失败：${error instanceof Error ? error.message : String(error)}` }
            }
          },
        })
      } catch {
        logger.warn('frostfin: 命令 /frostfin-plan 已被占用，跳过快捷键注册')
        return () => {}
      }
    })()
    return () => {
      disposeAttach()
      disposeSessions()
      disposeMode()
      disposeThinking()
      disposePlan()
      for (const dispose of disposeBuiltins) dispose()
      for (const dispose of disposeShortcuts) dispose()
    }
  }, 'frostfin.commands()')
}
