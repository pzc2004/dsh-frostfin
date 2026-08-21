// 远程线单测+e2e：shim 命令构建、ssh argv、体检（假 ssh）、
// 以及 shim+tmux 全链路 e2e（假 ssh 本地执行 shim，pane 跑 scripted ACP 夹具，不经真 ssh/真 kimi）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildRemoteArgv, buildShimCommand, buildUploadArgv, checkRemoteHost, expandRemoteHome, hostDriverFor, parseLiveKimiCwds, remoteTargetOf, sanitizeSessionName } from '../lib/remote.js'
import { startAcpProcess } from '../lib/acp-process.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bootPlugin, FIXTURE, localSpawn, mockGet, mockPost, mockResponse } from './helpers.mjs'

const HOST = {
  alias: 'spike-host',
  hostName: 'spike.internal.example.com',
  user: 'spiker',
  port: 2222,
  identityFile: '/home/spiker/.ssh/id_spike',
}

test('sanitizeSessionName：非常规字符压成 -，截断 48', () => {
  assert.equal(sanitizeSessionName('frostfin:a/b c'), 'frostfin-a-b-c')
  assert.equal(sanitizeSessionName('x'.repeat(60)), 'x'.repeat(48))
})

test('buildShimCommand：fifo 双向通道 + 存活闸 + 后台 cat 收尸', () => {
  const shim = buildShimCommand('s1', 'kimi acp')
  assert.ok(shim.includes('tmux has-session -t "s1"'))
  assert.ok(shim.includes('/tmp/frostfin-s1.in'))
  assert.ok(shim.includes('/tmp/frostfin-s1.fifo'))
  // pipe-pane 不带 -o：直接顶掉残留死 pipe（-o 会把输出写进已删除 inode，实测黑洞）
  assert.ok(shim.includes('tmux pipe-pane -t "s1" "cat >'))
  assert.ok(!shim.includes('pipe-pane -t "s1" -o'))
  // 输入 fifo 由 pane 侧 fd3 RDWR 持有 + cat 中继进 kimi 的管道 stdin（断线不死且大负载不卡）
  assert.ok(shim.includes('exec 3<>'))
  assert.ok(shim.includes('| exec kimi acp'))
  // 后台 cat 必须收尸（否则它继承 stdout，客户端 close 永不触发）
  assert.ok(shim.includes('CAT_PID'))
  // 死 pane 自愈：存活判定数 pane 根进程子进程（管道包装 sh + cat + kimi），死了 respawn-pane -k 原位重启
  assert.ok(shim.includes('alive()'))
  assert.ok(shim.includes("pgrep -P"))
  assert.ok(shim.includes('respawn-pane -k'))
})

test('remoteTargetOf / buildRemoteArgv：目标串与参数顺序', () => {
  assert.deepEqual(remoteTargetOf(HOST), {
    dest: 'spiker@spike.internal.example.com',
    sshArgs: ['-i', '/home/spiker/.ssh/id_spike', '-p', '2222'],
  })
  // 缺省：alias 直接作目标
  assert.deepEqual(remoteTargetOf({ alias: 'spike-min' }), { dest: 'spike-min', sshArgs: [] })

  const argv = buildRemoteArgv(HOST, 's1', 'kimi acp')
  assert.equal(argv[0], 'ssh')
  assert.deepEqual(argv.slice(1, 5), ['-i', '/home/spiker/.ssh/id_spike', '-p', '2222'])
  assert.ok(argv.includes('BatchMode=yes'))
  assert.equal(argv.at(-2), 'spiker@spike.internal.example.com')
  assert.equal(argv.at(-1), buildShimCommand('s1', 'kimi acp'))
})

test('hostDriverFor 分派点：host 在场走 posix-ssh-tmux，缺省走 posix-local，且委托等价', () => {
  const remote = hostDriverFor(HOST)
  assert.equal(remote.name, 'posix-ssh-tmux')
  // 远程委托等价：agentSpawnSpec 与直调 buildRemoteArgv 产出一致（缺省 sshBin 走默认 'ssh'）
  const spec = remote.agentSpawnSpec('s1', 'kimi', ['acp'])
  const argv = buildRemoteArgv(HOST, 's1', 'kimi acp')
  assert.equal(spec.command, argv[0])
  assert.deepEqual(spec.args, argv.slice(1))
  // 本地：posix-local 直起，命令与 args 原样（不掺 shim）。
  const local = hostDriverFor(undefined)
  assert.equal(local.name, 'posix-local')
  assert.deepEqual(local.agentSpawnSpec('whatever', 'kimi', ['acp']), { command: 'kimi', args: ['acp'] })
})

