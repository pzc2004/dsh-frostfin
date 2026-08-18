/**
 * ACP `session/update` → DSH 会话事件的纯转译层（映射表见 docs/design-v0.1.md §4）。
 *
 * 本模块不做任何 I/O：一个 ACP prompt 对应一个 DSH turn，转译器持有该 turn
 * 内的全部簿记状态（当前 step、累计文本、未终态的工具调用），调用方按序把
 * 产出事件写进 `session.append`。事件顺序纪律照抄
 * `deepseek-harness/packages/core/agent-loop/src/agent.ts`：
 * step 内先 chunk、再 assistant/message、再 tool/call、再 tool/result，
 * 本 step 全部工具终态后 step/end，新内容开启下一 step。
 *
 * @module dsh-frostfin/translate
 */

import type { ContentBlock as AcpContentBlock, Plan, SessionUpdate, StopReason, ToolCall as AcpToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { AgentCancelCause, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AssistantMessage, CallId, ContentBlock, StreamChunk, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { CallId as brandCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * 转译产物：一条待落盘的 DSH 会话事件（不含 seq/time/surface 元数据——
 * seq 由 `session.append` 赋予，`assistant/message`、`tool/result` 的
 * `sourceEventSeqs` 由调用方在落盘时按 chunk/call 的实际 seq 回填）。
 * `turn/start` 与 `user/message` 只在回放转译（translateReplay）里产出；
 * live 路径的这两个事件由 agent 直接落盘。
 */
export type TranslatedEvent =
  | { type: 'turn/start'; turn: number }
  | { type: 'step/start'; turn: number; step: number }
  | { type: 'step/end'; turn: number; step: number }
  | { type: 'user/message'; message: UserMessage }
  /** `accumulate` 标记该 chunk 是否汇入本 step 的 assistant/message 聚合。 */
  | { type: 'assistant/chunk'; turn: number; step: number; chunk: StreamChunk; accumulate: boolean }
  | { type: 'assistant/message'; turn: number; step: number; message: AssistantMessage }
  | { type: 'tool/call'; turn: number; step: number; callId: CallId; name: string; arguments: string }
  | { type: 'tool/result'; turn: number; step: number; callId: CallId; message: ToolResultMessage; error?: { name: string; code: string } }
  | { type: 'turn/end'; turn: number; reason: TurnEndReason }

/** ACP 流式 chunk 里 DSH 侧块序号的分配：思考块在前、可见文本块在后。 */
const REASONING_BLOCK_INDEX = 0
const TEXT_BLOCK_INDEX = 1
/** plan 快照独立成块，不汇入 assistant/message 聚合。 */
const PLAN_BLOCK_INDEX = 2

/** 一条工具调用在转译器内的簿记（result 需要 call 的原始事实）。 */
interface ToolCallState {
  callId: CallId
  name: string
  arguments: string
}

/** 一次 ACP prompt（= 一个 DSH turn）的转译器。 */
export interface Translator {
  /** 本转译器所属的 turn 号。 */
  readonly turn: number
  /** 当前打开的 step 号（0 表示尚无 step，仅供错误上报定位）。 */
  readonly currentStep: number
  /**
   * 开启 turn 的第一个 step。产出 `step/start`；调用方随后把本轮的
   * `user/message` 事件落在它之后、第一条 ACP 更新之前（agent-loop 的次序）。
   */
  begin(): TranslatedEvent[]
  /** 消费一条 ACP `session/update`，按序产出零或多条 DSH 事件。 */
  push(update: SessionUpdate): TranslatedEvent[]
  /**
   * 收尾本 turn：冲刷聚合消息、为未终态的工具调用合成错误结果、
   * 关闭未关的 step，最后产出 `turn/end`。幂等；重复调用产出空列表。
   */
  close(reason: TurnEndReason): TranslatedEvent[]
}

/**
 * ACP `stopReason` → DSH `TurnEndReason`（照抄 subagent-acp run.ts 的映射）。
 * DSH 的 `TurnEndReason` 没有 `refusal` 变体，refusal 与 max_turn_requests
 * 一律归为 error——不收尾的停止绝不报成 completed。
 * @param stop - `session/prompt` 响应里的终止原因。
 * @param cause - 本地取消原因（`cancelled` 映射为 aborted 时随附）。
 * @returns 对应的 DSH turn 结束原因。
 */
export function acpStopReason(stop: StopReason, cause: AgentCancelCause): TurnEndReason {
  switch (stop) {
    case 'end_turn':
      return { kind: 'completed' }
    case 'cancelled':
      return { kind: 'aborted', reason: cause }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'refusal':
      return { kind: 'error', error: { message: 'kimi acp 以 refusal 结束了本轮', code: 'FROSTFIN_REFUSAL' } }
    case 'max_turn_requests':
      return { kind: 'error', error: { message: 'kimi acp 触达轮次预算上限（max_turn_requests）', code: 'FROSTFIN_MAX_TURN_REQUESTS' } }
    // StopReason 是封闭线上联合；未来新增的未知变体按失败处理。
    default:
      return { kind: 'error', error: { message: `kimi acp 以未知原因结束本轮：${String(stop)}`, code: 'FROSTFIN_UNKNOWN_STOP' } }
  }
}

/**
 * ACP prompt 块：文本或内联图片（ACP ImageContent：base64 + MIME）。
 * kimi 侧把 image 块转成 data URL 并做格式门控/压缩（acp-adapter/src/convert.ts）。
 */
export type AcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/**
 * 图片附件解析器：DSH 的 image 块只持不透明引用（ImageAttachmentRef），
 * 字节在 ctx.attachments 服务里。返回 undefined = 读不到（无附件服务/校验失败），
 * toAcpPrompt 会以文本占位——用户发的图绝不能无声消失。
 */
export type ImageResolver = (ref: ImageAttachmentRef) => Promise<{ data: string; mimeType: string } | undefined>

/**
 * 把 DSH 用户消息压平成 ACP prompt 块。文本块原样保留；image 块经
 * resolveImage 读字节转 base64；其余块丢弃（同 run.ts 的 toAcpPrompt）。
 * @param messages - 本轮进入的用户消息。
 * @param resolveImage - 可选的图片字节解析器（缺省时图片变文本占位）。
 * @returns ACP prompt 块序列。
 */
export async function toAcpPrompt(
  messages: readonly UserMessage[],
  resolveImage?: ImageResolver,
): Promise<AcpPromptBlock[]> {
  const blocks: AcpPromptBlock[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type === 'image') {
        const image = resolveImage === undefined
          ? undefined
          : await resolveImage(block.attachment).catch(() => undefined)
        blocks.push(image === undefined
          ? { type: 'text', text: '[图片不可用：读取失败或宿主无附件服务]' }
          : { type: 'image', ...image })
      }
    }
  }
  return blocks
}

/** 提取 ACP 内容块的文本（非文本块贡献空串，同 run.ts 的 acpContentText）。 */
function contentText(content: AcpContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

/** 序列化工具调用参数；rawInput 不是可 JSON 化的值时退化为 '{}'。 */
function stringifyArguments(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return '{}'
  try {
    return JSON.stringify(rawInput) ?? '{}'
  } catch {
    // JSON.stringify 仅对循环引用/ BigInt 抛错；此时参数不可表达，按空调用记录。
    return '{}'
  }
}

/** 把工具终态更新里的内容压成 DSH 文本块（diff/terminal 折叠为摘要文本）。 */
function toolResultContent(update: ToolCallUpdate, isError: boolean, emptyText?: string): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const part of update.content ?? []) {
    if (part.type === 'content') {
      const text = contentText(part.content)
      if (text !== '') blocks.push({ type: 'text', text })
    } else if (part.type === 'diff') {
      blocks.push({ type: 'text', text: `[diff] ${part.path}` })
    } else if (part.type === 'terminal') {
      blocks.push({ type: 'text', text: `[terminal] ${part.terminalId}` })
    }
  }
  if (blocks.length === 0 && update.rawOutput !== undefined && update.rawOutput !== null) {
    blocks.push({ type: 'text', text: stringifyArguments(update.rawOutput) })
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: emptyText ?? (isError ? 'Error: tool call failed' : '(no output)') })
  }
  return blocks
}

