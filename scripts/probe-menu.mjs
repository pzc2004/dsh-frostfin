import { chromium } from 'playwright-core'
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage()
await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)
await page.getByText('新会话', { exact: false }).first().click()
await page.waitForTimeout(2500)
await page.locator('button[aria-label="命令"]').click()
await page.waitForTimeout(800)
const items = await page.evaluate(() =>
  [...document.querySelectorAll('[role="option"], [role="menuitem"]')].map(el => (el.innerText ?? '').split('\n')[0]))
console.log('plan 相关:', items.filter(i => /plan/i.test(i)))
await browser.close()