test('parseLiveKimiCwds：kimi 前台 pane 的 cwd 入选，frostfin pane 与 shell pane 排除', () => {
  const out = [
    'work|kimi-code|/home/u/proj', // 活 TUI
    'work|sh|/home/u/proj', // 同 tmux 会话里的 shell pane 不算
    'frostfin-v2-x|kimi-code|/home/u', // frostfin 自己的 acp pane 排除
    'misc|node|/home/u/other', // 非 kimi 排除
    '编辑|kimi-code|/home/u/proj', // 同 cwd 去重
    '残缺行',
    '|kimi-code|', // 空 path 排除
  ].join('\n')
  assert.deepEqual(parseLiveKimiCwds(out), ['/home/u/proj'])
})

test('expandRemoteHome：~ 与 ~/x 展开为远程 home，其余原样', () => {
  assert.equal(expandRemoteHome('~', '/home/u'), '/home/u')
  assert.equal(expandRemoteHome('~/proj/x', '/home/u'), '/home/u/proj/x')
  assert.equal(expandRemoteHome('~/proj', '/home/u/'), '/home/u/proj') // home 尾斜杠压住
  assert.equal(expandRemoteHome('/abs/path', '/home/u'), '/abs/path')
  assert.equal(expandRemoteHome('~other/x', '/home/u'), '~other/x') // ~user 形式不展开
  assert.equal(expandRemoteHome('~/proj', undefined), '~/proj') // home 未知原样
})

test('hostDriver.probeLiveCwds：经 ssh 探活并解析；失败回落空列表', async () => {
  const live = fakeSsh('#!/bin/sh\necho "work|kimi-code|/home/u/proj"\necho "frostfin-v2-p|kimi-code|/home/u"')
  assert.deepEqual(await hostDriverFor(HOST, live).probeLiveCwds(), ['/home/u/proj'])
  const dead = fakeSsh('#!/bin/sh\nexit 255')
  assert.deepEqual(await hostDriverFor(HOST, dead).probeLiveCwds(), [])
})

