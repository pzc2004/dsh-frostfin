// 第二段：重启后重开 hi 会话 → 发消息触发重连 → 状态条应仍是 yolo。
import { chromium } from 'playwright-core'

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(3000)

// 点开标题为 hi 的会话
await page.getByText('hi', { exact: true }).first().click()
await page.waitForTimeout(4000)

const box = page.locator('textarea').first()
await box.click()
await box.fill('在吗')
await box.press('Enter')
await page.waitForTimeout(20000)

const text = await page.evaluate(() => document.body.innerText)
const statusLine = text.split('\n').filter(l => /yolo|default|plan|auto/.test(l)).slice(-4)
console.log('状态条相关行:', statusLine)
console.log('含 yolo:', text.includes('yolo'))
await page.screenshot({ path: '/tmp/prefs-replay.png' })
await browser.close()
