/**
 * 霜鳍鲸状态条：渲染在输入区底部 dock（conversation.composer.dock），
 * 显示 kimi 侧的模型 / thinking 档位 / 权限模式 / 上下文占用 / 工作目录。
 * 非 frostfin 驱动的会话返回 null。数据：/plugins/frostfin/status，3 秒轮询。
 */
import { useEffect, useState } from 'react'

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

  useEffect(() => {
    let stopped = false
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/plugins/frostfin/status?sessionId=${encodeURIComponent(sessionId)}`)
        if (!stopped) setStatus(await res.json() as KimiStatusPayload)
      } catch {
        // 端点暂时不可达（重启中）：保持上一次快照。
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
    // 远程会话：目录前带主机名（VS Code 的 SSH: host 惯例）。
    parts.push(status.host !== undefined ? `${status.host}:${status.cwd}` : status.cwd)
  }
  if (status.alive === false) parts.push('kimi 进程未连接')

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
    </div>
  )
}
