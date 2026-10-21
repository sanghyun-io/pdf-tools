// Page thumbnails only: pdf.js draws each page once into a small image. Reading and writing PDFs stays in pdf.js (ours).
// legacy build: polyfills Promise.try & co., which iOS before 18.2 and older WebViews lack (+57 KB)
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

const SIZE = 240 // longest side in px: twice the card's 120px box, sharp on HiDPI screens

// draws pages unrotated (the card applies rotation) and hands each over as a JPEG data URL
export async function renderThumbs(bytes, password, onThumb) {
  // slice: pdf.js takes ownership of the buffer. isEvalSupported: the CSP forbids eval
  const task = getDocument({ data: bytes.slice(), password, isEvalSupported: false })
  try {
    const doc = await task.promise
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const { width, height } = page.getViewport({ scale: 1, rotation: 0 })
      const viewport = page.getViewport({ scale: SIZE / Math.max(width, height), rotation: 0 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      await page.render({ canvas, viewport }).promise
      onThumb(i - 1, canvas.toDataURL('image/jpeg', 0.8))
      page.cleanup()
    }
  } catch (e) {
    console.warn('thumbnail', e) // cards keep their placeholder
  } finally {
    await task.destroy()
  }
}
