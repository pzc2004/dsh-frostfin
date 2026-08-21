/**
 * 远程线：远程 kimi 传输（ssh + tmux 的 shim 命令构建与健康检查）。
 *
 * 传输模型（spike 定稿，scripts/spike-tmux-acp.mjs）：
 * - 远程 tmux 里养 `kimi acp`（pane 终端属性 `-echo -onlcr icrnl`）——断线不死；
 * - 读出：pipe-pane → fifo → shim stdout（后台 cat 显式收尸，否则它占着管道、
 *   客户端 close 永不触发）；
 * - 写入：shim stdin 按行经 load-buffer + paste 注入（icrnl 把 paste 的 \r 翻回 \n）；
 * - shim 作为单个 argv 元素经 ssh 逐字传递（无 shell 拼接，内容不受引号限制）。
 *
 * 纪律：本模块只处理"怎么连"，不内置任何真实主机信息。
 * 调用方一律经末尾的 `hostDriverFor` 分派点（HostDriver 接口）——本地/远程
 * 一视同仁；POSIX 是当前唯一实现族（posix-local / posix-ssh-tmux），
 * Windows 等非 POSIX 平台将来在此分派。
 *
 * @module dsh-frostfin/remote
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { SshHostEntry } from './ssh-config.js'

/** tmux 会话名白名单化（字母数字 . _ -，其余压成 -，截断 48）。 */
export function sanitizeSessionName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-{2,}/g, '-')
  return cleaned.slice(0, 48)
}

/** shim 的终端属性约定：-echo（防回显）-onlcr（防 \n→\r\n）icrnl（\r→\n，救活 paste）。 */
const PANE_TERMIOS = '-echo -onlcr icrnl'

/**
 * 构建远程 shim（远端登录 shell 执行的负载；作为单个 argv 元素经 ssh 逐字传递，
 * 无本地 shell 拼接，内容不受引号限制）。
 * @param sessionName - tmux 会话名（经 sanitizeSessionName）。
 * @param kimiCmd - pane 里启动 kimi 的命令（默认 `kimi acp`）。
 */
