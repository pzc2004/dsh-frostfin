// 自检 v3：逐行点会话，直到找到含对话内容的那个，再截图。
import { chromium } from 'playwright-core'

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', err => errors.push(String(err)))

await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(3000)

const rows = page.locator('[class*="sessionRow"]')
await rows.nth(1).click()
await page.waitForTimeout(4000)
const mainText = await page.evaluate(() => {
  const main = document.querySelector('main') ?? document.body
  return (main.innerText ?? '').slice(0, 600)
})
console.log('主区域内容:\n', mainText)
console.log('页面错误:', errors.length)
await page.screenshot({ path: '/tmp/dsh-ui-session.png' })
await browser.close()
