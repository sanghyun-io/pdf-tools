// A whole page: straighten it, find the text lines, read each with every language model and keep, word by
// word, the language that is surest. Layout is simple on purpose: recursive cuts along wide white gaps
// (columns are cut only when both sides are wide, so tables stay in rows), then rows of ink inside a block.
import { recognizeLine } from './recognize.js'

const PAD = 4 // pixels of page kept around a line, as Tesseract does (kImagePadding)

// Otsu: the gray level that best separates ink from paper
function otsu(gray) {
  const hist = new Float64Array(256)
  for (const v of gray) hist[v]++
  const total = gray.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0, wB = 0, best = 0, threshold = 128
  for (let i = 0; i < 256; i++) {
    wB += hist[i]
    if (!wB || wB === total) continue
    sumB += i * hist[i]
    const mB = sumB / wB, mF = (sum - sumB) / (total - wB), between = wB * (total - wB) * (mB - mF) ** 2
    if (between > best) {
      best = between
      threshold = i
    }
  }
  return threshold
}

const inkOf = (gray, threshold) => gray.map((v) => (v <= threshold ? 1 : 0))

// the skew angle (degrees) that makes rows of ink sharpest: the sum of squared row counts peaks when lines
// lie flat. Coarse then fine search on a sample of ink pixels.
function skewAngle(ink, w, h) {
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 400000)))
  const xs = [], ys = []
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (ink[y * w + x]) { xs.push(x); ys.push(y) }
  if (xs.length < 50) return 0
  const score = (deg) => {
    const t = Math.tan((deg * Math.PI) / 180), rows = new Map()
    for (let i = 0; i < xs.length; i++) {
      const r = Math.round((ys[i] - xs[i] * t) / step)
      rows.set(r, (rows.get(r) ?? 0) + 1)
    }
    let s = 0
    for (const n of rows.values()) s += n * n
    return s
  }
  let best = 0, bestScore = score(0)
  for (const [from, to, by] of [[-5, 5, 0.25], [-0.25, 0.25, 0.025]]) {
    const center = best
    for (let d = from; d <= to + 1e-9; d += by) {
      const s = score(center + d)
      if (s > bestScore) {
        bestScore = s
        best = center + d
      }
    }
  }
  return best
}

// gray turned by `deg` (counterclockwise positive, as the page appears) around its center, bilinear, white fill
function rotate(gray, w, h, deg) {
  const out = new Uint8Array(w * h).fill(255), a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  const cx = w / 2, cy = h / 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = c * (x - cx) - s * (y - cy) + cx, sy = s * (x - cx) + c * (y - cy) + cy // source of (x, y)
      const x0 = Math.floor(sx), y0 = Math.floor(sy)
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue
      const fx = sx - x0, fy = sy - y0, i = y0 * w + x0
      out[y * w + x] = Math.round(gray[i] * (1 - fx) * (1 - fy) + gray[i + 1] * fx * (1 - fy) + gray[i + w] * (1 - fx) * fy + gray[i + w + 1] * fx * fy)
    }
  }
  return out
}

// ink counts per row and per column of a region
function profiles(ink, w, { x0, y0, x1, y1 }) {
  const rows = new Int32Array(y1 - y0), cols = new Int32Array(x1 - x0)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (ink[y * w + x]) {
        rows[y - y0]++
        cols[x - x0]++
      }
    }
  }
  return { rows, cols }
}

// runs of values over `min` as [start, end) pairs
function runs(counts, min = 0) {
  const out = []
  for (let i = 0, start = -1; i <= counts.length; i++) {
    const on = i < counts.length && counts[i] > min
    if (on && start < 0) start = i
    else if (!on && start >= 0) {
      out.push([start, i])
      start = -1
    }
  }
  return out
}

// splits the page into blocks of lines along white gaps: [{ x0, y0, x1, y1 }], in reading order
function blocks(ink, w, region, lineHeight, depth = 0) {
  const { rows, cols } = profiles(ink, w, region)
  const rr = runs(rows), cr = runs(cols)
  if (!rr.length) return []
  const r = { x0: region.x0 + cr[0][0], x1: region.x0 + cr.at(-1)[1], y0: region.y0 + rr[0][0], y1: region.y0 + rr.at(-1)[1] }
  if (depth > 12) return [r]
  // widest gaps inside the trimmed region
  const gap = (rs) => rs.slice(1).reduce((best, [s], i) => (s - rs[i][1] > best.size ? { size: s - rs[i][1], at: rs[i][1], to: s } : best), { size: 0 })
  const hGap = gap(rr), vGap = gap(cr)
  const width = r.x1 - r.x0
  // a column cut needs a gutter (0.5-3 line heights in practice; wider gaps are table columns, which read
  // better row by row) and wide text on both sides
  const vOk = vGap.size >= lineHeight * 1.2 && vGap.size <= lineHeight * 4
    && vGap.at - cr[0][0] > width * 0.3 && cr.at(-1)[1] - vGap.to > width * 0.3
  const hOk = hGap.size >= lineHeight * 1.5
  if (vOk && (!hOk || vGap.size >= hGap.size)) {
    const cut = region.x0 + vGap.at + (vGap.to - vGap.at) / 2
    return [...blocks(ink, w, { ...r, x1: Math.floor(cut) }, lineHeight, depth + 1), ...blocks(ink, w, { ...r, x0: Math.ceil(cut) }, lineHeight, depth + 1)]
  }
  if (hOk) {
    const cut = region.y0 + hGap.at + (hGap.to - hGap.at) / 2
    return [...blocks(ink, w, { ...r, y1: Math.floor(cut) }, lineHeight, depth + 1), ...blocks(ink, w, { ...r, y0: Math.ceil(cut) }, lineHeight, depth + 1)]
  }
  return [r]
}

