// 图片透传验证：新建会话 → 粘贴 logo.png 进输入区 → 问 kimi 图里有什么 → 截图与回话。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const b64 = readFileSync(fileURLToPath(new URL('../assets/logo.png', import.meta.url))).toString('base64')

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', err => console.log('[pageerror]', String(err).slice(0, 200)))

await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)
await page.getByText('新会话', { exact: false }).first().click()
await page.waitForTimeout(3000)

// 合成粘贴事件（InputBar 的图片入口就是粘贴）
await page.locator('textarea').first().click()
const pasted = await page.evaluate(async (data) => {
  const res = await fetch(`data:image/png;base64,${data}`)
  const blob = await res.blob()
  const file = new File([blob], 'logo.png', { type: 'image/png' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const ta = document.querySelector('textarea')
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
  return ta.dispatchEvent(ev)
}, b64)
console.log('粘贴事件已分发:', pasted)
await page.waitForTimeout(3000)
await page.screenshot({ path: '/tmp/img-1-attached.png' })
const afterPaste = await page.evaluate(() => document.body.innerText)
console.log('粘贴后页面片段:', afterPaste.slice(0, 200).replaceAll('\n', ' | '))

const box = page.locator('textarea').first()
await box.click()
await box.fill('这张图里画了什么？一句话回答。')
await page.waitForTimeout(400)
await box.press('Enter')
console.log('已发送，等待回话…')
await page.waitForTimeout(90000)
const tail = (await page.evaluate(() => document.body.innerText)).slice(-500)
console.log('最终页面片段:\n', tail)
await page.screenshot({ path: '/tmp/img-2-answer.png' })
await browser.close()
