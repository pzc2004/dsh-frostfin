// 工作区归组：open 端点把接入的本地会话挂进 cwd 对应的工作区（侧边栏分组）。
// 两条分支都覆盖：新建分支创建后归组；幂等分支 reused 时补挂（愈合归组修复前接入的会话）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootPlugin, mockPost, mockResponse } from './helpers.mjs'

/** 假 workspaceRegistry：记录 create/attachSession 调用序列。 */
function fakeWorkspaceRegistry() {
  const calls = []
  return {
    calls,
    async create(path) {
      calls.push(['create', path])
      return { async attachSession(id) { calls.push(['attachSession', id]) } }
    },
  }
}

test('open 端点：接入会话归入 cwd 对应的工作区（新建 + 幂等愈合两条分支）', async (t) => {
  const DEAD = 'session_scripted-dead'
  // 假 KIMI_CODE_HOME：session_index.jsonl 一条目（scanKimiSessions 的磁盘面，cwd 走 workDir）。
  const prevHome = process.env.KIMI_CODE_HOME
  const kimiHome = mkdtempSync(join(tmpdir(), 'frostfin-kimihome-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'frostfin-proj-'))
  writeFileSync(join(kimiHome, 'session_index.jsonl'),
    `${JSON.stringify({ sessionId: DEAD, sessionDir: join(kimiHome, 'sessions', DEAD), workDir: wsDir })}\n`)
  process.env.KIMI_CODE_HOME = kimiHome
  t.after(() => { process.env.KIMI_CODE_HOME = prevHome })
  const registry = fakeWorkspaceRegistry()
  const { ctx, webServer } = await bootPlugin({ withWebServer: true, workspaceRegistry: registry })
  t.after(async () => { await ctx.fiber.dispose().catch(() => {}) })

  // 新建分支：POST open → 创建 + attach（夹具回放 DEAD 两轮）+ 归组。
  const fresh = mockResponse()
  await webServer.routes.get('/plugins/frostfin/open').handler(mockPost({ kimiSessionId: DEAD }), fresh)
  assert.equal(fresh.status, 200)
  assert.equal(fresh.body.reused, false)
  const dshId = fresh.body.sessionId
  assert.deepEqual(registry.calls, [['create', wsDir], ['attachSession', dshId]])

  // 幂等分支：再 POST 一次 → reused，归组再调一次（DSH 的 attach 幂等——愈合归组修复前接入的会话）。
  const again = mockResponse()
  await webServer.routes.get('/plugins/frostfin/open').handler(mockPost({ kimiSessionId: DEAD }), again)
  assert.equal(again.status, 200)
  assert.equal(again.body.reused, true)
  assert.equal(again.body.sessionId, dshId)
  assert.deepEqual(registry.calls, [
    ['create', wsDir], ['attachSession', dshId],
    ['create', wsDir], ['attachSession', dshId],
  ])
})
