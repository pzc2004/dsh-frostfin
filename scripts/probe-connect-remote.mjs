// 远程连接实测：面板点目标主机的「连接」，等待状态与错误信息。
// 用法：FROSTFIN_HOST=<主机别名> node scripts/probe-connect-remote.mjs
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

// 找到目标主机那一行的「连接」按钮并点击
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('div')].filter(d => d.textContent?.startsWith(HOST) && d.querySelector('button'))
  const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0]
  row?.querySelector('button')?.click()
})
console.log('已点击 ' + HOST + ' 的连接，等待…')

// 连接 = 体检 + 起探针，最长给 60 秒
await page.waitForTimeout(45000)
const text = await page.evaluate(() => document.body.innerText)
const idx = text.indexOf(HOST)
console.log(HOST + ' 区域:\n', text.slice(idx, idx + 400))
await page.screenshot({ path: '/tmp/remote-connect.png' })
await browser.close()
