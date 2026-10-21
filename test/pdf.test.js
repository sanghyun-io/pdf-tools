// npm test. pdf.js is used only as an independent reader to check what we write.
// imageToPdf and compression need a browser canvas and are checked in the browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { crc32 as zlibCrc32, gunzipSync } from 'node:zlib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdf, buildPdf, pageInfo, moveItems, Ref, Str, PasswordError } from '../src/pdf.js'
import { md5 } from '../src/crypt.js'
import { zip, crc32 } from '../src/zip.js'
import { loadModel } from '../src/ocr/model.js'
import { recognizeLine } from '../src/ocr/recognize.js'
import { recognizePage } from '../src/ocr/page.js'
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

// ---- decorations, checked as a viewer sees them: positions in the page as shown, 0..1 from the top-left ----

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

async function eachPage(bytes, fn) {
  const task = getDocument({ data: bytes.slice(), verbosity: 0 })
  const doc = await task.promise
  const out = []
  for (let i = 1; i <= doc.numPages; i++) out.push(await fn(await doc.getPage(i)))
  await task.destroy()
  return out
}

// image boxes as [left, top, right, bottom] fractions of the page shown turned by `rotation` (default: its own)
async function imageBoxes(page, rotation = page.rotate) {
  const { fnArray, argsArray } = await page.getOperatorList()
  const vp = page.getViewport({ scale: 1, rotation })
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack = [], boxes = []
  fnArray.forEach((fn, i) => {
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) ctm = mul(ctm, argsArray[i])
    else if (fn === OPS.paintImageXObject) {
      const m = mul(vp.transform, ctm)
      const [[x0, y0], [x1, y1]] = [apply(m, 0, 0), apply(m, 1, 1)]
      boxes.push([Math.min(x0, x1) / vp.width, Math.min(y0, y1) / vp.height, Math.max(x0, x1) / vp.width, Math.max(y0, y1) / vp.height])
    }
  })
  return boxes
}
const near = (a, b, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 0.01, `${msg}: ${a} vs ${b}`))

test('page numbers sit upright at the chosen spot of the page as shown, whatever its rotation', async () => {
  const doc = await readPdf(fixture('chrome.pdf'))
  const parts = [0, 90, 180, 270].map((rotate) => ({ doc, index: 0, rotate }))
  for (const pos of ['br', 'tc']) {
    const { bytes } = await buildPdf(parts, { numbers: { pos, format: 'of', start: 1 } })
    const found = await eachPage(bytes, async (page) => {
      const vp = page.getViewport({ scale: 1 })
      const item = (await page.getTextContent()).items.find((t) => /^\d+ \/ \d+$/.test(t.str))
      const m = mul(vp.transform, item.transform) // upright text: [size, 0, 0, -size, x, y]
      assert.ok(m[0] > 0 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 && m[3] < 0, `turned text ${m}`)
      return { str: item.str, x: m[4] / vp.width, right: (m[4] + item.width) / vp.width, y: m[5] / vp.height }
    })
    assert.deepEqual(found.map((f) => f.str), ['1 / 4', '2 / 4', '3 / 4', '4 / 4'])
    for (const f of found) {
      if (pos === 'br') assert.ok(f.right > 0.9 && f.right < 0.98 && f.y > 0.95, `${pos} ${JSON.stringify(f)}`)
      else assert.ok(Math.abs((f.x + f.right) / 2 - 0.5) < 0.01 && f.y < 0.06, `${pos} ${JSON.stringify(f)}`) // centered: widths are right
    }
  }
})

test('watermark centered on every page; a stamp stays where it was put and turns with its page', async () => {
  const doc = await readPdf(fixture('chrome.pdf'))
  const pixels = (w, h) => ({ width: w, height: h, rgb: new Uint8Array(w * h * 3), alpha: new Uint8Array(w * h).fill(128) })
  const stamp = { image: pixels(3, 1), x: 0.1, y: 0.2, w: 0.3, h: 0.1, rot: 0 }
  const watermark = { image: pixels(2, 1) }
  const { bytes } = await buildPdf([
    { doc, index: 0, rotate: 0, overlays: [stamp] },
    { doc, index: 1, rotate: 90, overlays: [stamp] }, // rotated after stamping
  ], { watermark })
  const pages = await eachPage(bytes, async (page) => ({ shown: await imageBoxes(page), unturned: await imageBoxes(page, 0) }))
  for (const { shown, unturned } of pages) {
    const [mark] = shown
    near([(mark[0] + mark[2]) / 2, (mark[1] + mark[3]) / 2], [0.5, 0.5], 'watermark center')
    near(unturned[1], [0.1, 0.2, 0.4, 0.3], 'stamp in the page as it was when stamped')
  }
  // each picture is stored once however many pages use it
  assert.equal((new TextDecoder().decode(bytes).match(/\/Subtype \/Image/g) ?? []).length, 4) // 2 pictures + 2 masks
})

