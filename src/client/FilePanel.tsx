/**
 * 「文件」tab：会话工作区的文件树（VS Code 资源管理器式懒加载）。
 * 数据源 GET /plugins/frostfin/files（锁在会话 cwd 子树；本地 sh、远程 ssh
 * 经 driver.execProbe 跑同一段脚本，一视同仁）。点目录展开/收起，点文件
 * 复制相对路径——DSH 没有编辑器也没有输入框写入 API，引用文件走输入框的
 * @ 补全（同一份 complete 数据面），树负责"看得见、逛得动"。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

interface DirView {
  dirs: string[]
  files: { name: string; size: number }[]
}
type DirState = DirView | 'loading' | { error: string }

interface StatusView {
  driven: boolean
  cwd?: string
  host?: string
  hostUser?: string
}

function formatSize(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function FilePanel({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<StatusView | null>(null)
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadDir = useCallback(async (rel: string): Promise<void> => {
    setDirs(prev => ({ ...prev, [rel]: 'loading' }))
    try {
      const res = await fetch(`/plugins/frostfin/files?sessionId=${encodeURIComponent(sessionId)}&dir=${encodeURIComponent(rel)}`)
      const data = await res.json() as { ok?: boolean; dirs?: string[]; files?: { name: string; size: number }[]; error?: string }
      if (!res.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${res.status}`)
      setDirs(prev => ({ ...prev, [rel]: { dirs: data.dirs ?? [], files: data.files ?? [] } }))
    } catch (error: unknown) {
      setDirs(prev => ({ ...prev, [rel]: { error: error instanceof Error ? error.message : String(error) } }))
    }
  }, [sessionId])

  // 先探驱动身份：非 frostfin 会话显示提示，不白打 files 的 404。
  useEffect(() => {
    setStatus(null)
    setDirs({})
    setOpen({})
    void (async () => {
      try {
        const res = await fetch(`/plugins/frostfin/status?sessionId=${encodeURIComponent(sessionId)}`)
        setStatus(await res.json() as StatusView)
      } catch { setStatus({ driven: false }) }
    })()
  }, [sessionId])

  useEffect(() => {
    if (status?.driven === true) void loadDir('.')
  }, [status, loadDir])

  const toggle = (rel: string): void => {
    const next = !(open[rel] === true)
    setOpen(prev => ({ ...prev, [rel]: next }))
    if (next && dirs[rel] === undefined) void loadDir(rel)
  }

  /** 已加载的目录全部重拉（打开的折叠状态保留）。 */
  const refresh = (): void => {
    const loaded = Object.keys(dirs)
    setDirs({})
    for (const rel of loaded.length === 0 ? ['.'] : loaded) void loadDir(rel)
  }

  const copyPath = (path: string): void => {
    void navigator.clipboard.writeText(path).then(() => {
      setCopied(path)
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(null), 1200)
    }).catch(() => { /* 剪贴板不可用时静默 */ })
  }

  if (status === null) return <div style={{ padding: 12, fontSize: 12, opacity: 0.6 }}>加载中…</div>
  if (!status.driven) return <div style={{ padding: 12, fontSize: 12, opacity: 0.6 }}>仅月芒霜鳍鲸会话支持工作区文件树。</div>

  const rowStyle = (depth: number): CSSProperties => ({
    padding: '2px 8px', paddingLeft: 8 + depth * 14, fontSize: 12,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  })

  const rows: ReactNode[] = []
  const walk = (rel: string, depth: number): void => {
    const state = dirs[rel]
    if (state === undefined || state === 'loading') {
      rows.push(<div key={`${rel}:loading`} style={{ ...rowStyle(depth), opacity: 0.5 }}>加载中…</div>)
      return
    }
    if ('error' in state) {
      rows.push(<div key={`${rel}:error`} style={{ ...rowStyle(depth), color: '#e5534b' }}>失败：{state.error}</div>)
      return
    }
    for (const name of state.dirs) {
      const childRel = rel === '.' ? name : `${rel}/${name}`
      const isOpen = open[childRel] === true
      rows.push(
        <div key={`d:${childRel}`} onClick={() => toggle(childRel)} style={{ ...rowStyle(depth), cursor: 'pointer' }} title={childRel}>
          <span style={{ opacity: 0.5, display: 'inline-block', width: 14 }}>{isOpen ? '▾' : '▸'}</span>
          {name}/
        </div>,
      )
      if (isOpen) walk(childRel, depth + 1)
    }
    for (const file of state.files) {
      const fileRel = rel === '.' ? file.name : `${rel}/${file.name}`
      rows.push(
        <div
          key={`f:${fileRel}`}
          onClick={() => copyPath(fileRel)}
          style={{ ...rowStyle(depth), cursor: 'pointer', display: 'flex', gap: 8, opacity: copied === fileRel ? 0.5 : 1 }}
          title={`${fileRel}（点击复制相对路径）`}
        >
          <span style={{ display: 'inline-block', width: 14 }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
          <span style={{ opacity: 0.45, flexShrink: 0 }}>{copied === fileRel ? '已复制 ✓' : formatSize(file.size)}</span>
        </div>,
      )
    }
    if (state.dirs.length === 0 && state.files.length === 0) {
      rows.push(<div key={`${rel}:empty`} style={{ ...rowStyle(depth), opacity: 0.5 }}>（空目录）</div>)
    }
  }
  walk('.', 0)

  const cwdLabel = status.cwd === undefined ? '工作区'
    : `${status.hostUser !== undefined ? `${status.hostUser}@` : ''}${status.host !== undefined ? `${status.host}:` : ''}${status.cwd}`

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px 6px', borderBottom: '1px solid rgba(128,128,128,0.2)' }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.6, fontSize: 12 }} title={cwdLabel}>
          {cwdLabel}
        </span>
        <button
          type="button"
          onClick={refresh}
          style={{ border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit', borderRadius: 6, padding: '1px 8px', fontSize: 12, cursor: 'pointer' }}
        >
          刷新
        </button>
      </div>
      <div style={{ paddingTop: 4, overflowX: 'hidden' }}>{rows}</div>
    </div>
  )
}
