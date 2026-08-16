/**
 * M2 审批桥：ACP `session/request_permission` → DSH `ctx.approval`。
 *
 * 桥本身是幂等无状态的；每次请求独立查 approval 服务（缺失/抛错/'unavailable'
 * 一律回落到 acp-process 的策略自动应答，ask 策略下的回落是 fail-closed 的
 * cancelled）。对照实现：deepseek-harness/packages/acp/acp/src/index.ts:215
 * （DSH 当 ACP server 时的反向同款映射）。
 *
 * @module dsh-frostfin/permission
 */

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { isKimiQuestion, type QuestionRegistry } from './question.js'

/** 审批桥所需的agent/服务/信号出口（全部延迟取值，避免创建次序耦合）。 */
export interface PermissionBridgeDeps {
  /** 代表哪个 agent 发问（路由与审计落盘都靠它）。 */
  agent: Agent
  /** 插件上下文（用 `ctx.get('approval')` 读未注入的服务）。 */
  ctx: Context
  /** 本次请求应跟随的中止信号：turn 取消 / 进程退出 / 插件卸载时中止。 */
  signal: () => AbortSignal
  /** 日志出口（回落告警，每种因由各报一次）。 */
  logger: { warn(format: string, ...args: unknown[]): void }
  /**
   * M7 问题通道：AskUserQuestion 形态的请求进插件自建 UI（注册表→浏览器模态框），
   * 与权限策略无关——'allow' 策略的自动应答会静默选第一个选项，对问题是错的。
   */
  questions?: QuestionRegistry
  /** false（allow/reject 策略）时非问题类请求交还 acp-process 自动应答。 */
  ask: boolean
}

/** ACP 权限应答：'selected' 选中某选项，或 'cancelled'。 */
function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId } }
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }

/** 'allowed-once' 的落点：优先 allow_once；kimi 只给 allow_always 时以它作答。 */
function allowOption(params: RequestPermissionRequest): RequestPermissionResponse {
  const option = params.options.find(o => o.kind === 'allow_once')
    ?? params.options.find(o => o.kind === 'allow_always')
  return option === undefined ? CANCELLED : selected(option.optionId)
}

/** 'rejected' 的落点：优先 reject_once；没有就 reject_always；都没有只能 cancelled。 */
function rejectOption(params: RequestPermissionRequest): RequestPermissionResponse {
  const option = params.options.find(o => o.kind === 'reject_once')
    ?? params.options.find(o => o.kind === 'reject_always')
  return option === undefined ? CANCELLED : selected(option.optionId)
}

/**
 * 创建一个权限桥回调。返回 undefined 表示"本桥不接"，由 acp-process
 * 回落到 config 策略自动应答（ask 策略下即 cancelled，fail-closed）。
 * @param deps - agent、上下文、信号与日志出口。
 * @returns 给 acp-process 的 onRequestPermission 回调。
 */
export function createPermissionBridge(
  deps: PermissionBridgeDeps,
): (params: RequestPermissionRequest) => Promise<RequestPermissionResponse | undefined> {
  const warned = new Set<string>()
  const warnOnce = (key: string, format: string, ...args: unknown[]): void => {
    if (warned.has(key)) return
    warned.add(key)
    deps.logger.warn(format, ...args)
  }
  return async (params) => {
    // M7：kimi 的提问（AskUserQuestion 经 ACP 复用本通道）单走插件自建 UI——
    // DSH approval 的四值枚举带不回"用户选了第几个选项"，进 approval 只会压扁成
    // "允许=第一个选项"的错误应答。本分支不看权限策略（'allow' 的自动应答同样会错选）。
    if (deps.questions !== undefined && isKimiQuestion(params)) {
      return deps.questions.ask(String(deps.agent.id), params, deps.signal())
    }
    // 非 ask 策略：普通审批交还 acp-process 按 allow/reject 自动应答。
    if (!deps.ask) return undefined
    const approval = deps.ctx.get('approval')
    if (approval === undefined) {
      warnOnce('no-service', 'frostfin: permission=ask 但宿主没有 approval 服务，审批请求回落为拒绝（cancelled）')
      return undefined
    }
    // kimi 的 ToolCallUpdate 里 name 仍是 unstable 可选；title/kind 组成人类可读的发问理由。
    const name = params.toolCall.name ?? undefined
    const title = params.toolCall.title ?? undefined
    const kind = params.toolCall.kind ?? undefined
    const reason = [title, kind === undefined ? undefined : `kind=${kind}`]
      .filter((part): part is string => part !== undefined)
      .join(' / ') || undefined
    let outcome: ApprovalOutcome
    try {
      outcome = await approval.request({
        agent: deps.agent,
        toolName: name ?? title ?? 'unknown',
        callId: CallId(params.toolCall.toolCallId),
        ...reason === undefined ? {} : { reason },
        signal: deps.signal(),
      })
    } catch (error: unknown) {
      // 主要是"无打开的 turn"的纪律抛错：按 unavailable 路径回落。
      warnOnce('request-threw', 'frostfin: approval.request 抛错（%s），审批请求回落为拒绝（cancelled）', String(error))
      return undefined
    }
    switch (outcome) {
      case 'allowed-once':
        return allowOption(params)
      case 'rejected':
        return rejectOption(params)
      case 'cancelled':
        return CANCELLED
      case 'unavailable':
        warnOnce('unavailable', 'frostfin: approval 答复链不可用（无应答 UI？），审批请求回落为拒绝（cancelled）')
        return undefined
    }
  }
}
