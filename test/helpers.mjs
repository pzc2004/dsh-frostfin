// 集成测试共享件：本地 subprocess 接缝桩 + frostfin 装配台。
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionPreparation } from '@deepseek-ai/dsh-session'
import * as frostfin from '../lib/index.js'

export const FIXTURE = new URL('./fixtures/scripted-acp-child.mjs', import.meta.url).pathname

/** 测试用的最小 subprocess 接缝实现（无进程组树杀，scripted 子进程没有孙进程）。 */
export function localSpawn(spec) {
  const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let killTimer
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (exitCode, signal) => {
      if (killTimer !== undefined) clearTimeout(killTimer)
      resolve({ exitCode, signal })
    })
  })
  return {
    pid: child.pid ?? -1,
    stdin: child.stdin ?? undefined,
    stdout: child.stdout ?? undefined,
    stderr: undefined,
    collected: {},
    done,
    terminate() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), spec.graceMs)
      killTimer.unref()
    },
    waitForExit(signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve(false)
        const onAbort = () => resolve(false)
        signal?.addEventListener('abort', onAbort, { once: true })
        done.then(
          () => { signal?.removeEventListener('abort', onAbort); resolve(true) },
          () => { signal?.removeEventListener('abort', onAbort); resolve(true) },
        )
      })
    },
  }
}

/**
 * 装配真实 Cordis 服务 + frostfin 插件。
 * @param options.permission - frostfin 的 permission 配置（allow/reject/ask）。
 * @param options.approval - 可选的假 approval 服务；缺省即宿主无此服务。
 * @param options.persistenceSeed - 提供即注册一个假 sessionPersistence（prepare 返回带该种子的会话）。
 * @param options.withCommands - 为 true 时注册一个捕获注册的假 commands 服务并随返回值带出。
 * @param options.withWebServer - 为 true 时注册一个捕获路由的假 webServer 服务并随返回值带出。
 * @param options.advertiseKimiRoute - 默认 false（隔离既有测试）；true 时需提供 routeFakes。
 * @param options.routeFakes - { llm, agentDefaultModel } 假服务对（见 fakeRouteServices）。
 * @param options.command - 覆盖 kimi 命令（默认用 node 跑 fixture；传不存在路径可模拟"kimi 未就绪"）。
 * @param options.onSpawn - 每次 spawn 回调（计数用）。
 * @returns ctx、插件 fiber、每次测试独立的 stateFile 路径等。
 */
export async function bootPlugin({ permission = 'allow', approval, attachments, persistenceSeed, withCommands, withWebServer, advertiseKimiRoute = false, routeFakes, command, onSpawn } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.provide('subprocess', {
    spawn: (spec) => {
      onSpawn?.()
      return localSpawn(spec)
    },
  })
  if (approval !== undefined) ctx.provide('approval', approval)
  if (attachments !== undefined) ctx.provide('attachments', attachments)
  if (persistenceSeed !== undefined) ctx.provide('sessionPersistence', fakePersistence(ctx, persistenceSeed))
  if (routeFakes !== undefined) {
    ctx.provide('llm', routeFakes.llm)
    ctx.provide('agentDefaultModel', routeFakes.agentDefaultModel)
  }
  const commands = withCommands === true ? fakeCommands() : undefined
  if (commands !== undefined) ctx.provide('commands', commands)
  const webServer = withWebServer === true ? fakeWebServer() : undefined
  if (webServer !== undefined) ctx.provide('webServer', webServer)
  const stateFile = join(mkdtempSync(join(tmpdir(), 'frostfin-test-')), 'kimi-sessions.json')
  const fiber = await ctx.plugin(frostfin, {
    command: command ?? process.execPath,
    args: command === undefined ? [FIXTURE] : [],
    permission,
    disposeEofGraceMs: 2000,
    disposeGraceMs: 1000,
    stateFile,
    advertiseKimiRoute,
    // 测试环境：不挂影子 loop、不写真实 preset 目录、不做配置同步与预热。
    dispatchNative: false,
    installPreset: false,
    syncModels: false,
    primeCatalog: false,
  })
  return { ctx, fiber, stateFile, commands, webServer }
}

/** 假 llm / agentDefaultModel 服务对：捕获路由注册与默认模型读写。 */
export function fakeRouteServices() {
  const llm = {
    routes: new Set(),
    adapters: new Map(),
    registerAdapter(providers, adapter) {
      for (const provider of providers) {
        if (llm.routes.has(provider)) throw new Error(`DUPLICATE_ADAPTER: ${provider}`)
        llm.routes.add(provider)
        llm.adapters.set(provider, adapter)
      }
      let released = false
      const handle = () => {
        if (released) return
        released = true
        for (const provider of providers) {
          llm.routes.delete(provider)
          llm.adapters.delete(provider)
        }
      }
      handle.replace = () => {}
      return handle
    },
    listProviders() {
      return [...llm.routes].map(id => ({ id, name: id }))
    },
  }
  const agentDefaultModel = {
    current: { provider: 'deepseek-official', model: 'deepseek-chat' },
    saved: [],
    currentSelection() {
      return this.current
    },
    async saveSelection(next) {
      this.saved.push(next)
      this.current = { provider: next.provider, model: next.model }
    },
  }
  return { llm, agentDefaultModel }
}

/** 假 commands 服务：捕获注册表，测试直接驱动 handler。 */
export function fakeCommands() {
  const registered = new Map()
  return {
    registered,
    register(definition) {
      registered.set(definition.name, definition)
      return () => { registered.delete(definition.name) }
    },
  }
}

/** 假 webServer 服务：按 path 捕获路由 handler，测试直接调用。 */
export function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  }
}

/** 假 HTTP 响应：捕获状态码与 JSON body。 */
export function mockResponse() {
  return {
    status: 0,
    body: undefined,
    writeHead(status) { this.status = status; return this },
    end(chunk) { if (chunk !== undefined) this.body = JSON.parse(chunk) },
  }
}

/** 假 GET 请求（只有 url 字段被读取）。 */
export function mockGet(url) {
  return { url }
}

/** 假 POST 请求：readBody 的 async 迭代协议。 */
export function mockPost(payload) {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload))
    },
  }
}

/** 直接调用一个已注册的斜杠命令 handler。 */
export function invokeCommand(commands, name, agent, rawInput = '') {
  const definition = commands.registered.get(name)
  if (definition === undefined) throw new Error(`命令 "${name}" 未注册`)
  return definition.handler({ commandId: `cmd-${name}`, agent, rawInput, signal: new AbortController().signal })
}

/** 装配并直接创建一个存活 agent。 */
export async function bootFrostfin(permission, approval) {
  const { ctx, stateFile } = await bootPlugin({ permission, approval })
  const handle = await ctx.agents.create({
    sessionId: `test-${crypto.randomUUID()}`,
    meta: { cwd: process.cwd() },
  })
  return { ctx, handle, agent: handle.agent, session: handle.agent.session, stateFile }
}

/** 让一个 agent 跑完一轮并返回落盘事件列表。 */
export async function runOneTurn(agent, message) {
  agent.followup(message)
  await agent.whenIdle()
  return agent.session.events
}

/** 造一个假的 sessionPersistence：prepare 返回带给定种子的未发布会话。 */
export function fakePersistence(ctx, seed) {
  return {
    async prepare(id) {
      return SessionPreparation.create(ctx.sessions.prepare(id, { seed }))
    },
    async list() {
      return []
    },
  }
}
