// 工具入参可见性验证（第二幕）：等 turn 跑完 → 点工具行看详情 → 截图 + 抓文本。
import { chromium } from 'playwright-core'

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', err => console.log('[pageerror]', String(err).slice(0, 200)))

await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)

// 侧栏点进刚创建的会话（第一个"用 Read 工具读 README.md"条目）
await page.getByText('用 Read 工具读 README.md', { exact: false }).first().click()
await page.waitForTimeout(2000)

// 等 turn 结束：'运行中' 消失，最多 150 秒
let text = ''
let done = false
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(5000)
  text = await page.evaluate(() => document.body.innerText)
  if (!text.includes('运行中') && !text.includes('Deep diving')) { done = true; break }
}
console.log('turn 结束:', done)
await page.screenshot({ path: '/tmp/tool-input-3.png', fullPage: true })

// 点工具行展开详情
const toolRow = page.getByText('Read', { exact: false }).last()
try {
  await toolRow.click({ timeout: 3000 })
  await page.waitForTimeout(1200)
} catch { console.log('工具行点击失败') }
await page.screenshot({ path: '/tmp/tool-input-4.png', fullPage: true })

text = await page.evaluate(() => document.body.innerText)
console.log('--- 页面文本（截 2600 字）---')
console.log(text.slice(0, 2600))
await browser.close()
