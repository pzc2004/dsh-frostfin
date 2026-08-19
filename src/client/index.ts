/**
 * frostfin 的浏览器半身：把「Kimi 会话」面板注册进会话视图环
 * （conversation.view 槽位，与 Chat / Trajectory 并列）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { SessionsPanel } from './SessionsPanel.js'
import { StatusDock } from './StatusDock.js'
import { QuestionModal } from './QuestionModal.js'
import { KimiConfigPill } from './KimiConfigPill.js'

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
  console.log('[frostfin] 输入区配置按钮已提交 inject')
}
