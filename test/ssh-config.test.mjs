// ssh-config 解析单测：合成主机名（纪律：真实服务器信息不进仓库）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSshHosts, parseSshConfig } from '../lib/ssh-config.js'

const SAMPLE = `
# 顶部注释
Host *
  ServerAliveInterval 30

Host spike-alpha
  HostName alpha.internal.example.com
  User alice
  Port 2222
  IdentityFile ~/.ssh/id_spike_alpha

  # 块内注释：ignored-key 不读
  ForwardAgent yes

host spike-beta spike-gamma
  hostname beta.example.com
  user bob

Host spike-wild-*-card
  HostName should-not-appear.example.com

Host spike-dup
  HostName first-wins.example.com
  HostName overwritten.example.com
  Port not-a-number
`

test('parseSshConfig：Host 块解析、通配跳过、first-obtained-wins', () => {
  const entries = parseSshConfig(SAMPLE)
  const byAlias = new Map(entries.map(e => [e.alias, e]))

  // 通配块（Host * / spike-wild-*-card）都不出现。
  assert.equal(byAlias.has('*'), false)
  assert.equal(byAlias.has('spike-wild-*-card'), false)

  // 完整参数的一块。
  assert.deepEqual(byAlias.get('spike-alpha'), {
    alias: 'spike-alpha',
    hostName: 'alpha.internal.example.com',
    user: 'alice',
    port: 2222,
    identityFile: join(process.env.HOME ?? '', '.ssh/id_spike_alpha'),
  })

  // 一块多别名：每个别名共享后续参数。
  assert.equal(byAlias.get('spike-beta')?.hostName, 'beta.example.com')
  assert.equal(byAlias.get('spike-gamma')?.user, 'bob')

  // first-obtained-wins；非法 port 忽略。
  assert.equal(byAlias.get('spike-dup')?.hostName, 'first-wins.example.com')
  assert.equal(byAlias.get('spike-dup')?.port, undefined)
})

test('parseSshConfig：Key=value 分隔、引号包裹、行内注释', () => {
  const entries = parseSshConfig(`
Host=spike-eq
  HostName="quoted.example.com" # 尾注释
  User='carol'
  ProxyCommand ssh -W %h:%p jump#not-a-comment.example.com
`)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].hostName, 'quoted.example.com')
  assert.equal(entries[0].user, 'carol')
})

test('loadSshHosts：展开 Include（含 目录/* 通配），主文件缺失按空清单', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frostfin-ssh-'))
  mkdirSync(join(dir, 'conf.d'))
  writeFileSync(join(dir, 'conf.d', '10-extra'), `
Host spike-included
  HostName included.example.com
`)
  writeFileSync(join(dir, 'config'), `
Include conf.d/*
Host spike-main
  HostName main.example.com
`)
  const aliases = loadSshHosts(join(dir, 'config')).map(e => e.alias)
  assert.deepEqual(aliases, ['spike-included', 'spike-main'])

  assert.deepEqual(loadSshHosts(join(dir, 'nonexistent')), [])
})
