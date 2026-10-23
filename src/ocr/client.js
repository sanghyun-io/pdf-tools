// The app's side of OCR: gets the Korean and English data (fetched from the site, or built into the
// single file), starts the worker once, and reads page pictures with it.
import { displayMatrix } from '../pdf.js'

// recognizePage's lines (pixels of the straightened picture of the page drawn at `dpi`, turned `rot` as
// shown) as buildPdf's text layer, in the page's own space: per line the baseline start, its direction and
// the text size, and per word its offset along the baseline and the width it spans
export function textLayer(result, W, H, box, rot, dpi) {
  const k = 72 / dpi, m = displayMatrix(box, rot)
  const shownHeight = rot % 180 ? box[2] - box[0] : box[3] - box[1]
  const a = (result.angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
  const toPage = (x, y) => {
    const sx = cos * (x - W / 2) - sin * (y - H / 2) + W / 2, sy = sin * (x - W / 2) + cos * (y - H / 2) + H / 2 // undo the straightening
    const u = sx * k, v = shownHeight - sy * k // as shown, in points from the bottom-left
    return [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]
  }
  // each word but a line's last carries a space reaching to the next word, so readers join the line with spaces
  return result.lines.filter((line) => line.words.length).map(({ words }) => {
    const first = words[0], last = words.at(-1)
    const [x, y] = toPage(first.x0, first.y1), [ex, ey] = toPage(last.x1, last.y1), [tx, ty] = toPage(first.x0, first.y0)
    const length = Math.hypot(ex - x, ey - y) || 1, ux = (ex - x) / length, uy = (ey - y) / length
    const along = (px) => {
      const [px2, py2] = toPage(px, first.y1)
      return (px2 - x) * ux + (py2 - y) * uy
    }
    return {
      x, y, ux, uy, size: Math.hypot(tx - x, ty - y),
      words: words.map((wd, i) => {
        const next = words[i + 1]
        return { text: next ? `${wd.text} ` : wd.text, at: along(wd.x0), width: along(next ? next.x0 : wd.x1) - along(wd.x0) }
      }),
    }
  })
}

// Some servers send a .gz file as Content-Encoding: gzip and the browser has already unpacked it,
// so only data that still starts with the gzip signature is unpacked here.
async function gunzip(buffer) {
  const b = new Uint8Array(buffer, 0, 2)
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buffer
  return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
}

async function data() {
  if (import.meta.env.MODE === 'single') {
    // inlined as data: URLs; decoded by hand because the page's CSP doesn't let fetch() read data: URLs
    const urls = await Promise.all([import('../../public/ocr/kor.traineddata.gz?inline'), import('../../public/ocr/eng.traineddata.gz?inline')])
    return urls.map(({ default: url }) => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0)).buffer)
  }
  return Promise.all(['kor', 'eng'].map(async (lang) => {
    const res = await fetch(`${import.meta.env.BASE_URL}ocr/${lang}.traineddata.gz`)
    if (!res.ok) throw new Error(`글자 인식 데이터를 받지 못했습니다 (${res.status})`)
    return res.arrayBuffer()
  }))
}

async function newWorker() {
  // the single file is opened from disk, where only a classic worker from a blob starts
  const { default: OcrWorker } = import.meta.env.MODE === 'single'
    ? await import('./worker.js?worker&inline')
    : await import('./worker.js?worker')
  return new OcrWorker()
}

let started = null
function start() {
  started ??= (async () => {
    const [worker, models] = await Promise.all([newWorker(), data().then((list) => Promise.all(list.map(gunzip)))])
    await new Promise((resolve, reject) => {
      worker.onmessage = ({ data: m }) => (m.ready ? resolve() : reject(new Error(m.error)))
      worker.onerror = (e) => reject(new Error(e.message || '글자 인식을 시작하지 못했습니다'))
      worker.postMessage({ models }, models)
    })
    return worker
  })()
  started.catch(() => { started = null }) // let a later try start over
  return started
}

// Starts fetching the data and loading it in the worker now, while the user is still choosing options, so the
// first page to read doesn't wait for the download (the data is otherwise asked for only when reading starts).
// A failure here is retried, and reported, when reading.
export function prepare() {
  start().catch(() => {})
}

let nextId = 0
// gray: Uint8Array w*h. onProgress(done, total) per line. Resolves to recognizePage's result.
export async function recognize(gray, w, h, onProgress = () => {}) {
  const worker = await start()
  const id = nextId++
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data: m }) => {
      if (m.id !== id) return
      if (m.progress) onProgress(...m.progress)
      else if (m.error) reject(new Error(m.error))
      else resolve(m.result)
    }
    worker.postMessage({ id, gray: gray.buffer, w, h }, [gray.buffer])
  })
}
