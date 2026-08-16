import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dirname, join } from 'node:path'
import { startAcpProcess } from './acp-process.js'
import { registerSlashCommands } from './commands.js'
import { FrostfinAgentFactory } from './factory.js'
import { KimiSessionMap, KimiSessionPrefs, expandStateFile } from './kimi-sessions.js'
import { KimiModelCatalog, registerKimiRoute } from './kimi-route.js'
import { installPreset } from './preset-install.js'
import { registerPanelRoutes } from './panel.js'
import { QuestionRegistry } from './question.js'
import { mountNativeShadow } from './shadow-native.js'
import { cleanKimiConfig, syncKimiConfig } from './config-sync.js'

export const name = 'frostfin'

// 本插件需要触碰的服务；未注入的服务一律用 ctx.get() 读取（postmortem 0001）。
export const inject = ['agents', 'sessions', 'subprocess']

export const Config = z.object({
  command: z.string().description('kimi CLI 命令').default('kimi'),
  args: z.array(String).description('启动参数').default(['acp']),
  permission: z.union(['allow', 'reject', 'ask'])
    .description('ACP 审批自动应答策略：allow/reject 直接自动应答；ask 桥接 DSH 审批 UI（approval 服务缺失或不可用时 fail-closed 回落为拒绝）')
    .default('allow'),
  disposeEofGraceMs: z.natural().description('stdin EOF 后等待协作退出的毫秒数').default(6000),
  disposeGraceMs: z.natural().description('SIGTERM 后升级 SIGKILL 的毫秒数').default(3000),
  stateFile: z.string()
    .description('DSH↔kimi 会话绑定映射的存储文件（~ 开头展开为 home 目录）')
    .default('~/.frostfin/kimi-sessions.json'),
  advertiseKimiRoute: z.boolean()
    .description('向 DSH 模型层注册 kimi-code 名义路由并把默认模型指向它：消除"添加 API Key"弹窗与输入框封锁（frostfin 会话由 kimi 驱动，不需要 DSH 的模型凭据）')
    .default(true),
  dispatchNative: z.boolean()
    .description('挂载影子里的原生 loop 并按 preset 分发：「月芒霜鳍鲸」会话由 kimi 驱动，其他 preset 由原生 loop 驱动')
    .default(true),
  installPreset: z.boolean()
    .description('把「月芒霜鳍鲸」preset 安装到 DSH 用户根目录（$DSH_HOME/.agent-presets/frostfin）')
    .default(true),
  syncModels: z.boolean()
    .description('把 DSH 已配置的模型供应商同步进 kimi 的 config.toml（让 kimi 直接跑 DSH 的模型；API key 会明文写入 kimi 配置文件）')
    .default(true),
  primeCatalog: z.boolean()
    .description('启动时预热一次 kimi 握手，让模型选择器立即显示真实模型列表（关闭则等首个会话握手时刷新）')
    .default(true),
})

export interface Config {
  command: string
  args: string[]
  permission: 'allow' | 'reject' | 'ask'
  disposeEofGraceMs: number
  disposeGraceMs: number
  stateFile: string
  advertiseKimiRoute: boolean
  dispatchNative: boolean
  installPreset: boolean
  syncModels: boolean
  primeCatalog: boolean
}

