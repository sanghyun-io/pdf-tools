// npm test. pdf.js is used only as an independent reader to check what we write.
// imageToPdf and compression need a browser canvas and are checked in the browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdf, buildPdf, pageInfo, moveItems, Ref, Str, PasswordError } from '../src/pdf.js'
import { md5 } from '../src/decrypt.js'
import { inAppBrowser } from '../src/inapp.js'

const fixture = (name) => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)))
const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0))

// what a real viewer sees: rotation and text of every page
async function view(bytes) {
  const task = getDocument({ data: bytes.slice(), verbosity: 0 })
  const doc = await task.promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const text = (await page.getTextContent()).items.map((t) => t.str).join(' ').replace(/\s+/g, ' ').trim()
    pages.push({ rotate: page.rotate, text })
  }
  await task.destroy()
  return pages
}

test('reads object streams (pdf-lib output) and plain xref files (Chrome output)', async () => {
  assert.equal((await readPdf(fixture('objstm.pdf'))).pages.length, 3)
  assert.equal((await readPdf(fixture('chrome.pdf'))).pages.length, 2)
})

test('merge, reorder and rotate across files', async () => {
  const a = await readPdf(fixture('objstm.pdf'))
  const c = await readPdf(fixture('chrome.pdf'))
  const { bytes } = await buildPdf([
    { doc: c, index: 1, rotate: 90 },
    { doc: a, index: 2, rotate: 0 },
    { doc: c, index: 0, rotate: 270 },
    { doc: a, index: 0, rotate: 180 },
  ])
  assert.deepEqual(await view(bytes), [
    { rotate: 90, text: 'chrome page 2' },
    { rotate: 0, text: 'a page 3' },
    { rotate: 270, text: 'chrome page 1 link to page 2' },
    { rotate: 180, text: 'a page 1' },
  ])
  // our own output must read back too
  assert.equal((await readPdf(bytes)).pages.length, 4)
})

test('later definitions win, inherited attributes, wrong stream length, string escapes', async () => {
  const pdf = latin1([
    '%PDF-1.4',
    '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj',
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 200]/Rotate 90>> endobj',
    '3 0 obj <</Type/Page/Parent 2 0 R/Contents 4 0 R>> endobj',
    '4 0 obj <</Length 999>>stream\nBT ET\nendstream endobj',
    '5 0 obj (a\\(b\\)c \\101 (nested)) endobj',
    'trailer <</Root 1 0 R>>',
    // incremental update: page 3 replaced, gets its own box and rotation
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]/Rotate -90/Note<48 69>/Odd#20Name 1>> endobj',
    'trailer <</Root 1 0 R/Prev 0>>',
  ].join('\n'))
  const doc = await readPdf(pdf)
  assert.deepEqual(pageInfo(doc, 0), { w: 300, h: 400, rotate: 270 })
  const page = doc.pages[0].dict
  assert.equal(new TextDecoder().decode(page.get('Note').bytes), 'Hi')
  assert.equal(page.get('Odd Name'), 1)
  const s5 = doc.get(new Ref(5))
  assert.ok(s5 instanceof Str)
  assert.equal(new TextDecoder().decode(s5.bytes), 'a(b)c A (nested)')
  // the rewritten file is valid for a real reader
  const { bytes } = await buildPdf([{ doc, index: 0, rotate: 90 }])
  assert.deepEqual((await view(bytes)).map((p) => p.rotate), [0])
})

// bookmarks as a viewer lists them: [title, page index]
async function outline(bytes) {
  const task = getDocument({ data: bytes.slice(), verbosity: 0 })
  const doc = await task.promise
  const items = await doc.getOutline()
  const out = []
  for (const item of items ?? []) out.push([item.title, await doc.getPageIndex(item.dest[0])])
  await task.destroy()
  return out
}

const all = (doc) => doc.pages.map((_, index) => ({ doc, index, rotate: 0 }))
const chrome = ['chrome page 1 link to page 2', 'chrome page 2']

test('md5 matches node:crypto', () => {
  for (const s of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(200)]) {
    assert.equal(Buffer.from(md5(latin1(s))).toString('hex'), createHash('md5').update(s).digest('hex'))
  }
})

test('opens files that need no password: RC4 40-bit, AES-128, AES-256 (R5)', async () => {
  for (const f of ['enc-rc4-40.pdf', 'enc-aes256r5.pdf']) {
    const { bytes } = await buildPdf(all(await readPdf(fixture(f))))
    assert.deepEqual((await view(bytes)).map((p) => p.text), chrome, f)
  }
  const { bytes } = await buildPdf(all(await readPdf(fixture('enc-aes128.pdf'))))
  assert.deepEqual(await outline(bytes), [['Chapter 1', 0], ['Chapter 2', 1]]) // decrypted strings
  assert.deepEqual((await view(bytes)).map((p) => p.text), ['Chapter 1', 'Chapter 2'])
})

