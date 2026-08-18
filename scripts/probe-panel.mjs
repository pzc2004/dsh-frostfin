import { chromium } from 'playwright-core'
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)
await page.getByText('新会话', { exact: false }).first().click()
await page.waitForTimeout(2500)
await page.getByText('月芒霜鳍鲸', { exact: true }).nth(1).click()
await page.waitForTimeout(2500)
const text = await page.evaluate(() => document.body.innerText)
const remote = text.includes('远程') ? text.slice(text.indexOf('月芒霜鳍鲸'), text.indexOf('月芒霜鳍鲸') + 300) : '(无远程区)'
const header = text.slice(text.indexOf('月芒霜鳍鲸'), text.indexOf('月芒霜鳍鲸') + 200)
console.log('头部片段:\n', header)
await page.screenshot({ path: '/tmp/panel-remote.png' })
await browser.close()
