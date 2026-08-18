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

/** 远程行：一台远程主机上的 kimi 会话。 */
interface RemoteSessionItem {
  sessionId: string
  title: string | null
  cwd: string
  updatedAt: string | null
}

/** 远程主机的面板状态：idle 未连接 → connecting → online / error。 */
interface RemoteHostState {
  status: 'idle' | 'connecting' | 'online' | 'error'
  sessions: RemoteSessionItem[]
  error?: string
  /** 远程 home（新建会话的默认工作区）。 */
  homeDir?: string
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
  switcher: { display: 'flex', border: '1px solid rgba(128,128,128,0.35)', borderRadius: 8, overflow: 'hidden' } as const,
  switcherBtn: { cursor: 'pointer', padding: '4px 14px', border: 'none', background: 'transparent', color: 'inherit', fontSize: 13 } as const,
  switcherActive: { background: 'rgba(128,128,128,0.25)', fontWeight: 600 } as const,
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
  const [view, setView] = useState<'local' | 'remote'>('local')
  const [entries, setEntries] = useState<KimiSessionEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // 远程大区：ssh 配置里的主机清单与各主机的连接状态。
  const [remoteHosts, setRemoteHosts] = useState<{ alias: string }[]>([])
  const [remoteState, setRemoteState] = useState<Record<string, RemoteHostState>>({})

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
    const loadHosts = async (): Promise<void> => {
      try {
        const res = await fetch('/plugins/frostfin/remote-hosts')
        const data = await res.json() as { hosts: { alias: string }[] }
        if (!stopped) setRemoteHosts(data.hosts)
      } catch {
        // 主机清单加载失败静默（远程大区只是没有内容）。
      }
    }
    const loadLocalVersion = async (): Promise<void> => {
      try {
        const res = await fetch('/plugins/frostfin/kimi-version')
        const data = await res.json() as { current?: string; latest?: string }
        if (!stopped) setVersions(prev => ({ ...prev, local: data }))
      } catch {
        // 版本探针失败静默。
      }
    }
    void load()
    void loadHosts()
    void loadLocalVersion()
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

  /** 连接/刷新一台远程主机：懒连接列出它的 kimi 会话。 */
  const connectRemote = async (alias: string): Promise<void> => {
    setRemoteState(prev => ({ ...prev, [alias]: { status: 'connecting', sessions: prev[alias]?.sessions ?? [] } }))
    try {
      const res = await fetch(`/plugins/frostfin/remote-sessions?host=${encodeURIComponent(alias)}`)
      const data = await res.json() as { sessions: RemoteSessionItem[]; error?: string; homeDir?: string }
      setRemoteState(prev => ({
        ...prev,
        [alias]: data.error !== undefined
          ? { status: 'error', sessions: [], error: data.error }
          : { status: 'online', sessions: data.sessions, ...data.homeDir === undefined ? {} : { homeDir: data.homeDir } },
      }))
      if (data.error === undefined) {
        // 上线后顺带拉一次版本（更新按钮旁的 当前→最新 显示）。
        void fetch(`/plugins/frostfin/kimi-version?host=${encodeURIComponent(alias)}`)
          .then(async (r) => {
            const v = await r.json() as { current?: string; latest?: string }
            setVersions(prev => ({ ...prev, [alias]: v }))
          })
          .catch(() => {})
      }
    } catch (err: unknown) {
      setRemoteState(prev => ({ ...prev, [alias]: { status: 'error', sessions: [], error: String(err) } }))
    }
  }