// the text lines of a block as boxes; a band twice as tall as usual is split at its thinnest row,
// tiny bands (a stray dot) join the nearest line
function lines(ink, w, block) {
  const { rows } = profiles(ink, w, block)
  let bands = runs(rows).map(([a, b]) => [block.y0 + a, block.y0 + b])
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
  const typical = median(bands.map(([a, b]) => b - a))
  bands = bands.flatMap(([a, b]) => {
    if (b - a < typical * 1.7 || typical < 4) return [[a, b]]
    const parts = Math.round((b - a) / typical), out = []
    let start = a
    for (let k = 1; k < parts; k++) {
      const center = a + Math.round(((b - a) * k) / parts), lo = center - Math.round(typical / 3), hi = center + Math.round(typical / 3)
      let cut = center
      for (let y = lo; y <= hi; y++) if (rows[y - block.y0] < rows[cut - block.y0]) cut = y
      out.push([start, cut])
      start = cut
    }
    out.push([start, b])
    return out
  })
  const merged = []
  for (const band of bands) {
    if (band[1] - band[0] < typical * 0.35 && merged.length && band[0] - merged.at(-1)[1] < typical * 0.5) merged.at(-1)[1] = band[1]
    else merged.push(band)
  }
  return merged.filter(([a, b]) => b - a >= typical * 0.35 || merged.length === 1).map(([y0, y1]) => {
    const { cols } = profiles(ink, w, { x0: block.x0, x1: block.x1, y0, y1 })
    const cr = runs(cols)
    return { y0, y1, segments: segmentsOf(cr, block.x0, (y1 - y0) * 2.5) }
  })
}

// pieces of a line separated by gaps wider than `gap` (table cells), as [x0, x1]
function segmentsOf(colRuns, x0, gap) {
  const out = []
  for (const [a, b] of colRuns) {
    if (out.length && x0 + a - out.at(-1)[1] <= gap) out.at(-1)[1] = x0 + b
    else out.push([x0 + a, x0 + b])
  }
  return out
}

function crop(gray, w, h, x0, y0, x1, y1) {
  x0 = Math.max(0, x0 - PAD)
  y0 = Math.max(0, y0 - PAD)
  x1 = Math.min(w, x1 + PAD)
  y1 = Math.min(h, y1 + PAD)
  const cw = x1 - x0, ch = y1 - y0, out = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++) out.set(gray.subarray((y0 + y) * w + x0, (y0 + y) * w + x1), y * cw)
  return { gray: out, w: cw, h: ch, x0, y0 }
}

// words of a list of characters: runs of non-space characters with their x range and worst confidence
function words(chars, dx) {
  const out = []
  let cur = null
  for (const c of chars) {
    if (c.text === ' ') { cur = null; continue }
    if (!cur) out.push((cur = { text: '', x0: c.x0 + dx, x1: c.x1 + dx, conf: 100 }))
    cur.text += c.text
    cur.x1 = c.x1 + dx
    cur.conf = Math.min(cur.conf, c.conf)
  }
  return out
}

const HANGUL = /[가-힣]/, LATIN = /[A-Za-z]/g
const SURE = 75, CLEAR = 95 // Korean syllables: below SURE never trusted, below CLEAR doubtful next to junk
const kept = (c) => c.text === ' ' || (HANGUL.test(c.text) && c.conf >= SURE)
const minConf = (cs) => cs.reduce((m, c) => Math.min(m, c.conf), 100)

