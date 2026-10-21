// Reads a Tesseract 4/5 LSTM traineddata file: the network with its int8 weights, the character set and the
// recoder. Only the data comes from Tesseract; this reader follows the format of Tesseract 5.5.3
// (tessdatamanager.cpp, lstmrecognizer.cpp:133-177, network.cpp:191-320, weightmatrix.cpp:280-342).

const TYPES = ['Invalid', 'Input', 'Convolve', 'Maxpool', 'Parallel', 'Replicated', 'ParBidiLSTM', 'DepParUDLSTM',
  'Par2dLSTM', 'Series', 'Reconfig', 'RTLReversed', 'TTBReversed', 'XYTranspose', 'LSTM', 'SummLSTM', 'Logistic',
  'LinLogistic', 'LinTanh', 'Tanh', 'Relu', 'Linear', 'Softmax', 'SoftmaxNoCTC', 'LSTMSoftmax', 'LSTMBinarySoftmax',
  'TensorFlow']
const PLUMBING = new Set(['Parallel', 'Replicated', 'ParBidiLSTM', 'DepParUDLSTM', 'Par2dLSTM', 'Series', 'RTLReversed', 'TTBReversed', 'XYTranspose'])
const LAYER_LR = 64 // NF_LAYER_SPECIFIC_LR: plumbing stores per-layer learning rates
const ENTRY = { lstm: 17, unicharset: 21, recoder: 22 }

class Reader {
  constructor(bytes) {
    this.b = bytes
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.p = 0
  }
  take(n) {
    if (this.p + n > this.b.length) throw new Error('OCR 데이터 파일이 잘렸습니다')
    this.p += n
    return this.p - n
  }
  i8() { return this.v.getInt8(this.take(1)) }
  u8() { return this.v.getUint8(this.take(1)) }
  i32() { return this.v.getInt32(this.take(4), true) }
  u32() { return this.v.getUint32(this.take(4), true) }
  f32() { return this.v.getFloat32(this.take(4), true) }
  f64() { return this.v.getFloat64(this.take(8), true) }
  str() {
    const n = this.u32(), at = this.take(n)
    return new TextDecoder().decode(this.b.subarray(at, at + n))
  }
}

// int8 rows x (inputs + 1); the last column is the bias. scale[i] = stored value / 127 as float32.
function readWeights(r) {
  const mode = r.u8()
  if (!(mode & 1) || !(mode & 128)) throw new Error('이 OCR 데이터 형식은 지원하지 않습니다 (int8 fast 모델만)')
  const rows = r.i32(), cols = r.i32()
  r.i8() // the matrix's unused "empty" value
  const at = r.take(rows * cols)
  const w = new Int8Array(r.b.buffer.slice(r.b.byteOffset + at, r.b.byteOffset + at + rows * cols))
  const scale = new Float32Array(r.u32())
  for (let i = 0; i < scale.length; i++) scale[i] = Math.fround(r.f64() / 127)
  return { rows, cols, w, scale }
}

function readNetwork(r) {
  const t = r.i8()
  const type = t === 0 ? r.str() : TYPES[t]
  if (!TYPES.includes(type)) throw new Error(`OCR 데이터: 알 수 없는 층 ${type}`)
  const net = { type }
  const training = r.i8() === 1
  r.i8() // needs backprop
  net.flags = r.i32()
  net.ni = r.i32()
  net.no = r.i32()
  r.i32() // number of weights
  net.name = r.str()
  if (training) throw new Error('OCR 데이터: 학습용 모델은 지원하지 않습니다')
  if (type === 'Input') net.shape = { batch: r.i32(), height: r.i32(), width: r.i32(), depth: r.i32(), loss: r.i32() }
  else if (type === 'Convolve') [net.halfX, net.halfY] = [r.i32(), r.i32()]
  else if (type === 'Maxpool') [net.xScale, net.yScale] = [r.i32(), r.i32()]
  else if (PLUMBING.has(type)) {
    net.children = Array.from({ length: r.u32() }, () => readNetwork(r))
    if (net.flags & LAYER_LR) for (let n = r.u32(); n > 0; n--) r.f32()
  } else if (type === 'LSTM' || type === 'SummLSTM') {
    net.na = r.i32()
    net.gates = [readWeights(r), readWeights(r), readWeights(r), readWeights(r)] // CI, GI, GF1, GO
    net.ns = net.gates[0].rows
    if (net.na !== net.ni + net.ns) throw new Error('OCR 데이터: 2차원 LSTM은 지원하지 않습니다')
  } else if (['Tanh', 'Logistic', 'Relu', 'Linear', 'Softmax'].includes(type)) net.weights = readWeights(r)
  else throw new Error(`OCR 데이터: 지원하지 않는 층 ${type}`)
  return net
}

// lstm-unicharset text: a count line, then "<char> <props> ..." per id. Id 0 is the space, written "NULL";
// ids 1 and 2 ("Joined", "|Broken|0|1") are internal and never come out of the network.
function readCharset(bytes) {
  const lines = new TextDecoder().decode(bytes).split('\n')
  return Array.from({ length: parseInt(lines[0], 10) }, (_, i) => {
    const ch = lines[i + 1].split(/[ \t]/)[0]
    return ch === 'NULL' ? ' ' : i < 3 ? '' : ch
  })
}

// lstm-recoder: for each unichar id, its code sequence (Korean syllables become several codes)
function readRecoder(bytes) {
  const r = new Reader(bytes)
  return Array.from({ length: r.u32() }, () => {
    r.i8() // self_normalized
    return Array.from({ length: r.u32() }, () => r.i32())
  })
}

// bytes: the whole .traineddata file
export function loadModel(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = v.getInt32(0, true)
  if (count < 1 || count > 1000) throw new Error('OCR 데이터 파일이 아닙니다')
  const offsets = Array.from({ length: count }, (_, i) => Number(v.getBigInt64(4 + i * 8, true)))
  const entry = (k) => {
    if (offsets[k] < 0) return null
    const next = offsets.slice(k + 1).find((o) => o >= 0) ?? bytes.length
    return bytes.subarray(offsets[k], next)
  }
  if (!entry(ENTRY.lstm) || !entry(ENTRY.unicharset) || !entry(ENTRY.recoder)) throw new Error('LSTM OCR 데이터가 아닙니다')
  const r = new Reader(entry(ENTRY.lstm))
  const net = readNetwork(r)
  const spec = r.str()
  const flags = r.i32()
  r.i32() // training iteration
  const sampleIteration = r.i32()
  const nullChar = r.i32()
  if (!(flags & 1)) throw new Error('이 OCR 데이터 형식은 지원하지 않습니다 (int8 fast 모델만)')
  const input = net.children[0]
  return {
    net, spec, sampleIteration, nullChar,
    height: input.shape.height,
    chars: readCharset(entry(ENTRY.unicharset)),
    codes: readRecoder(entry(ENTRY.recoder)),
  }
}
