/**
 * 输入区工具行的「传文件」按钮：把本机文件 scp 到远程会话的服务器。
 * 只在远程会话出现（status.host 在场）。文件两种进法：手输路径（每行一个），
 * 或点「浏览本机文件」开内置选择器（后端 ls 端点列主目录，点目录进入、
 * 点文件加入清单）；大文件走本机直 scp 不经浏览器内存。
 * 目标目录默认 /tmp/frostfin-uploads。上传是异步任务：POST 拿 jobId 后
 * 每秒轮询 upload-progress 画进度条（后端 stat 远端临时文件的字节数折算，
 * 比 scp 的 TTY 进度条还准）。
 */
import { useEffect, useRef, useState } from 'react'

interface UploadStatus {
  driven: boolean
  host?: string
}

/** 任务快照（对齐面板 upload-progress 端点的返回）。 */
interface JobView {
  id: string
  state: 'running' | 'done' | 'error'
  bytesDone: number
  bytesTotal: number
  fileIndex: number
  fileCount: number
  currentFile?: string
  files?: string[]
  error?: string
}

/** ls 端点的返回（文件选择器用）。 */
interface LsView {
  dir: string
  parent: string | null
  dirs: string[]
  files: { name: string; size: number }[]
  truncated: boolean
}

function formatMB(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1)
}

