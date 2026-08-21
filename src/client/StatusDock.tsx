/**
 * 霜鳍鲸状态条：渲染在输入区底部 dock（conversation.composer.dock），
 * 显示 kimi 侧的模型 / thinking 档位 / 权限模式 / 上下文占用 / 工作目录。
 * 非 frostfin 驱动的会话返回 null。数据：/plugins/frostfin/status，3 秒轮询。
 */
import { useEffect, useRef, useState } from 'react'

interface KimiStatusPayload {
  driven: boolean
  model?: string
  modelName?: string
  mode?: string
  thinking?: string
  used?: number
  size?: number
  alive?: boolean
  cwd?: string
  /** 远程会话的主机别名（本地会话缺省）。 */
  host?: string
  /** ssh 配置里的登录用户（拼 user@host 用，未配置缺省）。 */
  hostUser?: string
  /** 是否已绑定 kimi 会话（决定未连接时能否自动重连）。 */
  bound?: boolean
  /** Kimi Coding 订阅配额窗口（5h/周/月；没 key 或查询失败缺省）。 */
  balance?: { id: 'fiveHour' | 'week' | 'month'; percent: number; limit?: number; remaining?: number; resetsAt?: string }[]
  branch?: string
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

/** 长模型名压缩：provider/model 形式只保留模型段（如 kimi-coding/k3 → k3）。 */
function shortModel(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash === -1 ? model : model.slice(slash + 1)
}

export function StatusDock({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<KimiStatusPayload | null>(null)
  // 自动重连：只对"当前打开的、已绑定的、未连接"会话触发；30 秒冷却 + 在飞守卫。
  const [auto, setAuto] = useState<'idle' | 'connecting' | 'failed'>('idle')
  const guard = useRef({ at: 0, inFlight: false })

  useEffect(() => {
    let stopped = false
    guard.current = { at: 0, inFlight: false }
    setAuto('idle')
    setStatus(null) // 切会话即清——别在新会话首次轮询返回前显示上一个会话的状态。
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/plugins/frostfin/status?sessionId=${encodeURIComponent(sessionId)}`)
        const data = await res.json() as KimiStatusPayload
        if (stopped) return
        setStatus(data)
        void maybeReconnect(data)
      } catch {
        // 端点暂时不可达（重启中）：保持上一次快照。
      }
    }
    const maybeReconnect = async (s: KimiStatusPayload): Promise<void> => {
      if (!s.driven || s.bound !== true || s.alive !== false) return
      const g = guard.current
      if (g.inFlight || Date.now() - g.at < 30_000) return
      g.inFlight = true
      setAuto('connecting')
      try {
        const res = await fetch('/plugins/frostfin/reconnect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        const data = await res.json() as { ok?: boolean }
        if (!stopped) setAuto(data.ok === true ? 'idle' : 'failed')
      } catch {
        if (!stopped) setAuto('failed')
      } finally {
        g.inFlight = false
        g.at = Date.now() // 冷却从本次尝试结束时起算（慢重连不会压缩重试间隔）。
      }
    }
    void load()
    const timer = setInterval(() => void load(), 3000)
    return () => { stopped = true; clearInterval(timer) }
  }, [sessionId])

  if (status === null || !status.driven) return null

  const parts: string[] = []
  // 裸 id 显示（用户要求：模型 id 原样展示，只压掉 provider 前缀）。
  if (status.model !== undefined) parts.push(shortModel(status.model))
  if (status.thinking !== undefined && status.thinking !== 'off') parts.push(`thinking: ${status.thinking}`)
  if (status.mode !== undefined) parts.push(status.mode)
  if (status.branch !== undefined) parts.push(`⎇ ${status.branch}`)
  if (status.used !== undefined && status.size !== undefined && status.size > 0) {
    parts.push(`context: ${Math.round((status.used / status.size) * 100)}%（${formatTokens(status.used)}/${formatTokens(status.size)}）`)
  }
  if (status.cwd !== undefined) {
    // 远程会话：目录前带 user@host（VS Code Remote 惯例；ssh 配置没写 User 就裸别名）。
    const label = status.hostUser !== undefined ? `${status.hostUser}@${status.host}` : status.host
    parts.push(status.host !== undefined ? `${label}:${status.cwd}` : status.cwd)
  }
  if (status.alive === false) {
    if (auto === 'connecting') parts.push('⟳ 正在重连 kimi…')
    else if (auto === 'failed') parts.push('⚠ kimi 重连失败（30 秒后自动重试）')
    else parts.push('kimi 进程未连接')
  }

  return (
    <div style={{
      fontSize: 11,
      opacity: 0.65,
      padding: '2px 4px',
      display: 'flex',
      gap: 10,
      flexWrap: 'wrap',
      fontFamily: 'inherit',
    }}>
      {parts.map((part, index) => <span key={index}>{part}</span>)}
      {status.balance?.map(window => {
        const label = window.id === 'fiveHour' ? '5h' : window.id === 'week' ? '周' : '月'
        const detail = [
          window.limit !== undefined && window.remaining !== undefined
            ? `已用 ${window.limit - window.remaining}/${window.limit}`
            : '',
          window.resetsAt !== undefined ? `刷新：${window.resetsAt}` : '',
        ].filter(Boolean).join('；')
        const color = window.percent >= 95 ? '#e5534b' : window.percent >= 80 ? '#e8a13c' : undefined
        return (
          <span key={window.id} title={detail || 'Kimi Coding 订阅配额'} style={color === undefined ? {} : { color }}>
            {label}:{window.percent}%
          </span>
        )
      })}
      {status.alive === true && (
        <span title="kimi 进程已连接" style={{ color: '#57ab5a' }}>●</span>
      )}
    </div>
  )
}