/** 造一个假 ssh 可执行（记录参数、按剧本输出/退出码）。 */
function fakeSsh(script) {
  const dir = mkdtempSync(join(tmpdir(), 'frostfin-fakessh-'))
  const path = join(dir, 'ssh')
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

test('checkRemoteHost：tmux 缺失 / kimi 缺失 / 认证失败 / 全通', async () => {
  const noTmux = fakeSsh('#!/bin/sh\necho NO_TMUX; echo NO_KIMI; echo PROBE_DONE')
  const noKimi = fakeSsh('#!/bin/sh\necho NO_KIMI; echo PROBE_DONE')
  const authFail = fakeSsh('#!/bin/sh\necho "Permission denied (publickey)." >&2; exit 255')
  const allGood = fakeSsh('#!/bin/sh\necho "KIMI_PATH=/home/spiker/.kimi-code/bin/kimi"; echo "PROBE_HOME=/home/spiker"; echo PROBE_DONE')

  const r1 = await checkRemoteHost(HOST, noTmux)
  assert.equal(r1.ok, false); assert.match(r1.detail, /tmux/)
  const r2 = await checkRemoteHost(HOST, noKimi)
  assert.equal(r2.ok, false); assert.match(r2.detail, /kimi/)
  const r3 = await checkRemoteHost(HOST, authFail)
  assert.equal(r3.ok, false); assert.match(r3.detail, /认证|连接/)
  const r4 = await checkRemoteHost(HOST, allGood)
  assert.equal(r4.ok, true)
  // kimi 路径与远程 home 解析。
  assert.equal(r4.kimiPath, '/home/spiker/.kimi-code/bin/kimi')
  assert.equal(r4.homeDir, '/home/spiker')
})

const hasTmux = (() => {
  try { execFileSync('tmux', ['-V']); return true } catch { return false }
})()

test('e2e：shim+tmux 全链路（假 ssh 本地执行，pane 跑 ACP 夹具）', { skip: !hasTmux }, async (t) => {
  const session = `spike-${crypto.randomUUID().slice(0, 8)}`
  // 假 ssh：忽略选项与目标，用 sh -c 本地执行最后一个参数（即 shim）。
  const ssh = fakeSsh('#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"')
  const argv = buildRemoteArgv({ alias: 'spike-local' }, session, `${process.execPath} ${FIXTURE}`)
  argv[0] = ssh

  const updates = []
  const proc = await startAcpProcess({
    command: argv[0],
    args: argv.slice(1),
    cwd: process.cwd(),
    permission: 'allow',
    disposeEofGraceMs: 2000,
    disposeGraceMs: 1000,
    spawn: localSpawn,
    onSessionUpdate: update => updates.push(update),
  })
  t.after(async () => {
    await proc.dispose().catch(() => {})
    try { execFileSync('tmux', ['kill-session', '-t', session]) } catch { /* 清理 */ }
  })

  // 经 shim（fifo 出、paste 入）完成握手与真 prompt。
  assert.equal(typeof proc.sessionId, 'string')
  const stop = await proc.prompt([{ type: 'text', text: '打个招呼' }])
  assert.equal(stop.stopReason, 'end_turn')
  const text = updates
    .filter(u => u.sessionUpdate === 'agent_message_chunk')
    .map(u => u.content.text).join('')
  assert.ok(text.includes('你好'), '应收到夹具的流式回话')

  // 图片负载（大 base64）经 paste 注入无损到达。
  const imageData = Buffer.alloc(150_000, 7).toString('base64')
  const stop2 = await proc.prompt([
    { type: 'text', text: '看图说话' },
    { type: 'image', data: imageData, mimeType: 'image/png' },
  ])
  assert.equal(stop2.stopReason, 'end_turn')
  const text2 = updates
    .filter(u => u.sessionUpdate === 'agent_message_chunk')
    .map(u => u.content.text).join('')
  assert.ok(text2.includes(`[image] image/png ${imageData.length}`), '图片负载应无损到达夹具')

  await proc.dispose()
  // 客户端断开不杀 pane：tmux 会话应仍在（远程线核心语义）。
  execFileSync('tmux', ['has-session', '-t', session])
})

test('e2e：死 pane 自愈——kimi 死后重连，shim 原位重启（respawn-pane -k）', { skip: !hasTmux }, async (t) => {
  const session = `spike-${crypto.randomUUID().slice(0, 8)}`
  const ssh = fakeSsh('#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"')
  const argv = buildRemoteArgv({ alias: 'spike-local' }, session, `${process.execPath} ${FIXTURE}`)
  argv[0] = ssh
  const spec = {
    command: argv[0],
    args: argv.slice(1),
    cwd: process.cwd(),
    permission: 'allow',
    disposeEofGraceMs: 2000,
    disposeGraceMs: 1000,
    spawn: localSpawn,
  }
  const proc1 = await startAcpProcess({ ...spec, onSessionUpdate: () => {} })
  await proc1.dispose()
  t.after(() => { try { execFileSync('tmux', ['kill-session', '-t', session]) } catch { /* 清理 */ } })

  // 模拟"kimi 死了、pane 卡在 shell"的僵尸态（生产实录：旧 shim 会把管子接给死 pane → 握手永挂）。
  execFileSync('tmux', ['respawn-pane', '-k', '-t', session, 'exec sh'])
  // 重连：就绪闸后仍是 sh → shim 应 respawn-pane 原位重启夹具 → 握手成功、prompt 可跑。
  const updates = []
  const proc2 = await startAcpProcess({ ...spec, onSessionUpdate: u => updates.push(u) })
  t.after(async () => { await proc2.dispose().catch(() => {}) })
  assert.equal(typeof proc2.sessionId, 'string')
  const stop = await proc2.prompt([{ type: 'text', text: '打个招呼' }])
  assert.equal(stop.stopReason, 'end_turn')
  const text = updates
    .filter(u => u.sessionUpdate === 'agent_message_chunk')
    .map(u => u.content.text).join('')
  assert.ok(text.includes('你好'), '自愈后应收到夹具的流式回话')
})

test('e2e：整插件远程会话——meta.frostfinHost 走远程 spawn，绑定记主机，dispose 不杀 pane', { skip: !hasTmux }, async (t) => {
  const ssh = fakeSsh('#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"')
  const sshConfigDir = mkdtempSync(join(tmpdir(), 'frostfin-sshcfg-'))
  const sshConfigFile = join(sshConfigDir, 'config')
  writeFileSync(sshConfigFile, 'Host spike-local\n  HostName spike.local.example.com\n  User spiker\n')
  const { ctx, stateFile } = await bootPlugin({ sshConfigFile, sshCommand: ssh })

  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: process.cwd(), agentPreset: 'frostfin', frostfinHost: 'spike-local' },
  })
  t.after(async () => {
    await handle.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  })

  const { agent } = handle
  assert.equal(agent.remoteHost?.alias, 'spike-local')
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '打个招呼' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  // 完整跑通（夹具全剧本），绑定记录带主机别名。
  const messages = agent.session.events.filter(e => e.type === 'assistant/message')
  const text = messages.flatMap(e => e.data.message.content).map(b => b.text ?? '').join('')
  assert.ok(text.includes('你好'), '远程链路应跑通夹具全剧本')
  const { KimiSessionMap } = await import('../lib/kimi-sessions.js')
  const map = new KimiSessionMap(stateFile)
  assert.equal(map.getHost(agent.id), 'spike-local')

  // dispose 只断开 shim（= detach 语义）：pane 应活着。
  const tmuxName = sanitizeSessionName(`frostfin-v2-${agent.id}`)
  t.after(() => { try { execFileSync('tmux', ['kill-session', '-t', tmuxName]) } catch { /* 清理 */ } })
  await handle.dispose()
  execFileSync('tmux', ['has-session', '-t', tmuxName])
})