  /** 接入一台远程主机上的 kimi 会话。 */
  const openRemote = async (alias: string, kimiSessionId: string): Promise<void> => {
    setBusy(`${alias}/${kimiSessionId}`)
    try {
      const res = await fetch('/plugins/frostfin/open-remote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: alias, kimiSessionId }),
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

  /** 在一台远程主机上新建 kimi 会话（工作区可改，默认远程 home）。 */
  const [newCwd, setNewCwd] = useState<Record<string, string>>({})
  const createRemote = async (alias: string): Promise<void> => {
    setBusy(`new-${alias}`)
    try {
      const res = await fetch('/plugins/frostfin/new-remote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: alias, cwd: newCwd[alias] ?? '' }),
      })
      const data = await res.json() as OpenResult & { cwd?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      onOpen(data.sessionId)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  /** 更新 kimi Code（本地：alias 省略；远程：更新对应主机）。结果显示在行内备注。 */
  const [updateNote, setUpdateNote] = useState<Record<string, string>>({})
  /** kimi 版本信息（key 'local' 或主机别名）。 */
  const [versions, setVersions] = useState<Record<string, { current?: string; latest?: string }>>({})
  const updateKimi = async (alias?: string): Promise<void> => {
    const key = alias ?? 'local'
    setBusy(`update-${key}`)
    setUpdateNote(prev => ({ ...prev, [key]: '更新中…（下载安装可能需要一两分钟）' }))
    try {
      const res = await fetch('/plugins/frostfin/update-kimi', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(alias === undefined ? {} : { host: alias }),
      })
      const data = await res.json() as { ok: boolean; output: string; version?: string; error?: string }
      const note = !res.ok
        ? (data.error ?? data.output ?? `HTTP ${res.status}`)
        : data.version !== undefined ? `已是最新/已更新到 ${data.version}` : data.output.slice(0, 120)
      setUpdateNote(prev => ({ ...prev, [key]: note }))
      // 更新后刷新版本显示
      const ver = await fetch(`/plugins/frostfin/kimi-version${alias === undefined ? '' : `?host=${encodeURIComponent(alias)}`}`)
      const vdata = await ver.json() as { current?: string; latest?: string }
      setVersions(prev => ({ ...prev, [key]: vdata }))
    } catch (err: unknown) {
      setUpdateNote(prev => ({ ...prev, [key]: String(err) }))
    } finally {
      setBusy(null)
    }
  }

  /** 版本文本：落后时显示 当前 → 最新。 */
  const versionText = (key: string): string | null => {
    const v = versions[key]
    if (v?.current === undefined) return null
    if (v.latest !== undefined && v.latest !== '' && v.latest !== v.current) return `${v.current} → ${v.latest}`
    return v.current
  }

  return (
    <div style={styles.wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <img src="/plugins/frostfin/logo.png" alt="月芒霜鳍鲸" width={40} height={40} style={{ borderRadius: 10 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>月芒霜鳍鲸</h3>
          <div style={styles.meta}>{view === 'local' ? '本机 Kimi Code 会话，一键接入' : '远程服务器上的 Kimi Code 会话（ssh+tmux，断线不死）'}</div>
        </div>
        {view === 'local' && (
          <>
            {versionText('local') !== null && (
              <span style={{ ...styles.meta, alignSelf: 'center', color: versionText('local')?.includes('→') ? '#e8a13c' : undefined }}>
                {versionText('local')}
              </span>
            )}
            <button
              style={{ ...styles.button, opacity: busy === null ? 1 : 0.6 }}
              disabled={busy !== null}
              onClick={() => void updateKimi()}
            >
              {busy === 'update-local' ? '更新中…' : '更新 kimi'}
            </button>
          </>
        )}
        <div style={styles.switcher}>
          <button
            style={{ ...styles.switcherBtn, ...(view === 'local' ? styles.switcherActive : {}) }}
            onClick={() => setView('local')}
          >本地</button>
          <button
            style={{ ...styles.switcherBtn, ...(view === 'remote' ? styles.switcherActive : {}) }}
            onClick={() => setView('remote')}
          >远程</button>
        </div>
      </div>
      {error !== null && <div style={styles.error}>{error}</div>}
      {view === 'local' && updateNote.local !== undefined && (
        <div style={styles.meta}>{updateNote.local}</div>
      )}

      {view === 'local' && (
        <>
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
        </>
      )}

      {view === 'remote' && remoteHosts.length === 0 && (
        <div style={styles.meta}>~/.ssh/config 里没有可连的主机。</div>
      )}
      {view === 'remote' && remoteHosts.map(({ alias }) => {
        const state = remoteState[alias] ?? { status: 'idle' as const, sessions: [] }
        return (
          <div key={alias} style={{ marginBottom: 12 }}>
            <div style={{ ...styles.row, borderStyle: 'dashed' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.title}>{alias}</div>
                <div style={styles.meta}>
                  {state.status === 'idle' && '未连接'}
                  {state.status === 'connecting' && '连接中…（体检 + 拉起通道）'}
                  {state.status === 'online' && `● 在线（${state.sessions.length} 个会话）`}
                  {state.status === 'error' && (state.error ?? '连接失败')}
                  {updateNote[alias] !== undefined && ` ｜ ${updateNote[alias]}`}
                </div>
              </div>
              {state.status === 'online' && versionText(alias) !== null && (
                <span style={{ ...styles.meta, alignSelf: 'center', color: versionText(alias)?.includes('→') ? '#e8a13c' : undefined }}>
                  {versionText(alias)}
                </span>
              )}
              {state.status === 'online' && (
                <button
                  style={{ ...styles.button, opacity: busy === null ? 1 : 0.6 }}
                  disabled={busy !== null}
                  onClick={() => void updateKimi(alias)}
                >
                  {busy === `update-${alias}` ? '更新中…' : '更新 kimi'}
                </button>
              )}
              <button
                style={styles.button}
                disabled={state.status === 'connecting'}
                onClick={() => void connectRemote(alias)}
              >
                {state.status === 'online' ? '刷新' : state.status === 'connecting' ? '连接中…' : '连接'}
              </button>
            </div>
            {state.status === 'online' && groupByCwd(state.sessions.map(item => ({ ...item, archived: false, bound: false }))).map(([cwd, items]) => (
              <div key={cwd} style={{ marginLeft: 14, marginTop: 6 }}>
                <div style={{ ...styles.meta, fontWeight: 600, marginBottom: 4 }}>{cwd}（{items.length}）</div>
                {items.map(entry => (
                  <div key={entry.sessionId} style={styles.row}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={styles.title}>{entry.title ?? '(无标题)'}</div>
                      <div style={styles.meta}>{formatTime(entry.updatedAt)}</div>
                    </div>
                    <button
                      style={{ ...styles.button, opacity: busy === null ? 1 : 0.6 }}
                      disabled={busy !== null}
                      onClick={() => void openRemote(alias, entry.sessionId)}
                    >
                      {busy === `${alias}/${entry.sessionId}` ? '接入中…' : '接入'}
                    </button>
                  </div>
                ))}
              </div>
            ))}
            {state.status === 'online' && (
              <div style={{ ...styles.row, marginLeft: 14 }}>
                <input
                  style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', color: 'inherit', outline: 'none', fontSize: 13 }}
                  placeholder={state.homeDir ?? '远程工作区路径'}
                  value={newCwd[alias] ?? ''}
                  onChange={event => setNewCwd(prev => ({ ...prev, [alias]: event.target.value }))}
                />
                <button
                  style={{ ...styles.button, opacity: busy === null ? 1 : 0.6 }}
                  disabled={busy !== null}
                  onClick={() => void createRemote(alias)}
                >
                  {busy === `new-${alias}` ? '创建中…' : '新建会话'}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
