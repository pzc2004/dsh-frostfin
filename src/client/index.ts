/**
 * frostfin 的浏览器半身：把「Kimi 会话」面板注册进会话视图环
 * （conversation.view 槽位，与 Chat / Trajectory 并列）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { SessionsPanel } from './SessionsPanel.js'
import { FilePanel } from './FilePanel.js'
import { StatusDock } from './StatusDock.js'
import { QuestionModal } from './QuestionModal.js'
import { KimiConfigPill } from './KimiConfigPill.js'
import { UploadPill } from './UploadPill.js'
import { FoldStepsPill, installFoldSteps } from './FoldStepsPill.js'
import { installCollapsibleMessages } from './collapse-nodes.js'

/** 需要的客户端服务：槽位系统 + 会话导航。 */
export const inject = ['slots', 'sessions']

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'frostfin-kimi',
    order: 25,
    label: '月芒霜鳍鲸',
  }, () => createElement(SessionsPanel, {
    onOpen: (sessionId: string) => {
      // 接入成功后跳到目标会话（Chat 视图）。
      ctx.sessions.open(sessionId as never)
    },
  })))
  console.log('[frostfin] 会话面板 tab 已注册')

  // 「文件」tab：会话工作区文件树（轨迹(10) 与月芒霜鳍鲸(25) 之间），数据源 files 端点。
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'frostfin-files',
    order: 15,
    label: '文件',
    inject: (sessionId: string) => ({ sessionId }),
  }, (props: { sessionId: string }) => createElement(FilePanel, props)))
  console.log('[frostfin] 文件树 tab 已注册')

  // 输入区底部 dock：霜鳍鲸会话的 kimi 状态条（模型/思考/模式/上下文占用/cwd）。
  ctx.slots.inject('conversation.composer.dock', () => {
    console.log('[frostfin] composer.dock 声明已就绪，注册状态条')
    return ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'frostfin-status',
      inject: (sessionId: string) => ({ sessionId }),
    }, (props: { sessionId: string }) => createElement(StatusDock, props))
  })
  console.log('[frostfin] 状态条 dock 已提交 inject')

  // M7 问题模态框：同槽位常驻，有待答问题时弹出遮罩（kimi 的 AskUserQuestion）。
  ctx.slots.inject('conversation.composer.dock', () => {
    return ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'frostfin-question',
      inject: (sessionId: string) => ({ sessionId }),
    }, (props: { sessionId: string }) => createElement(QuestionModal, props))
  })
  console.log('[frostfin] 问题模态框 dock 已提交 inject')

  // 输入区工具行按钮：thinking 档位（右侧槽位，紧邻模型选择器）与
  // kimi 权限模式（左侧槽位，DSH 访问控制旁）。档位行来自 kimi 上报。
  ctx.slots.inject('conversation.input.right', () => {
    return ctx.slots.register({
      name: 'conversation.input.right',
      id: 'frostfin-thinking-pill',
      inject: (sessionId: string) => ({ sessionId }),
    }, (props: { sessionId: string }) => createElement(KimiConfigPill, { ...props, configId: 'thinking', label: 'thinking' }))
  })
  ctx.slots.inject('conversation.input.left', () => {
    return ctx.slots.register({
      name: 'conversation.input.left',
      id: 'frostfin-mode-pill',
      inject: (sessionId: string) => ({ sessionId }),
    }, (props: { sessionId: string }) => createElement(KimiConfigPill, { ...props, configId: 'mode', label: '模式' }))
  })
  // 传文件按钮（仅远程会话渲染，组件内自判）。
  ctx.slots.inject('conversation.input.left', () => {
    return ctx.slots.register({
      name: 'conversation.input.left',
      id: 'frostfin-upload-pill',
      inject: (sessionId: string) => ({ sessionId }),
    }, (props: { sessionId: string }) => createElement(UploadPill, props))
  })
  // 折叠步骤开关：隐藏对话流的 Think/工具行（CSS 钩子方案，见 FoldStepsPill 模块头）。
  ctx.effect(() => installFoldSteps(), 'frostfin.foldSteps()')
  // 单条消息折叠：长输入/长输出手动折成一两行（DOM 增量手术，见 collapse-nodes 模块头）。
  ctx.effect(() => installCollapsibleMessages(), 'frostfin.collapsibleMessages()')
  ctx.slots.inject('conversation.input.left', () => {
    return ctx.slots.register({
      name: 'conversation.input.left',
      id: 'frostfin-fold-steps',
      inject: (sessionId: string) => ({ sessionId }),
    }, () => createElement(FoldStepsPill))
  })
  console.log('[frostfin] 输入区配置按钮已提交 inject')

  /**
   * 输入框 @ 文件补全：注册进 DSH 的 inputTriggers 流水线（出厂 web profile 自带；
   * 菜单 UI/键盘仲裁/词边界守卫全是既成的）。候选走 complete 端点——锁在会话
   * cwd 子树、剪枝 node_modules 等重型目录；远程会话搜的是服务器上的工作区。
   * 选中插入裸相对路径（对齐 kimi 语义：prompt 里躺路径，模型自己 Read）。
   */
  interface InputTriggerSourceLike {
    trigger: '@'
    name: string
    order?: number
    candidates(session: { sessionId: string }, req: { query: string; signal: AbortSignal }): Promise<readonly { name: string; description?: string }[]>
    onPick(pick: { candidate: { name: string } }): { text: string }
  }
  const inputTriggers = ctx.get('inputTriggers') as { registerSource(src: InputTriggerSourceLike): () => void } | undefined
  if (inputTriggers === undefined) {
    console.warn('[frostfin] inputTriggers 服务缺席，@ 文件补全未注册')
  } else {
    ctx.effect(() => inputTriggers.registerSource({
      trigger: '@',
      name: '工作区文件',
      order: 10,
      async candidates({ sessionId }, { query, signal }) {
        const q = query.trim()
        if (q === '') return []
        try {
          const res = await fetch(`/plugins/frostfin/complete?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(q)}`, { signal })
          const data = await res.json() as { ok?: boolean; entries?: { path: string; dir: string }[] }
          if (!res.ok || data.ok !== true) return []
          return (data.entries ?? []).map(entry => ({ name: entry.path, ...entry.dir === '' ? {} : { description: entry.dir } }))
        } catch { return [] }
      },
      onPick: ({ candidate }) => ({ text: `${candidate.name} ` }),
    }), 'frostfin.@files()')
    console.log('[frostfin] @ 文件补全 source 已注册')
  }
}