export function buildShimCommand(sessionName: string, kimiCmd: string): string {
  const inf = `/tmp/frostfin-${sessionName}.in`
  const outf = `/tmp/frostfin-${sessionName}.fifo`
  // pane 负载（创建与自愈重启共用同一份）：fd3 RDWR 持有输入 fifo（无外部写者也
  // 不 EOF——shim 断开 kimi 不死），cat 把 fifo 中继进 kimi 的管道 stdin。
  // 不让 kimi 直读 RDWR fifo：node 的 stdin 那样挂在 64KB+ 负载会卡（实测：
  // pipe 正常、fifo 直读卡死、cat 中继后正常）。
  const paneCmd = `stty ${PANE_TERMIOS}; exec sh -c '(exec 3<>\\"${inf}\\" && cat \\"${inf}\\") | exec ${kimiCmd}'`
  return [
    `tmux has-session -t "${sessionName}" 2>/dev/null || { rm -f "${inf}"; mkfifo -m 600 "${inf}"; tmux new-session -d -s "${sessionName}" "${paneCmd}"; }`,
    // kimi 存活判定：pane 根进程（管道包装 sh）的子进程 ≥2 = 左侧 cat + 右侧 kimi 都在。
    // 不能用 pane_current_command——管道形态的前台组长永远是包装 sh（上报 sh/bash），
    // 活着和死透显示一模一样（实测）。
    `alive() { pp=$(tmux display-message -p -t "${sessionName}" '#{pane_pid}' 2>/dev/null); [ -n "$pp" ] && [ "$(pgrep -P "$pp" 2>/dev/null | wc -l | tr -d ' ')" -ge 2 ]; }`,
    // 就绪闸：等 pane 的 kimi 真正起来（新建要 exec 时间；重连活 pane 一次即过）。
    `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do alive && break; sleep 0.3; done`,
    // 死 pane 自愈：闸后 kimi 仍不在 = pane 活着但 kimi 死透（卡住的 cat/sh 成僵尸）
    // → respawn-pane -k 原位重启（fifo 路径不变），再等一次闸。
    // 不重建会话：kimi 会话在磁盘上，session/load 回放照常。
    `alive || tmux respawn-pane -k -t "${sessionName}" "${paneCmd}"`,
    `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do alive && break; sleep 0.3; done`,
    // 输入 fifo 被 tmp 清理器删掉时（fifo 的 mtime 不随数据流更新，长活 pane 会赶上
    // systemd-tmpfiles 的 10 天清理）：cat > 会创建同名普通文件、输入静默黑洞——
    // 重建 fifo 并 respawn 重绑 pane 的 fd3。
    `[ -p "${inf}" ] || { rm -f "${inf}"; mkfifo -m 600 "${inf}"; tmux respawn-pane -k -t "${sessionName}" "${paneCmd}"; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do alive && break; sleep 0.3; done; }`,
    `rm -f "${outf}"; mkfifo -m 600 "${outf}"`,
    // 不带 -o：直接顶掉可能残留的死 pipe——旧 shim 的 cat 被杀后 tmux 不一定及时发现
    // 读取端没了，-o 会把 pane 输出写进已删除的 inode，新 shim 永远收不到（实测黑洞）。
    `tmux pipe-pane -t "${sessionName}" "cat > ${outf}"`,
    // 后台 cat 会继承 shim 的 stdout——不显式收尸的话，shim 退出后它仍占着
    // 管道，客户端的 close 事件永远不来（e2e 排障实录）。trap 兜底。
    `cat "${outf}" & CAT_PID=$!`,
    `trap 'rm -f "${outf}"; kill $CAT_PID 2>/dev/null' EXIT`,
    // 输入：stdin 字节直进 fifo。shim 退出时 cat 收 EOF 走人，pane 侧 fd3
    // 仍持有写端——kimi 永远收不到 EOF，远程进程继续活。
    `cat > "${inf}"`,
  ].join('\n')
}

/** ssh 的目标串与参数（alias 缺 HostName 时直接用 alias 作目标）。 */
export function remoteTargetOf(host: SshHostEntry): { dest: string; sshArgs: string[] } {
  const sshArgs: string[] = []
  if (host.identityFile !== undefined) sshArgs.push('-i', host.identityFile)
  if (host.port !== undefined) sshArgs.push('-p', String(host.port))
  const dest = host.user !== undefined
    ? `${host.user}@${host.hostName ?? host.alias}`
    : (host.hostName ?? host.alias)
  return { dest, sshArgs }
}

/** 面板显示名：alias（user@host:port 有不同值时附上）。 */
export function remoteLabelOf(host: SshHostEntry): string {
  const parts: string[] = []
  if (host.user !== undefined) parts.push(host.user)
  const base = host.hostName ?? host.alias
  const detail = parts.length > 0 ? `${parts.join('')}@${base}` : base
  return host.port !== undefined ? `${host.alias}（${detail}:${host.port}）` : host.alias
}

/**
 * 构建远程 spawn 的完整 argv（本地 spawn 直接当命令跑）。
 * BatchMode：认证不通立刻失败（不挂交互提示）；ConnectTimeout 防呆。
 * @param sshBin - ssh 可执行名（测试注入假 ssh；也可指向包装脚本）。
 */
export function buildRemoteArgv(host: SshHostEntry, sessionName: string, kimiCmd: string, sshBin = 'ssh'): string[] {
  const { dest, sshArgs } = remoteTargetOf(host)
  return [
    sshBin,
    ...sshArgs,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    dest,
    buildShimCommand(sessionName, kimiCmd),
  ]
}