test('encrypts with AES-256: pdf.js and our reader need the password; the owner password opens it too', async () => {
  const doc = await readPdf(fixture('bookmarks.pdf'))
  const { bytes } = await buildPdf(all(doc), { encrypt: { password: '비밀1234', ownerPassword: 'boss', print: false } })
  await assert.rejects(readPdf(bytes), (e) => e instanceof PasswordError && !e.wrong)
  await assert.rejects(readPdf(bytes, 'nope'), (e) => e instanceof PasswordError && e.wrong)
  assert.equal((await readPdf(bytes, '비밀1234')).pages.length, 2)
  for (const password of ['비밀1234', 'boss']) {
    const task = getDocument({ data: bytes.slice(), password, verbosity: 0 })
    const pdf = await task.promise
    const text = (await (await pdf.getPage(2)).getTextContent()).items.map((t) => t.str).join('')
    const perms = [...((await pdf.getPermissions()) ?? [])] // a Set in pdf.js 6
    const outline = (await pdf.getOutline()).map((o) => o.title) // strings decrypt too
    await task.destroy()
    assert.equal(text, 'Chapter 2', password)
    assert.deepEqual(outline, ['Chapter 1', 'Chapter 2'], password)
    assert.ok(!perms.includes(0x04) && perms.includes(0x10), `print off, copy on: ${perms}`)
  }
})

test('strip drops page and image XMP, app data and comment authors; document info is never copied', async () => {
  const pdf = latin1([
    '%PDF-1.4',
    '1 0 obj <</Type/Catalog/Pages 2 0 R/Metadata 6 0 R>> endobj',
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj',
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Metadata 4 0 R/PieceInfo<</App<</Private (app data)>>>>/Annots[5 0 R]>> endobj',
    '4 0 obj <</Type/Metadata/Subtype/XML/Length 14>>stream\n<x>PAGEXMP</x>\nendstream endobj',
    '5 0 obj <</Type/Annot/Subtype/Text/Rect[10 10 30 30]/T (Hong Gildong)/Contents (keep this note)>> endobj',
    '6 0 obj <</Type/Metadata/Subtype/XML/Length 7>>stream\nDOCXMP!\nendstream endobj',
    '7 0 obj <</Title (Secret title)/Author (Hong)>> endobj',
    'trailer <</Root 1 0 R/Info 7 0 R>>',
  ].join('\n'))
  const doc = await readPdf(pdf)
  const hex = (s) => Buffer.from(s).toString('hex')
  const kept = new TextDecoder('latin1').decode((await buildPdf(all(doc))).bytes)
  const stripped = new TextDecoder('latin1').decode((await buildPdf(all(doc), { strip: true })).bytes)
  for (const s of ['DOCXMP', hex('Secret title')]) assert.ok(!kept.includes(s), s)
  for (const s of ['PAGEXMP', '/PieceInfo', hex('Hong Gildong')]) assert.ok(kept.includes(s) && !stripped.includes(s), s)
  assert.ok(stripped.includes(hex('keep this note')))
})

