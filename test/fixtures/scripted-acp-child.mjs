// 测试夹具：一个 script 化的 ACP agent 子进程（不依赖真 kimi）。
// 走 ndjson stdio，协议面与 kimi acp 一致：initialize / session/new /
// session/prompt（流式 session/update）/ session/cancel / session/list / session/load。
// 每次 prompt 先发 session/request_permission（M2 审批桥的对端剧本）：
// - 选中 'yes'（allow）→ 跑完整剧本：思考 → 两段文本 → 工具调用（终态完成）→ 收尾文本 → end_turn；
// - 选中 'no'（reject）→ 只流一段标记文本后 end_turn；
// - cancelled → 直接以 stopReason 'cancelled' 应答。
// prompt 文本含 'boom' → 立即 exit(1)（模拟进程崩溃，驱动 M3 的自愈重连）。
// session/load → 回放一段固定剧本历史（整块消息级形态，与真 kimi 的探针一致）。
// session/delete → 记入删除集，后续 session/list 不再返回该会话。
import { Readable, Writable } from 'node:stream'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const SESSION_ID = 'scripted-session-1'
export const DEAD_SESSION_ID = 'session_scripted-dead'

/** 已删除的会话 id（session/delete 剧本）；FROSTFIN_FIXTURE_STATE 指向文件时跨进程持久化（探针进程即弃，状态得落盘）。 */
const stateFile = process.env.FROSTFIN_FIXTURE_STATE
const deleted = new Set(
  stateFile !== undefined && stateFile !== '' && existsSync(stateFile)
    ? readFileSync(stateFile, 'utf8').split('\n').filter(Boolean)
    : [],
)

/** 回放的固定剧本（含一轮纯文本 + 一轮工具调用）。 */
const REPLAY = [
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '（回放）之前让你做什么' } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '（回放）想一下' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '（回放）你好，世界' } },
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '（回放）读一下文件' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '（回放）我来读' } },
  { sessionUpdate: 'tool_call', toolCallId: 'tc-replay-1', title: 'Read', status: 'in_progress', rawInput: { path: '/tmp/y' } },
  { sessionUpdate: 'tool_call_update', toolCallId: 'tc-replay-1', status: 'completed' },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '（回放）读完了' } },
]