/** 把 ACP plan 快照渲染成 Markdown 清单文本。 */
function renderPlan(plan: Plan): string {
  if (plan.entries.length === 0) return ''
  const lines = plan.entries.map(entry => `- [${entry.status}] ${entry.content}`)
  return `Plan:\n${lines.join('\n')}\n`
}

/** 创建一次 prompt（一个 turn）的转译器。 */
export function createTranslator(turn: number): Translator {
  return new AcpTranslator(turn)
}

class AcpTranslator implements Translator {
  private step = 0
  private stepOpen = false
  private text = ''
  private reasoning = ''
  private readonly pending = new Map<string, ToolCallState>()
  /** 流式懒创建（pending 且无 rawInput 的 tool_call）挂起集：存创建报文，等 started 补发带完整入参再落卡。 */
  private readonly heldCalls = new Map<string, AcpToolCall>()
  private closed = false

  constructor(readonly turn: number) {}

  get currentStep(): number {
    return this.step
  }

  begin(): TranslatedEvent[] {
    // 防御：begin 前就有内容到达时 step 1 已由 openStepIfNeeded 开启。
    if (this.stepOpen) return []
    this.step = 1
    this.stepOpen = true
    return [{ type: 'step/start', turn: this.turn, step: this.step }]
  }

  push(update: SessionUpdate): TranslatedEvent[] {
    // turn 已关闭的迟到更新直接丢弃。
    if (this.closed) return []
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = contentText(update.content)
        if (text === '') return []
        const events = this.openStepIfNeeded()
        this.text += text
        events.push({ type: 'assistant/chunk', turn: this.turn, step: this.step, chunk: { type: 'text-delta', index: TEXT_BLOCK_INDEX, text }, accumulate: true })
        return events
      }
      case 'agent_thought_chunk': {
        const text = contentText(update.content)
        if (text === '') return []
        const events = this.openStepIfNeeded()
        this.reasoning += text
        events.push({ type: 'assistant/chunk', turn: this.turn, step: this.step, chunk: { type: 'reasoning-delta', index: REASONING_BLOCK_INDEX, text }, accumulate: true })
        return events
      }
      case 'tool_call':
        return this.onToolCall(update)
      case 'tool_call_update':
        return this.onToolCallUpdate(update)
      case 'plan': {
        const text = renderPlan(update)
        if (text === '') return []
        const events = this.openStepIfNeeded()
        events.push({ type: 'assistant/chunk', turn: this.turn, step: this.step, chunk: { type: 'text-delta', index: PLAN_BLOCK_INDEX, text }, accumulate: false })
        return events
      }
      // user_message_chunk（回声）、available_commands_update、current_mode_update、
      // usage_update、plan_update/plan_removed 等：M1 不消费。
      default:
        return []
    }
  }

  close(reason: TurnEndReason): TranslatedEvent[] {
    if (this.closed) return []
    this.closed = true
    const events: TranslatedEvent[] = []
    events.push(...this.flushAssistant())
    // 挂起的懒创建随 turn 结束（取消/子进程死亡）：补落 tool/call，
    // 交给下面的悬挂循环统一合成错误结果——不让它无声消失。
    for (const [id, call] of this.heldCalls) {
      if (this.pending.has(id)) continue
      events.push(...this.openStepIfNeeded())
      const state: ToolCallState = {
        callId: brandCallId(id),
        name: call.name ?? call.title ?? 'unknown',
        arguments: stringifyArguments(call.rawInput),
      }
      this.pending.set(id, state)
      events.push({ type: 'tool/call', turn: this.turn, step: this.step, callId: state.callId, name: state.name, arguments: state.arguments })
    }
    this.heldCalls.clear()
    for (const call of this.pending.values()) {
      // turn 结束时仍悬挂的调用（取消 / 子进程死亡）：合成错误结果，
      // 保住 invariant 的 call→result 配对纪律。
      events.push({
        type: 'tool/result',
        turn: this.turn,
        step: this.step,
        callId: call.callId,
        message: createToolResultMessage({
          callId: call.callId,
          content: [{ type: 'text', text: 'Error: tool call did not complete before the turn ended' }],
          isError: true,
        }),
        error: { name: 'AbortError', code: 'FROSTFIN_TOOL_INCOMPLETE' },
      })
    }
    this.pending.clear()
    if (this.stepOpen) {
      events.push({ type: 'step/end', turn: this.turn, step: this.step })
      this.stepOpen = false
    }
    events.push({ type: 'turn/end', turn: this.turn, reason })
    return events
  }

  /** 新 tool_call：先冲刷 assistant 聚合（保住 message 在 call 前的次序），再落 call。 */
  private onToolCall(call: AcpToolCall): TranslatedEvent[] {
    // 流式懒创建（参数还在流、rawInput 缺席）：挂起等 started 补发带完整入参再落卡——
    // 此刻落盘只能快照到 '{}'，而 DSH 的 tool/call 落盘即不可变（kimi ACP 懒创建路径）。
    // in_progress 首发不挂起、立即落卡：那是真 started，不会再有更好的入参来了（如无参工具）。
    if (call.rawInput === undefined && call.status !== 'in_progress' && call.status !== 'completed' && call.status !== 'failed') {
      this.heldCalls.set(call.toolCallId, call)
      return []
    }
    // 同 id 的正式创建到达：清掉可能存在的挂起条目——不然后续带入参的更新会
    // 命中升级分支再落一条同 callId 的 tool/call（对端重发创建的防御）。
    this.heldCalls.delete(call.toolCallId)
    const events = this.openStepIfNeeded()
    events.push(...this.flushAssistant())
    const state: ToolCallState = {
      callId: brandCallId(call.toolCallId),
      // ACP 的 name 字段仍是 unstable 可选；没有就用人类可读的 title 顶上。
      name: call.name ?? call.title ?? 'unknown',
      arguments: stringifyArguments(call.rawInput),
    }
    this.pending.set(call.toolCallId, state)
    events.push({ type: 'tool/call', turn: this.turn, step: this.step, callId: state.callId, name: state.name, arguments: state.arguments })
    // 防御：有的 agent 会以终态直接首发 tool_call，不再补 tool_call_update。
    if (call.status === 'completed' || call.status === 'failed') {
      events.push(...this.completeCall(call.toolCallId, call))
    }
    return events
  }

  /**
   * tool_call_update：挂起懒创建的补发（非终态、带完整 rawInput）落 tool/call；
   * 终态（completed/failed）落盘为 tool/result。
   */
  private onToolCallUpdate(update: ToolCallUpdate): TranslatedEvent[] {
    const held = this.heldCalls.get(update.toolCallId)
    if (update.status !== 'completed' && update.status !== 'failed') {
      // 非终态更新只在一种情况落盘：挂起的懒创建等来了带完整 rawInput 的 started 补发——
      // 此刻才落卡（完整入参），后续审批弹窗的 callId 锚定成立；补发无入参则继续挂起。
      if (held === undefined || update.rawInput === undefined) return []
      this.heldCalls.delete(update.toolCallId)
      const events = this.openStepIfNeeded()
      events.push(...this.flushAssistant())
      const state: ToolCallState = {
        callId: brandCallId(update.toolCallId),
        name: update.name ?? update.title ?? held.name ?? held.title ?? 'unknown',
        arguments: stringifyArguments(update.rawInput),
      }
      this.pending.set(update.toolCallId, state)
      events.push({ type: 'tool/call', turn: this.turn, step: this.step, callId: state.callId, name: state.name, arguments: state.arguments })
      return events
    }
    this.heldCalls.delete(update.toolCallId)
    const events = this.openStepIfNeeded()
    if (!this.pending.has(update.toolCallId)) {
      // 防御：没见过 tool/call 的终态更新（含挂起直达终态）——不变量要求 result 必须有同 step 的 call 先行。
      events.push(...this.flushAssistant())
      const state: ToolCallState = {
        callId: brandCallId(update.toolCallId),
        name: update.name ?? update.title ?? held?.name ?? held?.title ?? 'unknown',
        arguments: stringifyArguments(update.rawInput),
      }
      this.pending.set(update.toolCallId, state)
      events.push({ type: 'tool/call', turn: this.turn, step: this.step, callId: state.callId, name: state.name, arguments: state.arguments })
    }
    events.push(...this.completeCall(update.toolCallId, update))
    return events
  }

  /** 一条调用到达终态：落 tool/result；本 step 悬挂调用清零则关闭 step。 */
  private completeCall(toolCallId: string, update: ToolCallUpdate): TranslatedEvent[] {
    const state = this.pending.get(toolCallId)
    if (state === undefined) return []
    this.pending.delete(toolCallId)
    const isError = update.status === 'failed'
    const events: TranslatedEvent[] = [{
      type: 'tool/result',
      turn: this.turn,
      step: this.step,
      callId: state.callId,
      message: createToolResultMessage({
        callId: state.callId,
        content: toolResultContent(update, isError),
        isError,
      }),
      ...isError ? { error: { name: 'ToolError', code: 'FROSTFIN_TOOL_FAILED' } } : {},
    }]
    if (this.pending.size === 0) {
      // 本 step 的工具批次全部终态：冲刷悬挂期间到达的文本，然后关闭 step；
      // 之后的文本/思考/新调用会在 openStepIfNeeded 里开启下一 step。
      events.push(...this.flushAssistant())
      events.push({ type: 'step/end', turn: this.turn, step: this.step })
      this.stepOpen = false
    }
    return events
  }

  /** step 已关闭（上一批工具终态）而又有新内容到达：开启下一 step。 */
  private openStepIfNeeded(): TranslatedEvent[] {
    if (this.stepOpen) return []
    this.step += 1
    this.stepOpen = true
    return [{ type: 'step/start', turn: this.turn, step: this.step }]
  }

  /** 把本 step 累计的思考/文本聚合为一条 assistant/message（无可聚合内容时不产出）。 */
  private flushAssistant(): TranslatedEvent[] {
    if (this.text === '' && this.reasoning === '') return []
    const content: ContentBlock[] = []
    if (this.reasoning !== '') content.push({ type: 'reasoning', text: this.reasoning })
    if (this.text !== '') content.push({ type: 'text', text: this.text })
    this.text = ''
    this.reasoning = ''
    // provenance 的 provider/model 只是展示元数据：模型与工具都在 kimi 侧，
    // M1 先落固定值，M4 再从 ACP configOptions 回读真实路由。
    const message: AssistantMessage = createAssistantMessage({
      content,
      source: { provider: 'kimi-acp', model: 'kimi' },
    })
    return [{ type: 'assistant/message', turn: this.turn, step: this.step, message }]
  }
}

