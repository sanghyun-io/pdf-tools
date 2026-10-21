// From the network's per-frame code probabilities to characters: Tesseract's recoder beam search without a
// dictionary (recodebeam.cpp: DecodeStep, ContinueContext, PushHeapIfBetter, ExtractBestPaths). A Korean
// syllable is three codes (initial, vowel, final), so a frame-by-frame best guess loses syllables whose last
// code is only second best; the beam keeps those alive.

const DICT_RATIO = 2.25, CERT_OFFSET = -0.085, MIN_CERT = -20
const WIDTHS = [5, 10, 16, 16, 16, 16, 16, 16, 16, 16] // beam width by codes already given for the character
const ANY = 0, ONLY_DUP = 1, NO_DUP = 2 // what may follow a node
const MASK = (1n << 64n) - 1n
const toCert = (p) => (p > Math.exp(MIN_CERT) ? Math.log(p) : MIN_CERT)

// code tables from the recoder: which codes continue a prefix and which finish a character
export function decoderTables(codes) {
  const range = Math.max(...codes.flat()) + 1
  const ids = new Map(), next = new Map(), final = new Map()
  const add = (m, k, v) => (m.get(k) ?? m.set(k, new Set()).get(k)).add(v)
  codes.forEach((code, id) => {
    ids.set(code.join(','), id)
    add(final, code.slice(0, -1).join(','), code.at(-1))
    for (let l = code.length - 1; l > 0; l--) add(next, code.slice(0, l - 1).join(','), code[l - 1])
  })
  return { range, ids, next, final }
}

