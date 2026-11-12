// A redaction box on every page, one save, then the size of each burned picture: a black one is tiny.
import { readFileSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdf } from '../../src/pdf.js'

const { chromium } = await import('playwright-core')
const [file, channel = 'msedge'] = process.argv.slice(2)
copyFileSync(file, 'tmp-debug/repro-in.pdf')
const browser = await chromium.launch({ channel })
const page = await (await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } })).newPage()
await page.goto(pathToFileURL(resolve('dist/pdf-tools.html')).href)
await page.locator('input[type=file]').setInputFiles('tmp-debug/repro-in.pdf')
const n = await page.waitForFunction(() => document.querySelectorAll('.page').length).then((h) => h.jsonValue())
for (let i = 0; i < n; i++) {
  await page.locator('.page').nth(i).dblclick()
  await page.locator('dialog.editor .paper > img').waitFor()
  if (process.env.COMBO) { // the user's order: an image, a redaction box, a text box
    await page.locator('dialog.editor input[type=file]').setInputFiles('tmp-debug/dark.png')
    await page.locator('dialog.editor .item').first().waitFor()
  }
  await page.getByRole('button', { name: '가림 상자' }).click()
  if (process.env.COMBO) {
    await page.locator('dialog.editor textarea').fill('테스트 글상자')
    await page.getByRole('button', { name: '글상자 넣기' }).click()
    await page.locator('dialog.editor .item').nth(2).waitFor()
  }
  await page.getByRole('button', { name: '적용' }).click()
}
const [d] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.getByRole('button', { name: '저장', exact: true }).click()])
await d.saveAs('tmp-debug/repro-all.pdf')
await browser.close()
const doc = await readPdf(new Uint8Array(readFileSync('tmp-debug/repro-all.pdf')))
const sizes = doc.pages.map((p) => doc.get(doc.get(doc.get(p.attrs.Resources).get('XObject')).get('Im0')).data.length)
console.log(JSON.stringify({ channel, pages: sizes.length, smallest: Math.min(...sizes), tiny: sizes.map((s, i) => [i + 1, s]).filter(([, s]) => s < 30000) }))
