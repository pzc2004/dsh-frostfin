import { chromium } from 'playwright-core'
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const SID = process.env.FROSTFIN_SID; const HOST = process.env.FROSTFIN_HOST; if (!SID || !HOST) throw new Error('请先设置 FROSTFIN_SID=<DSH 会话id> 与 FROSTFIN_HOST=<主机别名>')
const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)
await page.getByText('未分组', { exact: false }).first().click().catch(() => {})
await page.waitForTimeout(1500)
await page.getByText('只回复两个字：远程', { exact: false }).last().click()
await page.waitForTimeout(4000)
// 发一条消息触发 resume + 远程进程拉起
const box = page.locator('textarea').first()
await box.click()
await box.fill('在吗')
await box.press('Enter')
await page.waitForTimeout(30000)
const res = await page.evaluate(async (sid) => {
  const r = await fetch('/plugins/frostfin/status?sessionId=' + sid)
  return r.json()
}, SID)
console.log('status:', JSON.stringify(res))
const text = await page.evaluate(() => document.body.innerText)
const line = text.split('\n').find(l => l.includes(HOST)) ?? '(未见主机名)'
console.log('状态条行:', line)
await page.screenshot({ path: '/tmp/status-host.png' })
await browser.close()