/**
 * 注册 FrostfinAgentFactory，占住 DSH 的 loop 插槽（`ctx.agents.setFactory`）。
 * 全部注册都走 Cordis effect：先挂"卸载时停掉所有存活 agent"，
 * 再注册工厂——顺序照抄 agent-loop 的构造函数。
 * M3：再注册 /frostfin-attach 斜杠命令（commands 服务缺失的宿主跳过）。
 */
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('frostfin')
  const catalog = new KimiModelCatalog(join(dirname(expandStateFile(config.stateFile)), 'model-catalog.json'))
  if (config.advertiseKimiRoute) {
    // 名义路由 + 真实模型目录：喂饱 Web UI 的两道模型层门禁（详见 kimi-route.ts）。
    ctx.effect(() => registerKimiRoute(ctx, logger, catalog), 'frostfin.kimiRoute()')
  }
  if (config.installPreset) {
    // 「月芒霜鳍鲸」preset 落到用户根目录，模式下拉里出现这个选项。
    ctx.effect(() => installPreset(logger), 'frostfin.installPreset()')
  }
  const kimiMap = new KimiSessionMap(expandStateFile(config.stateFile))
  // kimi 会话的运行档位（模式/thinking）：kimi 侧不持久化，我们记着，重连后重放。
  const kimiPrefs = new KimiSessionPrefs(join(dirname(expandStateFile(config.stateFile)), 'kimi-session-prefs.json'))
  // M7 待答问题注册表：桥挂起 → 浏览器作答；卸载时全部按"用户跳过"取消。
  const questions = new QuestionRegistry()
  ctx.effect(() => () => questions.cancelAll(), 'frostfin.questions()')
  const factory = new FrostfinAgentFactory(ctx, config, kimiMap, catalog, kimiPrefs)
  factory.setQuestionRegistry(questions)
  // 面板端点（webServer 服务可能晚于我们激活——用 inject 等它就绪；headless 无此服务则跳过）。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerPanelRoutes(webCtx, logger, kimiMap, questions), 'frostfin.panelRoutes()')
  })
  // 启动时预热模型目录：一次性 kimi 握手读 configOptions（失败静默——
  // 磁盘缓存/兜底先顶着，首个会话握手会补上）。
  if (config.primeCatalog) {
    ctx.effect(() => {
      void (async () => {
      try {
        const proc = await startAcpProcess({
          command: config.command,
          args: config.args,
          cwd: process.cwd(),
          permission: 'allow',
          disposeEofGraceMs: config.disposeEofGraceMs,
          disposeGraceMs: config.disposeGraceMs,
          spawn: spec => ctx.subprocess.spawn(spec),
          onSessionUpdate: () => {},
        })
        if (proc.configOptions !== undefined) catalog.publish(proc.configOptions)
        // 预热产生的一次性会话不留痕：先删会话再拆进程（kimi 不支持 delete 时静默）。
        await proc.deleteSession()
        await proc.dispose()
      } catch {
        // 预热失败（未登录/未装 kimi）：忽略。
      }
      })()
      return () => {}
    }, 'frostfin.primeCatalog()')
  }
  if (config.syncModels) {
    // 模型配置同步：apply 时跑一次；之后每次真正起 kimi 进程前再跑（见 factory.startProcess）。
    // 写盘只在内容变化时发生。卸载时移除 kimi 配置里的托管块（可逆性纪律：
    // 文件系统副作用 Cordis 管不到，必须自己登记撤销）。
    const trigger = (): void => {
      void syncKimiConfig(ctx, logger).catch((error: unknown) => {
        logger.warn('frostfin: 模型配置同步失败：%s', error instanceof Error ? error.message : String(error))
      })
    }
    ctx.effect(() => {
      trigger()
      return () => { cleanKimiConfig(logger) }
    }, 'frostfin.syncModels()')
    factory.setSyncTrigger(trigger)
  }
  if (config.dispatchNative) {
    // 影子挂载原生 loop 并把捕获的工厂交给分发器（详见 shadow-native.ts）。
    ctx.effect(async () => {
      const shadow = await mountNativeShadow(ctx, logger)
      factory.setNativeFactory(shadow.factory)
      return () => shadow.dispose()
    }, 'frostfin.nativeShadow()')
  }
  ctx.effect(() => () => factory.disposeAll(), 'frostfin.disposeAll()')
  ctx.effect(() => ctx.agents.setFactory(factory), 'frostfin.setFactory()')

  // 斜杠命令（/frostfin-* 系列 + kimi 内建透传 + 模式快捷键）。
  registerSlashCommands(ctx, logger, kimiMap)
  logger.info('frostfin factory registered, command: %s %s', config.command, config.args.join(' '))
}