test('e2e：面板远程端点——remote-hosts / remote-sessions / open-remote / delete-session 全链', { skip: !hasTmux }, async (t) => {
  // 假 ssh：活 TUI 探针（含 pane_current_path 的 list-panes；shim 存活闸不含此字段）回剧本行
  //（cwd 可被 FROSTFIN_PROBE_CWD 覆盖，测 held 负向）；其余命令本地执行。
  const ssh = fakeSsh('#!/bin/sh\nfor last; do :; done\ncase "$last" in *pane_current_path*) printf "work|kimi-code|%s\\n" "${FROSTFIN_PROBE_CWD:-$PWD}" ;; *rev-parse*) echo main ;; *) exec sh -c "$last" ;; esac')
  const sshConfigDir = mkdtempSync(join(tmpdir(), 'frostfin-sshcfg-'))
  const sshConfigFile = join(sshConfigDir, 'config')
  writeFileSync(sshConfigFile, 'Host spike-local\n  HostName spike.local.example.com\nHost spike-elsewhere\n  HostName spike2.example.com\n')
  const boot = await bootPlugin({ withWebServer: true, sshConfigFile, sshCommand: ssh })
  const { ctx, webServer, stateFile } = boot
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })

  // remote-hosts：列出 ssh 配置里的主机。
  const hostsRes = mockResponse()
  webServer.routes.get('/plugins/frostfin/remote-hosts').handler(mockGet('/plugins/frostfin/remote-hosts'), hostsRes)
  assert.deepEqual(hostsRes.body.hosts, [{ alias: 'spike-local' }, { alias: 'spike-elsewhere' }])

  // remote-sessions：体检 + 探针列出远程 kimi 会话（夹具 3 条刨去探针自身握手会话剩 2 条）。
  const listRes = mockResponse()
  await webServer.routes.get('/plugins/frostfin/remote-sessions').handler(
    mockGet('/plugins/frostfin/remote-sessions?host=spike-local'), listRes)
  assert.equal(listRes.body.error, undefined)
  assert.equal(listRes.body.sessions.length, 2)
  // 双写提示：假 tmux 探针报夹具 cwd 上有活 TUI → 全部条目带 held 标记。
  assert.ok(listRes.body.sessions.every(item => item.held === true))

  // held 负向：探活 cwd 不命中任何会话 → 无 held 标记（防"全部打标"的退化）。
  process.env.FROSTFIN_PROBE_CWD = '/elsewhere'
  const negRes = mockResponse()
  await webServer.routes.get('/plugins/frostfin/remote-sessions').handler(
    mockGet('/plugins/frostfin/remote-sessions?host=spike-elsewhere'), negRes)
  delete process.env.FROSTFIN_PROBE_CWD
  assert.equal(negRes.body.sessions.length, 2)
  assert.ok(negRes.body.sessions.every(item => item.held === undefined))

  // 未知主机：404 + 人话错误。
  const ghostRes = mockResponse()
  await webServer.routes.get('/plugins/frostfin/remote-sessions').handler(
    mockGet('/plugins/frostfin/remote-sessions?host=spike-ghost'), ghostRes)
  assert.equal(ghostRes.status, 404)

  // open-remote：接入夹具的 session_scripted-dead，创建远程绑定会话。
  const openRes = mockResponse()
  await webServer.routes.get('/plugins/frostfin/open-remote').handler(
    mockPost({ host: 'spike-local', kimiSessionId: 'session_scripted-dead' }), openRes)
  assert.equal(openRes.status, 200)
  assert.equal(typeof openRes.body.sessionId, 'string')
  const { KimiSessionMap } = await import('../lib/kimi-sessions.js')
  assert.equal(new KimiSessionMap(stateFile).getHost(openRes.body.sessionId), 'spike-local')
  // 接入的 agent 是远程绑定。
  const agent = ctx.agents.get(openRes.body.sessionId)
  assert.equal(agent.remoteHost?.alias, 'spike-local')
  // open-remote 的会话 pane 按设计"断开不死"——测试里用完手动收掉，别在本地 tmux 攒垃圾。
  t.after(() => { try { execFileSync('tmux', ['kill-session', '-t', sanitizeSessionName(`frostfin-v2-${openRes.body.sessionId}`)]) } catch { /* 清理 */ } })

  // open-remote 幂等：重复接入同一会话 → 复用既有 DSH 会话，不双写。
  const reopenRes = mockResponse()
  await webServer.routes.get('/plugins/frostfin/open-remote').handler(
    mockPost({ host: 'spike-local', kimiSessionId: 'session_scripted-dead' }), reopenRes)
  assert.equal(reopenRes.status, 200)
  assert.equal(reopenRes.body.reused, true)
  assert.equal(reopenRes.body.sessionId, openRes.body.sessionId)

  // 夹具删除态跨进程持久化：pane 由 tmux 服务器拉起、不继承我们的 process.env——
  // 走 tmux 全局环境变量。此刻 open-remote 的会话 pane 在，server 必然活着。
  const delState = join(mkdtempSync(join(tmpdir(), 'frostfin-delstate-')), 'deleted.txt')
  execFileSync('tmux', ['set-environment', '-g', 'FROSTFIN_FIXTURE_STATE', delState])
  t.after(() => { try { execFileSync('tmux', ['set-environment', '-gu', 'FROSTFIN_FIXTURE_STATE']) } catch { /* 清理 */ } })

  // 绑定态标注（open-remote 已失效列表缓存）：该行带 boundDshId。
  const listBound = mockResponse()
  await webServer.routes.get('/plugins/frostfin/remote-sessions').handler(
    mockGet('/plugins/frostfin/remote-sessions?host=spike-local'), listBound)
  const boundRow = listBound.body.sessions.find(item => item.sessionId === 'session_scripted-dead')
  assert.equal(boundRow?.boundDshId, openRes.body.sessionId)

  // 远程会话状态条：git 分支经 ssh 查远程（假 ssh 的 rev-parse 剧本回 main）。
  const statusRes = mockResponse()
  await webServer.routes.get('/plugins/frostfin/status').handler(
    mockGet(`/plugins/frostfin/status?sessionId=${openRes.body.sessionId}`), statusRes)
  assert.equal(statusRes.body.branch, 'main')

  // delete-session 守卫：已绑定的 409；不存在的（夹具对齐真 kimi 报错）409。
  const delBound = mockResponse()
  await webServer.routes.get('/plugins/frostfin/delete-session').handler(
    mockPost({ host: 'spike-local', kimiSessionId: 'session_scripted-dead' }), delBound)
  assert.equal(delBound.status, 409)
  const delGone = mockResponse()
  await webServer.routes.get('/plugins/frostfin/delete-session').handler(
    mockPost({ host: 'spike-local', kimiSessionId: 'session_no-such' }), delGone)
  assert.equal(delGone.status, 409)

  // delete-session（远程，未绑定）：删完缓存已失效，再列表只剩绑定的 DEAD。
  const delRes = mockResponse()
  await webServer.routes.get('/plugins/frostfin/delete-session').handler(
    mockPost({ host: 'spike-local', kimiSessionId: 'session_no-title' }), delRes)
  assert.equal(delRes.status, 200)
  const listRes2 = mockResponse()
  await webServer.routes.get('/plugins/frostfin/remote-sessions').handler(
    mockGet('/plugins/frostfin/remote-sessions?host=spike-local'), listRes2)
  assert.deepEqual(listRes2.body.sessions.map(item => item.sessionId), ['session_scripted-dead'])

  // delete-session（本地，无 host）：本地直起探针删除。
  const delLocalRes = mockResponse()
  await webServer.routes.get('/plugins/frostfin/delete-session').handler(
    mockPost({ kimiSessionId: 'session_no-title' }), delLocalRes)
  assert.equal(delLocalRes.status, 200)

  // 探针 pane 收尾：本测试的探针用完即杀（断言收窄到 spike 命名，不碰别的 pane）。
  const tmuxLs = () => { try { return execFileSync('tmux', ['ls', '-F', '#{session_name}']).toString() } catch { return '' } }
  assert.ok(!tmuxLs().split('\n').some(n => n.startsWith('frostfin-v2-probe-') && n.includes('spike')), '探针 pane 应用完即杀')

  // new-remote：~ 展开为远程 home（假 ssh 体检的 PROBE_HOME = 测试进程 HOME）。
  const newRes = mockResponse()
  await webServer.routes.get('/plugins/frostfin/new-remote').handler(
    mockPost({ host: 'spike-local', cwd: '~/proj' }), newRes)
  assert.equal(newRes.status, 200)
  assert.equal(newRes.body.cwd, `${homedir()}/proj`)
})

