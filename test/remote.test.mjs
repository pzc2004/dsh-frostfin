// 远程线单测+e2e：shim 命令构建、ssh argv、体检（假 ssh）、
// 以及 shim+tmux 全链路 e2e（假 ssh 本地执行 shim，pane 跑 scripted ACP 夹具，不经真 ssh/真 kimi）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildRemoteArgv, buildShimCommand, checkRemoteHost, remoteTargetOf, sanitizeSessionName } from '../lib/remote.js'
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

test('buildShimCommand：fifo 双向通道 + 就绪闸 + 后台 cat 收尸', () => {
  const shim = buildShimCommand('s1', 'kimi acp')
  assert.ok(shim.includes('tmux has-session -t "s1"'))
  assert.ok(shim.includes('/tmp/frostfin-s1.in'))
  assert.ok(shim.includes('/tmp/frostfin-s1.fifo'))
  assert.ok(shim.includes('pipe-pane'))
  // 输入 fifo 由 pane 侧 fd3 RDWR 持有 + cat 中继进 kimi 的管道 stdin（断线不死且大负载不卡）
  assert.ok(shim.includes('exec 3<>'))
  assert.ok(shim.includes('| exec kimi acp'))
  // 后台 cat 必须收尸（否则它继承 stdout，客户端 close 永不触发）
  assert.ok(shim.includes('CAT_PID'))
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
  await handle.dispose()
  const { execFileSync: exec } = await import('node:child_process')
  exec('tmux', ['has-session', '-t', tmuxName])
  exec('tmux', ['kill-session', '-t', tmuxName])
})

test('e2e：面板远程端点——remote-hosts / remote-sessions / open-remote 全链', { skip: !hasTmux }, async (t) => {
  const ssh = fakeSsh('#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"')
  const sshConfigDir = mkdtempSync(join(tmpdir(), 'frostfin-sshcfg-'))
  const sshConfigFile = join(sshConfigDir, 'config')
  writeFileSync(sshConfigFile, 'Host spike-local\n  HostName spike.local.example.com\n')
  const boot = await bootPlugin({ withWebServer: true, sshConfigFile, sshCommand: ssh })
  const { ctx, webServer, stateFile } = boot
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })

  // remote-hosts：列出 ssh 配置里的主机。
  const hostsRes = mockResponse()
  webServer.routes.get('/plugins/frostfin/remote-hosts').handler(mockGet('/plugins/frostfin/remote-hosts'), hostsRes)
  assert.deepEqual(hostsRes.body.hosts, [{ alias: 'spike-local' }])

  // remote-sessions：体检 + 探针列出远程 kimi 会话（夹具的 3 条）。
  const listRes = mockResponse()
  await webServer.routes.get('/plugins/frostfin/remote-sessions').handler(
    mockGet('/plugins/frostfin/remote-sessions?host=spike-local'), listRes)
  assert.equal(listRes.body.error, undefined)
  assert.equal(listRes.body.sessions.length, 3)
  assert.ok(listRes.body.sessions.every(item => typeof item.cwd === 'string'))

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
