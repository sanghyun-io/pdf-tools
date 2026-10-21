// Runs a Tesseract LSTM network (int8 "fast" models) on a line picture, reproducing Tesseract 5.5.3's
// arithmetic step for step: float32 everywhere (Math.fround), int8 between layers, the same activation tables
// and the same random fill at picture edges. A tensor is { H, W, D, data } with t = y * W + x, x fastest.

const f32 = Math.fround
const icrF = (v) => (v >= 0 ? Math.trunc(f32(v + 0.5)) : -Math.trunc(f32(-v + 0.5))) // IntCastRounded(float)
const icrD = (v) => (v >= 0 ? Math.trunc(v + 0.5) : -Math.trunc(-v + 0.5))
const clip127 = (v) => (v < -127 ? -127 : v > 127 ? 127 : v)
const q8 = (x) => clip127(icrF(f32(x * 127))) // what a layer writes for the next one

// tanh and logistic: 4096-entry tables over [0, 16) with linear interpolation (functions.h, generate_lut.py)
const TANH = new Float32Array(4096), LOGISTIC = new Float32Array(4096)
for (let i = 0; i < 4096; i++) {
  TANH[i] = Math.tanh(i / 256)
  LOGISTIC[i] = 1 / (1 + Math.exp(-i / 256))
}
function lookup(table, x) {
  x = f32(x * 256)
  const i = Math.trunc(x)
  if (i >= 4095) return 1
  const a = table[i]
  return f32(a + f32(f32(table[i + 1] - a) * f32(x - i)))
}
const tanh = (x) => (x < 0 ? -lookup(TANH, -x) : lookup(TANH, x))
const logistic = (x) => (x < 0 ? f32(1 - lookup(LOGISTIC, -x)) : lookup(LOGISTIC, x))
const ACTIVATION = { Tanh: tanh, Logistic: logistic, Relu: (x) => (x > 0 ? x : 0), Linear: (x) => x }

// Tesseract's TRand, seeded per line: 64-bit LCG, a value is the top 31 bits (helpers.h:71-102)
export function lineRandom(sampleIteration) {
  const M = (1n << 64n) - 1n
  let seed = (BigInt(sampleIteration) * 0x10000001n) & M
  const next = () => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & M
    return Number(seed >> 33n)
  }
  next() // SetRandomSeed throws one away
  return () => icrD((127 * 2.0 * next()) / 2147483647 - 127) // an int8 in [-127, 127]
}

// v = (W u + bias * 127) * scale, int32 sums, one float32 multiply per row (intsimdmatrix.cpp:78-117)
function matVec({ w, scale, rows, cols }, u, at, out) {
  const ni = cols - 1
  for (let i = 0, r = 0; i < rows; i++, r += cols) {
    let total = 0
    for (let j = 0; j < ni; j++) total += w[r + j] * u[at + j]
    out[i] = f32((total + w[r + ni] * 127) * scale[i])
  }
}

function convolve(node, x, rand) {
  const { H, W, D } = x, hx = node.halfX, hy = node.halfY, k = (2 * hx + 1) * (2 * hy + 1)
  const out = new Int8Array(H * W * D * k)
  for (let y = 0, o = 0; y < H; y++) {
    for (let c = 0; c < W; c++) {
      for (let dx = -hx; dx <= hx; dx++) { // column by column, top to bottom inside
        const xx = c + dx
        for (let dy = -hy; dy <= hy; dy++) {
          const yy = y + dy
          if (xx < 0 || xx >= W || yy < 0 || yy >= H) for (let d = 0; d < D; d++) out[o++] = rand()
          else for (let d = 0; d < D; d++) out[o++] = x.data[(yy * W + xx) * D + d]
        }
      }
    }
  }
  return { H, W, D: D * k, data: out }
}

function fullyConnected(node, x) {
  const { H, W } = x, T = H * W, no = node.weights.rows, z = new Float32Array(no)
  if (node.type === 'Softmax') {
    const out = new Float32Array(T * no)
    for (let t = 0; t < T; t++) {
      matVec(node.weights, x.data, t * x.D, z)
      let m = z[0]
      for (let i = 1; i < no; i++) if (z[i] > m) m = z[i]
      let total = 0
      for (let i = 0; i < no; i++) {
        const d = f32(z[i] - m)
        z[i] = f32(Math.exp(d < -86 ? -86 : d))
        total = f32(total + z[i])
      }
      for (let i = 0; i < no; i++) out[t * no + i] = total > 0 ? f32(z[i] / total) : z[i]
    }
    return { H, W, D: no, data: out }
  }
  const fn = ACTIVATION[node.type], out = new Int8Array(T * no)
  for (let t = 0; t < T; t++) {
    matVec(node.weights, x.data, t * x.D, z)
    for (let i = 0; i < no; i++) out[t * no + i] = q8(fn(z[i]))
  }
  return { H, W, D: no, data: out }
}