test('flatten paints every field exactly over its old box and removes the form', async () => {
  const doc = await readPdf(fixture('form-noap.pdf'))
  const sortRects = (rs) => rs.map((r) => r.map((v) => Math.round(v * 10) / 10)).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const [before] = await eachPage((await buildPdf(all(doc))).bytes, async (page) =>
    sortRects((await page.getAnnotations()).filter((a) => a.subtype === 'Widget').map((a) => a.rect)))
  const { bytes } = await buildPdf(all(doc), { flatten: true })
  const task = getDocument({ data: bytes.slice(), verbosity: 0 })
  const pdf = await task.promise
  assert.equal(await pdf.getFieldObjects(), null)
  const page = await pdf.getPage(1)
  assert.equal((await page.getAnnotations()).filter((a) => a.subtype === 'Widget').length, 0)
  const { fnArray, argsArray } = await page.getOperatorList()
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack = [], painted = []
  fnArray.forEach((fn, i) => {
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) ctm = mul(ctm, argsArray[i])
    else if (fn === OPS.paintFormXObjectBegin) {
      const [matrix, [x0, y0, x1, y1]] = argsArray[i]
      const m = mul(ctm, matrix)
      const [[ax, ay], [bx, by]] = [apply(m, x0, y0), apply(m, x1, y1)]
      painted.push([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)])
    }
  })
  await task.destroy()
  assert.equal(before.length, 2)
  assert.deepEqual(sortRects(painted), before)
})

test('flatten redraws text fields from their values when NeedAppearances marks the stored pictures stale', async () => {
  const doc = await readPdf(fixture('form-noap.pdf')) // NeedAppearances, with a stale picture for the name field
  const asked = []
  const textImage = async (text) => {
    asked.push(text)
    return { width: 40, height: 10, rgb: new Uint8Array(1200), alpha: null }
  }
  const { bytes } = await buildPdf(all(doc), { flatten: true, textImage })
  assert.deepEqual(asked, ['FILLED VALUE 12345'])
  const [images] = await eachPage(bytes, (page) => imageBoxes(page))
  assert.equal(images.length, 1) // the name; the checkbox keeps its on/off picture
})

test('flatten draws a text field that has no appearance with the given text painter', async () => {
  const pdf = latin1([
    '%PDF-1.4',
    '1 0 obj <</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[4 0 R]>>>> endobj',
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj',
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Annots[4 0 R]>> endobj',
    '4 0 obj <</Type/Annot/Subtype/Widget/FT/Tx/T(name)/V<FEFFD64DAE38B3D9>/Rect[50 100 250 130]>> endobj',
    'trailer <</Root 1 0 R>>',
  ].join('\n'))
  const asked = []
  const textImage = async (text) => {
    asked.push(text)
    return { width: 30, height: 10, rgb: new Uint8Array(900), alpha: null }
  }
  const { bytes } = await buildPdf(all(await readPdf(pdf)), { flatten: true, textImage })
  assert.deepEqual(asked, ['홍길동'])
  const [[box]] = await eachPage(bytes, (page) => imageBoxes(page))
  const [l, t, r, b] = [50 / 300, 170 / 300, 250 / 300, 200 / 300] // the Rect, from the top-left
  assert.ok(box[0] >= l && box[1] >= t && box[2] <= r && box[3] <= b, `${box} inside ${[l, t, r, b]}`)
})

// text items with their position in the page as shown (fractions from the top-left)
const placedText = (page) => page.getTextContent().then(({ items }) => {
  const vp = page.getViewport({ scale: 1 })
  return items.filter((t) => t.str.trim()).map((t) => {
    const m = mul(vp.transform, t.transform)
    return { str: t.str, x: m[4] / vp.width, y: m[5] / vp.height, upright: m[0] > 0 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 }
  })
})

test('blank pages and cropped pages: the size shown and where page numbers land', async () => {
  const doc = await readPdf(fixture('chrome.pdf'))
  const { w, h } = pageInfo(doc, 0)
  const crop = [100, 100, w - 100, h - 200]
  const { bytes } = await buildPdf([
    { size: [300, 400], rotate: 0 },
    { doc, index: 0, rotate: 0, crop },
  ], { numbers: { pos: 'br', format: 'n', start: 1 } })
  const pages = await eachPage(bytes, async (page) => ({ view: page.view, text: await placedText(page) }))
  assert.deepEqual(pages[0].view, [0, 0, 300, 400])
  assert.deepEqual(pages[0].text.map((t) => t.str), ['1'])
  assert.deepEqual(pages[1].view, crop)
  const two = pages[1].text.find((t) => t.str === '2') // inside the cropped area, bottom-right
  assert.ok(two.x > 0.85 && two.x < 1 && two.y > 0.9 && two.y < 1, JSON.stringify(two))
})