/** 远程主机健康检查结果。 */
export interface RemoteHealth {
  ok: boolean
  /** 具体失败点（ok=false 时的人话原因）。 */
  detail: string
  /** 解析出的 kimi 绝对路径（ok=true 且探到时有；spawn 时优先于 PATH 里的裸名）。 */
  kimiPath?: string
  /** 远程用户 home（探针握手 newSession 的 cwd——kimi 校验远程路径必须存在，home 必然存在）。 */
  homeDir?: string
}

/**
 * 体检一台远程主机：ssh 认证 → tmux 在场 → kimi 在场（解析其绝对路径）。
 * kimi 的 PATH 解析三级：`command -v` → 官方默认位 `~/.kimi-code/bin/kimi`
 * → 登录 shell 兜底（版本管理器安装）——非交互 ssh 的 PATH 往往不含
 * 交互式配置（实测：装在默认位但 PATH 裸奔）。
 * kimi 登录态不在这里查（握手时自然暴露，翻译成人话）。
 * @param host - ssh 配置条目。
 * @param sshBin - ssh 可执行名（测试注入假 ssh 用）。
 */
export function checkRemoteHost(host: SshHostEntry, sshBin = 'ssh'): Promise<RemoteHealth> {
  const { dest, sshArgs } = remoteTargetOf(host)
  const probe = [
    'kimi=$(command -v kimi 2>/dev/null || true)',
    '[ -z "$kimi" ] && [ -x "$HOME/.kimi-code/bin/kimi" ] && kimi="$HOME/.kimi-code/bin/kimi"',
    '[ -z "$kimi" ] && kimi=$($SHELL -lc "command -v kimi" 2>/dev/null || true)',
    'command -v tmux >/dev/null 2>&1 || echo NO_TMUX',
    // shim 的存活判定（alive）用 pgrep -P 数 pane 子进程——缺 procps 的极简远程没有它。
    'command -v pgrep >/dev/null 2>&1 || echo NO_PGREP',
    '[ -z "$kimi" ] && echo NO_KIMI',
    '[ -n "$kimi" ] && echo "KIMI_PATH=$kimi"',
    'echo "PROBE_HOME=$HOME"',
    'echo PROBE_DONE',
  ].join('; ')
  const argv = [...sshArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', dest, probe]
  return new Promise((resolve) => {
    execFile(sshBin, argv, { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error !== null) {
        resolve({
          ok: false,
          detail: `ssh 连接/认证失败（${dest}）：${stderr.trim() || error.message}。请检查免密登录或 ssh-agent。`,
        })
        return
      }
      if (stdout.includes('NO_TMUX')) {
        resolve({ ok: false, detail: `远程主机 ${host.alias} 上没有 tmux——请先安装（如 apt/yum install tmux）。` })
        return
      }
      if (stdout.includes('NO_PGREP')) {
        resolve({ ok: false, detail: `远程主机 ${host.alias} 上没有 pgrep（procps 包）——死 pane 自愈的存活判定依赖它，请安装后重试。` })
        return
      }
      if (stdout.includes('NO_KIMI')) {
        resolve({ ok: false, detail: `远程主机 ${host.alias} 上没有 kimi——请按官方脚本安装并在其上跑一次 /login。` })
        return
      }
      const rawKimiPath = /^KIMI_PATH=(.+)$/m.exec(stdout)?.[1]?.trim()
      // 白名单校验：远端 stdout 解析出的路径只接受安全字符——含空格/引号的路径
      // 会在 pane 命令行里被词分割或破引号（宁可回退裸名也不拼危险值）。
      const kimiPath = rawKimiPath !== undefined && /^\/[A-Za-z0-9._/-]+$/.test(rawKimiPath) ? rawKimiPath : undefined
      const homeDir = /^PROBE_HOME=(.+)$/m.exec(stdout)?.[1]?.trim()
      resolve({
        ok: true,
        detail: 'ok',
        ...kimiPath === undefined ? {} : { kimiPath },
        ...homeDir === undefined ? {} : { homeDir },
      })
    })
  })
}

