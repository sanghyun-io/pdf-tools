// Drawing pages as pictures (thumbnails, the page editor, "save as images") is the one job left to pdf.js.
// Reading and writing PDFs stays in pdf.js (ours).
// legacy build: polyfills Promise.try & co., which iOS before 18.2 and older WebViews lack (+57 KB)
import { getDocument, GlobalWorkerOptions, PDFWorker, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

// The single-file build is opened from disk (file://), where a page can start only a classic worker from a blob:
// pdf.js's own module worker (and its import() fallback) fail there. Vite rebuilds the worker as a classic script.
// Imported dynamically so the web build drops it. Each document gets its own, as in the web build:
// pdf.js shares one PDFWorker per port and tears it down when any document using it closes.
let newWorker = null
if (import.meta.env.MODE.startsWith('single')) {
  const { default: InlineWorker } = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline')
  newWorker = () => new InlineWorker()
} else {
  GlobalWorkerOptions.workerSrc = workerUrl
}

// A document kept open to draw pages from: { count, draw(index, scale, rotation) -> canvas, close() }.
// scale(width, height) gets the page size in points; rotation: absolute degrees, or null for the page's own.
export async function openPages(bytes, password) {
  const port = newWorker?.()
  const worker = port && new PDFWorker({ port })
  // slice: pdf.js takes ownership of the buffer. isEvalSupported: the CSP forbids eval
  const task = getDocument({ data: bytes.slice(), password, isEvalSupported: false, worker })
  const close = async () => {
    await task.destroy()
    worker?.destroy() // pdf.js leaves a worker it was given running
    port?.terminate()
  }
  let doc
  try {
    doc = await task.promise
  } catch (e) {
    await close()
    throw e
  }
  return {
    count: doc.numPages,
    // canvas.black: still pure black after a second try (a lost page, or one that really is black)
    async draw(i, scale, rotation = null) {
      const page = await doc.getPage(i + 1)
      const turn = rotation ?? page.rotate
      const { width, height } = page.getViewport({ scale: 1, rotation: turn })
      const viewport = page.getViewport({ scale: scale(width, height), rotation: turn })
      let canvas
      for (let tries = 0; tries < 2; tries++) {
        if (canvas) canvas.width = 0 // hand the lost one's memory back
        canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        await page.render({ canvas, viewport }).promise
        canvas.black = allBlack(canvas)
        if (!canvas.black) break
      }
      page.cleanup()
      return canvas
    },
    // whether the page already has text a reader can find (a scan has none)
    async hasText(i) {
      const { items } = await (await doc.getPage(i + 1)).getTextContent()
      return items.some((t) => t.str.trim())
    },
    // The page's text as pdf.js's selectable text layer (see .textLayer in index.css), for marking text.
    // container: an empty element over a picture of the page as shown turned by `rotation`; it is sized by
    // its --total-scale-factor (px per point), so it follows the picture's size. scale: px per point to
    // measure text at. false when the page has no text.
    async textLayer(i, rotation, container, scale) {
      const page = await doc.getPage(i + 1)
      const textContentSource = await page.getTextContent()
      if (!textContentSource.items.some((t) => t.str.trim())) return false
      await new TextLayer({ textContentSource, container, viewport: page.getViewport({ scale, rotation }) }).render()
      return true
    },
    close,
  }
}

// pdf.js paints the page white before anything else, on a canvas without transparency, so a page that comes
// out pure black everywhere was most likely lost by the browser: a user once got a redacted page saved all
// black, and the same steps came out fine every time after. Read in strips: a real page shows a non-black
// pixel in the first one, so only a black page costs a full read.
function allBlack(canvas) {
  const ctx = canvas.getContext('2d')
  for (let y = 0; y < canvas.height; y += 64) {
    const px = ctx.getImageData(0, y, canvas.width, Math.min(64, canvas.height - y)).data
    for (let k = 0; k < px.length; k += 4) if (px[k] | px[k + 1] | px[k + 2]) return false
  }
  return true
}

// Draws pages one at a time and hands each canvas to onPage(index, canvas). pages: 0-based (default all).
export async function renderPages(bytes, { password, pages, scale, rotation = null }, onPage) {
  const doc = await openPages(bytes, password)
  try {
    for (const i of pages ?? Array.from({ length: doc.count }, (_, k) => k)) await onPage(i, await doc.draw(i, scale, rotation))
  } finally {
    await doc.close()
  }
}

const THUMB = 240 // longest side in px: twice the card's 120px box, sharp on HiDPI screens

// thumbnails unrotated (the card applies rotation) as JPEG data URLs
export async function renderThumbs(bytes, password, onThumb) {
  try {
    await renderPages(bytes, { password, rotation: 0, scale: (w, h) => THUMB / Math.max(w, h) },
      (i, canvas) => onThumb(i, canvas.toDataURL('image/jpeg', 0.8)))
  } catch (e) {
    console.warn('thumbnail', e) // cards keep their placeholder
  }
}
