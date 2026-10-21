// Drawing pages as pictures (thumbnails, the page editor, "save as images") is the one job left to pdf.js.
// Reading and writing PDFs stays in pdf.js (ours).
// legacy build: polyfills Promise.try & co., which iOS before 18.2 and older WebViews lack (+57 KB)
import { getDocument, GlobalWorkerOptions, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs'
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
    async draw(i, scale, rotation = null) {
      const page = await doc.getPage(i + 1)
      const turn = rotation ?? page.rotate
      const { width, height } = page.getViewport({ scale: 1, rotation: turn })
      const viewport = page.getViewport({ scale: scale(width, height), rotation: turn })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      await page.render({ canvas, viewport }).promise
      page.cleanup()
      return canvas
    },
    // whether the page already has text a reader can find (a scan has none)
    async hasText(i) {
      const { items } = await (await doc.getPage(i + 1)).getTextContent()
      return items.some((t) => t.str.trim())
    },
    close,
  }
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
