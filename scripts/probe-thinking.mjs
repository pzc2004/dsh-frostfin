// /frostfin-thinking 验证：新会话 → 切 low → 看回执与状态条。
import { chromium } from 'playwright-core'

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', err => console.log('[pageerror]', String(err).slice(0, 200)))

await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)
await page.getByText('新会话', { exact: false }).first().click()
await page.waitForTimeout(3000)

const box = page.locator('textarea').first()
await box.click()
await box.fill('/frostfin-thinking low')
await box.press('Enter')
await page.waitForTimeout(6000)
const text = await page.evaluate(() => document.body.innerText)
const line = text.split('\n').find(l => l.includes('thinking')) ?? '(未找到 thinking 行)'
console.log('回执/状态条相关行:', line)
console.log('含"已切换":', text.includes('已切换'))
await page.screenshot({ path: '/tmp/thinking-1.png' })

// 再查一次（无参）
await box.click()
await box.fill('/frostfin-thinking')
await box.press('Enter')
await page.waitForTimeout(4000)
const text2 = await page.evaluate(() => document.body.innerText)
const query = text2.split('\n').filter(l => l.includes('档位') || l.includes('已切换'))
console.log('查询结果行:', query)
await page.screenshot({ path: '/tmp/thinking-2.png' })
await browser.close()