test('two pages per sheet: in order, upright, bookmarks moved to the sheets', async () => {
  const a = await readPdf(fixture('bookmarks.pdf')), c = await readPdf(fixture('chrome.pdf'))
  const { bytes } = await buildPdf([...all(a), { doc: c, index: 0, rotate: 90 }], { impose: 2 })
  const task = getDocument({ data: bytes.slice(), verbosity: 0 })
  const pdf = await task.promise
  assert.equal(pdf.numPages, 2)
  const s1 = await pdf.getPage(1)
  assert.deepEqual(s1.view.map(Math.round), [0, 0, 842, 595]) // landscape A4 for portrait pages
  const t1 = await placedText(s1)
  const ch1 = t1.find((t) => t.str === 'Chapter 1'), ch2 = t1.find((t) => t.str === 'Chapter 2')
  assert.ok(ch1.x < 0.5 && ch2.x > 0.5 && ch1.upright && ch2.upright, JSON.stringify(t1))
  const s2 = await pdf.getPage(2) // a portrait page turned 90 degrees: wide, so on a portrait sheet
  assert.deepEqual(s2.view.map(Math.round), [0, 0, 595, 842])
  const outline = await Promise.all((await pdf.getOutline()).map(async (o) => [o.title, await pdf.getPageIndex(o.dest[0])]))
  await task.destroy()
  assert.deepEqual(outline, [['Chapter 1', 0], ['Chapter 2', 0]])
})

test('fit to A4 keeps each page in its own orientation; four per sheet stays readable', async () => {
  const c = await readPdf(fixture('chrome.pdf'))
  const fit = await buildPdf([{ doc: c, index: 0, rotate: 0 }, { doc: c, index: 1, rotate: 90 }], { impose: 1 })
  const views = await eachPage(fit.bytes, (page) => page.view.map(Math.round))
  assert.deepEqual(views, [[0, 0, 595, 842], [0, 0, 842, 595]])
  const four = await buildPdf([...all(c), ...all(c)], { impose: 4 })
  const [texts] = await eachPage(four.bytes, placedText)
  const p2 = texts.filter((t) => t.str === 'chrome page 2')
  assert.equal(p2.length, 2)
  assert.ok(p2[0].x > 0.5 && p2[0].y < 0.5 && p2[1].x > 0.5 && p2[1].y > 0.5, JSON.stringify(p2)) // top-right, bottom-right
})

test('lossless: a font that came in twice is kept once, plain streams get compressed', async () => {
  const c = await readPdf(fixture('chrome.pdf'))
  const twice = [...all(c), ...all(await readPdf(fixture('chrome.pdf')))] // two separate reads: separate objects
  const plain = (await buildPdf(twice)).bytes, lossless = (await buildPdf(twice, { level: 'lossless' })).bytes
  const fonts = (b) => (new TextDecoder('latin1').decode(b).match(/\/FontFile2/g) ?? []).length
  assert.equal(fonts(lossless) * 2, fonts(plain))
  assert.ok(lossless.length < plain.length * 0.75, `${lossless.length} vs ${plain.length}`)
  assert.deepEqual((await view(lossless)).map((p) => p.text), [...chrome, ...chrome])

  const raw = latin1([
    '%PDF-1.4',
    '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj',
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj',
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>> endobj',
    `4 0 obj <</Length 999>>stream\n${'0 0 m 100 100 l S\n'.repeat(20)}endstream endobj`,
    'trailer <</Root 1 0 R>>',
  ].join('\n'))
  const out = new TextDecoder('latin1').decode((await buildPdf(all(await readPdf(raw)), { level: 'lossless' })).bytes)
  assert.match(out, /\/FlateDecode/)
  assert.ok(!out.includes('100 100 l'))
})