/** 活 TUI 探针的 list-panes 输出格式（| 分隔；含 | 的路径行整体丢弃）。 */
const LIVE_PANES_FORMAT = '#{session_name}|#{pane_current_command}|#{pane_current_path}'

/**
 * 解析 tmux list-panes 输出 → 疑似有活 kimi 在前台的工作目录（去重）。
 * kimi 的进程名是 kimi-code（TUI 与 acp 相同）；frostfin 自己的 pane
 * （tmux 会话名 frostfin-*）排除——我们的 acp 进程也是 kimi-code，但它不是
 * TUI 双写威胁。
 */
export function parseLiveKimiCwds(output: string): string[] {
  const cwds = new Set<string>()
  for (const line of output.split('\n')) {
    const parts = line.split('|')
    if (parts.length !== 3) continue
    const [session, command, path] = parts as [string, string, string]
    if (session.startsWith('frostfin-') || !command.includes('kimi') || path === '') continue
    cwds.add(path)
  }
  return [...cwds]
}

/**
 * 探一台远程主机上"疑似被活 TUI 持有"的工作区（双写防护）：
 * tmux 全量 pane 中前台命令含 kimi 者的 cwd。两个已知局限——
 * 裸终端（非 tmux）里的 kimi 看不到；粒度是工作区而非会话
 * （kimi 不在磁盘留活会话标记：fd 随写随关、updatedAt 只跟踪内容活动）。
 * 任何失败都回落空列表——held 只是提示标记，不挡列表主流程。
 */
