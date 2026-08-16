// M7 验证：新建 frostfin 会话 → 让 kimi 发起 AskUserQuestion → 截图模态框 → 点选 → 截图结果。
import { chromium } from 'playwright-core'

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', err => console.log('[pageerror]', String(err).slice(0, 200)))

const shot = (name) => page.screenshot({ path: `/tmp/m7-${name}.png` })

await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)

// 新建会话
await page.getByText('新会话', { exact: false }).first().click()
await page.waitForTimeout(3000)
await shot('1-new-session')
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400))
console.log('新会话后页面文本:\n', bodyText)

// 输入提示词，让 kimi 调 AskUserQuestion
const box = page.locator('textarea').first()
await box.click()
await box.fill('请调用 AskUserQuestion 工具问我一个问题：今晚吃什么？给我三个选项。不要自己回答，等我选。')
await box.press('Enter')
console.log('提示词已发送，等待 kimi 提问…')

// 等模态框出现（kimi 思考 + 工具调用，给 120 秒）
try {
  await page.getByText('Kimi 在等你作答').waitFor({ timeout: 120000 })
  console.log('模态框已出现')
} catch {
  console.log('模态框 120 秒未出现，页面文本：\n', (await page.evaluate(() => document.body.innerText)).slice(0, 800))
  await shot('2-timeout')
  await browser.close()
  process.exit(1)
}
await page.waitForTimeout(600)
await shot('2-modal')

// 点第一个选项（非 Skip）
const buttons = page.locator('div[style*="position: fixed"] button')
const count = await buttons.count()
console.log(`选项按钮数：${count}`)
const labels = []
for (let i = 0; i < count; i++) labels.push(await buttons.nth(i).innerText())
console.log('选项：', labels)
await buttons.nth(0).click()
console.log(`已点选：${labels[0]}`)

// 等模态框消失 + kimi 继续
await page.waitForTimeout(2000)
await shot('3-answered')
await page.waitForTimeout(12000)
await shot('4-continued')
console.log('最终页面片段:\n', (await page.evaluate(() => document.body.innerText)).slice(-500))
await browser.close()