function formatSize(bytes: number): string {
  return bytes >= 1_048_576 ? `${formatMB(bytes)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function UploadPill({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<UploadStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [paths, setPaths] = useState('')
  const [dest, setDest] = useState('/tmp/frostfin-uploads')
  const [job, setJob] = useState<JobView | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [picker, setPicker] = useState<LsView | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let stopped = false
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/plugins/frostfin/status?sessionId=${encodeURIComponent(sessionId)}`)
        if (!stopped) setStatus(await res.json() as UploadStatus)
      } catch { /* 保旧快照 */ }
    }
    void load()
    const timer = setInterval(() => void load(), 3000)
    return () => { stopped = true; clearInterval(timer) }
  }, [sessionId])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // 任务轮询：running 期间每秒取一次进度；终态（done/error）停表。
  // 关掉下拉也不停——任务在服务端跑，重开下拉进度还在。
  const jobId = job?.id
  const jobState = job?.state
  useEffect(() => {
    if (jobId === undefined || jobState !== 'running') return
    let stopped = false
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`/plugins/frostfin/upload-progress?jobId=${encodeURIComponent(jobId)}`)
          const data = await res.json() as { ok?: boolean } & Omit<JobView, 'id'>
          if (stopped || data.ok !== true) return
          setJob({
            id: jobId,
            state: data.state,
            bytesDone: data.bytesDone,
            bytesTotal: data.bytesTotal,
            fileIndex: data.fileIndex,
            fileCount: data.fileCount,
            ...data.currentFile === undefined ? {} : { currentFile: data.currentFile },
            ...data.files === undefined ? {} : { files: data.files },
            ...data.error === undefined ? {} : { error: data.error },
          })
          if (data.state === 'done') setPaths('')
        } catch { /* 保旧快照 */ }
      })()
    }, 1000)
    return () => { stopped = true; clearInterval(timer) }
  }, [jobId, jobState])

  if (status === null || !status.driven || status.host === undefined) return null

  const running = job?.state === 'running'
  const pathList = paths.split('\n').map(s => s.trim()).filter(s => s !== '')

  const loadDir = async (dir?: string): Promise<void> => {
    try {
      const res = await fetch(`/plugins/frostfin/ls${dir === undefined ? '' : `?dir=${encodeURIComponent(dir)}`}`)
      const data = await res.json() as { ok?: boolean; error?: string } & Partial<LsView>
      if (!res.ok || data.ok !== true || typeof data.dir !== 'string') throw new Error(data.error ?? `HTTP ${res.status}`)
      setPicker({
        dir: data.dir,
        parent: data.parent ?? null,
        dirs: data.dirs ?? [],
        files: data.files ?? [],
        truncated: data.truncated ?? false,
      })
      setPickerError(null)
    } catch (error: unknown) {
      setPickerError(error instanceof Error ? error.message : String(error))
    }
  }

  const togglePicker = (): void => {
    const next = !pickerOpen
    setPickerOpen(next)
    if (next && picker === null) void loadDir()
  }

  /** 点文件行：把完整路径加进清单（去重；规范化掉首尾空白行）。 */
  const addPath = (full: string): void => {
    setPaths(pathList.includes(full) ? paths : [...pathList, full].join('\n'))
  }

  /** 传完一键复制全部远端路径（每行一个）——粘贴进输入框补半句指令即可发问（等价 kimi TUI 的 @）。 */
  const copyPaths = async (): Promise<void> => {
    const list = job?.files ?? []
    if (list.length === 0) return
    try {
      await navigator.clipboard.writeText(list.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* 剪贴板不可用时静默，用户还可手选路径 */ }
  }

  const submit = async (): Promise<void> => {
    if (pathList.length === 0 || running) return
    setSubmitError(null)
    try {
      const res = await fetch('/plugins/frostfin/upload-remote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, paths: pathList, dest }),
      })
      const data = await res.json() as { ok?: boolean; jobId?: string; error?: string }
      if (!res.ok || data.ok !== true || typeof data.jobId !== 'string') throw new Error(data.error ?? `HTTP ${res.status}`)
      setJob({ id: data.jobId, state: 'running', bytesDone: 0, bytesTotal: 0, fileIndex: 0, fileCount: pathList.length })
    } catch (error: unknown) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    }
  }

  const percent = job === null ? 0
    : job.bytesTotal > 0 ? Math.min(100, Math.floor((100 * job.bytesDone) / job.bytesTotal))
    : job.state === 'done' ? 100 : 0

  const chipStyle = {
    border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit',
    borderRadius: 6, padding: '1px 8px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
  } as const

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => { setOpen(v => !v); setSubmitError(null) }}
        title="把本机文件传到远程服务器（scp）"
        style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, padding: '2px 6px', opacity: running ? 0.5 : 0.8 }}
      >
        {running ? `传输中 ${percent}%` : '传文件 ⬆'}
      </button>
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, zIndex: 50, width: 320,
          background: '#1e1f24', color: '#e6e6e9',
          border: '1px solid rgba(128,128,128,0.4)', borderRadius: 8, padding: 10,
        }}>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>本地文件路径（每行一个；大文件走本机直 scp）</div>
          <textarea
            value={paths}
            onChange={event => setPaths(event.target.value)}
            rows={4}
            placeholder={'/Users/你/Downloads/a.pdf\n/Users/你/Downloads/b.zip'}
            style={{
              width: '100%', boxSizing: 'border-box', background: 'transparent', color: 'inherit',
              border: '1px solid rgba(128,128,128,0.35)', borderRadius: 6, padding: 6, fontSize: 12,
              fontFamily: 'inherit', outline: 'none', resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
            <input
              value={dest}
              onChange={event => setDest(event.target.value)}
              style={{
                flex: 1, minWidth: 0, background: 'transparent', color: 'inherit',
                border: '1px solid rgba(128,128,128,0.35)', borderRadius: 6, padding: '4px 6px', fontSize: 12, outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={running || pathList.length === 0}
              style={{ ...chipStyle, padding: '4px 12px' }}
            >
              传
            </button>
          </div>
          <div style={{ marginTop: 6 }}>
            <button type="button" onClick={togglePicker} style={{ ...chipStyle, opacity: 0.85 }}>
              {pickerOpen ? '收起选择器 ▾' : '浏览本机文件…'}
            </button>
          </div>
          {pickerOpen && (
            <div style={{ marginTop: 6, border: '1px solid rgba(128,128,128,0.25)', borderRadius: 6 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 6px', borderBottom: '1px solid rgba(128,128,128,0.2)', fontSize: 12 }}>
                <button
                  type="button"
                  disabled={picker?.parent == null}
                  onClick={() => { if (picker?.parent != null) void loadDir(picker.parent) }}
                  style={{ ...chipStyle, opacity: picker?.parent == null ? 0.35 : 0.85 }}
                >
                  ↑
                </button>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.7 }} title={picker?.dir}>
                  {picker?.dir ?? '…'}
                </span>
                <button type="button" onClick={() => void loadDir('~')} style={{ ...chipStyle, opacity: 0.85 }}>主目录</button>
                <button type="button" onClick={() => void loadDir('~/Downloads')} style={{ ...chipStyle, opacity: 0.85 }}>下载</button>
              </div>
              <div style={{ maxHeight: 180, overflowY: 'auto', fontSize: 12 }}>
                {pickerError !== null && <div style={{ padding: 6, color: '#e5534b' }}>失败：{pickerError}</div>}
                {picker !== null && picker.dirs.map(name => (
                  <div
                    key={`d:${name}`}
                    onClick={() => void loadDir(`${picker.dir}/${name}`)}
                    style={{ padding: '3px 8px', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    <span style={{ opacity: 0.5 }}>▸</span> {name}/
                  </div>
                ))}
                {picker !== null && picker.files.map(file => {
                  const full = `${picker.dir}/${file.name}`
                  const added = pathList.includes(full)
                  return (
                    <div
                      key={`f:${file.name}`}
                      onClick={() => addPath(full)}
                      title={added ? '已在清单里' : full}
                      style={{ padding: '3px 8px', cursor: 'pointer', display: 'flex', gap: 8, opacity: added ? 0.4 : 1 }}
                    >
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
                      <span style={{ opacity: 0.5 }}>{formatSize(file.size)}</span>
                    </div>
                  )
                })}
                {picker !== null && picker.dirs.length === 0 && picker.files.length === 0 && pickerError === null && (
                  <div style={{ padding: 6, opacity: 0.5 }}>（空目录）</div>
                )}
                {picker?.truncated === true && <div style={{ padding: 6, opacity: 0.5 }}>（条目过多，只显示前 500）</div>}
              </div>
            </div>
          )}
          {job?.state === 'running' && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, opacity: 0.85 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {job.fileIndex}/{job.fileCount} {job.currentFile ?? ''}
                </span>
                <span>{percent}%</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'rgba(128,128,128,0.25)', marginTop: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${percent}%`, background: '#4c8dff', transition: 'width 0.5s' }} />
              </div>
              <div style={{ opacity: 0.6, marginTop: 4 }}>{formatMB(job.bytesDone)} / {formatMB(job.bytesTotal)} MB</div>
            </div>
          )}
          {job?.state === 'done' && (
            <div style={{ fontSize: 12, marginTop: 6, opacity: 0.85, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                已传 {job.files?.length ?? job.fileCount} 个 → {dest}（让 kimi 直接读就行）
              </span>
              <button type="button" onClick={() => void copyPaths()} style={{ ...chipStyle, flexShrink: 0 }}>
                {copied ? '已复制 ✓' : '复制路径'}
              </button>
            </div>
          )}
          {job?.state === 'error' && (
            <div style={{ fontSize: 12, marginTop: 6, color: '#e5534b' }}>失败：{job.error}</div>
          )}
          {submitError !== null && (
            <div style={{ fontSize: 12, marginTop: 6, color: '#e5534b' }}>失败：{submitError}</div>
          )}
        </div>
      )}
    </div>
  )
}
