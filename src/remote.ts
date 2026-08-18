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
 *
 * @module dsh-frostfin/remote
 */

import { execFile } from 'node:child_process'
import type { SshHostEntry } from './ssh-config.js'

/** tmux 会话名白名单化（字母数字 . _ -，其余压成 -，截断 48）。 */
export function sanitizeSessionName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-{2,}/g, '-')
  return cleaned.slice(0, 48)
}

/** shim 的终端属性约定：-echo（防回显）-onlcr（防 \n→\r\n）icrnl（\r→\n，救活 paste）。 */
const PANE_TERMIOS = '-echo -onlcr icrnl'

/**
 * 构建远程 shim（sh -c 的负载；整体无单引号，可整体包进 ssh 的单引号命令串）。
 * @param sessionName - tmux 会话名（经 sanitizeSessionName）。
 * @param kimiCmd - pane 里启动 kimi 的命令（默认 `kimi acp`）。
 */
export function buildShimCommand(sessionName: string, kimiCmd: string): string {
  const inf = `/tmp/frostfin-${sessionName}.in`
  const outf = `/tmp/frostfin-${sessionName}.fifo`
  return [
    // 只在会话不存在时创建。输入 fifo 由 pane 侧 fd3 以 RDWR 持有（无外部写者也
    // 不 EOF——shim 断开 kimi 不死），cat 把 fifo 中继进 kimi 的管道 stdin。
    // 不让 kimi 直读 RDWR fifo：node 的 stdin 那样挂在 64KB+ 负载会卡（实测：
    // pipe 正常、fifo 直读卡死、cat 中继后正常）。
    `tmux has-session -t "${sessionName}" 2>/dev/null || { rm -f "${inf}"; mkfifo "${inf}"; tmux new-session -d -s "${sessionName}" "stty ${PANE_TERMIOS}; exec sh -c '(exec 3<>\\"${inf}\\" && cat \\"${inf}\\") | exec ${kimiCmd}'"; }`,
    // 就绪闸：等 pane 的命令真正 exec 起来。排除启动期的过渡命令名
    //（sh/bash/dash/zsh/stty；macOS 的 sh 以 bash 上报）。
    `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do pc=$(tmux list-panes -t "${sessionName}" -F "#{pane_current_command}" 2>/dev/null | head -1); case "$pc" in ""|sh|bash|dash|zsh|stty) sleep 0.3 ;; *) break ;; esac; done`,
    `rm -f "${outf}"; mkfifo "${outf}"`,
    `tmux pipe-pane -t "${sessionName}" -o "cat > ${outf}"`,
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
      if (stdout.includes('NO_KIMI')) {
        resolve({ ok: false, detail: `远程主机 ${host.alias} 上没有 kimi——请按官方脚本安装并在其上跑一次 /login。` })
        return
      }
      const kimiPath = /^KIMI_PATH=(.+)$/m.exec(stdout)?.[1]?.trim()
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
