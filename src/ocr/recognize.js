// One text line in, its characters out, the way Tesseract's LSTMRecognizer::RecognizeLine works:
// scale to the network height, run the network, try the inverted picture when the result is unsure,
// decode with the recoder beam.
import { scaleGray } from './scale.js'
import { forward, inputTensor, lineRandom } from './net.js'
import { beamDecode, decoderTables } from './decode.js'

const INVERT_BELOW = 0.7 // mean best-character probability under which the inverted picture is tried

// mean of the best non-null probability per frame, in 1/127 steps (LSTMRecognizer::OutputStats)
function outputMean(probs, frames, range, nullCode) {
  let sum = 0, count = 0
  for (let t = 0; t < frames; t++) {
    let best = 0
    for (let c = 1; c < range; c++) if (probs[t * range + c] > probs[t * range + best]) best = c
    if (best === nullCode) continue
    sum += Math.trunc(127 * probs[t * range + best])
    count++
  }
  return count ? sum / count / 127 : 0
}

// gray: Uint8Array w*h, 0 black .. 255 white. Returns { text, chars: [{ text, x0, x1, conf }] } with x in
// the given picture's pixels and conf 0-100.
export function recognizeLine(model, gray, w, h) {
  const scaled = scaleGray(gray, w, h, model.height / h)
  if (scaled.w < 3 || scaled.h !== model.height) return { text: '', chars: [] }
  const run = (pixels) => {
    const out = forward(model.net, inputTensor(pixels, scaled.w, scaled.h), lineRandom(model.sampleIteration))
    return { probs: out.data, frames: out.W, mean: outputMean(out.data, out.W, out.D, model.nullChar) }
  }
  let best = run(scaled.gray)
  if (best.mean < INVERT_BELOW) {
    const inverted = run(scaled.gray.map((v) => 255 - v))
    if (inverted.mean > best.mean) best = inverted
  }
  model.tables ??= decoderTables(model.codes)
  const { chars, bounds } = beamDecode(best.probs, best.frames, model.tables, model.nullChar)
  const k = (3 * h) / model.height // a frame is three pixels of the scaled picture (Maxpool)
  const out = chars.map((c, i) => ({
    text: model.chars[c.id] ?? '',
    x0: Math.floor(bounds[i] * k), x1: Math.ceil(bounds[i + 1] * k),
    conf: Math.max(0, Math.min(100, 100 + 5 * c.cert)),
  })).filter((c) => c.text)
  return { text: out.map((c) => c.text).join('').trim(), chars: out }
}
