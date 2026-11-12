// Hypothesis: after heavy work in the same tab (all pages saved as 300 dpi images), a redacted page burns
// black because the browser can't give the new canvas memory. Then: redact page 3, save only it, measure.
import { readFileSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdf } from '../../src/pdf.js'

const { chromium } = await import('playwright-core')
const [file, channel = 'msedge', rounds = '1'] = process.argv.slice(2)
copyFileSync(file, 'tmp-debug/repro-in.pdf')
const browser = await chromium.launch({ channel })
const page = await (await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } })).newPage()
const problems = []
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(m.text().slice(0, 160)))
await page.goto(pathToFileURL(resolve('dist/pdf-tools.html')).href)
await page.locator('input[type=file]').setInputFiles('tmp-debug/repro-in.pdf')
await page.waitForFunction(() => document.querySelectorAll('img[src^="data:image/jpeg"]').length >= 44, null, { timeout: 120000 })
await page.locator('summary', { hasText: '저장 옵션' }).click()
await page.locator('.option-rows label', { hasText: '이미지로 저장' }).locator('select').nth(1).selectOption('300')
const save = page.getByRole('button', { name: '저장', exact: true })
await page.getByLabel('저장 형식').selectOption('images')
for (let r = 0; r < +rounds; r++) {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), save.click()])
  await d.path()
  console.log('round', r + 1)
}
await page.getByLabel('저장 형식').selectOption('pdf')
const card = page.locator('.page').nth(2)
await card.dblclick()
await page.locator('dialog.editor .paper > img').waitFor()
await page.getByRole('button', { name: '가림 상자' }).click()
await page.getByRole('button', { name: '적용' }).click()
await card.click()
await page.getByLabel('저장할 쪽').selectOption('selected')
const [d] = await Promise.all([page.waitForEvent('download'), save.click()])
await d.saveAs('tmp-debug/repro-out.pdf')
await browser.close()
const doc = await readPdf(new Uint8Array(readFileSync('tmp-debug/repro-out.pdf')))
const im = doc.get(doc.get(doc.get(doc.pages[0].attrs.Resources).get('XObject')).get('Im0'))
console.log(JSON.stringify({ channel, rounds: +rounds, jpegBytes: im.data.length, black: im.data.length < 30000, problems: problems.slice(0, 5) }))
