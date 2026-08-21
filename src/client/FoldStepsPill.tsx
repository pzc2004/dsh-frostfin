/**
 * 「折叠步骤」开关：一键隐藏对话流里的所有 Think 行与工具调用行——它们是
 * 长会话的主要体积（几百步的对话流折完只剩问答正文）。
 *
 * 实现是 CSS 开关而非渲染器替换：apply 时往 document.head 注入一条样式，
 * 开关联 <body> 的 class。选择器挂 DSH 的语义钩子——工具行根的 data-tool
 * （ToolRow.tsx:195）、Think 行根的 data-variant="think"（ReasoningRow.tsx:41）；
 * 不碰 React 节点，DSH 重渲染不受影响。替换 'assistant-step' 渲染器等于
 * fork DSH 内部实现（markdown/工具卡全套），维护上不值。
 *
 * 已知软肋：DSH 改动这两个钩子名时开关会静默失效（无害降级，不破坏页面）。
 * 偏好记 localStorage，全局生效（原生 loop 的会话同样可用）。
 */
import { useState } from 'react'

const BODY_CLASS = 'frostfin-fold-steps'
const STORE_KEY = 'frostfin.foldSteps'

/** 注入的样式（选择器即 DSH 的 data 钩子；范围限对话流列 [data-chat-flow]）。 */
const FOLD_STYLE = `
body.${BODY_CLASS} [data-chat-flow] div[data-variant="think"],
body.${BODY_CLASS} [data-chat-flow] div[data-tool] {
  display: none !important;
}
`

/** apply 时安装：注入样式并恢复上次开关状态；返回 ctx.effect 的清理函数。 */
export function installFoldSteps(): () => void {
  const style = document.createElement('style')
  style.id = 'frostfin-fold-steps-style'
  style.textContent = FOLD_STYLE
  document.head.appendChild(style)
  if (localStorage.getItem(STORE_KEY) === '1') document.body.classList.add(BODY_CLASS)
  return () => {
    style.remove()
    document.body.classList.remove(BODY_CLASS)
  }
}

export function FoldStepsPill() {
  const [on, setOn] = useState(() => document.body.classList.contains(BODY_CLASS))
  const toggle = (): void => {
    const next = !on
    document.body.classList.toggle(BODY_CLASS, next)
    localStorage.setItem(STORE_KEY, next ? '1' : '0')
    setOn(next)
  }
  return (
    <button
      type="button"
      onClick={toggle}
      title="隐藏对话流里的 Think 与工具调用行（再点恢复；记 localStorage 全局生效）"
      style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, padding: '2px 6px', opacity: 0.8 }}
    >
      {on ? '展开步骤' : '折叠步骤'}
    </button>
  )
}