// Korean first, English where Korean can't be right. Confidence alone doesn't decide: the English model
// reads Hangul as confident Latin junk, and without a dictionary that can't be told apart. The Korean model
// has no Latin letters at all, so every stretch where it gave something other than sure Hangul or a space
// is cut out (from the neighbor's edge: half a space, or where a syllable's box ends) and read again by
// english(x0, x1). That reading replaces the stretch when it is mostly letters ("ESG" for "656"), or, for a
// number, when only it has proper thousands separators ("12,345" for "12.345"). A doubtful syllable glued
// to the stretch ("6민" for "GRI") joins it, and then only a confident English reading replaces it.
function fuse(korean, english) {
  if (!english) return korean
  const doubtful = (c) => c && HANGUL.test(c.text) && c.conf < CLEAR
  const out = []
  for (let i = 0; i < korean.length;) {
    if (kept(korean[i])) {
      out.push(korean[i++])
      continue
    }
    let j = i
    while (j < korean.length && !kept(korean[j])) j++
    let absorbed = false
    while (j < korean.length && doubtful(korean[j])) { j++; absorbed = true }
    while (out.length && doubtful(out.at(-1))) { out.pop(); i--; absorbed = true }
    const prev = korean[i - 1], next = korean[j], run = korean.slice(i, j)
    const xa = !prev ? run[0].x0 : prev.text === ' ' ? (prev.x0 + prev.x1) >> 1 : prev.x1
    const xb = !next ? run.at(-1).x1 : next.text === ' ' ? (next.x0 + next.x1) >> 1 : next.x0
    const alt = english(xa, xb)
    const text = alt.map((c) => c.text).join('').trim()
    const letters = text.match(LATIN)?.length ?? 0
    const grouped = (s) => /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)
    const runText = run.map((c) => c.text).join('')
    const digitsOnly = run.every((c) => /^[0-9.,:;%()/-]$/.test(c.text))
    // English agreeing on the digits and adding letters at an end is reading the neighbor syllable ("1il")
    const echo = digitsOnly && (text.startsWith(runText) || text.endsWith(runText))
    const better = text && !echo && (letters >= 2 && letters * 2 >= text.length
      ? minConf(alt) >= (absorbed ? 90 : digitsOnly ? 85 : 0)
      : grouped(text) && !grouped(runText))
    out.push(...(better ? alt.filter((c, k) => c.text !== ' ' || (k > 0 && k < alt.length - 1)) : run))
    i = j
  }
  return out
}

// ink pixels inside a box: words read where there is no ink (the network's edge noise) are dropped
function inkIn(ink, w, x0, y0, x1, y1) {
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += ink[y * w + x]
  return n
}

// models: loaded traineddata, the first one preferred on ties. gray: Uint8Array w*h.
// Returns { angle, lines: [{ text, words: [{ text, x0, x1, y0, y1, conf }] }] } with boxes in the
// straightened page (turn them back by `angle` around the page center to get original coordinates).
export function recognizePage(models, gray, w, h, onLine = () => {}) {
  let threshold = otsu(gray), ink = inkOf(gray, threshold)
  const angle = skewAngle(ink, w, h)
  if (Math.abs(angle) > 0.05) {
    gray = rotate(gray, w, h, angle)
    threshold = otsu(gray)
    ink = inkOf(gray, threshold)
  }
  // typical line height from the whole page's rows of ink, to size the gaps that count
  const { rows } = profiles(ink, w, { x0: 0, y0: 0, x1: w, y1: h })
  const bandHeights = runs(rows).map(([a, b]) => b - a).sort((a, b) => a - b)
  const lineHeight = bandHeights[Math.floor(bandHeights.length / 2)] ?? 20
  const found = blocks(ink, w, { x0: 0, y0: 0, x1: w, y1: h }, lineHeight).flatMap((b) => lines(ink, w, b))
  const out = []
  found.forEach((line, i) => {
    const ws = line.segments.flatMap(([x0, x1]) => {
      const c = crop(gray, w, h, x0, line.y0, x1, line.y1)
      const korean = recognizeLine(models[0], c.gray, c.w, c.h).chars
      // the second model reads just the stretches the first wasn't sure of, cut out of the line at the nearest
      // blank column (so no stroke of a neighbor comes along); characters read where there is no ink are noise
      const cols = new Int32Array(c.w)
      for (let y = Math.max(c.y0, line.y0); y < Math.min(c.y0 + c.h, line.y1); y++) for (let x = 0; x < c.w; x++) cols[x] += ink[y * w + c.x0 + x]
      const snap = (x) => {
        for (let d = 0, r = Math.round(c.h / 4); d <= r; d++) {
          if (cols[x - d] === 0) return x - d
          if (cols[x + d] === 0) return x + d
        }
        return x
      }
      const english = models[1] && ((x0, x1) => {
        x0 = Math.max(0, snap(x0))
        x1 = Math.min(c.w, snap(x1) + 1)
        if (x1 - x0 < 3) return []
        const piece = new Uint8Array((x1 - x0) * c.h)
        for (let y = 0; y < c.h; y++) piece.set(c.gray.subarray(y * c.w + x0, y * c.w + x1), y * (x1 - x0))
        return recognizeLine(models[1], piece, x1 - x0, c.h).chars
          .map((ch) => ({ ...ch, x0: ch.x0 + x0, x1: ch.x1 + x0 }))
          .filter((ch) => ch.text === ' ' || cols.subarray(Math.max(0, ch.x0), Math.min(c.w, ch.x1)).some((n) => n > 0))
      })
      return words(fuse(korean, english), c.x0)
        .filter((wd) => inkIn(ink, w, Math.max(0, wd.x0), line.y0, Math.min(w, wd.x1), line.y1) >= Math.max(4, 0.01 * (wd.x1 - wd.x0) * (line.y1 - line.y0)))
        .map((wd) => ({ ...wd, y0: c.y0, y1: c.y0 + c.h }))
    })
    out.push({ text: ws.map((x) => x.text).join(' '), words: ws })
    onLine(i + 1, found.length)
  })
  return { angle, lines: out }
}
