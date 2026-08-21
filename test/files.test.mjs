// 工作区文件面测试：files（单层列举）与 complete（递归模糊搜索）端点。
// 离线：本地会话 cwd 指向临时工作区，posix-local 的 execProbe 本地跑 sh，不碰 ssh/tmux。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootPlugin, mockGet, mockResponse } from './helpers.mjs'

/** 造一棵带重型目录与点文件的临时工作区。 */
function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'frostfin-ws-'))
  mkdirSync(join(ws, 'src', 'util'), { recursive: true })
  mkdirSync(join(ws, 'docs'))
  mkdirSync(join(ws, 'node_modules', 'dep'), { recursive: true })
  mkdirSync(join(ws, '.git'))
  writeFileSync(join(ws, 'src', 'index.ts'), 'export {}\n')
  writeFileSync(join(ws, 'src', 'util', 'helper.ts'), 'export {}\n')
  writeFileSync(join(ws, 'docs', 'guide.md'), '# guide\n')
  writeFileSync(join(ws, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(ws, '.git', 'config'), '[core]\n')
  writeFileSync(join(ws, 'package.json'), '{}\n')
  writeFileSync(join(ws, 'README.md'), 'readme\n')
  writeFileSync(join(ws, '.hidden'), 'x\n')
  return ws
}

async function bootWorkspaceSession(t, ws) {
  const { ctx, webServer } = await bootPlugin({ withWebServer: true })
  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: ws, agentPreset: 'frostfin' },
  })
  t.after(async () => {
    await handle.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  })
  return { webServer, sessionId: handle.agent.id }
}

async function get(webServer, path, url) {
  const res = mockResponse()
  await webServer.routes.get(path).handler(mockGet(url), res)
  return res
}

test('files 端点：单层列举（目录/文件/尺寸/点文件）、父级与越界 403、不存在 404', async (t) => {
  const ws = makeWorkspace()
  const { webServer, sessionId } = await bootWorkspaceSession(t, ws)

  // 根：目录与文件都含点文件；尺寸是真实字节数。
  const root = await get(webServer, '/plugins/frostfin/files', `/plugins/frostfin/files?sessionId=${sessionId}`)
  assert.equal(root.status, 200)
  assert.equal(root.body.dir, '.')
  assert.equal(root.body.parent, null)
  assert.deepEqual([...root.body.dirs].sort(), ['.git', 'docs', 'node_modules', 'src'])
  assert.deepEqual([...root.body.files.map(f => f.name)].sort(), ['.hidden', 'README.md', 'package.json'])
  assert.ok(root.body.files.find(f => f.name === 'README.md').size > 0)
  // 排序约定：目录按名称（localeCompare 非降序）。
  const sorted = [...root.body.dirs].sort((a, b) => a.localeCompare(b))
  assert.deepEqual(root.body.dirs, sorted)

  // 子目录：parent 指回根。
  const src = await get(webServer, '/plugins/frostfin/files', `/plugins/frostfin/files?sessionId=${sessionId}&dir=src`)
  assert.equal(src.status, 200)
  assert.deepEqual(src.body.dirs, ['util'])
  assert.deepEqual(src.body.files.map(f => f.name), ['index.ts'])
  assert.equal(src.body.parent, '.')

  // 越界（绝对路径 / .. 逃逸 / 规范化后逃逸）一律 403。
  for (const bad of ['/etc', '..', 'src/../../outside']) {
    const res = await get(webServer, '/plugins/frostfin/files', `/plugins/frostfin/files?sessionId=${sessionId}&dir=${encodeURIComponent(bad)}`)
    assert.equal(res.status, 403, `dir=${bad} 应 403`)
  }
  // 不存在 → 404；非 frostfin 会话 → 404。
  const missing = await get(webServer, '/plugins/frostfin/files', `/plugins/frostfin/files?sessionId=${sessionId}&dir=no-such-dir`)
  assert.equal(missing.status, 404)
  const ghost = await get(webServer, '/plugins/frostfin/files', '/plugins/frostfin/files?sessionId=no-such-session')
  assert.equal(ghost.status, 404)
})

test('complete 端点：递归模糊搜索（剪枝重型目录、大小写不敏感、排名与上限）、空 q 回空', async (t) => {
  const ws = makeWorkspace()
  const { webServer, sessionId } = await bootWorkspaceSession(t, ws)

  // 'index'：命中 src/index.ts；node_modules 被剪枝（dep/index.js 不得出现），.git 同理。
  const index = await get(webServer, '/plugins/frostfin/complete', `/plugins/frostfin/complete?sessionId=${sessionId}&q=index`)
  assert.equal(index.status, 200)
  assert.deepEqual(index.body.entries.map(e => e.path), ['src/index.ts'])
  assert.deepEqual(index.body.entries[0], { path: 'src/index.ts', dir: 'src', name: 'index.ts' })

  // 大小写不敏感 + 嵌套路径。
  const guide = await get(webServer, '/plugins/frostfin/complete', `/plugins/frostfin/complete?sessionId=${sessionId}&q=GUIDE`)
  assert.deepEqual(guide.body.entries.map(e => e.path), ['docs/guide.md'])

  // 't'：多个命中时 basename 命中的排在路径命中前；总量封顶 20。
  const multi = await get(webServer, '/plugins/frostfin/complete', `/plugins/frostfin/complete?sessionId=${sessionId}&q=t`)
  assert.ok(multi.body.entries.length > 0 && multi.body.entries.length <= 20)
  assert.ok(!multi.body.entries.some(e => e.path.includes('node_modules') || e.path.includes('.git')))

  // 空 q → 空；非 frostfin 会话 → 404。
  const empty = await get(webServer, '/plugins/frostfin/complete', `/plugins/frostfin/complete?sessionId=${sessionId}&q=`)
  assert.deepEqual(empty.body.entries, [])
  const ghost = await get(webServer, '/plugins/frostfin/complete', '/plugins/frostfin/complete?sessionId=no-such&q=x')
  assert.equal(ghost.status, 404)
})
