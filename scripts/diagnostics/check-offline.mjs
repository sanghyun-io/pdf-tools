// The web build as an app: installable (Chrome's own check), every file kept on the PC once opened, then with the
// network cut it opens again, reads a PDF, draws it, saves it. Base URL: argv[2] (default the preview server).
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { readPdf } from '../../src/pdf.js'

const base = process.argv[2] ?? 'http://localhost:17021/'
const { chromium } = await import('playwright-core')
const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
const problems = [], result = {}
page.on('pageerror', (e) => problems.push(e.message))
page.on('requestfailed', (r) => problems.push(`failed ${r.url()} ${r.failure()?.errorText} sw=${!!r.serviceWorker?.()}`))
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(m.text().slice(0, 200)))
await page.goto(base)
await page.evaluate(() => navigator.serviceWorker.ready)
const cdp = await context.newCDPSession(page)
result.installable = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors
result.manifestErrors = (await cdp.send('Page.getAppManifest')).errors
// all files kept: the list in sw.js against the cache
const kept = await page.evaluate(async () => {
  const names = await caches.keys(), cache = await caches.open(names[0])
  return { caches: names, files: (await cache.keys()).length }
})
const listed = JSON.parse((await (await fetch(base + 'sw.js')).text()).match(/const FILES = (.*)/)[1]).length
result.kept = { ...kept, listed }

await context.setOffline(true)
await page.reload()
result.offlineTitle = await page.title()
result.controlled = await page.evaluate(() => !!navigator.serviceWorker.controller)
result.body = (await page.evaluate(() => document.body.innerText)).slice(0, 300)
result.url = page.url()
await page.screenshot({ path: 'tmp-screenshots/offline-reload.png' })
if (process.argv[3] === 'stop') { await browser.close(); console.log(JSON.stringify({ ...result, problems }, null, 1)); process.exit(0) }
await page.locator('input[type=file]').first().setInputFiles('test/fixtures/chrome.pdf')
await page.waitForFunction(() => document.querySelectorAll('.page img[src^="data:"]').length === 2, null, { timeout: 30000 })
result.thumbs = await page.locator('.page img').count()
result.ocrKept = await page.evaluate(async () => !!(await caches.match('./ocr/kor.traineddata.gz')))
await page.screenshot({ path: 'tmp-screenshots/offline-app.png' })
const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()])
result.savedPages = (await readPdf(new Uint8Array(readFileSync(await d.path())))).pages.length
await browser.close()
console.log(JSON.stringify({ ...result, problems }, null, 1))
