// Reproduce the black redacted page: load a PDF, put one redaction box on page N, save only that page,
// and report how dark the burned picture is (0 black .. 255 white).
// Usage: node scripts/diagnostics/repro-black.mjs <pdf> <page number>
import { readFileSync, copyFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdf, Stream, Name } from '../../src/pdf.js'

const { chromium } = await import('playwright-core')
const [file, pageNo] = process.argv.slice(2)
copyFileSync(file, 'tmp-debug/repro-in.pdf') // a plain name for setInputFiles
const browser = await chromium.launch({ channel: 'chrome' })
const page = await (await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } })).newPage()
const problems = []
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(m.text().slice(0, 200)))
await page.goto(pathToFileURL(resolve('dist/pdf-tools.html')).href)
// a stand-in for the user's picture: a 900x1600 dark app screenshot
const dark = await page.evaluate(() => {
  const c = Object.assign(document.createElement('canvas'), { width: 900, height: 1600 })
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#16161c'
  ctx.fillRect(0, 0, 900, 1600)
  ctx.fillStyle = '#c084fc'
  ctx.font = 'bold 60px sans-serif'
  ctx.fillText('ISTP · ST', 250, 500)
  for (let i = 0; i < 6; i++) ctx.fillRect(100, 700 + i * 80, 600 - i * 70, 20)
  return c.toDataURL('image/png')
})
writeFileSync('tmp-debug/dark.png', Buffer.from(dark.split(',')[1], 'base64'))
await page.locator('input[type=file]').setInputFiles('tmp-debug/repro-in.pdf')
await page.waitForFunction((n) => document.querySelectorAll('.page').length >= n, +pageNo)
const card = page.locator('.page').nth(+pageNo - 1)
await card.dblclick()
await page.locator('dialog.editor .paper > img').waitFor()
// the user's order: an image, a redaction box, a text box
await page.locator('dialog.editor input[type=file]').setInputFiles(process.env.IMG || 'tmp-debug/dark.png')
await page.locator('dialog.editor .item').first().waitFor()
await page.getByRole('button', { name: '가림 상자' }).click()
await page.locator('dialog.editor textarea').fill('테스트 글상자')
await page.getByRole('button', { name: '글상자 넣기' }).click()
const boxes = await page.locator('dialog.editor .item').evaluateAll((els) => els.map((e) => `${e.className} ${e.style.left} ${e.style.top} ${e.style.width} ${e.style.height}`))
console.log(boxes)
await page.screenshot({ path: 'tmp-screenshots/repro-editor.png' })
await page.getByRole('button', { name: '적용' }).click()
await card.click()
const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '선택만 저장' }).click()])
await d.saveAs('tmp-debug/repro-out.pdf')
await browser.close()

const doc = await readPdf(new Uint8Array(readFileSync('tmp-debug/repro-out.pdf')))
const res = doc.get(doc.pages[0].attrs.Resources)
const im = doc.get(doc.get(res.get('XObject')).get('Im0'))
console.log(JSON.stringify({ page: +pageNo, jpegBytes: im.data.length, filter: doc.get(im.dict.get('Filter')) instanceof Name && doc.get(im.dict.get('Filter')).v, problems }))
