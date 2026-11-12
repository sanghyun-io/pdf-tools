// A new version on the server: fetched in the background while the app is open, it takes over the next time the
// app is opened, and the old copy is deleted. Changes dist/sw.js's version in place (rebuild afterwards).
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const base = 'http://localhost:17021/'
const { chromium } = await import('playwright-core')
const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext()
let page = await context.newPage()
const keys = () => page.evaluate(() => caches.keys())
await page.goto(base)
await page.evaluate(() => navigator.serviceWorker.ready)
const result = { first: await keys() }
const sw = readFileSync('dist/sw.js', 'utf8')
writeFileSync('dist/sw.js', sw.replace(/pdf-tools-[0-9a-f]+/, 'pdf-tools-next'))
await page.reload() // the browser looks for a new sw.js on each open
await page.evaluate(() => new Promise((done) => {
  const check = async () => ((await navigator.serviceWorker.getRegistration())?.waiting ? done() : setTimeout(check, 200))
  check()
}))
result.whileOpen = await keys() // both: the open page keeps its files
await page.close()
page = await context.newPage()
await page.goto(base)
await page.waitForFunction(async () => (await caches.keys()).length === 1)
result.reopened = await keys()
await browser.close()
console.log(JSON.stringify(result))
