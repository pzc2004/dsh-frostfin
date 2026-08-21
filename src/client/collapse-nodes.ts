/**
 * 单条消息折叠：长输入/长输出都能手动折成一小段，「展开」键还原。
 *
 * 挂点：ChatNodeSeat 给每个聊天节点一个稳定壳 div[data-chat-flow-kind]
 * （user/steering/assistant-step 等）。折叠形态 = 整个壳限高 10em（约六七行，
 * 够认出原对话）+ 底部渐变遮罩；按钮折叠时绝对定位进壳内（与消息同侧：
 * user/steering 靠右）。全部只是壳的 classList 增量，不碰 React 的内容节点
 * （slot 包装是 display:contents，纯 CSS 压不到孩子——壳自身才是可压的盒）。
 *
 * 滚动行为（实测出来的，勿想当然）：
 * - DSH 的底部吸附逻辑会按收缩量回拨 scrollTop——"折叠后乱飘"的来源。
 *   我们反向抵消它的回拨（scrollHeight delta 取反），视口不被拽走；
 * - 折叠后额外把被折的消息定位到屏幕中间（用户点名的交互）；
 * - 展开只抵消不回中（长文展开回中会把视图拽飞）。
 * 抵消与回中都在同一帧内先于 DSH 的反应落地，实测净滚动为零。
 *
 * MutationObserver 监听对话流，内容变高（流式输出越过阈值）自动出现「折叠」；
 * React 重渲染清掉按钮/类时按保存的状态自愈重放。折叠状态只存内存
 * （WeakMap 按壳元素），刷新/切会话不保留：它是阅读辅助，不是内容状态。
 * 已知软肋：DSH 改 data-chat-flow-kind 钩子名或其吸附逻辑，本功能退化
 * （按钮消失或回中偏一个收缩量），不破坏页面。
 */

const KINDS = 'user, steering, assistant-step'
/** 出现折叠按钮的壳高阈值（折叠能省出空间才出现——约 10 行）。 */
const THRESHOLD_PX = 200

const STYLE = `
[data-frostfin-msgfold].frostfin-msgfold-collapsed {
  max-height: 10em;
  overflow: hidden;
  position: relative;
}
[data-frostfin-msgfold].frostfin-msgfold-collapsed::after {
  content: '';
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  height: 2.5em;
  background: linear-gradient(transparent, var(--dsw-alias-bg-base, #141517));
  pointer-events: none;
}
[data-frostfin-msgfold].frostfin-msgfold-collapsed > .frostfin-msgfold-btn {
  position: absolute;
  bottom: 2px;
  z-index: 1;
  background: var(--dsw-alias-bg-base, #141517);
  border-radius: 4px;
}
[data-frostfin-msgfold].frostfin-msgfold-collapsed > .frostfin-msgfold-btn:not(.frostfin-msgfold-btn-right) { left: 4px; }
[data-frostfin-msgfold].frostfin-msgfold-collapsed > .frostfin-msgfold-btn-right { right: 4px; }
.frostfin-msgfold-btn {
  display: block;
  width: fit-content;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.55;
  font-size: 11px;
  padding: 2px 4px;
  cursor: pointer;
}
/* 用户消息气泡靠右，按钮跟着靠右（kind=user/steering 时 JS 挂上）。 */
.frostfin-msgfold-btn-right { margin-left: auto; }
.frostfin-msgfold-btn:hover { opacity: 0.9; }
`

/** apply 时安装：注入样式 + 起观察者；返回 ctx.effect 的清理函数。 */
export function installCollapsibleMessages(): () => void {
  const style = document.createElement('style')
  style.id = 'frostfin-msgfold-style'
  style.textContent = STYLE
  document.head.appendChild(style)

  /** 壳元素 → 折叠状态（按钮引用与 collapsed 用于自愈重放）。 */
  const seen = new WeakMap<HTMLElement, { button: HTMLButtonElement; collapsed: boolean }>()

  const enhance = (seat: HTMLElement): void => {
    const existing = seen.get(seat)
    if (existing !== undefined) {
      // React 重渲染可能清掉我们追加的按钮/类——按保存的状态自愈重放。
      if (!existing.button.isConnected) seat.appendChild(existing.button)
      seat.classList.toggle('frostfin-msgfold-collapsed', existing.collapsed)
      return
    }
    if (seat.scrollHeight <= THRESHOLD_PX) return // 不够长不打扰；变长后观察者会再来
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'frostfin-msgfold-btn'
    // 按钮与消息同侧：user/steering 的气泡在右，按钮靠右（assist 系默认靠左）。
    const kind = seat.getAttribute('data-chat-flow-kind')
    if (kind === 'user' || kind === 'steering') button.classList.add('frostfin-msgfold-btn-right')
    button.textContent = '折叠'
    const state = { button, collapsed: false }
    button.addEventListener('click', () => {
      const scrollPort = seat.closest('[data-conversation-scroll]')
      const beforeTop = seat.getBoundingClientRect().top
      const beforeHeight = scrollPort instanceof HTMLElement ? scrollPort.scrollHeight : 0
      state.collapsed = !state.collapsed
      seat.classList.toggle('frostfin-msgfold-collapsed', state.collapsed)
      button.textContent = state.collapsed ? '展开' : '折叠'
      if (!(scrollPort instanceof HTMLElement)) return
      const delta = scrollPort.scrollHeight - beforeHeight
      if (state.collapsed) {
        /** 把被折的消息定位到屏幕中间（相对当前滚动位置的偏移量）。 */
        const center = (): void => {
          const seatRect = seat.getBoundingClientRect()
          const portRect = scrollPort.getBoundingClientRect()
          const offset = (seatRect.top + seatRect.height / 2) - (portRect.top + portRect.height / 2)
          if (Math.abs(offset) > 1) scrollPort.scrollTop += offset
        }
        scrollPort.scrollTop += -delta // 先抵消 DSH 底部吸附的回拨
        center()
        // DSH 的吸附反应（可能与吸附动画不同步、不成比例）落地后再咬一次中——实测残余 ~61px。
        setTimeout(center, 200)
      } else if (beforeTop < scrollPort.getBoundingClientRect().top) {
        scrollPort.scrollTop -= delta // 展开只抵消不回中
      }
    })
    seat.setAttribute('data-frostfin-msgfold', '')
    seat.appendChild(button)
    seen.set(seat, state)
  }

  const scan = (): void => {
    for (const seat of document.querySelectorAll<HTMLElement>(
      KINDS.split(',').map(kind => `[data-chat-flow-kind="${kind.trim()}"]`).join(', '),
    )) enhance(seat)
  }

  const observer = new MutationObserver(() => scan())
  observer.observe(document.body, { childList: true, subtree: true })
  scan()

  return () => {
    observer.disconnect()
    style.remove()
    for (const seat of document.querySelectorAll<HTMLElement>('[data-frostfin-msgfold]')) {
      seat.classList.remove('frostfin-msgfold-collapsed')
      seat.removeAttribute('data-frostfin-msgfold')
      seat.querySelector(':scope > .frostfin-msgfold-btn')?.remove()
    }
  }
}