test('buildUploadArgv：每文件一条 scp/mv/rm/stat 步骤；临时名随机不撞车、scp 目标裸路径', () => {
  const { mkdir, steps } = buildUploadArgv(HOST, ['/local/a.txt', "/local/b's file.pdf"], '/up/dir/')
  // 返回的是 argv（不含二进制——driver 用 runCollect(sshBin/scpBin, argv) 跑）。
  assert.ok(mkdir.at(-2) === 'spiker@spike.internal.example.com' && mkdir.at(-1).startsWith('mkdir -p ') && mkdir.at(-1).includes('/up/dir/'))
  assert.equal(steps.length, 2)
  const [a, b] = steps
  // 临时名 = 最终名 + 随机后缀 + 同批序号：并发两批/同批同 basename 都不撞车；
  // 且进度观测期间远端字节数从 0 单调涨（不受同名旧文件干扰）。
  assert.notEqual(a.temp, b.temp)
  assert.match(a.temp, /^\/up\/dir\/a\.txt\.frostfin-part-[0-9a-f]{8}-0$/)
  assert.ok(b.temp.startsWith("/up/dir/b's file.pdf.frostfin-part-"))
  assert.equal(a.remote, '/up/dir/a.txt')
  // scp：-- 后裸本地路径，最后一个参数是 host:temp 裸串
  // （新版 OpenSSH 的 scp 走 SFTP 不过 shell，引号会被当字面字符——真机实录）。
  const dash = a.scp.indexOf('--')
  assert.deepEqual(a.scp.slice(dash + 1), ['/local/a.txt', `spiker@spike.internal.example.com:${a.temp}`])
  assert.ok(!a.scp.some(arg => arg.includes("'")))
  // stat/mv/rm 走远端 shell：路径 shQuote 包裹（含单引号的文件名按 '\'' 闭合重开）。
  const q = value => `'${value.replace(/'/g, `'\\''`)}'`
  assert.ok(b.mv.at(-1).includes(`mv ${q(b.temp)} ${q(b.remote)}`))
  assert.ok(a.stat.at(-1).includes('stat -c %s') && a.stat.at(-1).includes('stat -f %z') && a.stat.at(-1).includes('|| echo 0'))
  assert.ok(a.rm.at(-1) === `rm -f ${q(a.temp)}`)
})

test('e2e：upload-remote 任务化——jobId + 进度端点 + scp/mv 参数形态；坏路径 400；未知 jobId 404', { skip: !hasTmux }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frostfin-upload-'))
  const log = join(dir, 'calls.log')
  const up1 = join(dir, 'a.txt'); writeFileSync(up1, 'hello')
  const up2 = join(dir, 'b.txt'); writeFileSync(up2, 'world')
  // 假 ssh/scp：记录参数，成功退出。
  const recorder = `#!/bin/sh\necho "$0 $@" >> ${log}\nexit 0\n`
  const ssh = fakeSsh(recorder)
  const scp = fakeSsh(recorder)
  const sshConfigDir = mkdtempSync(join(tmpdir(), 'frostfin-sshcfg-'))
  const sshConfigFile = join(sshConfigDir, 'config')
  writeFileSync(sshConfigFile, 'Host spike-local\n  HostName spike.local.example.com\n')
  const { ctx, webServer } = await bootPlugin({ withWebServer: true, sshConfigFile, sshCommand: ssh, scpCommand: scp })
  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: process.cwd(), agentPreset: 'frostfin', frostfinHost: 'spike-local' },
  })
  t.after(async () => {
    await handle.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  })

  // POST 立即回 jobId（任务异步跑，大文件不挂 HTTP 连接）。
  const res = mockResponse()
  await webServer.routes.get('/plugins/frostfin/upload-remote').handler(
    mockPost({ sessionId: handle.agent.id, paths: [up1, up2] }), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(typeof res.body.jobId, 'string')

  // 轮询进度端点到终态（假 scp 瞬时完成，几拍内 done）。
  let snap
  for (let i = 0; i < 100; i++) {
    const probe = mockResponse()
    await webServer.routes.get('/plugins/frostfin/upload-progress').handler(
      mockGet(`/plugins/frostfin/upload-progress?jobId=${res.body.jobId}`), probe)
    assert.equal(probe.status, 200)
    snap = probe.body
    if (snap.state !== 'running') break
    await new Promise(r => setTimeout(r, 50))
  }
  assert.equal(snap.state, 'done')
  assert.deepEqual(snap.files, ['/tmp/frostfin-uploads/a.txt', '/tmp/frostfin-uploads/b.txt'])
  assert.equal(snap.bytesTotal, 10) // 'hello' + 'world'
  assert.equal(snap.bytesDone, 10)

  const calls = readFileSync(log, 'utf8').trim().split('\n')
  const scpCalls = calls.filter(line => line.startsWith(scp))
  const sshCalls = calls.filter(line => line.startsWith(ssh))
  // scp 每文件一次：-- 后裸本地路径，目标是 host:临时名（带 .frostfin-part- 后缀与批次序号）。
  assert.equal(scpCalls.length, 2)
  assert.ok(scpCalls[0].includes('--') && scpCalls[0].includes(up1))
  assert.match(scpCalls[0], /:\/tmp\/frostfin-uploads\/a\.txt\.frostfin-part-[0-9a-f]+-0$/)
  assert.match(scpCalls[1], /b\.txt\.frostfin-part-[0-9a-f]+-1$/)
  assert.ok(!scpCalls.some(line => line.includes(":''")))
  // ssh：mkdir 一次 + mv 两次（临时名 → 最终名）；stat 轮询在瞬时 scp 下不一定发生，不断言。
  assert.equal(sshCalls.filter(line => line.includes('mkdir -p')).length, 1)
  const mvCalls = sshCalls.filter(line => line.includes('mv '))
  assert.equal(mvCalls.length, 2)
  assert.ok(mvCalls[0].includes('.frostfin-part-') && mvCalls[0].includes('/tmp/frostfin-uploads/a.txt'))

  // 不存在的文件 → 400。
  const bad = mockResponse()
  await webServer.routes.get('/plugins/frostfin/upload-remote').handler(
    mockPost({ sessionId: handle.agent.id, paths: ['/no/such/file'] }), bad)
  assert.equal(bad.status, 400)

  // 未知 jobId → 404。
  const ghost = mockResponse()
  await webServer.routes.get('/plugins/frostfin/upload-progress').handler(
    mockGet('/plugins/frostfin/upload-progress?jobId=no-such'), ghost)
  assert.equal(ghost.status, 404)
})