export function probeLiveKimiCwds(host: SshHostEntry, sshBin = 'ssh'): Promise<string[]> {
  const { dest, sshArgs } = remoteTargetOf(host)
  const argv = [...sshArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', dest, `tmux list-panes -a -F '${LIVE_PANES_FORMAT}' 2>/dev/null`]
  return new Promise((resolve) => {
    execFile(sshBin, argv, { timeout: 10_000 }, (error, stdout) => {
      resolve(error !== null ? [] : parseLiveKimiCwds(stdout))
    })
  })
}

/** 杀掉远程的一个 frostfin tmux 会话（探针 pane 用完收尾；不存在/失败都静默）。 */
export function killRemoteTmuxSession(host: SshHostEntry, sessionName: string, sshBin = 'ssh'): Promise<void> {
  const { dest, sshArgs } = remoteTargetOf(host)
  const argv = [...sshArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', dest, `tmux kill-session -t "${sessionName}" 2>/dev/null || true`]
  return new Promise((resolve) => {
    execFile(sshBin, argv, { timeout: 10_000 }, () => resolve())
  })
}

/** 一个文件的上传步骤：scp 到远端临时名 → mv 落最终名（失败时 rm 清半截）。 */
export interface UploadStep {
  /** 本地源路径。 */
  local: string
  /** 远端最终路径（destDir/basename）。 */
  remote: string
  /** 远端临时路径：scp 先传这里——stat 它的字节数折算进度，mv 同分区原子落位。 */
  temp: string
  /** scp argv。目标必须裸路径：新版 OpenSSH 的 scp 走 SFTP（不过 shell），引号会被当字面字符。 */
  scp: string[]
  /** ssh argv：查临时文件字节数（GNU stat -c，兜底 BSD stat -f，都没有回 0）。 */
  stat: string[]
  /** ssh argv：mv 临时 → 最终（走远端 shell，shQuote 引号）。 */
  mv: string[]
  /** ssh argv：失败时清半截临时文件（best effort）。 */
  rm: string[]
}

/**
 * 构建一次上传的全部 argv：mkdir 建目录 + 每文件一条 scp/mv/rm/stat 步骤。
 * 临时名带随机后缀与同批序号：并发/同批同 basename 不撞车；进度观测期间
 * 远端字节数从 0 单调涨（不受同名旧文件干扰）。
 */
export function buildUploadArgv(host: SshHostEntry, paths: readonly string[], destDir: string): { mkdir: string[]; steps: UploadStep[] } {
  const { dest, sshArgs } = remoteTargetOf(host)
  const dir = destDir.replace(/\/$/, '')
  const sshBase = [...sshArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', dest]
  const suffix = randomUUID().slice(0, 8)
  return {
    mkdir: [...sshBase, `mkdir -p ${shQuote(destDir)}`],
    steps: paths.map((local, i) => {
      const remote = `${dir}/${basename(local)}`
      const temp = `${remote}.frostfin-part-${suffix}-${i}`
      return {
        local,
        remote,
        temp,
        scp: [...sshArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', local, `${dest}:${temp}`],
        stat: [...sshBase, `stat -c %s ${shQuote(temp)} 2>/dev/null || stat -f %z ${shQuote(temp)} 2>/dev/null || echo 0`],
        mv: [...sshBase, `mv ${shQuote(temp)} ${shQuote(remote)}`],
        rm: [...sshBase, `rm -f ${shQuote(temp)}`],
      }
    }),
  }
}

/**
 * 远程路径的 ~ 展开：`~` 与 `~/x` → 远程 home（探针握手时解析）；
 * `~user/x` 形式不展开（kimi 的 cwd 校验不走 shell，展开了也是错路径，不如原样报错）。
 * homeDir 未知时原样返回。
 */
export function expandRemoteHome(cwd: string, homeDir: string | undefined): string {
  if (homeDir === undefined) return cwd
  if (cwd === '~') return homeDir
  if (cwd.startsWith('~/')) return homeDir.replace(/\/$/, '') + cwd.slice(1)
  return cwd
}

/** POSIX 单引号包裹（内容里的单引号按 '\'' 闭合重开）。 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 查远程某目录的 git 分支（状态条用；非仓库/失败/detached 回落 undefined）。 */
export function probeGitBranch(host: SshHostEntry, cwd: string, sshBin = 'ssh'): Promise<string | undefined> {
  const { dest, sshArgs } = remoteTargetOf(host)
  const argv = [...sshArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', dest, `git -C ${shQuote(cwd)} rev-parse --abbrev-ref HEAD 2>/dev/null`]
  return new Promise((resolve) => {
    execFile(sshBin, argv, { timeout: 10_000 }, (error, stdout) => {
      const branch = stdout.trim()
      resolve(error !== null || branch === '' || branch === 'HEAD' ? undefined : branch)
    })
  })
}

/** 上传进度快照（driver → 面板任务注册表 → UI 进度条）。 */
export interface UploadProgress {
  /** 已落远端字节数（同批所有文件累计）。 */
  bytesDone: number
  /** 同批总字节数。 */
  bytesTotal: number
  /** 当前传第几个文件（1 起）。 */
  fileIndex: number
  /** 同批文件总数。 */
  fileCount: number
  /** 当前文件名（basename）。 */
  currentFile: string
}

/**
 * 宿主驱动接口：本地与远程一视同仁的主机操作面——体检、组装 ACP 进程 spawn、
 * 跑探针脚本、探活（双写防护）、杀 tmux 会话、查 git 分支、传文件。
 * 核心代码（panel/factory）只经此接口，不再有本地/远程分叉；平台差异
 * （POSIX vs 将来的 Windows）与位置差异都收口在这一层。
 * 纪律：先立约——没有测试的第二实现不写。
 */
export interface HostDriver {
  /** 驱动名（日志与错误信息用：'posix-local' / 'posix-ssh-tmux'）。 */
  readonly name: string
  /** 连接前体检（本地恒 ok——kimi 是否在场在 spawn 时自然暴露；远程验认证/tmux/pgrep/kimi）。 */
  check(): Promise<RemoteHealth>
  /** 组装承载一个 kimi acp 进程的 spawn 规格（本地直起；远程经 ssh+tmux shim）。 */
  agentSpawnSpec(sessionName: string, kimiCommand: string, kimiArgs: readonly string[]): { command: string; args: string[] }
  /** 跑一段 sh 探针脚本。永不 reject——调用方检查 error/stdout（对齐 execFile 回调语义）。 */
  execProbe(script: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; error: Error | null }>
  /** 探活：疑似被活 TUI 持有的工作区列表（双写防护提示；失败回落空）。 */
  probeLiveCwds(): Promise<string[]>
  /** 杀掉一个 frostfin tmux 会话（探针收尾；不存在/失败都静默）。 */
  killSession(sessionName: string): Promise<void>
  /** 查某目录的 git 分支（状态条用；非仓库/失败回落 undefined）。 */
  probeGitBranch(cwd: string): Promise<string | undefined>
  /**
   * 把本地文件上传到目标目录，返回远端最终路径列表。
   * 远程：逐文件 scp 到临时名 + mv 原子落位——scp 无 TTY 不自报进度，
   * 期间每 2 秒 stat 远端临时文件的字节数折算 onProgress；失败清半截临时文件。
   * 本地：逐文件复制，每文件完成时报一次进度。
   */
  uploadLocal(paths: readonly string[], destDir: string, onProgress?: (progress: UploadProgress) => void): Promise<string[]>
}

/** execFile 的 Promise 封装（永不 reject，对齐回调语义）。 */
function runCollect(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, error })
    })
  })
}

