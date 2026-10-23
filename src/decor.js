// Images and text turned into pixels for decorate() in pdf.js: stamps, signatures, text boxes, watermarks.
// Text is drawn into a picture with the PC's own fonts, so Korean works without shipping a font file.
import { splitRgba } from './pdf.js'
import { DEFAULT_FONT } from './fonts.js'

export const PX_PER_PT = 4 // text pictures at about 290 dpi: sharp in print

// Boxes are fractions of the page as shown (origin top-left). turnBox gives the same box once the page
// is turned a quarter clockwise `n` times; steps counts the quarter turns from one rotation to another.
export const steps = (from, to) => ((((to - from) / 90) % 4) + 4) % 4
export function turnBox(b, n) {
  for (let i = 0; i < n; i++) b = { x: 1 - b.y - b.h, y: b.x, w: b.h, h: b.w }
  return b
}
// a mark (see MARKS in pdf.js) turned the same way: its box, and the points and boxes inside it
export function turnMark(o, n) {
  const point = (l) => l.map((_, k) => (k % 2 ? l[k - 1] : 1 - l[k + 1])) // (u, v) -> (1 - v, u)
  for (let i = 0; i < n; i++) {
    o = { ...o, ...turnBox(o, 1) }
    if (o.lines) o.lines = o.lines.map(point)
    if (o.ends) o.ends = point(o.ends)
    if (o.rects) o.rects = o.rects.map(([u, v, w, h]) => [1 - v - h, u, h, w])
  }
  return o
}

// pixels back on a canvas, to draw them into another picture
function asCanvas({ width, height, rgb, alpha }) {
  const canvas = new OffscreenCanvas(width, height), data = new ImageData(width, height)
  for (let i = 0; i < width * height; i++) {
    data.data.set([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], alpha ? alpha[i] : 255], i * 4)
  }
  canvas.getContext('2d').putImageData(data, 0, 0)
  return canvas
}

async function pixels(canvas) {
  const { width, height } = canvas
  const image = splitRgba(canvas.getContext('2d').getImageData(0, 0, width, height).data, width, height)
  image.url = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' })) // preview
  return image
}

// an image file, at most maxSide px. opacity is baked into the alpha;
// clearWhite turns a scanned stamp's white paper transparent, fading the near-white edge.
export async function imagePixels(file, { maxSide = 1600, opacity = 1, clearWhite = false } = {}) {
  let bmp
  try {
    bmp = await createImageBitmap(file)
  } catch {
    throw new Error('읽을 수 없는 이미지입니다 (JPG·PNG 권장)')
  }
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)))
  const ctx = canvas.getContext('2d', { willReadFrequently: clearWhite }) // read back twice when clearing
  ctx.globalAlpha = opacity
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  bmp.close()
  if (clearWhite) {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const px = data.data
    for (let i = 0; i < px.length; i += 4) {
      const light = Math.min(px[i], px[i + 1], px[i + 2]) // white paper: every channel high
      if (light > 200) px[i + 3] = Math.round(px[i + 3] * Math.max(0, (240 - light) / 40))
    }
    ctx.putImageData(data, 0, 0)
  }
  return pixels(canvas)
}

const FONT = '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'
export const TEXT_FONT = FONT // the editor shows text boxes in the font they are drawn with
// a name written as a signature: handwriting-like fonts a PC may have, else the browser's cursive
export const SIGN_FONT = '"Nanum Pen Script", "Nanum Brush Script", "Segoe Script", "Gungsuh", cursive'

// text, size in points; lines split on \n; turned `angle` degrees counterclockwise
export async function textPixels(text, { size = 12, color = '#000000', opacity = 1, angle = 0, bold = false, family = FONT } = {}) {
  const px = size * PX_PER_PT, font = `${bold ? 'bold ' : ''}${px}px ${family}`, lineH = px * 1.35
  const lines = text.split('\n')
  const measure = new OffscreenCanvas(1, 1).getContext('2d')
  measure.font = font
  const tw = Math.max(1, ...lines.map((l) => measure.measureText(l).width)), th = lineH * lines.length
  const rad = (angle * Math.PI) / 180, cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad))
  const pad = px * 0.2
  const canvas = new OffscreenCanvas(Math.ceil(tw * cos + th * sin + pad), Math.ceil(tw * sin + th * cos + pad))
  const ctx = canvas.getContext('2d')
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate(-rad)
  Object.assign(ctx, { font, fillStyle: color, globalAlpha: opacity, textAlign: 'center', textBaseline: 'middle' })
  lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * lineH))
  return pixels(canvas)
}

