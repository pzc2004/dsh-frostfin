/**
 * M7 问题通道：kimi 的 AskUserQuestion 经 ACP 复用 `session/request_permission`
 * （ACP 没有专门的提问 RPC——反向通道只有权限/文件/终端三类），选项嵌在
 * `q<问题号>_opt_<选项号>` 命名空间里（kimi 侧：acp-adapter/src/question.ts）。
 * DSH 的 approval 服务是封闭四值枚举、请求结构没有选项字段，放不下多选题；
 * 本模块给问题单开一条插件自闭环通道：注册表挂起 → 浏览器模态框 → 回答回传。
 *
 * @module dsh-frostfin/question
 */

import { randomUUID } from 'node:crypto'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'

/** kimi 选项 optionId 的命名空间（q0_opt_0 / q0_skip …）。 */
const QUESTION_OPTION_ID = /^q\d+_(opt_\d+|skip)$/

/**
 * 识别"这是 kimi 的 AskUserQuestion 而不是工具审批"。
 * 双条件缺一不可：title 是适配器写死的 'AskUserQuestion'
 * （acp-adapter/src/session.ts handleQuestion），且至少一个选项落在
 * q*_opt_* 命名空间——防某个真叫 AskUserQuestion 的工具的普通审批被误截。
 */
export function isKimiQuestion(params: RequestPermissionRequest): boolean {
  if (params.toolCall.title !== 'AskUserQuestion') return false
  return params.options.some(option => QUESTION_OPTION_ID.test(option.optionId))
}

/** 从 toolCall.content 提取问题文本（content 型 text 部件拼接；兜底空串）。 */
export function extractQuestionText(params: RequestPermissionRequest): string {
  const parts: string[] = []
  for (const entry of params.toolCall.content ?? []) {
    if (entry.type === 'content' && entry.content.type === 'text') parts.push(entry.content.text)
  }
  return parts.join('\n')
}

/** 面板上的一道待答问题（GET 端点的 DTO）。 */
export interface PendingQuestion {
  id: string
  /** 拥有该问题的 DSH 会话 id（浏览器按会话轮询）。 */
  sessionId: string
  question: string
  /**
   * 选项原样透传。description 是预埋管线：当前 kimi 适配器会丢弃选项描述，
   * 若上游改经 `_meta.description` 携带（ACP 保留扩展位），面板即刻可渲染。
   */
  options: { optionId: string; name: string; kind?: string; description?: string }[]
  createdAt: string
}

interface ParkedQuestion {
  question: PendingQuestion
  settle: (response: RequestPermissionResponse) => void
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }

/**
 * 待答问题注册表：ask 挂起一个 request_permission 直到浏览器回答或中止。
 * 中止（turn 取消/进程退出/插件卸载）一律 fail-closed 为 cancelled
 * （kimi 语义 = 用户跳过，模型改用文本追问），绝不伪造用户没给过的答案。
 */
export class QuestionRegistry {
  private readonly parked = new Map<string, ParkedQuestion>()

  /**
   * 挂起一个问题，返回给 ACP 的应答 promise。
   * @param sessionId - 拥有该问题的 DSH 会话 id。
   * @param params - 原始 request_permission 请求（选项原样透传给面板）。
   * @param signal - 跟随 turn/进程的中止信号；中止即取消作答。
   */
  ask(sessionId: string, params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    if (signal.aborted) return Promise.resolve(CANCELLED)
    const question: PendingQuestion = {
      id: randomUUID(),
      sessionId,
      question: extractQuestionText(params),
      options: params.options.map((option) => {
        // 预埋：上游若经 _meta.description 带选项描述（ACP 保留扩展位），直接透传给面板。
        const meta = (option as { _meta?: { description?: unknown } })._meta
        const description = typeof meta?.description === 'string' && meta.description !== '' ? meta.description : undefined
        return { optionId: option.optionId, name: option.name, kind: option.kind, ...description === undefined ? {} : { description } }
      }),
      createdAt: new Date().toISOString(),
    }
    return new Promise((resolve) => {
      const entry: ParkedQuestion = {
        question,
        settle: (response) => {
          signal.removeEventListener('abort', onAbort)
          this.parked.delete(question.id)
          resolve(response)
        },
      }
      const onAbort = (): void => { entry.settle(CANCELLED) }
      signal.addEventListener('abort', onAbort, { once: true })
      this.parked.set(question.id, entry)
    })
  }

  /** 某会话的待答问题（按挂起先后；面板一次只显示最旧的一道）。 */
  list(sessionId: string): PendingQuestion[] {
    return [...this.parked.values()]
      .map(entry => entry.question)
      .filter(question => question.sessionId === sessionId)
  }

  /**
   * 浏览器作答：optionId 必须属于该问题的选项（防越权/过期作答）。
   * @returns 是否成功应答（问题不存在或选项不匹配为 false）。
   */
  answer(id: string, optionId: string): boolean {
    const entry = this.parked.get(id)
    if (entry === undefined) return false
    if (!entry.question.options.some(option => option.optionId === optionId)) return false
    entry.settle({ outcome: { outcome: 'selected', optionId } })
    return true
  }

  /** 插件卸载：取消全部待答问题（kimi 侧按"用户跳过"继续）。 */
  cancelAll(): void {
    for (const entry of this.parked.values()) entry.settle(CANCELLED)
  }
}