test('e2e：上传进度可观测——慢 scp 期间 stat 轮询折算出中间进度', { skip: !hasTmux }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frostfin-upload-slow-'))
  const log = join(dir, 'calls.log')
  const big = join(dir, 'big.bin'); writeFileSync(big, Buffer.alloc(1_048_576, 7))
  // 假 ssh：stat 查询回报"已有一半"，其余记录参数成功退出。
  const ssh = fakeSsh(`#!/bin/sh\necho "$0 $@" >> ${log}\ncase "$*" in\n  *"stat -c"*) echo 524288 ;;\nesac\nexit 0\n`)
  // 假 scp：睡 3 秒再成功——给 2 秒一拍 的 stat 轮询留出窗口。
  const scp = fakeSsh(`#!/bin/sh\necho "$0 $@" >> ${log}\nsleep 3\nexit 0\n`)
  const sshConfigDir = mkdtempSync(join(tmpdir(), 'frostfin-sshcfg-'))
  const sshConfigFile = join(sshConfigDir, 'config')
  writeFileSync(sshConfigFile, 'Host spike-local\n  HostName spike.local.example.com\n')
  const { ctx, webServer } = await bootPlugin({ withWebServer: true, sshConfigFile, sshCommand: ssh, scpCommand: scp })
  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: process.cwd(), agentPreset: 'frostfin', frostfinHost: 'spike-local' },
  })
  t.after(async () => {
    await handle.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  })

  const res = mockResponse()
  await webServer.routes.get('/plugins/frostfin/upload-remote').handler(
    mockPost({ sessionId: handle.agent.id, paths: [big] }), res)
  assert.equal(res.status, 200)

  const snapshots = []
  let snap
  for (let i = 0; i < 80; i++) {
    const probe = mockResponse()
    await webServer.routes.get('/plugins/frostfin/upload-progress').handler(
      mockGet(`/plugins/frostfin/upload-progress?jobId=${res.body.jobId}`), probe)
    snap = probe.body
    snapshots.push(snap)
    if (snap.state !== 'running') break
    await new Promise(r => setTimeout(r, 100))
  }
  assert.equal(snap.state, 'done')
  assert.deepEqual(snap.files, ['/tmp/frostfin-uploads/big.bin'])
  assert.equal(snap.bytesDone, 1_048_576)
  // 中间快照：stat 回报的 50% 被折算成字节进度（bytesTotal = 文件真实大小）。
  const mid = snapshots.find(s => s.state === 'running' && s.bytesDone === 524288)
  assert.ok(mid, `应抓到 stat 折算的中间进度：${JSON.stringify(snapshots.map(s => [s.state, s.bytesDone]))}`)
  assert.equal(mid.bytesTotal, 1_048_576)
  assert.equal(mid.currentFile, 'big.bin')
  assert.equal(mid.fileCount, 1)
  // scp 失败后清半截：本用例全成功，rm 不应出现。
  const calls = readFileSync(log, 'utf8').trim().split('\n')
  assert.ok(!calls.some(line => line.includes('rm -f')))
})

