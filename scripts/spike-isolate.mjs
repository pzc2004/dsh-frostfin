// 微型 spike：弄清 cordis v4 的 isolate + provide 遮蔽语义（用玩具服务，不碰真注册表）。
import { Context } from '@deepseek-ai/cordis'

async function variant(name, fn) {
  const ctx = new Context()
  const real = { tag: 'real' }
  const shim = { tag: 'shim' }
  try {
    await fn(ctx, real, shim)
  } catch (error) {
    console.log(`${name}: 抛错 — ${error.message}`)
    await ctx.fiber.dispose().catch(() => {})
    return
  }
  await ctx.fiber.dispose().catch(() => {})
}

// 基线：根上 provide，根上读
await variant('基线（无遮蔽）', async (ctx, real) => {
  ctx.provide('svc', real)
  console.log(`基线: ctx.svc.tag =`, ctx.svc?.tag)
})

// A：isolate 后直接在影子上 provide
await variant('A: isolate + shadow.provide', async (ctx, real, shim) => {
  ctx.provide('svc', real)
  const shadow = ctx.isolate('svc')
  shadow.provide('svc', shim)
  console.log('A: ctx.svc =', ctx.svc?.tag, '| shadow.svc =', shadow.svc?.tag)
})

// B：isolate 后，在影子上挂一个提供 shim 的小插件
await variant('B: isolate + 影子内插件 provide', async (ctx, real, shim) => {
  ctx.provide('svc', real)
  const shadow = ctx.isolate('svc')
  await shadow.plugin({
    name: 'shim-provider',
    apply(shadowCtx) {
      shadowCtx.provide('svc', shim)
    },
  })
  console.log('B: ctx.svc =', ctx.svc?.tag, '| shadow.svc =', shadow.svc?.tag)
  // 再在影子里挂一个读取者插件，看插件视角读到什么
  await shadow.plugin({
    name: 'reader',
    inject: ['svc'],
    apply(readerCtx) {
      console.log(`B: reader 插件视角 svc.tag =`, readerCtx.svc?.tag)
    },
  })
})

// C：真身由"插件"提供（模拟 AgentRegistry 的形态），读者也是插件（模拟 AgentLoop）
await variant('C: 插件提供真身 + 影子里插件读者', async (ctx, real, shim) => {
  await ctx.plugin({
    name: 'real-provider',
    apply(rootCtx) { rootCtx.provide('svc', real) },
  })
  const shadow = ctx.isolate('svc')
  shadow.provide('svc', shim)
  await shadow.plugin({
    name: 'reader-c',
    inject: ['svc'],
    apply(readerCtx) {
      console.log('C: reader 插件视角 svc.tag =', readerCtx.svc?.tag)
    },
  })
  console.log('C: ctx.svc =', ctx.svc?.tag, '| shadow.svc =', shadow.svc?.tag)
})
