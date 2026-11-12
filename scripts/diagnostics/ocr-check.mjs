// OCR in the real app: two scan pictures (skewed scan, two columns) and a PDF that has text, saved with
// "글자 인식" on. The saved PDF's text is compared with the truth; the text PDF's pages must stay as they were.
// Usage: node scripts/diagnostics/ocr-check.mjs [url] [channel]   (default: dist/pdf-tools.html from disk, offline)
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
// Character error rate with all whitespace removed, so line breaks and spacing don't count.
function distance(a, b) {
  a = [...a]
  b = [...b]
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}
const squeeze = (s) => s.replace(/\s+/g, '')
const cer = (got, want) => distance(squeeze(got), squeeze(want)) / [...squeeze(want)].length

const { chromium } = await import('playwright-core')
const url = process.argv[2] || pathToFileURL(resolve('dist/pdf-tools.html')).href
const channel = process.argv[3] || 'chrome'
const truth = JSON.parse(readFileSync('tmp-debug/ocr/pages/truth.json', 'utf8'))

const browser = await chromium.launch({ channel })
const context = await browser.newContext({ offline: url.startsWith('file:'), acceptDownloads: true, viewport: { width: 1280, height: 900 } })
const requests = []
context.on('request', (r) => requests.push(r.url().slice(0, 70)))
const page = await context.newPage()
const problems = []
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(`${m.type()}: ${m.text().slice(0, 200)}`))
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error('CSP blocked', e.violatedDirective, e.blockedURI)))

await page.goto(url)
await page.locator('input[type=file]').setInputFiles(['tmp-debug/ocr/pages/02.png', 'tmp-debug/ocr/pages/01.png', 'test/fixtures/chrome.pdf'])
await page.waitForFunction(() => document.querySelectorAll('img[src^="data:image/jpeg"]').length >= 4)
await page.locator('summary', { hasText: '저장 옵션' }).click()
await page.getByLabel('스캔된 쪽의 글자 인식 (OCR)').check()

const t0 = Date.now()
const progress = new Set()
const poll = setInterval(async () => {
  const t = await page.locator('main p.muted').filter({ hasText: '처리 중' }).first().innerText().catch(() => null)
  if (t) progress.add(t)
}, 300)
const downloaded = page.waitForEvent('download', { timeout: 300000 })
await page.getByRole('button', { name: '저장', exact: true }).click()
const failed = page.locator('main p.error').waitFor({ timeout: 300000 }).then(() => null)
const d = await Promise.race([downloaded, failed])
if (!d) {
  clearInterval(poll)
  console.log(JSON.stringify({ error: await page.locator('main p.error').innerText(), progress: [...progress], problems }, null, 1))
  await browser.close()
  process.exit(1)
}
const path = `tmp-debug/ocr-out-${channel}.pdf`
await d.saveAs(path)
clearInterval(poll)
const seconds = (Date.now() - t0) / 1000
const status = await page.locator('main p.ok, main p.error').first().innerText()

const pdf = await getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise
const texts = []
for (let i = 1; i <= pdf.numPages; i++) {
  const items = (await (await pdf.getPage(i)).getTextContent()).items
  texts.push(items.map((t) => t.str + (t.hasEOL ? '\n' : ' ')).join('').trim())
}
const want = (name) => truth.find((t) => t.name === name).lines.join('\n')
console.log(JSON.stringify({
  url: url.slice(0, 40), channel, seconds, status, progress: [...progress].slice(0, 4),
  scanSkewedCER: `${(cer(texts[0], want('02')) * 100).toFixed(2)}%`,
  scanTwoColumnsCER: `${(cer(texts[1], want('01')) * 100).toFixed(2)}%`,
  textPdfPages: texts.slice(2),
  firstLines: texts[0].split('\n').slice(0, 3),
  twoColumnLines: texts[1].split('\n').slice(0, 3),
  outside: requests.filter((u) => !/^(file|blob|data):/.test(u) && !u.startsWith(url.slice(0, 22))),
  fetched: requests.filter((u) => u.includes('/ocr/')),
  problems,
}, null, 1))
await browser.close()