function maxpool(node, x) {
  const sx = node.xScale, sy = node.yScale, H = Math.trunc(x.H / sy), W = Math.trunc(x.W / sx), D = x.D
  const out = new Int8Array(H * W * D)
  for (let y = 0; y < H; y++) {
    for (let c = 0; c < W; c++) {
      for (let d = 0; d < D; d++) {
        let m = -128
        for (let dy = 0; dy < sy; dy++) {
          for (let dx = 0; dx < sx; dx++) {
            const v = x.data[((y * sy + dy) * x.W + c * sx + dx) * D + d]
            if (v > m) m = v
          }
        }
        out[(y * W + c) * D + d] = m
      }
    }
  }
  return { H, W, D, data: out }
}

// each row is one sequence, left to right; SummLSTM keeps only the row's last output
function lstm(node, x) {
  const { H, W } = x, ni = node.ni, ns = node.ns, summary = node.type === 'SummLSTM'
  const [gCI, gGI, gGF, gGO] = node.gates
  const out = new Int8Array(H * (summary ? 1 : W) * ns)
  const src = new Int8Array(ni + ns), c = new Float32Array(ns), h = new Float32Array(ns)
  const zi = new Float32Array(ns), zg = new Float32Array(ns), zf = new Float32Array(ns), zo = new Float32Array(ns)
  for (let y = 0; y < H; y++) {
    c.fill(0)
    h.fill(0)
    for (let col = 0; col < W; col++) {
      const t = y * W + col
      src.set(x.data.subarray(t * ni, t * ni + ni))
      for (let i = 0; i < ns; i++) src[ni + i] = q8(h[i])
      matVec(gCI, src, 0, zi)
      matVec(gGI, src, 0, zg)
      matVec(gGF, src, 0, zf)
      matVec(gGO, src, 0, zo)
      for (let i = 0; i < ns; i++) {
        let s = f32(c[i] * logistic(zf[i]))
        s = f32(s + f32(tanh(zi[i]) * logistic(zg[i])))
        c[i] = s < -100 ? -100 : s > 100 ? 100 : s
        h[i] = f32(tanh(c[i]) * logistic(zo[i]))
      }
      if (!summary) for (let i = 0; i < ns; i++) out[t * ns + i] = q8(h[i])
    }
    if (summary) for (let i = 0; i < ns; i++) out[y * ns + i] = q8(h[i])
  }
  return { H, W: summary ? 1 : W, D: ns, data: out }
}

function transpose(x) {
  const { H, W, D } = x, out = new Int8Array(H * W * D)
  for (let y = 0; y < H; y++) for (let c = 0; c < W; c++) out.set(x.data.subarray((y * W + c) * D, (y * W + c + 1) * D), (c * H + y) * D)
  return { H: W, W: H, D, data: out }
}

function reverseX(x) {
  const { H, W, D } = x, out = new Int8Array(H * W * D)
  for (let y = 0; y < H; y++) for (let c = 0; c < W; c++) out.set(x.data.subarray((y * W + c) * D, (y * W + c + 1) * D), (y * W + W - 1 - c) * D)
  return { H, W, D, data: out }
}

export function forward(node, x, rand) {
  switch (node.type) {
    case 'Series': return node.children.reduce((v, child) => forward(child, v, rand), x)
    case 'Input': return x
    case 'Convolve': return convolve(node, x, rand)
    case 'Maxpool': return maxpool(node, x)
    case 'XYTranspose': return transpose(forward(node.children[0], transpose(x), rand))
    case 'RTLReversed': return reverseX(forward(node.children[0], reverseX(x), rand))
    case 'LSTM': case 'SummLSTM': return lstm(node, x)
    default: return fullyConnected(node, x)
  }
}

// Network input from a gray picture of the network's height: contrast from the local extremes of the middle
// row (25% of the minima is black, 75% of the maxima white), mapped to [-1, 1], times 128 (networkio.cpp:127-297)
export function inputTensor(gray, W, H) {
  const mins = new Float64Array(256), maxes = new Float64Array(256), row = Math.trunc(H / 2) * W
  for (let c = 1; c < W - 1; c++) {
    const p = gray[row + c - 1], v = gray[row + c], n = gray[row + c + 1]
    if ((v < p && v <= n) || (v <= p && v < n)) mins[v]++
    if ((v > p && v >= n) || (v >= p && v > n)) maxes[v]++
  }
  if (!mins.some(Boolean)) mins[0] = 1
  if (!maxes.some(Boolean)) maxes[255] = 1
  const black = f32(ile(mins, 0.25)), white = f32(ile(maxes, 0.75))
  let contrast = f32(f32(white - black) / 2)
  if (contrast <= 0) contrast = 1
  const data = new Int8Array(W * H)
  for (let t = 0; t < W * H; t++) data[t] = clip127(icrF(f32(128 * f32(f32(f32(gray[t] - black) / contrast) - 1))))
  return { H, W, D: 1, data }
}

// STATS::ile: the value below which `frac` of the counts lie, interpolated inside its bucket
function ile(buckets, frac) {
  const total = buckets.reduce((s, v) => s + v, 0)
  const target = Math.min(Math.max(frac * total, 1), total)
  let sum = 0, i = 0
  while (i <= 255 && sum < target) sum += buckets[i++]
  return i - (sum - target) / buckets[i - 1]
}
