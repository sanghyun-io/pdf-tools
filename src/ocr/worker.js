// OCR off the main thread, so the page stays responsive while lines are read.
// Messages in: { models: [ArrayBuffer...] } once, then { id, gray, w, h }.
// Messages out: { ready }, { id, progress: [done, total] }, { id, result } or { id, error }.
import { loadModel } from './model.js'
import { recognizePage } from './page.js'

let models = null
self.onmessage = ({ data }) => {
  if (data.models) {
    try {
      models = data.models.map((b) => loadModel(new Uint8Array(b)))
      self.postMessage({ ready: true })
    } catch (e) {
      self.postMessage({ error: e.message })
    }
    return
  }
  const { id, gray, w, h } = data
  try {
    const result = recognizePage(models, new Uint8Array(gray), w, h, (done, total) => self.postMessage({ id, progress: [done, total] }))
    self.postMessage({ id, result })
  } catch (e) {
    self.postMessage({ id, error: e.message })
  }
}
