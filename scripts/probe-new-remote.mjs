// 新建远程会话实测：连目标主机（FROSTFIN_HOST）→ 新建（默认远程 home）→ 发消息 → 等回话。
import { chromium } from 'playwright-core'
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const HOST = process.env.FROSTFIN_HOST; if (!HOST) throw new Error('请先设置 FROSTFIN_HOST=<ssh 主机别名>')
const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)
await page.getByText('新会话', { exact: false }).first().click()
await page.waitForTimeout(2500)
await page.getByText('月芒霜鳍鲸', { exact: true }).nth(1).click()
await page.waitForTimeout(2000)
await page.getByText('远程', { exact: true }).click()
await page.waitForTimeout(1000)
// 连接目标主机
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('div')].filter(d => d.textContent?.startsWith(HOST) && d.querySelector('button'))
  rows.sort((a, b) => a.textContent.length - b.textContent.length)[0]?.querySelector('button')?.click()
})
await page.waitForTimeout(15000)
// 点「新建会话」
await page.getByText('新建会话', { exact: true }).click()
await page.waitForTimeout(6000)
// 应跳到新会话，发一条消息
const box = page.locator('textarea').first()
await box.click()
await box.fill('只回复两个字：远程')
await box.press('Enter')
await page.waitForTimeout(60000)
const text = await page.evaluate(() => document.body.innerText)
console.log('含远程回话:', text.includes('远程'))
const lines = text.split('\n').filter(l => /远程|失败|error/i.test(l)).slice(-6)
console.log('相关行:', lines)
await page.screenshot({ path: '/tmp/new-remote.png' })
await browser.close()
