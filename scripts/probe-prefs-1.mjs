// 档位重放实机验证：切 yolo → 重启 DSH → 重开会话发消息 → 状态条应仍是 yolo。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
await box.fill('hi')
await box.press('Enter')
await page.waitForTimeout(15000)

await box.click()
await box.fill('/yolo')
await box.press('Enter')
await page.waitForTimeout(5000)
let text = await page.evaluate(() => document.body.innerText)
console.log('切换后状态条含 yolo:', text.includes('yolo'))

// 档位文件应已写入
const prefs = JSON.parse(readFileSync(join(homedir(), '.frostfin', 'kimi-session-prefs.json'), 'utf8'))
console.log('prefs 文件内容:', JSON.stringify(prefs))

// 记录当前会话标题，便于重启后点回来
const title = await page.evaluate(() => document.title)
console.log('会话标题:', title)
await browser.close()
console.log('--- 请重启后跑第二段 ---')