// ---- text boxes and tables (the page editor's 글상자 and 표) ----
// Laid out here once, the same way for the editor's screen and for the saved picture, in points.

const CJK = /[⺀-⿿぀-ヿ㐀-䶿一-鿿豈-﫿]/ // Han and kana: a line may break between any two
const graphemes = (s) => (typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(s)].map((g) => g.segment) : Array.from(s))
// the pieces a line may break between: a word with the spaces after it (Korean breaks between 어절, as in
// Korean word processors), or one Han or kana character
const atoms = (s) => s.match(new RegExp(`${CJK.source}\\s*|[^\\s${CJK.source.slice(1, -1)}]+\\s*|\\s+`, 'g')) ?? []

// pt width of text in a font: font is a CSS font string at 1pt-per-px scale
export function canvasMeasure(font) {
  const ctx = new OffscreenCanvas(1, 1).getContext('2d')
  ctx.font = font
  return (s) => ctx.measureText(s).width
}
// a CSS font: the box's own font first (o.font, a family name), then the usual Korean ones
const fontOf = ({ size, bold, font }) => `${bold ? 'bold ' : ''}${size}px ${font ? `"${font}", ` : ''}${FONT}`

// Wraps text to `width` pt as pdfme does (src/text/wrap.ts, MIT, read with REA): each paragraph is filled
// piece by piece; a piece that fits on a full line moves to the next one, a longer one fills what is left
// and is cut between characters. Returns lines { text, x, width } (x from the alignment) and the height.
// measure(s) -> pt (canvasMeasure, or a stand-in for tests).
export function layoutText(text, { size = 12, lineHeight = 1.4, align = 'left', width, bold = false, font }, measure = canvasMeasure(fontOf({ size, bold, font }))) {
  const lines = []
  const push = (s) => {
    const t = s.replace(/\s+$/, ''), w = measure(t)
    lines.push({ text: t, width: w, x: align === 'center' ? (width - w) / 2 : align === 'right' ? width - w : 0 })
  }
  for (const paragraph of text.split('\n')) {
    let line = ''
    const fits = (s) => measure(s.replace(/\s+$/, '')) <= width
    for (const piece of atoms(paragraph)) {
      if (fits(line + piece)) { line += piece; continue }
      if (line && fits(piece)) { push(line); line = piece.replace(/^\s+/, ''); continue }
      for (const g of graphemes(piece)) { // longer than a line: fill it, then cut between characters
        if (line && !fits(line + g)) { push(line); line = g.trim() ? g : '' } else line += g
      }
    }
    push(line)
  }
  const lineH = size * lineHeight
  return { lines, lineH, height: Math.max(1, lines.length) * lineH }
}

const PAD = 0.45 // a table cell's padding, in its font size
// a table cell holds text, or { image } (pixels, as imagePixels gives) shown across its width
export const cellText = (v) => (typeof v === 'string' ? v : '')
export const cellImage = (v) => (v && typeof v === 'object' ? v.image : null)
export const tableFonts = (t) => {
  const plain = canvasMeasure(fontOf(t)), bold = canvasMeasure(fontOf({ ...t, bold: true }))
  return (isBold) => (isBold ? bold : plain)
}
// Columns by width share (t.widths), rows as tall as their tallest cell; the header row (t.header) bold.
// Returns { cols: [{ x, w }], rows: [{ y, h, cells: [layout] }], height, pad } in pt for a table `width` pt
// wide. fonts(bold) -> measure (tableFonts, or a stand-in for tests).
export function layoutTable(t, width, fonts = tableFonts(t)) {
  const pad = t.size * PAD
  const cols = t.widths.map((share, c) => ({ x: t.widths.slice(0, c).reduce((a, b) => a + b, 0) * width, w: share * width }))
  let y = 0
  const rows = t.rows.map((row, r) => {
    const bold = !!t.header && r === 0
    const cells = row.map((v, c) => {
      const width = Math.max(1, cols[c].w - 2 * pad), image = cellImage(v)
      return image ? { lines: [], lineH: t.size * 1.3, height: (width * image.height) / image.width, image, width }
        : layoutText(cellText(v), { size: t.size, lineHeight: 1.3, width, bold }, fonts(bold))
    })
    const out = { y, h: Math.max(...cells.map((l) => l.height)) + 2 * pad, cells, bold }
    y += out.h
    return out
  })
  return { cols, rows, height: y, pad }
}

