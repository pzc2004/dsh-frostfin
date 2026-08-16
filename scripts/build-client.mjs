/**
 * 构建浏览器半身（lib/client.js），遵循 DSH 的客户端 bundle 协议：
 * window.__ModuleLoader__.load({ id, factory }) 的 CJS 包；
 * 平台模块表（react 等）与运行时走 external，由外壳注入。
 */
import { build } from 'esbuild'

const PLUGIN_ID = 'dsh-frostfin'

/** 外壳共享的平台模块表（packages/client/web/src/platform.ts）。 */
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
]

/** 运行时存储引擎豁免（runtime 是 immediately 层行）。 */
const RUNTIME_EXTERNALS = ['@deepseek-ai/dsh-client-runtime/client']

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  // 自动 JSX 运行时（react/jsx-runtime 由外壳提供，在外部模块表里）——
  // 否则经典转换要求 React 在作用域内，运行即炸。
  jsx: 'automatic',
  outfile: 'lib/client.js',
  sourcemap: true,
  external: [...PLATFORM_EXTERNALS, ...RUNTIME_EXTERNALS],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

console.log('[dsh-frostfin] built lib/client.js (browser half)')