test('ls 端点：目录列举（目录字母序/文件新的在前）、~ 展开、越出 home 403、不存在 400', async (t) => {
  // 端点只允许主目录子树——把 HOME 指到临时目录（POSIX 上 os.homedir() 读 $HOME，请求时生效）。
  const prevHome = process.env.HOME
  const fakeHome = mkdtempSync(join(tmpdir(), 'frostfin-home-'))
  t.after(() => { process.env.HOME = prevHome })
  const { ctx, webServer } = await bootPlugin({ withWebServer: true })
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })
  mkdirSync(join(fakeHome, 'Downloads'))
  mkdirSync(join(fakeHome, 'proj'))
  writeFileSync(join(fakeHome, 'Downloads', 'old.txt'), 'old')
  writeFileSync(join(fakeHome, 'Downloads', 'new.txt'), 'newer')
  const past = new Date(Date.now() - 86_400_000)
  utimesSync(join(fakeHome, 'Downloads', 'old.txt'), past, past) // old.txt 的 mtime 拨回昨天
  process.env.HOME = fakeHome

  // 缺省 = 主目录：dirs 字母序，parent 为 null（不允许再往上）。
  const home = mockResponse()
  await webServer.routes.get('/plugins/frostfin/ls').handler(mockGet('/plugins/frostfin/ls'), home)
  assert.equal(home.status, 200)
  assert.equal(home.body.dir, fakeHome)
  assert.equal(home.body.parent, null)
  assert.deepEqual(home.body.dirs, ['Downloads', 'proj'])

  // ~ 展开进子目录：文件按 mtime 新的在前，带字节数。
  const dl = mockResponse()
  await webServer.routes.get('/plugins/frostfin/ls').handler(
    mockGet(`/plugins/frostfin/ls?dir=${encodeURIComponent('~/Downloads')}`), dl)
  assert.equal(dl.status, 200)
  assert.equal(dl.body.parent, fakeHome)
  assert.deepEqual(dl.body.files.map(f => f.name), ['new.txt', 'old.txt'])
  assert.equal(dl.body.files[0].size, 5)

  // 越出主目录 → 403；不存在 → 400。
  const outside = mockResponse()
  await webServer.routes.get('/plugins/frostfin/ls').handler(
    mockGet(`/plugins/frostfin/ls?dir=${encodeURIComponent('/etc')}`), outside)
  assert.equal(outside.status, 403)
  const missing = mockResponse()
  await webServer.routes.get('/plugins/frostfin/ls').handler(
    mockGet(`/plugins/frostfin/ls?dir=${encodeURIComponent('~/no-such-dir')}`), missing)
  assert.equal(missing.status, 400)
})

test('整插件：未知主机别名给清晰错误', async () => {
  const sshConfigDir = mkdtempSync(join(tmpdir(), 'frostfin-sshcfg-'))
  const sshConfigFile = join(sshConfigDir, 'config')
  writeFileSync(sshConfigFile, 'Host spike-local\n  HostName spike.local.example.com\n')
  const { ctx } = await bootPlugin({ sshConfigFile })
  await assert.rejects(
    ctx.agents.create({
      sessionId: `test-${crypto.randomUUID()}`,
      meta: { cwd: process.cwd(), agentPreset: 'frostfin', frostfinHost: 'spike-ghost' },
    }),
    /找不到主机 "spike-ghost"/,
  )
  await ctx.fiber.dispose().catch(() => {})
})