function makeAgent(conn) {
  // 会话内的"当前模型/模式/thinking 档位"（configOptions 同步与 setSessionConfigOption 共用）。
  let currentModel = 'kimi-for-coding'
  let currentMode = 'default'
  let currentThinking = 'high'
  const modelOptions = () => [{
    type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: currentModel,
    options: [
      { value: 'kimi-for-coding', name: 'Kimi For Coding' },
      { value: 'kimi-plain', name: 'Kimi Plain' },
      { value: 'relay/deepseek-v4-pro', name: 'DeepSeek V4 Pro（relay）' },
    ],
  }, {
    type: 'select', id: 'thinking', name: 'Thinking', category: 'thought_level', currentValue: currentThinking,
    options: [
      { value: 'off', name: 'Off' },
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  }, {
    type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: currentMode,
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
      { value: 'auto', name: 'Auto' },
      { value: 'yolo', name: 'Yolo' },
    ],
  }]
  return {
    initialize() {
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
          sessionCapabilities: { list: {} },
        },
        authMethods: [],
      })
    },
    newSession() {
      return Promise.resolve({ sessionId: SESSION_ID, configOptions: modelOptions() })
    },
    setSessionConfigOption(params) {
      if (params.configId === 'model') currentModel = params.value
      if (params.configId === 'mode') currentMode = params.value
      if (params.configId === 'thinking') currentThinking = params.value
      return Promise.resolve({ configOptions: modelOptions() })
    },
    authenticate() {
      return Promise.resolve()
    },
    listSessions() {
      // FROSTFIN_FIXTURE_EMPTY_LIST=1 时返回空列表（测空态渲染）。
      if (process.env.FROSTFIN_FIXTURE_EMPTY_LIST === '1') return Promise.resolve({ sessions: [] })
      return Promise.resolve({
        sessions: [
          { sessionId: SESSION_ID, cwd: process.cwd(), title: 'current scripted session', updatedAt: '2026-08-15T10:00:00.000Z' },
          { sessionId: DEAD_SESSION_ID, cwd: process.cwd(), title: 'scripted dead session', updatedAt: '2026-08-15T11:00:00.000Z' },
          { sessionId: 'session_no-title', cwd: process.cwd(), title: null, updatedAt: '2026-08-14T09:00:00.000Z' },
        ].filter(s => !deleted.has(s.sessionId)),
      })
    },
    deleteSession(params) {
      deleted.add(params.sessionId)
      if (stateFile !== undefined && stateFile !== '') appendFileSync(stateFile, params.sessionId + '\n')
      return Promise.resolve({})
    },
    async loadSession(params) {
      for (const update of REPLAY) {
        await conn.sessionUpdate({ sessionId: params.sessionId, update })
      }
      return {}
    },
    async prompt(params) {
      const text = params.prompt.map(block => (block.type === 'text' ? block.text : '')).join('')
      if (text.includes('boom')) process.exit(1)
      const say = (update) => conn.sessionUpdate({ sessionId: params.sessionId, update })
      // 斜杠命令剧本：模拟 kimi 适配器的内建命令执行（回显标记文本）。
      if (text.startsWith('/')) {
        await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `[executed] ${text}` } })
        return { stopReason: 'end_turn' }
      }
      // M7 问题剧本：prompt 含"提问"时模拟 kimi 的 AskUserQuestion（选项走 q0_* 命名空间），
      // 回显选中的 optionId；cancelled（=用户跳过）则回显 skipped。
      if (text.includes('提问')) {
        const answer = await conn.requestPermission({
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'tc-q1',
            title: 'AskUserQuestion',
            content: [{ type: 'content', content: { type: 'text', text: '选哪个方案？' } }],
          },
          options: [
            { optionId: 'q0_opt_0', name: '方案甲', kind: 'allow_once', _meta: { description: '甲方案的取舍说明' } },
            { optionId: 'q0_opt_1', name: '方案乙', kind: 'allow_once' },
            { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
          ],
        })
        const picked = answer.outcome.outcome === 'cancelled' ? 'cancelled' : answer.outcome.optionId
        await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `[answer] ${picked}` } })
        return { stopReason: 'end_turn' }
      }
      // 图片剧本：prompt 里每有一个 image 块就回显其 MIME 与 base64 长度（验证字节真的到了）。
      const images = params.prompt.filter(block => block.type === 'image')
      if (images.length > 0) {
        for (const image of images) {
          await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `[image] ${image.mimeType} ${image.data.length}` } })
        }
        return { stopReason: 'end_turn' }
      }
      const decision = await conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'Read /tmp/x', kind: 'read', name: 'Read' },
        options: [
          { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      })
      if (decision.outcome.outcome === 'cancelled') {
        return { stopReason: 'cancelled' }
      }
      if (decision.outcome.optionId === 'no') {
        await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'permission-rejected' } })
        return { stopReason: 'end_turn' }
      }
      await say({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一下' } })
      await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好，' } })
      await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '世界' } })
      await say({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read',
        status: 'in_progress',
        rawInput: { path: '/tmp/x' },
      })
      await say({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '文件内容' } }],
      })
      await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '读完了' } })
      // 模型被切换过时回显当前模型（默认模型不追加，保持既有断言稳定）。
      if (currentModel !== 'kimi-for-coding') {
        await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `（model:${currentModel}）` } })
      }
      return { stopReason: 'end_turn' }
    },
    cancel() {
      return Promise.resolve()
    },
  }
}

new AgentSideConnection(
  makeAgent,
  ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
)