// probs: Float32Array frames * range. Returns [{ id, frame, cert }] for the best path, plus character bounds.
export function beamDecode(probs, frames, tables, nullCode) {
  const { range, ids, next, final } = tables, R = BigInt(range)
  let prevBeams = null
  for (let t = 0; t < frames; t++) {
    const p = probs.subarray(t * range, (t + 1) * range)
    const order = Array.from({ length: range }, (_, c) => c).sort((a, b) => p[b] - p[a] || a - b)
    const rank = new Uint8Array(range).fill(2) // 0: top 2 (and the null), 1: top 3-5, 2: the rest
    order.slice(0, 5).forEach((c, r) => { rank[c] = r < 2 ? 0 : 1 })
    rank[nullCode] = 0
    const [top, second] = order
    const beams = new Map() // "cont,len" -> nodes
    const pushHeap = (len, cont, code, id, dup, cert, prev) => {
      const key = `${cont},${len}`, heap = beams.get(key) ?? beams.set(key, []).get(key)
      const score = cert + (prev ? prev.score : 0)
      let worst = null
      for (const n of heap) if (!worst || n.score < worst.score) worst = n
      if (heap.length >= WIDTHS[len] && score <= worst.score) return
      let hash = prev ? prev.hash : 0n
      if (!dup && code !== nullCode) hash = (hash * R + (((hash >> 32n) * R) >> 32n) + BigInt(code)) & MASK
      const node = { code, id, dup, cert, score, prev, hash, len, cont }
      const same = heap.findIndex((n) => n.code === code && n.hash === hash)
      if (same >= 0) {
        if (score > heap[same].score) heap[same] = node
        return
      }
      heap.push(node)
      if (heap.length > WIDTHS[len]) heap.splice(heap.indexOf(worst), 1)
    }
    const pushDup = (len, cont, code, id, dup, cert, prev) => {
      cert *= DICT_RATIO
      if (cert >= MIN_CERT || code === nullCode) pushHeap(len, cont, code, id, dup, cert, prev)
    }
    const extend = (prev, length, prevCont, tier) => {
      const prefix = []
      for (let q = prev, k = length; k > 0; k--) {
        while (q.dup || q.code === nullCode) q = q.prev
        prefix.unshift(q.code)
        q = q.prev
      }
      if (prev) {
        if (rank[prev.code] === tier) {
          if (prevCont !== NO_DUP) pushDup(length, ANY, prev.code, prev.id, true, toCert(p[prev.code]) + CERT_OFFSET, prev)
          if (prevCont === ANY && tier === 0 && prev.code !== nullCode) {
            pushDup(length, NO_DUP, prev.code, prev.id, true, toCert(p[prev.code] + p[nullCode]) + CERT_OFFSET, prev)
          }
        }
        if (prevCont === ONLY_DUP) return
        if (prev.code !== nullCode && length > 0 && rank[nullCode] === tier) {
          pushDup(length, ANY, nullCode, -1, false, toCert(p[nullCode]) + CERT_OFFSET, prev)
        }
      }
      const combined = (code) => {
        let pr = p[code] + p[nullCode]
        if (prev && prevCont === ANY && prev.code !== nullCode && ((prev.code === top && code === second) || (code === top && prev.code === second))) pr += p[prev.code]
        return toCert(pr) + CERT_OFFSET
      }
      const key = prefix.join(',')
      for (const code of final.get(key) ?? []) {
        if (rank[code] !== tier || (prev && prev.code === code)) continue
        const cert = toCert(p[code]) + CERT_OFFSET
        if (cert < MIN_CERT && code !== nullCode) continue
        const id = length === 0 && code === nullCode ? -1 : ids.get([...prefix, code].join(','))
        pushHeap(0, ANY, code, id, false, cert * DICT_RATIO, prev)
        if (tier === 0 && code !== nullCode) pushHeap(0, ONLY_DUP, code, id, false, combined(code) * DICT_RATIO, prev)
      }
      for (const code of next.get(key) ?? []) {
        if (rank[code] !== tier || (prev && prev.code === code)) continue
        pushDup(length + 1, ANY, code, -1, false, toCert(p[code]) + CERT_OFFSET, prev)
        if (tier === 0 && code !== nullCode) pushDup(length + 1, ONLY_DUP, code, -1, false, combined(code), prev)
      }
    }
    if (t === 0) extend(null, 0, ANY, 0)
    else {
      for (let tier = 0; tier < 3; tier++) {
        for (const heap of prevBeams.values()) for (const n of heap) extend(n, n.len, n.cont, tier)
        if ([...beams.values()].some((h) => h.length && h[0].cont === ANY)) break
      }
    }
    prevBeams = beams
  }
  let best = null
  for (const key of [`${ANY},0`, `${NO_DUP},0`]) for (const n of prevBeams?.get(key) ?? []) if (!best || n.score > best.score) best = n
  const path = []
  for (let n = best; n; n = n.prev) path.unshift(n)
  return charsOf(path)
}

// the path's characters: id, the frame where it ends (its last code), the worst certainty on its way,
// and frame bounds halfway between characters (ExtractPathAsUnicharIds, calculateCharBoundaries)
function charsOf(path) {
  const chars = [], starts = [], ends = [], W = path.length
  let t = 0
  while (t < W) {
    let cert = 0
    while (t < W && path[t].id < 0) cert = Math.min(cert, path[t++].cert)
    starts.push(t)
    if (t >= W) {
      if (chars.length) chars.at(-1).cert = Math.min(chars.at(-1).cert, cert)
      break
    }
    if (path[t].id === 0 && chars.length) { // the nulls before a space belong to the character before it
      chars.at(-1).cert = Math.min(chars.at(-1).cert, cert)
      cert = 0
    }
    const id = path[t].id, frame = t
    do cert = Math.min(cert, path[t++].cert)
    while (t < W && path[t].dup)
    ends.push(t)
    chars.push({ id, frame, cert })
  }
  starts.push(W)
  const bounds = [0]
  for (let i = 0; i < ends.length; i++) bounds.push(ends[i] + Math.trunc((starts[i + 1] - ends[i]) / 2))
  bounds[bounds.length - 1] = W
  return { chars, bounds }
}
