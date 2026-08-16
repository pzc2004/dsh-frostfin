// /tasks 实测：让 kimi 起后台任务 → /tasks 列出来。
import { chromium } from 'playwright-core'

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)
await page.getByText('新会话', { exact: false }).first().click()
await page.waitForTimeout(3000)

const box = page.locator('textarea').first()
await box.click()
await box.fill('用 Bash 工具在后台跑一个 sleep 120（run_in_background），启动后回我一句。')
await box.press('Enter')
console.log('已要求起后台任务，等待 50 秒…')
await page.waitForTimeout(50000)

await box.click()
await box.fill('/tasks')
await box.press('Enter')
await page.waitForTimeout(12000)

const text = await page.evaluate(() => document.body.innerText)
const idx = text.indexOf('Background tasks')
console.log('tasks 回显:', idx === -1 ? '(未找到 Background tasks)' : text.slice(idx, idx + 300))
await page.screenshot({ path: '/tmp/tasks-1.png' })
await browser.close()