/** 本地 POSIX 宿主（macOS/Linux）：直起进程、本地 sh 跑探针、本地 tmux/git。 */
const posixLocal: HostDriver = {
  name: 'posix-local',
  // 本地不体检：kimi 是否在场、是否登录，在首个 prompt 的 spawn/握手时自然暴露并翻译成人话。
  check: () => Promise.resolve({ ok: true, detail: 'ok' }),
  agentSpawnSpec: (_sessionName, kimiCommand, kimiArgs) => ({ command: kimiCommand, args: [...kimiArgs] }),
  execProbe: (script, timeoutMs = 15_000) => runCollect('sh', ['-c', script], timeoutMs),
  probeLiveCwds: async () => {
    const { stdout, error } = await runCollect('tmux', ['list-panes', '-a', '-F', LIVE_PANES_FORMAT], 5_000)
    return error !== null ? [] : parseLiveKimiCwds(stdout)
  },
  killSession: async (sessionName) => {
    await runCollect('tmux', ['kill-session', '-t', sessionName], 5_000)
  },
  probeGitBranch: async (cwd) => {
    const { stdout, error } = await runCollect('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], 5_000)
    const branch = stdout.trim()
    return error !== null || branch === '' || branch === 'HEAD' ? undefined : branch
  },
  uploadLocal: async (paths, destDir, onProgress) => {
    await runCollect('mkdir', ['-p', destDir], 10_000)
    const sizes = paths.map(p => statSync(p).size)
    const total = sizes.reduce((sum, n) => sum + n, 0)
    let finished = 0
    for (const [i, p] of paths.entries()) {
      const name = basename(p)
      onProgress?.({ bytesDone: finished, bytesTotal: total, fileIndex: i + 1, fileCount: paths.length, currentFile: name })
      const { error } = await runCollect('cp', [p, destDir], 300_000)
      if (error !== null) throw new Error(`本地复制失败（${name}）：${error.message}`)
      finished += sizes[i]!
      onProgress?.({ bytesDone: finished, bytesTotal: total, fileIndex: i + 1, fileCount: paths.length, currentFile: name })
    }
    return paths.map(p => `${destDir.replace(/\/$/, '')}/${basename(p)}`)
  },
}

/** 远程 POSIX 宿主（ssh+tmux）：所有操作经 ssh 承载（shim/fifo/探针脚本）。 */
function posixSshTmuxDriver(host: SshHostEntry, sshBin: string, scpBin = 'scp'): HostDriver {
  return {
    name: 'posix-ssh-tmux',
    check: () => checkRemoteHost(host, sshBin),
    agentSpawnSpec: (sessionName, kimiCommand, kimiArgs) => {
      const argv = buildRemoteArgv(host, sessionName, `${kimiCommand} ${kimiArgs.join(' ')}`, sshBin)
      return { command: argv[0]!, args: argv.slice(1) }
    },
    execProbe: (script, timeoutMs = 15_000) => {
      const { dest, sshArgs } = remoteTargetOf(host)
      return runCollect(sshBin, [...sshArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', dest, script], timeoutMs)
    },
    probeLiveCwds: () => probeLiveKimiCwds(host, sshBin),
    killSession: (sessionName) => killRemoteTmuxSession(host, sessionName, sshBin),
    probeGitBranch: (cwd) => probeGitBranch(host, cwd, sshBin),
    uploadLocal: async (paths, destDir, onProgress) => {
      const { mkdir, steps } = buildUploadArgv(host, paths, destDir)
      const made = await runCollect(sshBin, mkdir, 15_000)
      if (made.error !== null) throw new Error(`远端建目录失败：${made.stderr.trim() || made.error.message}`)
      const sizes = paths.map(p => statSync(p).size)
      const total = sizes.reduce((sum, n) => sum + n, 0)
      const uploaded: string[] = []
      let finished = 0
      for (const [i, step] of steps.entries()) {
        const report = (current: number): void => onProgress?.({
          bytesDone: Math.min(finished + current, total),
          bytesTotal: total,
          fileIndex: i + 1,
          fileCount: steps.length,
          currentFile: basename(step.local),
        })
        report(0)
        // scp 无 TTY 不自报进度：每 2 秒 stat 远端临时文件的字节数折算。
        // inFlight 闸：上一次 stat 没回来不叠加（慢链路下 ssh 建连可能超 2 秒）。
        let inFlight = false
        const timer = setInterval(() => {
          if (inFlight) return
          inFlight = true
          void runCollect(sshBin, step.stat, 10_000).then(({ stdout, error }) => {
            if (error === null) {
              const size = Number(stdout.trim().split('\n').pop())
              if (Number.isFinite(size) && size > 0) report(Math.min(size, sizes[i]!))
            }
          }).finally(() => { inFlight = false })
        }, 2_000)
        let scpError: Error | null = null
        let scpStderr = ''
        try {
          const scp = await runCollect(scpBin, step.scp, 3_600_000)
          scpError = scp.error
          scpStderr = scp.stderr
        } finally {
          clearInterval(timer)
        }
        if (scpError !== null) {
          await runCollect(sshBin, step.rm, 10_000)
          throw new Error(`scp 失败（${basename(step.local)}）：${scpStderr.trim() || scpError.message}`)
        }
        const moved = await runCollect(sshBin, step.mv, 15_000)
        if (moved.error !== null) {
          await runCollect(sshBin, step.rm, 10_000)
          throw new Error(`远端落位失败（${basename(step.local)}）：${moved.stderr.trim() || moved.error.message}`)
        }
        finished += sizes[i]!
        report(0)
        uploaded.push(step.remote)
      }
      return uploaded
    },
  }
}

/**
 * 位置 × 平台分派点：插件内所有主机操作只经此函数拿驱动。
 * - host 在场 = 远程：POSIX（ssh+tmux）。远程平台的实际闸是体检——没有 tmux/sh
 *   就人话报缺件；将来的远程 Windows 驱动在体检探出平台后在此分派。
 * - host 缺省 = 本地：按 process.platform 分。Windows 本地宿主暂未实现——
 *   明确报错而不是跑出莫名其妙的 POSIX 错误（无测试不实现）。
 */
export function hostDriverFor(host: SshHostEntry | undefined, sshBin = 'ssh', scpBin?: string): HostDriver {
  if (host !== undefined) return posixSshTmuxDriver(host, sshBin, scpBin ?? 'scp')
  if (process.platform === 'win32') throw new Error('frostfin: Windows 本地宿主暂未支持（HostDriver 目前只有 POSIX 实现）')
  return posixLocal
}