test('open password: missing, wrong, right (RC4 128-bit, AES-256 R6)', async () => {
  const expected = { 'enc-rc4-128-pw.pdf': chrome, 'enc-aes256-pw.pdf': ['Chapter 1', 'Chapter 2'] }
  for (const [f, texts] of Object.entries(expected)) {
    await assert.rejects(readPdf(fixture(f)), (e) => e instanceof PasswordError && !e.wrong, f)
    await assert.rejects(readPdf(fixture(f), 'nope'), (e) => e instanceof PasswordError && e.wrong, f)
    const { bytes } = await buildPdf(all(await readPdf(fixture(f), '1234')))
    assert.deepEqual((await view(bytes)).map((p) => p.text), texts, f)
  }
})

test('bookmarks follow their pages and drop with them', async () => {
  const doc = await readPdf(fixture('bookmarks.pdf'))
  const swapped = await buildPdf([{ doc, index: 1, rotate: 0 }, { doc, index: 0, rotate: 0 }])
  assert.deepEqual(await outline(swapped.bytes), [['Chapter 1', 1], ['Chapter 2', 0]])
  const second = await buildPdf([{ doc, index: 1, rotate: 0 }])
  assert.deepEqual(await outline(second.bytes), [['Chapter 2', 0]])
})

test('hidden layers stay hidden', async () => {
  const { bytes } = await buildPdf(all(await readPdf(fixture('layer.pdf'))))
  const task = getDocument({ data: bytes.slice(), verbosity: 0 })
  const groups = [...(await (await task.promise).getOptionalContentConfig())]
  await task.destroy()
  assert.deepEqual(groups.map(([, g]) => [g.name, g.visible]), [['Draft watermark', false]])
})

test('form fields and NeedAppearances survive', async () => {
  const { bytes } = await buildPdf(all(await readPdf(fixture('form-noap.pdf'))))
  const task = getDocument({ data: bytes.slice(), verbosity: 0 })
  const doc = await task.promise
  const fields = await doc.getFieldObjects() // null when the file has no AcroForm at all
  const widgets = (await (await doc.getPage(1)).getAnnotations()).map((a) => [a.fieldName, a.fieldValue])
  await task.destroy()
  assert.notEqual(fields, null)
  assert.deepEqual(widgets, [['name', 'FILLED VALUE 12345'], ['agree', 'Yes']])
  assert.match(new TextDecoder().decode(bytes), /\/NeedAppearances true/)
})

test('moveItems keeps selection order and lands at the insertion point', () => {
  const list = [1, 2, 3, 4, 5, 6].map((id) => ({ id }))
  const ids = (l) => l.map((x) => x.id)
  assert.deepEqual(ids(moveItems(list, new Set([2, 3]), 5)), [1, 4, 5, 2, 3, 6])
  assert.deepEqual(ids(moveItems(list, new Set([5, 2]), 0)), [2, 5, 1, 3, 4, 6])
  assert.deepEqual(ids(moveItems(list, new Set([1]), 6)), [2, 3, 4, 5, 6, 1])
  assert.deepEqual(ids(moveItems(list, new Set([3, 4]), 3)), [1, 2, 3, 4, 5, 6])
})

test('inAppBrowser tells embedded browsers from real ones', () => {
  const href = 'https://example.github.io/pdf-tools/'
  const ua = {
    desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    androidChrome: 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36',
    samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/147.0.0.0 Mobile/15E148 Safari/604.1',
    androidKakao: 'Mozilla/5.0 (Linux; Android 14; SM-S921N Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 KAKAOTALK 25.8.0',
    iosKakao: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 25.8.0',
    iosNaver: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/605.1 NAVER(inapp; search; 2000; 12.0.0)',
    androidWebView: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36',
    iosWebView: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  }
  for (const k of ['desktopChrome', 'androidChrome', 'samsung', 'iosSafari', 'iosChrome']) assert.equal(inAppBrowser(ua[k], href), null, k)
  const kakaoOpen = `kakaotalk://web/openExternal?url=${encodeURIComponent(href)}`
  assert.deepEqual(inAppBrowser(ua.androidKakao, href), { app: '카카오톡', open: kakaoOpen })
  assert.deepEqual(inAppBrowser(ua.iosKakao, href), { app: '카카오톡', open: kakaoOpen })
  assert.deepEqual(inAppBrowser(ua.androidWebView, href), { app: null, open: 'intent://example.github.io/pdf-tools/#Intent;scheme=https;end' })
  assert.deepEqual(inAppBrowser(ua.iosNaver, href), { app: null, open: null })
  assert.deepEqual(inAppBrowser(ua.iosWebView, href), { app: null, open: null })
})