test('OCR text layer: invisible words a reader finds where they were put, with a font it accepts', async () => {
  const doc = await readPdf(fixture('chrome.pdf'))
  const a = 0.035, cos = Math.cos(a), sin = Math.sin(a) // a scan line tilted 2 degrees
  const text = [
    { x: 100, y: 500, ux: 1, uy: 0, size: 20, words: [{ text: '지속가능경영 ', at: 0, width: 200 }, { text: 'ESG', at: 200, width: 60 }] },
    { x: 100, y: 300, ux: cos, uy: sin, size: 18, words: [{ text: '기울어진 ', at: 0, width: 150 }, { text: '줄', at: 150, width: 20 }] },
  ]
  const expect = [ // where each word should start, and its width (readers leave the trailing space out of it)
    { text: '지속가능경영', x: 100, y: 500, width: (200 * 6) / 7 }, { text: 'ESG', x: 300, y: 500, width: 60 },
    { text: '기울어진', x: 100, y: 300, width: (150 * 4) / 5 }, { text: '줄', x: 100 + 150 * cos, y: 300 + 150 * sin, width: 20 },
  ]
  const { bytes } = await buildPdf([{ doc, index: 0, rotate: 0, text }])
  const warnings = []
  const log = console.log
  console.log = (...a) => warnings.push(a.join(' '))
  try {
    const task = getDocument({ data: bytes.slice(), verbosity: 1 })
    const page = await (await task.promise).getPage(1)
    const items = (await page.getTextContent()).items.filter((t) => t.str.trim())
    await page.getOperatorList() // loads the font the way rendering does
    await task.destroy()
    const found = (s) => items.find((t) => t.str.trim() === s)
    for (const t of expect) {
      const item = found(t.text)
      assert.ok(item, `${t.text} in ${items.map((i) => i.str)}`)
      assert.ok(Math.abs(item.transform[4] - t.x) < 0.5 && Math.abs(item.transform[5] - t.y) < 0.5, `${t.text} at ${item.transform}`)
      assert.ok(Math.abs(item.width - t.width) < 1, `${t.text} width ${item.width} vs ${t.width}`)
    }
  } finally {
    console.log = log
  }
  assert.deepEqual(warnings.filter((w) => /font|cmap|glyf|loca|TrueType/i.test(w)), [])
})

// ---- OCR: the engine on line pictures drawn by Chrome with Malgun Gothic (tmp-debug/ocr/gen-lines.mjs) ----

const ocrModels = ['kor', 'eng'].map((lang) => loadModel(new Uint8Array(gunzipSync(readFileSync(new URL(`../public/ocr/${lang}.traineddata.gz`, import.meta.url))))))
function pgm(name) {
  const b = readFileSync(new URL(`fixtures/ocr/${name}`, import.meta.url))
  const [head, w, h] = b.subarray(0, 64).toString('latin1').match(/^P5\s+(\d+)\s+(\d+)\s+255\s/)
  return { gray: new Uint8Array(b.subarray(head.length)), w: +w, h: +h }
}

test('OCR reads a Korean line as Tesseract does', () => {
  const { gray, w, h } = pgm('plain.pgm')
  assert.equal(recognizeLine(ocrModels[0], gray, w, h).text, '사내 문서는 외부로 보내지 않습니다.')
})

test('OCR page reading fixes what the Korean model alone gets wrong: English words, thousands separators', () => {
  const read = (name) => {
    const { gray, w, h } = pgm(name)
    return recognizePage(ocrModels, gray, w, h).lines.map((l) => l.text).join('\n')
  }
  assert.equal(read('number.pgm'), '합계: 1,234,567원 / 부가세 10%') // Korean alone: "1234,567"
  assert.match(read('english.pgm'), /^Quantified ESG 보고서 초안 /) // Korean alone: "_0480408060 656"
})

test('zip: stored entries with UTF-8 names that a reader can list and check', () => {
  const files = [{ name: '보고서_01.pdf', bytes: latin1('%PDF-1.7 one') }, { name: 'b.txt', bytes: latin1('two') }]
  const z = zip(files)
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength)
  const end = z.length - 22
  assert.equal(v.getUint32(end, true), 0x06054b50)
  assert.equal(v.getUint16(end + 10, true), 2)
  let p = v.getUint32(end + 16, true)
  for (const f of files) {
    assert.equal(v.getUint32(p, true), 0x02014b50)
    assert.equal(v.getUint16(p + 8, true) & 0x0800, 0x0800) // UTF-8 flag
    const nameLen = v.getUint16(p + 28, true), local = v.getUint32(p + 42, true)
    assert.equal(new TextDecoder().decode(z.subarray(p + 46, p + 46 + nameLen)), f.name)
    assert.equal(v.getUint32(p + 16, true), crc32(f.bytes))
    assert.equal(crc32(f.bytes), zlibCrc32(f.bytes)) // our table against node's
    const dataAt = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    assert.deepEqual(z.subarray(dataAt, dataAt + f.bytes.length), f.bytes)
    p += 46 + nameLen
  }
})
