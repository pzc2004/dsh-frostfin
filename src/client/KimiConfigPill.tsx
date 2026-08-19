/**
 * 输入区工具行的 kimi 配置按钮：thinking 档位（右侧，模型选择旁）与权限模式
 * （左侧，DSH 访问控制旁）。数据源 /plugins/frostfin/status（3 秒轮询，与状态条
 * 同节奏）；点选走 /plugins/frostfin/set-config。档位行是 kimi 当前模型上报的
 * 真实集合（有几个列几个）。非 frostfin 驱动会话返回 null。
 */
import { useEffect, useRef, useState } from 'react'

interface PillStatus {
  driven: boolean
  thinking?: string
  thinkingOptions?: string[]
  mode?: string
  modeOptions?: string[]
}

export function KimiConfigPill({ sessionId, configId, label }: {
  sessionId: string
  configId: 'thinking' | 'mode'
  label: string
}) {
  const [status, setStatus] = useState<PillStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let stopped = false
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/plugins/frostfin/status?sessionId=${encodeURIComponent(sessionId)}`)
        if (!stopped) setStatus(await res.json() as PillStatus)
      } catch {
        // 端点暂时不可达：保持上一次快照。
      }
    }
    void load()
    const timer = setInterval(() => void load(), 3000)
    return () => { stopped = true; clearInterval(timer) }
  }, [sessionId])

  // 外部点击关下拉。
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  if (status === null || !status.driven) return null
  const current = configId === 'thinking' ? status.thinking : status.mode
  const rows = configId === 'thinking' ? status.thinkingOptions : status.modeOptions
  if (current === undefined || rows === undefined || rows.length === 0) return null

  const pick = async (value: string): Promise<void> => {
    setOpen(false)
    if (value === current || busy) return
    // 乐观更新，失败回滚（3 秒轮询最终也会纠偏）。
    const previous = status
    setBusy(true)
    setStatus({ ...status, [configId]: value })
    try {
      const res = await fetch('/plugins/frostfin/set-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, configId, value }),
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${res.status}`)
    } catch {
      setStatus(previous)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        title={configId === 'thinking' ? 'kimi 思考强度' : 'kimi 权限模式'}
        style={{
          border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
          fontSize: 12, padding: '2px 6px', opacity: busy ? 0.5 : 0.8,
        }}
      >
        {label}: {current} ▾
      </button>
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', marginBottom: 4, zIndex: 50, minWidth: 110,
          ...(configId === 'thinking' ? { right: 0 } : { left: 0 }),
          background: '#1e1f24', color: '#e6e6e9',
          border: '1px solid rgba(128,128,128,0.4)', borderRadius: 8, padding: 4,
        }}>
          {rows.map(row => (
            <div
              key={row}
              onClick={() => void pick(row)}
              style={{
                padding: '4px 10px', cursor: 'pointer', borderRadius: 6, fontSize: 12,
                fontWeight: row === current ? 600 : 400, opacity: row === current ? 1 : 0.75,
                whiteSpace: 'nowrap',
              }}
            >
              {row}{row === current ? ' ✓' : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
