// Kimi Coding 配额解析单测：key 提取（官方渠道识别）+ usages 响应解析。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { kimiCodingKeyOf, parseKimiUsage } from '../lib/panel.js'

test('kimiCodingKeyOf：只认官方域名渠道，relay 不匹配', () => {
  const toml = [
    '[providers.relay]',
    'type = "openai"',
    'base_url = "https://third-party-relay.example/v1"',
    'api_key = "RELAYKEY"',
    '',
    '[providers.kimi]',
    'type = "kimi"',
    'base_url = "https://api.kimi.com/coding"',
    'api_key = "OFFICIAL"',
  ].join('\n')
  assert.equal(kimiCodingKeyOf(toml), 'OFFICIAL')
  assert.equal(kimiCodingKeyOf('[providers.relay]\nbase_url = "https://third-party-relay.example/v1"\napi_key = "X"\n'), undefined)
})

test('parseKimiUsage：官方形态——used/limit 字符串 + window proto 枚举', () => {
  const windows = parseKimiUsage({
    limits: [
      { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { used: '38', limit: '100', resetTime: '2026-08-20T18:00:00Z' } },
      { window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' }, detail: { used: '520', limit: '1000' } },
      { window: { duration: 30, timeUnit: 'TIME_UNIT_DAY' }, detail: { used: '1000', limit: '5000' } },
    ],
    usage: { used: '500', limit: '1000' },
  })
  const byId = Object.fromEntries(windows.map(w => [w.id, w]))
  assert.equal(byId.fiveHour.percent, 38)
  assert.equal(byId.week.percent, 52)
  assert.equal(byId.month.percent, 20)
  assert.equal(byId.fiveHour.resetsAt, '2026-08-20T18:00:00Z')
})

test('parseKimiUsage：第三方形态——limit/remaining 数字 + 秒数窗口', () => {
  const windows = parseKimiUsage({
    limits: [
      { window: 18000, detail: { limit: 100, remaining: 62, resetTime: '2026-08-20T18:00:00Z' } },
      { window: 604800, detail: { limit: 1000, remaining: 480, resetTime: '2026-08-24T00:00:00Z' } },
      { window: 2592000, detail: { limit: 5000, remaining: 4000 } },
    ],
    usage: { limit: 2000, remaining: 1500 },
  })
  const byId = Object.fromEntries(windows.map(w => [w.id, w]))
  assert.equal(byId.fiveHour.percent, 38)
  assert.equal(byId.week.percent, 52)
  assert.equal(byId.month.percent, 20)
  assert.equal(byId.fiveHour.resetsAt, '2026-08-20T18:00:00Z')
})

test('parseKimiUsage：兜底形态——limits[0] 当 5 小时窗、usage 当周限额', () => {
  const windows = parseKimiUsage({
    limits: [{ detail: { limit: 100, remaining: 90 } }],
    usage: { limit: 100, remaining: 50 },
  })
  assert.deepEqual(windows.map(w => w.id).sort(), ['fiveHour', 'week'])
})

test('parseKimiUsage：坏输入零窗口（null / 非正 limit）', () => {
  assert.deepEqual(parseKimiUsage(null), [])
  assert.deepEqual(parseKimiUsage({ limits: [{ detail: { limit: 0, remaining: 0 } }] }), [])
})
