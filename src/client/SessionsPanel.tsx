/**
 * 霜鳍鲸会话面板：列出本机磁盘上的 kimi 会话，一键接入 DSH。
 * 数据来自插件的宿主端点（/plugins/frostfin/*），5 秒轮询。
 */
import { useEffect, useState } from 'react'

interface KimiSessionEntry {
  sessionId: string
  title: string | null
  cwd: string
  updatedAt: string | null
  archived: boolean
  bound: boolean
}

interface OpenResult {
  sessionId: string
  reused: boolean
  replayTurns?: number
  error?: string
}

export interface SessionsPanelProps {
  /** 打开成功后的跳转（由注册处注入，接 DSH 的 sessions.open）。 */
  onOpen: (sessionId: string) => void
}

const styles = {
  wrap: { padding: 16, fontFamily: 'inherit', overflow: 'auto', height: '100%' } as const,
  row: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
    borderRadius: 8, marginBottom: 6, border: '1px solid rgba(128,128,128,0.25)',
  } as const,
  title: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const,
  meta: { opacity: 0.6, fontSize: 12 } as const,
  badge: { fontSize: 11, opacity: 0.7, border: '1px solid rgba(128,128,128,0.4)', borderRadius: 4, padding: '0 4px' } as const,
  button: { cursor: 'pointer', borderRadius: 6, padding: '4px 10px', border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit' } as const,
  error: { color: '#e85454', fontSize: 12, marginBottom: 8 } as const,
}

function formatTime(updatedAt: string | null): string {
  if (updatedAt === null) return '时间未知'
  const time = new Date(updatedAt)
  return Number.isNaN(time.getTime()) ? '时间未知' : time.toLocaleString('zh-CN', { hour12: false })
}

/** 把 home 前缀压缩成 ~，让路径短一点。 */
function shortCwd(cwd: string): string {
  return cwd.replace(/^\/Users\/[^/]+/, '~')
}

/** 按工作区分组：组内保持时间倒序，组按最新活动排序。 */
function groupByCwd(entries: readonly KimiSessionEntry[]): [string, KimiSessionEntry[]][] {
  const groups = new Map<string, KimiSessionEntry[]>()
  for (const entry of entries) {
    const key = entry.cwd === '' ? '（未知目录）' : entry.cwd
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [entry])
    else list.push(entry)
  }
  return [...groups.entries()].sort((a, b) =>
    (b[1][0]?.updatedAt ?? '').localeCompare(a[1][0]?.updatedAt ?? ''))
}

export function SessionsPanel({ onOpen }: SessionsPanelProps) {
  const [entries, setEntries] = useState<KimiSessionEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('/plugins/frostfin/kimi-sessions')
        const data = await res.json() as { sessions: KimiSessionEntry[] }
        if (!stopped) {
          setEntries(data.sessions)
          setError(null)
        }
      } catch (err: unknown) {
        if (!stopped) setError(String(err))
      }
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => { stopped = true; clearInterval(timer) }
  }, [])

  const open = async (kimiSessionId: string): Promise<void> => {
    setBusy(kimiSessionId)
    try {
      const res = await fetch('/plugins/frostfin/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kimiSessionId }),
      })
      const data = await res.json() as OpenResult
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      onOpen(data.sessionId)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={styles.wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <img src="/plugins/frostfin/logo.png" alt="月芒霜鳍鲸" width={40} height={40} style={{ borderRadius: 10 }} />
        <div>
          <h3 style={{ margin: 0 }}>月芒霜鳍鲸</h3>
          <div style={styles.meta}>本机 Kimi Code 会话，一键接入</div>
        </div>
      </div>
      {error !== null && <div style={styles.error}>{error}</div>}
      {entries.length === 0 && <div style={styles.meta}>本机磁盘上没有 kimi 会话。</div>}
      {groupByCwd(entries).map(([cwd, items]) => (
        <div key={cwd} style={{ marginBottom: 14 }}>
          <div style={{ ...styles.meta, fontWeight: 600, marginBottom: 6 }}>{shortCwd(cwd)}（{items.length}）</div>
          {items.map(entry => (
            <div key={entry.sessionId} style={styles.row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.title}>{entry.title ?? '(无标题)'}</div>
                <div style={styles.meta}>{formatTime(entry.updatedAt)}</div>
              </div>
              {entry.bound && <span style={styles.badge}>已接入</span>}
              {entry.archived && <span style={styles.badge}>已归档</span>}
              <button
                style={{ ...styles.button, opacity: busy === null ? 1 : 0.6 }}
                disabled={busy !== null}
                onClick={() => void open(entry.sessionId)}
              >
                {busy === entry.sessionId ? '接入中…' : entry.bound ? '打开' : '接入'}
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