// A layout's lines as invisible text for a reader (decorate in pdf.js): baselines in pt from the box's top-left.
const BASELINE = 0.33 // below the middle of the line, in the font size
function textRuns(layout, size, dx, dy, measure) {
  return layout.lines.flatMap((l, i) => {
    const words = [], re = /\S+/g
    for (let m; (m = re.exec(l.text));) words.push({ text: m[0], at: measure(l.text.slice(0, m.index)), width: measure(m[0]) })
    return words.length ? [{ x: dx + l.x, y: dy + (i + 0.5) * layout.lineH + size * BASELINE, size, words }] : []
  })
}

// A text box as a picture at PX_PER_PT, plus its words for decorate's invisible text. o: { text, size, bold,
// color, align, lineHeight }, width in pt.
export async function textBoxPixels(o, width) {
  const measure = canvasMeasure(fontOf(o))
  const layout = layoutText(o.text, { ...o, width }, measure)
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(width * PX_PER_PT)), Math.max(1, Math.ceil(layout.height * PX_PER_PT)))
  const ctx = canvas.getContext('2d')
  Object.assign(ctx, { font: fontOf({ ...o, size: o.size * PX_PER_PT }), fillStyle: o.color, textBaseline: 'middle' })
  layout.lines.forEach((l, i) => ctx.fillText(l.text, l.x * PX_PER_PT, (i + 0.5) * layout.lineH * PX_PER_PT))
  return { image: await pixels(canvas), height: layout.height, runs: textRuns(layout, o.size, 0, 0, measure) }
}

// A table as a picture (header fill, grid, text) and its words. t: { rows, widths, size, color, header, border, borderColor }
export async function tablePixels(t, width) {
  const fonts = tableFonts(t)
  const layout = layoutTable(t, width, fonts)
  const k = PX_PER_PT, bw = t.border
  const canvas = new OffscreenCanvas(Math.ceil((width + bw) * k), Math.ceil((layout.height + bw) * k))
  const ctx = canvas.getContext('2d')
  ctx.translate((bw / 2) * k, (bw / 2) * k) // the outer lines stay inside the picture
  if (t.header && layout.rows[0]) {
    ctx.fillStyle = HEADER_FILL
    ctx.fillRect(0, 0, width * k, layout.rows[0].h * k)
  }
  const runs = []
  for (const row of layout.rows) {
    row.cells.forEach((cell, c) => {
      const x = layout.cols[c].x + layout.pad, y = row.y + layout.pad
      if (cell.image) ctx.drawImage(asCanvas(cell.image), x * k, y * k, cell.width * k, cell.height * k)
      Object.assign(ctx, { font: fontOf({ size: t.size * k, bold: row.bold }), fillStyle: t.color, textBaseline: 'middle' })
      cell.lines.forEach((l, i) => ctx.fillText(l.text, (x + l.x) * k, (y + (i + 0.5) * cell.lineH) * k))
      runs.push(...textRuns(cell, t.size, x + bw / 2, y + bw / 2, fonts(row.bold)))
    })
  }
  if (bw > 0) {
    Object.assign(ctx, { strokeStyle: t.borderColor, lineWidth: bw * k })
    ctx.beginPath()
    for (const x of [...layout.cols.map((col) => col.x), width]) { ctx.moveTo(x * k, 0); ctx.lineTo(x * k, layout.height * k) }
    for (const y of [...layout.rows.map((row) => row.y), layout.height]) { ctx.moveTo(0, y * k); ctx.lineTo(width * k, y * k) }
    ctx.stroke()
  }
  return { image: await pixels(canvas), height: layout.height + bw, width: width + bw, runs }
}
export const HEADER_FILL = '#e8efff'