/** 回放里工具结果内容的占位文本（kimi 的 session/load 回放不带工具输出）。 */
const REPLAY_RESULT_PLACEHOLDER = '(replayed history: tool output not retained by kimi)'

/**
 * 把 `session/load` 的回放序列一次性转译成合法的 DSH turn/step 结构
 * （attach 路径专用；resume 路径吞掉回放，不经过这里）。
 *
 * 探针实测（kimi 0.36.1）的回放形态：消息级整块——每条用户消息一个
 * `user_message_chunk`，每条助手输出一个整块的 `agent_message_chunk`/
 * `agent_thought_chunk`；工具调用以 `tool_call`（status 恒 in_progress）+
 * 后续 `tool_call_update`（completed/failed，无 content/rawOutput）成对出现；
 * 没有任何 turn 边界概念。规则：`user_message_chunk` 切开 turn（前 turn 以
 * completed 收尾），其余内容按 live 同款纪律落 step。
 *
 * @param updates - loadSession 期间收集到的完整回放序列。
 * @param firstTurn - 第一个回放 turn 的编号（接在现有日志最后 turn 之后）。
 * @returns 完整有序的事件列表（若干闭合 turn；空回放产空列表）。
 */
export function translateReplay(updates: readonly SessionUpdate[], firstTurn: number): TranslatedEvent[] {
  const events: TranslatedEvent[] = []
  let turn = firstTurn - 1
  let turnOpen = false
  let step = 0
  let stepOpen = false
  let text = ''
  let reasoning = ''
  const pending = new Map<string, ToolCallState>()

  const flushAssistant = (): void => {
    if (text === '' && reasoning === '') return
    const content: ContentBlock[] = []
    if (reasoning !== '') content.push({ type: 'reasoning', text: reasoning })
    if (text !== '') content.push({ type: 'text', text })
    reasoning = ''
    text = ''
    events.push({
      type: 'assistant/message',
      turn,
      step,
      message: createAssistantMessage({ content, source: { provider: 'kimi-acp', model: 'kimi' } }),
    })
  }
  const closeStep = (): void => {
    if (!stepOpen) return
    flushAssistant()
    events.push({ type: 'step/end', turn, step })
    stepOpen = false
  }
  const closeTurn = (): void => {
    if (!turnOpen) return
    closeStep()
    // 回放的都是已完成的历史：恒 completed。
    events.push({ type: 'turn/end', turn, reason: { kind: 'completed' } })
    turnOpen = false
  }
  const ensureOpen = (): void => {
    if (!turnOpen) {
      turn += 1
      step = 0
      turnOpen = true
      events.push({ type: 'turn/start', turn })
    }
    if (!stepOpen) {
      step += 1
      stepOpen = true
      events.push({ type: 'step/start', turn, step })
    }
  }
  const completeCall = (toolCallId: string, update: ToolCallUpdate): void => {
    const state = pending.get(toolCallId)
    if (state === undefined) return
    pending.delete(toolCallId)
    const isError = update.status === 'failed'
    events.push({
      type: 'tool/result',
      turn,
      step,
      callId: state.callId,
      message: createToolResultMessage({
        callId: state.callId,
        content: toolResultContent(update, isError, REPLAY_RESULT_PLACEHOLDER),
        isError,
      }),
      ...isError ? { error: { name: 'ToolError', code: 'FROSTFIN_TOOL_FAILED' } } : {},
    })
    if (pending.size === 0) closeStep()
  }

  for (const update of updates) {
    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        const content = contentText(update.content)
        if (content === '') continue
        // 新一条用户消息 = 新 turn（先把前 turn 以 completed 收好）。
        closeTurn()
        ensureOpen()
        events.push({
          type: 'user/message',
          message: createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } }),
        })
        break
      }
      case 'agent_message_chunk': {
        const chunk = contentText(update.content)
        if (chunk === '') continue
        ensureOpen()
        text += chunk
        events.push({ type: 'assistant/chunk', turn, step, chunk: { type: 'text-delta', index: TEXT_BLOCK_INDEX, text: chunk }, accumulate: true })
        break
      }
      case 'agent_thought_chunk': {
        const chunk = contentText(update.content)
        if (chunk === '') continue
        ensureOpen()
        reasoning += chunk
        events.push({ type: 'assistant/chunk', turn, step, chunk: { type: 'reasoning-delta', index: REASONING_BLOCK_INDEX, text: chunk }, accumulate: true })
        break
      }
      case 'tool_call': {
        ensureOpen()
        flushAssistant()
        const state: ToolCallState = {
          callId: brandCallId(update.toolCallId),
          name: update.name ?? update.title ?? 'unknown',
          arguments: stringifyArguments(update.rawInput),
        }
        pending.set(update.toolCallId, state)
        events.push({ type: 'tool/call', turn, step, callId: state.callId, name: state.name, arguments: state.arguments })
        // 防御：终态首发的 tool_call 不再等 update。
        if (update.status === 'completed' || update.status === 'failed') completeCall(update.toolCallId, update)
        break
      }
      case 'tool_call_update': {
        if (update.status !== 'completed' && update.status !== 'failed') continue
        ensureOpen()
        if (!pending.has(update.toolCallId)) {
          // 防御：没见过 call 的终态——先合成 call 保住配对纪律。
          flushAssistant()
          const state: ToolCallState = {
            callId: brandCallId(update.toolCallId),
            name: update.name ?? update.title ?? 'unknown',
            arguments: stringifyArguments(update.rawInput),
          }
          pending.set(update.toolCallId, state)
          events.push({ type: 'tool/call', turn, step, callId: state.callId, name: state.name, arguments: state.arguments })
        }
        completeCall(update.toolCallId, update)
        break
      }
      // plan、available_commands_update、usage_update 等元数据：回放不落盘。
      default:
        break
    }
  }
  closeTurn()
  return events
}