// A text box or table as drawing steps for decorate in pdf.js ({ kind: 'vector', draw, height }): its text
// real, in the PC font's own glyphs (book: a FontBook, fonts.js), its grid as lines. null when a font can't
// be embedded or lacks one of the characters; the box is then saved as its picture.
// A layout's lines as text drawing steps in a face, from (x0, y0); null if the face lacks a character.
// The baseline sits below a line's middle where CSS puts it: half of ascent + descent.
function glyphLines(book, layout, face, size, color, x0, y0) {
  const out = [], below = (size * (face.font.ascent + face.font.descent)) / 2000
  for (const [i, l] of layout.lines.entries()) {
    if (!l.text.trim()) continue
    const text = book.glyphs(face, l.text)
    if (!text) return null
    out.push({ text, font: face.key, size, color, bold: face.synthetic, x: x0 + l.x, y: y0 + (i + 0.5) * layout.lineH + below })
  }
  return out
}

// a spread note: its text at this size, this far inside its colored box
export const NOTE_TEXT = { size: 10, lineHeight: 1.35, color: '#000000' }, NOTE_PAD = 5
export const noteLayout = (o, width) => layoutText(o.text || ' ', { ...NOTE_TEXT, font: o.font, width: Math.max(1, width - 2 * NOTE_PAD) })

// A spread note (shown as a box with its text, not an icon) as drawing steps: its color, an edge, and the
// text, real in a PC font when the book can, else a picture of it. Returns { draw, height } in points.
export async function noteDrawing(o, width, book) {
  const layout = noteLayout(o, width), height = layout.height + 2 * NOTE_PAD
  const draw = [{ fill: o.color, x: 0, y: 0, w: width, h: height },
    { stroke: '#404040', width: 0.75, segments: [[0, 0, width, 0], [width, 0, width, height], [width, height, 0, height], [0, height, 0, 0]] }]
  const face = book && await book.face(o.font ?? DEFAULT_FONT, false)
  const text = face && glyphLines(book, layout, face, NOTE_TEXT.size, NOTE_TEXT.color, NOTE_PAD, NOTE_PAD)
  if (text) draw.push(...text)
  else if (o.text?.trim()) {
    const { image } = await textBoxPixels({ ...NOTE_TEXT, text: o.text, font: o.font }, width - 2 * NOTE_PAD)
    draw.push({ image, x: NOTE_PAD, y: NOTE_PAD, w: width - 2 * NOTE_PAD, h: layout.height })
  }
  return { draw, height }
}

export async function boxDrawing(o, width, book) {
  const family = o.font ?? DEFAULT_FONT
  const lines = (layout, face, size, color, x0, y0) => glyphLines(book, layout, face, size, color, x0, y0)
  if (o.kind === 'textbox') {
    const face = await book.face(family, o.bold)
    const layout = layoutText(o.text, { ...o, width })
    const draw = face && lines(layout, face, o.size, o.color, 0, 0)
    return draw && { kind: 'vector', draw, height: layout.height }
  }
  const bw = o.border, inner = width - bw, off = bw / 2, layout = layoutTable(o, inner)
  const plain = await book.face(family, false), bold = o.header ? await book.face(family, true) : plain
  if (!plain || !bold) return null
  const draw = []
  if (o.header && layout.rows[0]) draw.push({ fill: HEADER_FILL, x: off, y: off, w: inner, h: layout.rows[0].h })
  for (const row of layout.rows) {
    for (const [c, cell] of row.cells.entries()) {
      const x = off + layout.cols[c].x + layout.pad, y = off + row.y + layout.pad
      if (cell.image) draw.push({ image: cell.image, x, y, w: cell.width, h: cell.height })
      const text = lines(cell, row.bold ? bold : plain, o.size, o.color, x, y)
      if (!text) return null
      draw.push(...text)
    }
  }
  if (bw > 0) {
    const xs = [...layout.cols.map((col) => col.x), inner], ys = [...layout.rows.map((row) => row.y), layout.height]
    draw.push({ stroke: o.borderColor, width: bw, segments: [...xs.map((x) => [off + x, off, off + x, off + layout.height]), ...ys.map((y) => [off, off + y, off + inner, off + y])] })
  }
  return { kind: 'vector', draw, height: layout.height + bw }
}

// a preview picture turned clockwise, for stamps placed before their page was rotated
export async function turnedUrl(url, deg) {
  const img = new Image()
  img.src = url
  await img.decode()
  const side = deg % 180 !== 0
  const canvas = new OffscreenCanvas(side ? img.height : img.width, side ? img.width : img.height)
  const ctx = canvas.getContext('2d')
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((deg * Math.PI) / 180)
  ctx.drawImage(img, -img.width / 2, -img.height / 2)
  return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }))
}
