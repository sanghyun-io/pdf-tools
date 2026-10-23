// Self-made PDF reader/writer: just enough to merge, reorder, rotate and drop pages, turn images
// into pages, shrink images and draw page numbers, watermarks and stamps on top. No rendering.
//
// Reading follows pdf-lib's approach (found with REA): ignore the xref table and scan the
// whole file for "N G obj" definitions, later definitions winning. Broken xref tables and
// incremental updates then need no special handling.

import { makeCipher, makeEncryption, concat } from './crypt.js'
import { glyphlessFont, GLYPH_WIDTH } from './glyphless.js'
export { PasswordError } from './crypt.js'

export class Name { constructor(v) { this.v = v } }
const names = new Map()
export const N = (v) => names.get(v) ?? names.set(v, new Name(v)).get(v)
export class Ref { constructor(num) { this.num = num } }
export class Str { constructor(bytes) { this.bytes = bytes } }
export class Stream { constructor(dict, data) { this.dict = dict; this.data = data } }
// dictionaries are Map<string, value>, arrays are JS arrays, numbers/booleans/null are JS values

const WS = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)))
const isRegular = (b) => b !== undefined && !WS.has(b) && !DELIM.has(b)
const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to))
const ESCAPES = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 } // \n \r \t \b \f

class Parser {
  // text: the same bytes as a 1-char-per-byte string, for keyword searches
  constructor(bytes, text) { this.b = bytes; this.s = text; this.p = 0 }

  skipWs() {
    const b = this.b
    for (;;) {
      while (WS.has(b[this.p])) this.p++
      if (b[this.p] !== 0x25) return // %comment
      while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p++
    }
  }

  word() {
    this.skipWs()
    const start = this.p
    while (isRegular(this.b[this.p])) this.p++
    return ascii(this.b, start, this.p)
  }

  object() {
    this.skipWs()
    const b = this.b, c = b[this.p]
    if (c === 0x2f) { // /Name
      const start = ++this.p
      while (isRegular(b[this.p])) this.p++
      return N(ascii(b, start, this.p).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))))
    }
    if (c === 0x28) return this.literal()
    if (c === 0x3c) return b[this.p + 1] === 0x3c ? this.dict() : this.hex()
    if (c === 0x5b) {
      this.p++
      const arr = []
      for (;;) {
        this.skipWs()
        if (b[this.p] === 0x5d) { this.p++; return arr }
        if (this.p >= b.length) throw new Error('unterminated array')
        arr.push(this.object())
      }
    }
    const w = this.word()
    if (w === '') { this.p++; return null } // stray delimiter
    if (/^\d+$/.test(w)) { // maybe "12 0 R"
      const save = this.p
      if (/^\d+$/.test(this.word()) && this.word() === 'R') return new Ref(Number(w))
      this.p = save
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return Number(w)
    if (w === 'true' || w === 'false') return w === 'true'
    return null // null and unknown keywords
  }

  literal() {
    const b = this.b, out = []
    let depth = 1
    this.p++
    while (this.p < b.length) {
      let c = b[this.p++]
      if (c === 0x5c) {
        c = b[this.p++]
        if (c in ESCAPES) out.push(ESCAPES[c])
        else if (c >= 0x30 && c <= 0x37) {
          let v = c - 0x30
          for (let i = 0; i < 2 && b[this.p] >= 0x30 && b[this.p] <= 0x37; i++) v = v * 8 + b[this.p++] - 0x30
          out.push(v & 0xff)
        } else if (c === 13) { if (b[this.p] === 10) this.p++ } // line continuation
        else if (c !== 10) out.push(c)
        continue
      }
      if (c === 0x28) depth++
      else if (c === 0x29 && --depth === 0) break
      out.push(c)
    }
    return new Str(Uint8Array.from(out))
  }

  hex() {
    const end = this.s.indexOf('>', this.p)
    let digits = this.s.slice(this.p + 1, end < 0 ? undefined : end).replace(/[^0-9a-fA-F]/g, '')
    this.p = end < 0 ? this.b.length : end + 1
    if (digits.length % 2) digits += '0'
    return new Str(Uint8Array.from(digits.match(/../g) ?? [], (h) => parseInt(h, 16)))
  }

  dict() {
    const b = this.b, d = new Map()
    this.p += 2
    for (;;) {
      this.skipWs()
      if (b[this.p] === 0x3e && b[this.p + 1] === 0x3e) { this.p += 2; break }
      if (this.p >= b.length) throw new Error('unterminated dictionary')
      const key = this.object()
      if (key instanceof Name) d.set(key.v, this.object())
    }
    const save = this.p
    if (this.word() !== 'stream') { this.p = save; return d }
    if (b[this.p] === 13) this.p++
    if (b[this.p] === 10) this.p++
    const start = this.p
    const len = d.get('Length')
    let end = typeof len === 'number' ? start + len : -1
    if (!(end >= start && /^\s*endstream/.test(this.s.slice(end, end + 20)))) {
      // Length missing, indirect or wrong: fall back to the keyword
      end = this.s.indexOf('endstream', start)
      if (end < 0) throw new Error('unterminated stream')
      if (b[end - 1] === 10) end--
      if (b[end - 1] === 13) end--
    }
    this.p = end
    this.word() // endstream
    return new Stream(d, b.subarray(start, end))
  }
}

const latin1 = (bytes) => new TextDecoder('latin1').decode(bytes) // 1 char per byte, positions match

async function pipe(bytes, transform) {
  const reader = new Blob([bytes]).stream().pipeThrough(transform).getReader()
  const chunks = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } catch (e) {
    if (!chunks.length) throw e // junk after the compressed data: keep what was decoded
  }
  return concat(chunks)
}

const deflate = (bytes) => pipe(bytes, new CompressionStream('deflate'))

// ponytail: FlateDecode without predictors only; enough for object streams in practice
async function decode(stream, get) {
  const f = get(stream.dict.get('Filter'))
  const filters = f == null ? [] : Array.isArray(f) ? f.map(get) : [f]
  let data = stream.data
  for (const filter of filters) {
    if (filter !== N('FlateDecode')) throw new Error(`unsupported filter ${filter?.v}`)
    data = await pipe(data, new DecompressionStream('deflate'))
  }
  return data
}

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate']

function cipherParams(enc, id, get) {
  const g = (k) => get(enc.get(k))
  if (g('Filter') !== N('Standard')) throw new Error('지원하지 않는 암호 방식입니다 (인증서 암호 등)')
  const V = g('V') ?? 0
  const method = (key) => {
    if (V < 4) return 'RC4'
    const name = g(key) ?? N('Identity')
    if (name === N('Identity')) return null
    const cfm = get(get(get(g('CF'))?.get(name.v))?.get('CFM'))
    return { V2: 'RC4', AESV2: 'AESV2', AESV3: 'AESV3' }[cfm?.v] ?? null
  }
  const bytes = (k) => g(k)?.bytes ?? new Uint8Array(0)
  return {
    V, R: g('R'), O: bytes('O'), U: bytes('U'), UE: bytes('UE'), P: g('P') ?? 0, length: g('Length') ?? 40,
    id: get(get(id)?.[0])?.bytes ?? new Uint8Array(0), encryptMetadata: g('EncryptMetadata') !== false,
    stmf: method('StmF'), strf: method('StrF'),
  }
}

// decrypt every string and stream of one indirect object
async function decryptObject(v, num, gen, cipher, encryptMetadata) {
  const walk = async (x) => {
    if (x instanceof Str) return cipher.string ? new Str(await cipher.string(x.bytes, num, gen)) : x
    if (Array.isArray(x)) return Promise.all(x.map(walk))
    if (x instanceof Map) return new Map(await Promise.all([...x].map(async ([k, y]) => [k, await walk(y)])))
    return x
  }
  if (!(v instanceof Stream)) return walk(v)
  const type = v.dict.get('Type')
  if (type === N('XRef')) return v // never encrypted
  const dict = await walk(v.dict)
  const f = v.dict.get('Filter')
  // ponytail: streams with their own Crypt filter (embedded files, usually Identity) are left as they are
  const ownCrypt = f === N('Crypt') || (Array.isArray(f) && f.includes(N('Crypt')))
  const plain = !cipher.stream || ownCrypt || (type === N('Metadata') && !encryptMetadata)
  return new Stream(dict, plain ? v.data : await cipher.stream(v.data, num, gen))
}

// password: the open password; a PasswordError means it's needed (or wrong)
export async function readPdf(bytes, password = '') {
  const text = latin1(bytes)
  if (!text.slice(0, 1024).includes('%PDF-')) throw new Error('PDF 파일이 아닙니다')
  const p = new Parser(bytes, text)
  const objects = new Map() // num -> { value, at, gen }
  const trailers = []
  const re = /(\d+)\s+(\d+)\s+obj\b|trailer\s*<</g
  for (let m; (m = re.exec(text));) {
    try {
      if (m[1] !== undefined) {
        p.p = m.index + m[0].length
        const value = p.object()
        objects.set(Number(m[1]), { value, at: m.index, gen: Number(m[2]) })
        if (value instanceof Stream && value.dict.get('Type') === N('XRef')) trailers.push(value.dict)
      } else {
        p.p = m.index + m[0].length - 2
        trailers.push(p.object())
      }
      re.lastIndex = Math.max(re.lastIndex, p.p) // don't look for "obj" inside stream data
    } catch { /* unreadable object: skip it */ }
  }
  const get = (v) => (v instanceof Ref ? objects.get(v.num)?.value ?? null : v)
  const trailer = new Map(trailers.flatMap((t) => (t instanceof Map ? [...t] : [])))

  const encRef = trailer.get('Encrypt')
  const enc = get(encRef)
  if (enc instanceof Map) {
    const params = cipherParams(enc, trailer.get('ID'), get)
    const cipher = await makeCipher(params, password)
    for (const [num, o] of objects) {
      if (encRef instanceof Ref && num === encRef.num) continue
      o.value = await decryptObject(o.value, num, o.gen, cipher, params.encryptMetadata)
    }
  }

  // objects inside object streams: decrypted already as part of their stream
  for (const [, { value, at }] of [...objects]) {
    if (!(value instanceof Stream) || value.dict.get('Type') !== N('ObjStm')) continue
    try {
      const data = await decode(value, get)
      const sp = new Parser(data, latin1(data))
      const header = Array.from({ length: get(value.dict.get('N')) }, () => [Number(sp.word()), Number(sp.word())])
      for (const [num, offset] of header) {
        if (objects.get(num)?.at > at) continue // redefined later in the file
        sp.p = get(value.dict.get('First')) + offset
        objects.set(num, { value: sp.object(), at })
      }
    } catch { /* unreadable object stream: skip it */ }
  }

  const isType = (v, t) => v instanceof Map && v.get('Type') === N(t)
  let catalog = get(trailer.get('Root'))
  if (!isType(catalog, 'Catalog')) catalog = [...objects.values()].map((o) => o.value).findLast((v) => isType(v, 'Catalog'))

  const pages = []
  const seen = new Set()
  const walk = (ref, inherited) => {
    const node = get(ref)
    if (!(node instanceof Map) || seen.has(node)) return
    seen.add(node)
    const attrs = { ...inherited }
    for (const k of INHERITED) if (node.has(k)) attrs[k] = node.get(k)
    const kids = get(node.get('Kids'))
    if (Array.isArray(kids) && !isType(node, 'Page')) kids.forEach((k) => walk(k, attrs))
    else if (!isType(node, 'Pages')) pages.push({ ref, dict: node, attrs })
  }
  if (catalog) walk(catalog.get('Pages'), {})
  if (!pages.length) throw new Error('페이지를 찾을 수 없습니다 (손상된 PDF)')
  return { get, pages, catalog }
}

const norm = (deg) => (((Math.round(deg / 90) * 90) % 360) + 360) % 360

// the visible area (CropBox, else MediaBox) as [left, bottom, right, top]
export function pageBox(doc, i) {
  const { attrs } = doc.pages[i]
  const box = doc.get(attrs.CropBox ?? attrs.MediaBox)
  const [a, b, c, d] = Array.isArray(box) && box.length === 4 ? box.map((v) => Number(doc.get(v)) || 0) : [0, 0, 612, 792]
  return a === c || b === d ? [0, 0, 612, 792] : [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]
}

// size in points and the page's own rotation
export function pageInfo(doc, i) {
  const [x0, y0, x1, y1] = pageBox(doc, i)
  return { w: x1 - x0, h: y1 - y0, rotate: norm(Number(doc.get(doc.pages[i].attrs.Rotate)) || 0) }
}

// ---- writing ----

const num = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6))
const hex2 = (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0')

function serialize(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'number') return Number.isFinite(v) ? num(v) : '0'
  if (v instanceof Name) return '/' + v.v.replace(/[^\x21-\x7e]|[#()<>[\]{}/%]/g, hex2)
  if (v instanceof Str) return '<' + Array.from(v.bytes, (x) => x.toString(16).padStart(2, '0')).join('') + '>'
  if (v instanceof Ref) return `${v.num} 0 R`
  if (Array.isArray(v)) return '[' + v.map(serialize).join(' ') + ']'
  if (v instanceof Map) return '<<' + [...v].map(([k, x]) => serialize(N(k)) + ' ' + serialize(x)).join(' ') + '>>'
  throw new Error('cannot serialize ' + v)
}

// objects[n] is written as "n 0 obj"; objects[1] must be the catalog
// trailer: extra trailer entries as a Map (Encrypt, ID)
function writePdf(objects, trailer = new Map()) {
  const enc = new TextEncoder()
  const chunks = [], offsets = []
  let size = 0
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); size += b.length }
  push('%PDF-1.7\n%âãÏÓ\n')
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = size
    const v = objects[n]
    if (v instanceof Stream) {
      push(`${n} 0 obj\n${serialize(new Map([...v.dict, ['Length', v.data.length]]))}\nstream\n`)
      push(v.data)
      push('\nendstream\nendobj\n')
    } else push(`${n} 0 obj\n${serialize(v)}\nendobj\n`)
  }
  const xref = size
  push(`xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join(''))
  push(`trailer\n${serialize(new Map([['Size', objects.length], ['Root', new Ref(1)], ...trailer]))}\nstartxref\n${xref}\n%%EOF\n`)
  return concat(chunks)
}

// ---- document-level structures that live in the catalog ----

function lookupName(doc, node, key, depth = 0) {
  node = doc.get(node)
  if (!(node instanceof Map) || depth > 32) return null
  const names = doc.get(node.get('Names'))
  if (Array.isArray(names)) {
    for (let i = 0; i + 1 < names.length; i += 2) {
      const k = doc.get(names[i])
      if (k instanceof Str && k.bytes.length === key.length && k.bytes.every((b, j) => b === key[j])) return doc.get(names[i + 1])
    }
  }
  const kids = doc.get(node.get('Kids'))
  for (const kid of Array.isArray(kids) ? kids : []) {
    const found = lookupName(doc, kid, key, depth + 1)
    if (found) return found
  }
  return null
}

// bookmarks that point at an exported page; others are dropped and their children move up a level
function readOutline(doc, pageMap, copy) {
  const resolve = (dest) => {
    dest = doc.get(dest)
    if (dest instanceof Name) dest = doc.get(doc.get(doc.catalog?.get('Dests'))?.get(dest.v))
    else if (dest instanceof Str) dest = lookupName(doc, doc.get(doc.catalog?.get('Names'))?.get('Dests'), dest.bytes)
    if (dest instanceof Map) dest = doc.get(dest.get('D'))
    if (!Array.isArray(dest) || !(dest[0] instanceof Ref) || !pageMap.has(dest[0].num)) return null
    return [new Ref(pageMap.get(dest[0].num)), ...dest.slice(1).map(copy)]
  }
  const seen = new Set()
  const walk = (ref) => {
    const items = []
    while (ref instanceof Ref && !seen.has(ref.num)) {
      seen.add(ref.num)
      const item = doc.get(ref)
      if (!(item instanceof Map)) break
      const action = doc.get(item.get('A'))
      const goTo = action instanceof Map && doc.get(action.get('S')) === N('GoTo') ? action.get('D') : null
      const dest = resolve(item.get('Dest') ?? goTo)
      const kids = walk(item.get('First'))
      if (dest) items.push({ title: doc.get(item.get('Title')), dest, open: (doc.get(item.get('Count')) ?? 0) > 0, kids })
      else items.push(...kids)
      ref = item.get('Next')
    }
    return items
  }
  const root = doc.get(doc.catalog?.get('Outlines'))
  return root instanceof Map ? walk(root.get('First')) : []
}

function writeOutline(items, parent, out, alloc) {
  const nums = items.map(() => alloc())
  let count = 0
  items.forEach((item, i) => {
    const d = new Map([
      ['Title', item.title instanceof Str ? item.title : new Str(new Uint8Array(0))],
      ['Parent', new Ref(parent)], ['Dest', item.dest],
    ])
    if (i > 0) d.set('Prev', new Ref(nums[i - 1]))
    if (i < items.length - 1) d.set('Next', new Ref(nums[i + 1]))
    count++
    if (item.kids.length) {
      const sub = writeOutline(item.kids, nums[i], out, alloc)
      d.set('First', sub.first)
      d.set('Last', sub.last)
      d.set('Count', item.open ? sub.count : -sub.count)
      if (item.open) count += sub.count
    }
    out[nums[i]] = d
  })
  return { first: new Ref(nums[0]), last: new Ref(nums.at(-1)), count }
}

// keep hidden layers hidden; without OCProperties a viewer shows every layer
function mergeLayers(docs, copy) {
  const ocgs = [], off = []
  for (const doc of docs) {
    const oc = doc.get(doc.catalog?.get('OCProperties'))
    const groups = oc instanceof Map ? doc.get(oc.get('OCGs')) : null
    if (!Array.isArray(groups)) continue
    const config = doc.get(oc.get('D'))
    const nums = (key) => {
      const list = config instanceof Map ? doc.get(config.get(key)) : null
      return new Set(Array.isArray(list) ? list.map((r) => r?.num) : [])
    }
    const on = nums('ON'), hidden = nums('OFF')
    const baseOff = config instanceof Map && doc.get(config.get('BaseState')) === N('OFF')
    for (const g of groups) {
      if (!(g instanceof Ref)) continue
      const ref = copy(doc, g)
      ocgs.push(ref)
      if (hidden.has(g.num) || (baseOff && !on.has(g.num))) off.push(ref)
    }
  }
  return ocgs.length ? new Map([['OCGs', ocgs], ['D', new Map([['OFF', off]])]]) : null
}

// form fields whose widgets came along; NeedAppearances keeps viewer-drawn values visible.
// ponytail: same-named fields from different files are not renamed, so viewers may link them
function mergeForms(docs, copiedOf, copy) {
  const fields = [], form = new Map(), dr = new Map()
  for (const doc of docs) {
    const af = doc.get(doc.catalog?.get('AcroForm'))
    if (!(af instanceof Map)) continue
    const copied = copiedOf(doc)
    const list = doc.get(af.get('Fields'))
    for (const f of Array.isArray(list) ? list : []) if (f instanceof Ref && copied.has(f.num)) fields.push(new Ref(copied.get(f.num)))
    if (doc.get(af.get('NeedAppearances')) === true) form.set('NeedAppearances', true)
    if (af.has('DA') && !form.has('DA')) form.set('DA', copy(doc, af.get('DA')))
    const res = doc.get(af.get('DR'))
    for (const [category, v] of res instanceof Map ? res : []) {
      const sub = doc.get(v)
      if (!(sub instanceof Map)) continue
      const target = dr.get(category) ?? dr.set(category, new Map()).get(category)
      for (const [name, x] of sub) if (!target.has(name)) target.set(name, copy(doc, x))
    }
  }
  if (!fields.length) return null
  form.set('Fields', fields)
  if (dr.size) form.set('DR', dr)
  return form
}

// ---- decorations: page numbers, watermark, stamps ----

// Maps "display space" (points, origin at the bottom-left of the page as shown turned by `rot`) to PDF user space.
export function displayMatrix([x0, y0, x1, y1], rot) {
  return { 0: [1, 0, 0, 1, x0, y0], 90: [0, 1, -1, 0, x1, y0], 180: [-1, 0, 0, -1, x1, y1], 270: [0, -1, 1, 0, x0, y1] }[rot]
}
const displaySize = ([x0, y0, x1, y1], rot) => (rot % 180 ? [y1 - y0, x1 - x0] : [x1 - x0, y1 - y0])

export const NUMBER_FORMATS = { n: (i) => `${i}`, of: (i, total) => `${i} / ${total}`, dash: (i) => `- ${i} -` }
// Helvetica advance widths per 1000 units for the characters page numbers use; digits are 556
const HELVETICA = { ' ': 278, '/': 278, '-': 333 }
const textWidth = (s, size) => ([...s].reduce((w, c) => w + (HELVETICA[c] ?? 556), 0) * size) / 1000

// image pixels as { width, height, rgb, alpha }: rgb has 3 bytes per pixel, alpha 1 (or null when opaque)
export function splitRgba(px, width, height) {
  const rgb = new Uint8Array(width * height * 3), alpha = new Uint8Array(width * height)
  let opaque = true
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = px[i * 4]
    rgb[i * 3 + 1] = px[i * 4 + 1]
    rgb[i * 3 + 2] = px[i * 4 + 2]
    alpha[i] = px[i * 4 + 3]
    if (alpha[i] < 255) opaque = false
  }
  return { width, height, rgb, alpha: opaque ? null : alpha }
}

// PDF text strings: UTF-16BE or UTF-8 with a byte order mark, else PDFDocEncoding (close enough to Latin-1)
function decodeText(b) {
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2))
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3))
  return latin1(b)
}

// numbers: { pos: 'bc'|'br'|'bl'|'tc'|'tr'|'tl', format: key of NUMBER_FORMATS, start, size }
// watermark: { image } centered on every page; part.overlays: [{ image, x, y, w, h, rot }] with x/y/w/h as
// fractions of the page as shown turned by `rot` (origin top-left), so a stamp turns with its page later.
// An overlay may carry runs (a text box or table drawn as its picture): its lines as { x, y (baseline), size,
// words } in points from the box's top-left, put in as invisible text the same way as part.text.
// { kind: 'vector', draw } is a text box or table drawn for real (boxDrawing in decor.js), with the faces of
// fonts (a FontBook, fonts.js) embedded once for the whole file.
// part.text: invisible text (OCR) in the page's own space, by line: [{ x, y, ux, uy, size, words: [{ text,
// at, width }] }]. A line's baseline starts at (x, y) and runs along (ux, uy); each word starts `at` points
// along it and spans `width`; glyphs are `size` tall. One text matrix per line, words moved along it, so
// readers keep a tilted line together. Render mode 3 with the glyphless font: found and copied, never shown.
// Marks (see MARKS) become annotations of their page.
// flatten: form fields and annotations painted into their pages and removed (see flattenAnnots). A text
// field without an appearance stream, or any text field when NeedAppearances says the stored ones may be
// stale, is drawn with textImage(value) -> pixels when given (the browser draws Korean); without textImage
// the stored appearance is used, if any.
async function decorate(out, alloc, pages, { numbers, watermark, flatten, textImage, fonts: book }) {
  const enc = new TextEncoder()
  const stale = out[1].get('AcroForm')?.get('NeedAppearances') === true
  const images = new Map() // pixels -> Ref: a stamp used on many pages is stored once
  const imageRef = async (img) => {
    if (images.has(img)) return images.get(img)
    const n = alloc()
    images.set(img, new Ref(n))
    out[n] = new Stream(imageDict(img.width, img.height, 'DeviceRGB', 'FlateDecode'), await deflate(img.rgb))
    if (img.alpha) {
      const m = alloc()
      out[m] = new Stream(imageDict(img.width, img.height, 'DeviceGray', 'FlateDecode'), await deflate(img.alpha))
      out[n].dict.set('SMask', new Ref(m))
    }
    return images.get(img)
  }
  const resolve = (v) => (v instanceof Ref ? out[v.num] : v)
  let open = null // one shared "q" stream: the original content runs inside q ... Q
  let ocrFont = null
  const textFont = async () => (ocrFont ??= await glyphlessFontObjects(out, alloc))
  const embedded = new Map() // FontBook key -> [resource name, Ref]: each face embedded once for the whole file
  const fontRef = async (key) => {
    if (!embedded.has(key)) embedded.set(key, [`PTF${embedded.size}`, await embedFont(out, alloc, await book.data(key), embedded.size)])
    return embedded.get(key)
  }

  for (const [i, { slot, dict, box, view = box, rotate, overlays = [], text }] of pages.entries()) {
    const ops = [], xobjects = new Map(), fonts = new Map()
    const at = (rot, body, b = box) => ops.push(`q ${displayMatrix(b, rot).map(num).join(' ')} cm ${body} Q`)
    const place = async (img, rot, x, y, w, h, b = box) => {
      const name = `PTIm${xobjects.size}`
      xobjects.set(name, await imageRef(img))
      at(rot, `${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /${name} Do`, b)
    }
    const marks = overlays.filter((o) => MARKS.has(o.kind))
    if (marks.length) dict.set('Annots', [...(resolve(dict.get('Annots')) ?? []), ...marks.flatMap((o) => addMark(out, alloc, new Ref(slot), o, box))])
    if (flatten) await flattenAnnots(dict, resolve, ops, async (ref, img) => {
      const name = `PTFm${xobjects.size}`
      xobjects.set(name, ref ?? await imageRef(img))
      return name
    }, textImage, stale)
    // a text box or table is a picture; its words go in as invisible text where they show, like OCR text
    const shown = overlays.filter((o) => o.image && o.runs).flatMap((o) => {
      const [W, H] = displaySize(box, o.rot), m = displayMatrix(box, o.rot)
      return o.runs.map((r) => {
        const X = o.x * W + r.x, Y = (1 - o.y) * H - r.y // points from the box's top-left -> as shown -> page
        return { ...r, x: m[0] * X + m[2] * Y + m[4], y: m[1] * X + m[3] * Y + m[5], ux: m[0], uy: m[1] }
      })
    })
    const lines = [...(text ?? []), ...shown] // text null: the page had text of its own
    if (lines.length) {
      fonts.set('PTOcr', await textFont())
      const runs = lines.filter((line) => line.size > 0).flatMap((line) => {
        let at = 0
        const words = line.words.flatMap((wd) => {
          // UTF-16 code units are the character codes (Identity-H); outside the BMP becomes U+FFFD
          const codes = [...wd.text].map((ch) => (ch.codePointAt(0) > 0xffff ? 0xfffd : ch.codePointAt(0)))
          if (!codes.length || !(wd.width > 0)) return []
          const scale = (100 * wd.width) / ((codes.length * line.size * GLYPH_WIDTH) / 1000)
          const move = wd.at - at
          at = wd.at
          return [`${num(move)} 0 Td ${num(scale)} Tz <${codes.map((c) => c.toString(16).padStart(4, '0')).join('')}> Tj`]
        })
        return words.length ? [`/PTOcr ${num(line.size)} Tf ${[line.ux, line.uy, -line.uy, line.ux, line.x, line.y].map(num).join(' ')} Tm`, ...words] : []
      })
      if (runs.length) ops.push(`BT 3 Tr\n${runs.join('\n')}\nET`)
    }
    if (watermark) {
      const [W, H] = displaySize(view, rotate), { width, height } = watermark.image
      const s = Math.min((W * 0.8) / width, (H * 0.8) / height)
      await place(watermark.image, rotate, (W - width * s) / 2, (H - height * s) / 2, width * s, height * s, view)
    }
    for (const o of overlays) {
      if (o.kind === 'vector') { // a text box or table drawn: real text in an embedded font, lines, fills, pictures
        const [W, H] = displaySize(box, o.rot), X = o.x * W, T = (1 - o.y) * H
        const p = (x, y) => `${num(X + x)} ${num(T - y)}` // points from the box's top-left, y down -> as shown
        const body = []
        for (const d of o.draw) {
          if (d.fill) body.push(`${paint(d.fill, 'rg')} ${p(d.x, d.y + d.h)} ${num(d.w)} ${num(d.h)} re f`)
          else if (d.stroke) body.push(`${num(d.width)} w ${paint(d.stroke, 'RG')} ${d.segments.map(([a, b, c, e]) => `${p(a, b)} m ${p(c, e)} l`).join(' ')} S`)
          else if (d.image) {
            const name = `PTIm${xobjects.size}`
            xobjects.set(name, await imageRef(d.image))
            body.push(`q ${num(d.w)} 0 0 ${num(d.h)} ${p(d.x, d.y + d.h)} cm /${name} Do Q`)
          } else if (d.text) {
            const [name, ref] = await fontRef(d.font)
            fonts.set(name, ref)
            const bolder = d.bold ? ` 2 Tr ${num(d.size * 0.03)} w ${paint(d.color, 'RG')}` : '' // no bold face: filled and outlined
            body.push(`q BT /${name} ${num(d.size)} Tf ${paint(d.color, 'rg')}${bolder} ${p(d.x, d.y)} Td <${d.text.map((g) => g.toString(16).padStart(4, '0')).join('')}> Tj ET Q`)
          }
        }
        at(o.rot, body.join('\n'))
        continue
      }
      if (!o.image) continue // redaction boxes: App burns those into a picture of the page
      const [W, H] = displaySize(box, o.rot)
      await place(o.image, o.rot, o.x * W, (1 - o.y - o.h) * H, o.w * W, o.h * H)
    }
    if (numbers) {
      const [W, H] = displaySize(view, rotate), size = numbers.size ?? 10, margin = 28
      const text = NUMBER_FORMATS[numbers.format ?? 'n'](numbers.start + i, numbers.start + pages.length - 1)
      const width = textWidth(text, size)
      const x = numbers.pos[1] === 'l' ? margin : numbers.pos[1] === 'r' ? W - margin - width : (W - width) / 2
      const y = numbers.pos[0] === 'b' ? margin : H - margin - size * 0.72
      fonts.set('PTHelv', new Map([['Type', N('Font')], ['Subtype', N('Type1')], ['BaseFont', N('Helvetica')], ['Encoding', N('WinAnsiEncoding')]]))
      at(rotate, `0 g BT /PTHelv ${num(size)} Tf ${num(x)} ${num(y)} Td (${text}) Tj ET`, view)
    }
    if (!ops.length) continue

    // a page's Resources may be shared with other pages: give this one its own copy
    const res = new Map(resolve(dict.get('Resources')) ?? [])
    for (const [kind, add] of [['XObject', xobjects], ['Font', fonts]]) {
      if (add.size) res.set(kind, new Map([...(resolve(res.get(kind)) ?? []), ...add]))
    }
    dict.set('Resources', res)
    if (!open) {
      open = alloc()
      out[open] = new Stream(new Map(), enc.encode('q\n'))
    }
    const decor = alloc()
    out[decor] = new Stream(new Map(), enc.encode(`Q\n${ops.join('\n')}\n`))
    const contents = resolve(dict.get('Contents'))
    const list = Array.isArray(contents) ? contents : dict.has('Contents') ? [dict.get('Contents')] : []
    dict.set('Contents', [new Ref(open), ...list, new Ref(decor)])
  }
  if (flatten) out[1].delete('AcroForm')
}

// A PC font's subset as a Type0 font over a CIDFontType2 (ISO 32000-2 §9.7, §9.9): codes are glyph ids
// (Identity-H, CIDToGIDMap /Identity), the widths of the glyphs used, and a ToUnicode map so the text can be
// found, copied and edited. f: FontBook.data in fonts.js.
async function embedFont(out, alloc, f, serial) {
  const enc = new TextEncoder()
  const stream = async (dict, data) => {
    const n = alloc()
    out[n] = new Stream(new Map([...dict, ['Filter', N('FlateDecode')]]), await deflate(data))
    return new Ref(n)
  }
  const hex4 = (n) => n.toString(16).padStart(4, '0').toUpperCase()
  const gids = [...f.used.keys()].sort((a, b) => a - b)
  const map = []
  for (let i = 0; i < gids.length; i += 100) { // at most 100 entries per block
    const part = gids.slice(i, i + 100)
    map.push(`${part.length} beginbfchar`, ...part.map((g) => `<${hex4(g)}> <${Array.from({ length: f.used.get(g).length }, (_, k) => hex4(f.used.get(g).charCodeAt(k))).join('')}>`), 'endbfchar')
  }
  const cmap = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def', '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange', ...map, 'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end'].join('\n')
  // a subset's name starts with six capital letters of its own
  const name = N(`${Array.from({ length: 6 }, (_, k) => String.fromCharCode(65 + ((serial * 7 + k * 3) % 26))).join('')}+${f.name}`)
  const descriptor = alloc()
  out[descriptor] = new Map([
    ['Type', N('FontDescriptor')], ['FontName', name], ['Flags', 4], ['FontBBox', f.bbox.map(Math.round)], ['ItalicAngle', f.italicAngle],
    ['Ascent', Math.round(f.ascent)], ['Descent', Math.round(f.descent)], ['CapHeight', Math.round(f.capHeight)], ['StemV', 80],
    ['FontFile2', await stream(new Map([['Length1', f.file.length]]), f.file)],
  ])
  const cid = alloc()
  out[cid] = new Map([
    ['Type', N('Font')], ['Subtype', N('CIDFontType2')], ['BaseFont', name],
    ['CIDSystemInfo', new Map([['Registry', new Str(enc.encode('Adobe'))], ['Ordering', new Str(enc.encode('Identity'))], ['Supplement', 0]])],
    ['FontDescriptor', new Ref(descriptor)], ['DW', 1000], ['W', gids.flatMap((g) => [g, [Math.round(f.width(g))]])], ['CIDToGIDMap', N('Identity')],
  ])
  const font = alloc()
  out[font] = new Map([
    ['Type', N('Font')], ['Subtype', N('Type0')], ['BaseFont', name], ['Encoding', N('Identity-H')],
    ['DescendantFonts', [new Ref(cid)]], ['ToUnicode', await stream(new Map(), enc.encode(cmap))],
  ])
  return new Ref(font)
}

// The OCR text font: Type0 with Identity-H codes = UTF-16 code units, every code drawn with the one empty
// glyph of the glyphless TrueType font, and a ToUnicode map giving each code back as itself.
async function glyphlessFontObjects(out, alloc) {
  const enc = new TextEncoder()
  const stream = async (dict, data) => {
    const n = alloc()
    out[n] = new Stream(new Map([...dict, ['Filter', N('FlateDecode')]]), await deflate(data))
    return new Ref(n)
  }
  const ttf = glyphlessFont()
  const file = await stream(new Map([['Length1', ttf.length]]), ttf)
  const toGid = new Uint8Array(65536 * 2)
  for (let i = 1; i < toGid.length; i += 2) toGid[i] = 1 // every CID -> glyph 1
  const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase()
  const ranges = Array.from({ length: 256 }, (_, h) => `<${hex(h)}00> <${hex(h)}FF> <${hex(h)}00>`) // a range may only vary its last byte
  const cmap = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def', '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
    ...[0, 100, 200].flatMap((from) => {
      const part = ranges.slice(from, from + 100)
      return [`${part.length} beginbfrange`, ...part, 'endbfrange']
    }),
    'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end'].join('\n')
  const descriptor = alloc()
  out[descriptor] = new Map([
    ['Type', N('FontDescriptor')], ['FontName', N('GlyphLessFont')], ['Flags', 5], ['FontBBox', [0, 0, GLYPH_WIDTH, 1000]],
    ['ItalicAngle', 0], ['Ascent', 1000], ['Descent', 0], ['CapHeight', 1000], ['StemV', 80], ['FontFile2', file],
  ])
  const cid = alloc()
  out[cid] = new Map([
    ['Type', N('Font')], ['Subtype', N('CIDFontType2')], ['BaseFont', N('GlyphLessFont')],
    ['CIDSystemInfo', new Map([['Registry', new Str(enc.encode('Adobe'))], ['Ordering', new Str(enc.encode('Identity'))], ['Supplement', 0]])],
    ['FontDescriptor', new Ref(descriptor)], ['DW', GLYPH_WIDTH], ['CIDToGIDMap', await stream(new Map(), toGid)],
  ])
  const font = alloc()
  out[font] = new Map([
    ['Type', N('Font')], ['Subtype', N('Type0')], ['BaseFont', N('GlyphLessFont')], ['Encoding', N('Identity-H')],
    ['DescendantFonts', [new Ref(cid)]], ['ToUnicode', await stream(new Map(), enc.encode(cmap))],
  ])
  return new Ref(font)
}

// annotations flatten paints; notes (Text, with their Popup) stay, since painting one would lose what it says,
// and so do links, which do nothing once painted
const FLATTENED = new Set(['Widget', 'Ink', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'FreeText', 'Stamp', 'Caret'].map(N))

// Paints each widget's and annotation's normal appearance where a viewer would (ISO 32000-2 §12.5.5: the
// form's BBox, turned by its Matrix, is fitted to the Rect) and takes it off the page. Hidden ones just go,
// and so does a widget without a picture; an annotation without one stays, as nothing could draw it.
// addXObject(ref, pixels) registers an XObject on the page and returns its name. stale: NeedAppearances is set.
async function flattenAnnots(dict, resolve, ops, addXObject, textImage, stale) {
  const annots = resolve(dict.get('Annots'))
  if (!Array.isArray(annots)) return
  const nums = (v) => (Array.isArray(resolve(v)) ? resolve(v).map((x) => Number(resolve(x)) || 0) : null)
  const inherited = (a, key) => {
    for (let d = a, depth = 0; d instanceof Map && depth < 32; d = resolve(d.get('Parent')), depth++) if (d.has(key)) return resolve(d.get(key))
    return null
  }
  const keep = []
  for (const ref of annots) {
    const a = resolve(ref)
    if (!(a instanceof Map) || !FLATTENED.has(a.get('Subtype'))) {
      keep.push(ref)
      continue
    }
    if (a.get('Subtype') !== N('Widget') && !(resolve(resolve(a.get('AP'))?.get?.('N')) instanceof Stream)) {
      keep.push(ref)
      continue
    }
    const r = nums(a.get('Rect'))
    if ((Number(resolve(a.get('F'))) & 2) || !r || r.length < 4) continue // Hidden
    const [rx0, ry0, rx1, ry1] = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]
    let apRef = resolve(a.get('AP'))?.get?.('N') ?? null
    if (resolve(apRef) instanceof Map) apRef = resolve(apRef).get(resolve(a.get('AS'))?.v) ?? null // on/off states
    const ap = resolve(apRef)
    const value = inherited(a, 'FT') === N('Tx') && inherited(a, 'V') instanceof Str ? decodeText(inherited(a, 'V').bytes) : null
    // NeedAppearances: the stored picture of a text field may be stale, so draw the value itself
    const redraw = textImage && value !== null && (stale || !(ap instanceof Stream))
    if (!redraw && ap instanceof Stream && apRef instanceof Ref) {
      const m = nums(ap.dict.get('Matrix')) ?? [1, 0, 0, 1, 0, 0], bb = nums(ap.dict.get('BBox')) ?? [0, 0, 1, 1]
      const corners = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
      const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1])
      const [bx0, by0, bx1, by1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
      if (bx1 - bx0 < 1e-6 || by1 - by0 < 1e-6) continue
      const sx = (rx1 - rx0) / (bx1 - bx0), sy = (ry1 - ry0) / (by1 - by0)
      ap.dict.set('Type', N('XObject'))
      ap.dict.set('Subtype', N('Form'))
      const name = await addXObject(apRef)
      ops.push(`q ${[sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy].map(num).join(' ')} cm /${name} Do Q`)
    } else if (redraw) {
      if (!value.trim()) continue
      const img = await textImage(value)
      const h = Math.min((ry1 - ry0) * 0.75, ((rx1 - rx0 - 4) * img.height) / img.width), w = (h * img.width) / img.height
      const name = await addXObject(null, img)
      ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(rx0 + 2)} ${num(ry0 + (ry1 - ry0 - h) / 2)} cm /${name} Do Q`)
    }
  }
  // a popup goes with the annotation it belonged to
  const gone = new Set(annots.filter((ref) => !keep.includes(ref)).map(resolve))
  const left = keep.filter((ref) => !(resolve(ref)?.get?.('Subtype') === N('Popup') && gone.has(resolve(resolve(ref).get('Parent')))))
  if (left.length) dict.set('Annots', left)
  else dict.delete('Annots')
}

// ---- marks: the page editor's pen, highlighter, underline, strike-out, shapes and notes ----
// Written as pdf.js's editor writes its own (src/core/annotation.js, Apache-2.0, read with REA): a standard
// annotation plus a normal appearance drawn in the page's own space, so viewers show the same thing and a
// reader can still move or delete it. flatten paints them into the page like form fields (flattenAnnots).
//
// A mark is an overlay (x, y, w, h, rot as for stamps) with kind and color '#rrggbb', and inside its box
// (u, v: 0..1 from the box's top-left): ink { lines: [[u, v, u, v, ...]], width, opacity, marker },
// highlight | underline | strikeout { rects: [[u, v, w, h]] } (one per line of text, read left to right),
// square | circle { width, fill }, line | arrow { ends: [u1, v1, u2, v2], width }, note { text }.
export const MARKS = new Set(['ink', 'highlight', 'underline', 'strikeout', 'square', 'circle', 'line', 'arrow', 'note'])
const NOTE_SIZE = 20 // pt, a note's icon
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
const paint = (hex, op) => `${rgbOf(hex).map(num).join(' ')} ${op}`
const pt = ([x, y]) => `${num(x)} ${num(y)}`
const textString = (s) => new Str(Uint8Array.from([0xfe, 0xff, ...Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)).flatMap((u) => [u >> 8, u & 255])])) // UTF-16BE

// pdf.js's pen smoothing (Outline.createBezierPoints): each point bends the line toward the next one.
function smoothPath(p) {
  const ops = [`${pt(p[0])} m`]
  if (p.length < 3) return [...ops, `${pt(p.at(-1))} l`] // a dot (round cap) or a straight stroke
  for (let i = 2; i < p.length; i++) {
    const [a, b, c] = [p[i - 2], p[i - 1], p[i]]
    ops.push(`${pt([(a[0] + 5 * b[0]) / 6, (a[1] + 5 * b[1]) / 6])} ${pt([(5 * b[0] + c[0]) / 6, (5 * b[1] + c[1]) / 6])} ${pt([(b[0] + c[0]) / 2, (b[1] + c[1]) / 2])} c`)
  }
  return [...ops, `${pt(p.at(-1))} l`] // pdf.js stops halfway to the last point
}

// o: a mark; at(u, v): a point of its box in the page's own space.
// Returns { fields, rect, ops, gs, bbox? }: the annotation's entries, its Rect, the appearance drawn in page
// space (or in its own bbox), and the ExtGState it needs (opacity, multiply) or null.
function markAnnotation(o, at) {
  const ops = [], fields = [['C', rgbOf(o.color)]]
  let gs = null, pad = 1
  const quads = o.rects?.map(([u, v, w, h]) => [at(u, v), at(u + w, v), at(u, v + h), at(u + w, v + h)]) // UL UR LL LR
  const along = (q, f) => [[q[2][0] + (q[0][0] - q[2][0]) * f, q[2][1] + (q[0][1] - q[2][1]) * f], [q[3][0] + (q[1][0] - q[3][0]) * f, q[3][1] + (q[1][1] - q[3][1]) * f]]
  let points = quads?.flat() ?? []
  switch (o.kind) {
    case 'ink': {
      const lines = o.lines.map((l) => Array.from({ length: l.length / 2 }, (_, k) => at(l[2 * k], l[2 * k + 1])))
      ops.push(`${num(o.width)} w 1 J 1 j`, paint(o.color, 'RG'), ...lines.flatMap(smoothPath), 'S')
      fields.push(['Subtype', N('Ink')], ['InkList', lines.map((p) => p.flat())], ['BS', new Map([['W', o.width]])])
      if (o.marker) fields.push(['IT', N('InkHighlight')]) // how Edge and Acrobat tell a free highlight
      if (o.marker || o.opacity < 1) gs = new Map([['CA', o.opacity ?? 1], ...(o.marker ? [['BM', N('Multiply')]] : [])])
      if (o.opacity < 1) fields.push(['CA', o.opacity])
      points = lines.flat()
      pad = o.width + 1 // half a stroke would do; pdf.js distrusts a border width over half the Rect
      break
    }
    case 'highlight':
      ops.push(paint(o.color, 'rg'), ...quads.map((q) => `${pt(q[0])} m ${pt(q[1])} l ${pt(q[3])} l ${pt(q[2])} l h`), 'f')
      gs = new Map([['BM', N('Multiply')]])
      fields.push(['Subtype', N('Highlight')], ['QuadPoints', quads.flat(2)])
      break
    case 'underline':
    case 'strikeout':
      ops.push(paint(o.color, 'RG'), ...quads.map((q) => {
        const tall = Math.hypot(q[0][0] - q[2][0], q[0][1] - q[2][1])
        const [a, b] = along(q, o.kind === 'underline' ? 0.08 : 0.45)
        return `${num(Math.max(0.5, tall * 0.07))} w ${pt(a)} m ${pt(b)} l S`
      }))
      fields.push(['Subtype', N(o.kind === 'underline' ? 'Underline' : 'StrikeOut')], ['QuadPoints', quads.flat(2)])
      break
    case 'square':
    case 'circle': {
      const [a, b] = [at(0, 0), at(1, 1)], hw = o.width / 2
      const [x0, y0, x1, y1] = [Math.min(a[0], b[0]) + hw, Math.min(a[1], b[1]) + hw, Math.max(a[0], b[0]) - hw, Math.max(a[1], b[1]) - hw]
      ops.push(`${num(o.width)} w`, paint(o.color, 'RG'))
      if (o.fill) ops.push(paint(o.fill, 'rg'))
      if (o.kind === 'square') ops.push(`${pt([x0, y0])} ${num(x1 - x0)} ${num(y1 - y0)} re`)
      else { // four Béziers, as pdf.js draws a circle annotation without appearance
        const k = (4 / 3) * Math.tan(Math.PI / 8), [mx, my, rx, ry] = [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2]
        ops.push(`${pt([mx, y1])} m`, `${pt([mx + rx * k, y1])} ${pt([x1, my + ry * k])} ${pt([x1, my])} c`, `${pt([x1, my - ry * k])} ${pt([mx + rx * k, y0])} ${pt([mx, y0])} c`,
          `${pt([mx - rx * k, y0])} ${pt([x0, my - ry * k])} ${pt([x0, my])} c`, `${pt([x0, my + ry * k])} ${pt([mx - rx * k, y1])} ${pt([mx, y1])} c h`)
      }
      ops.push(o.fill ? 'B' : 'S')
      fields.push(['Subtype', N(o.kind === 'square' ? 'Square' : 'Circle')], ['BS', new Map([['W', o.width]])])
      if (o.fill) fields.push(['IC', rgbOf(o.fill)])
      points = [a, b]
      break
    }
    case 'line':
    case 'arrow': {
      const [a, b] = [at(o.ends[0], o.ends[1]), at(o.ends[2], o.ends[3])]
      ops.push(`${num(o.width)} w 1 J 1 j`, paint(o.color, 'RG'), `${pt(a)} m ${pt(b)} l S`)
      points = [a, b]
      pad = o.width + 1 // half a stroke would do; pdf.js distrusts a border width over half the Rect
      if (o.kind === 'arrow') { // an open arrowhead at the end, 30° each side
        const len = Math.max(8, o.width * 4), d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, [ux, uy] = [(a[0] - b[0]) / d, (a[1] - b[1]) / d]
        const wing = (s) => [b[0] + len * (ux * Math.cos(s) - uy * Math.sin(s)), b[1] + len * (ux * Math.sin(s) + uy * Math.cos(s))]
        ops.push(`${pt(wing(Math.PI / 6))} m ${pt(b)} l ${pt(wing(-Math.PI / 6))} l S`)
        pad += len
      }
      fields.push(['Subtype', N('Line')], ['L', [...a, ...b]], ['BS', new Map([['W', o.width]])], ['LE', [N('None'), N(o.kind === 'arrow' ? 'OpenArrow' : 'None')]])
      break
    }
    case 'note': { // pinned by its top-left corner and drawn upright whatever the page's rotation (NoRotate)
      const [x, y] = at(0, 0), s = NOTE_SIZE
      // a speech bubble in its own 20 x 20 space
      ops.push('1 w 1 j 0.25 0.25 0.25 RG', paint(o.color, 'rg'), '1.5 18.5 m 18.5 18.5 l 18.5 5.5 l 10 5.5 l 4 1.5 l 5 5.5 l 1.5 5.5 l h B',
        '4.5 14.5 m 15.5 14.5 l 4.5 12 m 15.5 12 l 4.5 9.5 m 11.5 9.5 l S')
      fields.push(['Subtype', N('Text')], ['Name', N('Comment')], ['Contents', textString(o.text ?? '')], ['Open', false])
      return { fields, rect: [x, y - s, x + s, y], ops, gs, bbox: [0, 0, s, s], flags: 4 | 8 | 16 } // Print, NoZoom, NoRotate
    }
  }
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1])
  return { fields, rect: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad], ops, gs }
}

// Adds a mark to the page as an annotation with its appearance (and a popup for a note); returns the refs.
function addMark(out, alloc, pageRef, o, box) {
  const enc = new TextEncoder()
  const m = displayMatrix(box, o.rot), [W, H] = displaySize(box, o.rot)
  const at = (u, v) => { // box fraction -> page as shown (points from the bottom-left) -> page space
    const X = (o.x + u * o.w) * W, Y = (1 - o.y - v * o.h) * H
    return [m[0] * X + m[2] * Y + m[4], m[1] * X + m[3] * Y + m[5]]
  }
  const { fields, rect, ops, gs, bbox = rect, flags = 4 } = markAnnotation(o, at)
  const ap = alloc()
  out[ap] = new Stream(new Map([['Type', N('XObject')], ['Subtype', N('Form')], ['BBox', bbox.map((v) => Math.round(v * 1000) / 1000)],
    ['Resources', new Map(gs ? [['ExtGState', new Map([['GS0', new Map([['Type', N('ExtGState')], ...gs])]])]] : [])]]),
  enc.encode(`${gs ? '/GS0 gs\n' : ''}${ops.join('\n')}`))
  const date = new Str(enc.encode(`D:${new Date().toISOString().replace(/[-:T]|\.\d+/g, '').slice(0, 14)}Z`))
  const annot = alloc()
  out[annot] = new Map([['Type', N('Annot')], ...fields, ['Rect', rect.map((v) => Math.round(v * 1000) / 1000)], ['F', flags], ['P', pageRef],
    ['CreationDate', date], ['M', date], ['AP', new Map([['N', new Ref(ap)]])]])
  if (o.kind !== 'note') return [new Ref(annot)]
  const popup = alloc()
  out[popup] = new Map([['Type', N('Annot')], ['Subtype', N('Popup')], ['Rect', [rect[2], rect[3] - 120, rect[2] + 200, rect[3]]], ['Parent', new Ref(annot)], ['Open', false], ['F', 28]])
  out[annot].set('Popup', new Ref(popup))
  return [new Ref(annot), new Ref(popup)]
}

// parts: [{ doc, index, rotate, overlays?, crop?, text? } | { size: [w, h], rotate, overlays? }] in output order.
// size makes a blank page; crop ([left, bottom, right, top] in the page's own space) narrows what shows;
// text is an invisible OCR text layer (see decorate).
// options: { level: 'lossless' or a key of LEVELS, gray: images to grayscale, numbers, watermark, flatten,
// textImage and fonts (see decorate), impose: 1 | 2 | 4 (see impose), strip: drop hidden info, encrypt (see encryptAll) }
export async function buildPdf(parts, { level, gray, numbers, watermark, flatten, textImage, fonts, impose: per, strip, encrypt } = {}) {
  const out = [null, null, null] // 1 catalog, 2 page tree
  const alloc = () => out.push(null) - 1
  const state = new Map() // doc -> { pages: srcNum -> newNum, copied: srcNum -> newNum }
  const st = (doc) => state.get(doc) ?? state.set(doc, { pages: new Map(), copied: new Map() }).get(doc)
  const slots = parts.map(({ doc, index }) => {
    const n = alloc()
    const ref = doc?.pages[index].ref
    if (ref instanceof Ref) st(doc).pages.set(ref.num, n)
    return n
  })

  const queue = [] // copy referenced objects iteratively; recursion could overflow on long chains
  const copy = (doc, v) => {
    if (v instanceof Ref) {
      const s = st(doc)
      if (s.pages.has(v.num)) return new Ref(s.pages.get(v.num))
      const target = doc.get(v)
      // pages left out and the old page tree: links to them become null
      if (target instanceof Map && (target.get('Type') === N('Page') || target.get('Type') === N('Pages'))) return null
      if (!s.copied.has(v.num)) {
        const n = alloc()
        s.copied.set(v.num, n)
        queue.push([doc, target, n])
      }
      return new Ref(s.copied.get(v.num))
    }
    if (Array.isArray(v)) return v.map((x) => copy(doc, x))
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, copy(doc, x)]))
    if (v instanceof Stream) {
      const d = new Map(v.dict)
      d.delete('Length') // rewritten on save; an indirect Length would be copied for nothing
      return new Stream(copy(doc, d), v.data)
    }
    return v
  }

  parts.forEach(({ doc, index, rotate, size, crop }, i) => {
    if (size) {
      out[slots[i]] = new Map([['Type', N('Page')], ['Parent', new Ref(2)], ['MediaBox', [0, 0, ...size]], ['Rotate', norm(rotate)], ['Resources', new Map()]])
      return
    }
    const page = doc.pages[index]
    const d = copy(doc, page.dict)
    for (const k of INHERITED) if (page.attrs[k] !== undefined) d.set(k, copy(doc, page.attrs[k]))
    d.set('Parent', new Ref(2))
    d.set('Rotate', norm((Number(doc.get(page.attrs.Rotate)) || 0) + rotate))
    if (crop) d.set('CropBox', crop)
    d.delete('B') // article beads point into the source's thread list
    out[slots[i]] = d
  })
  const drain = () => {
    while (queue.length) {
      const [doc, target, n] = queue.pop()
      out[n] = copy(doc, target)
    }
  }
  drain() // first, so form fields reachable from the copied widgets are known

  const docs = [...new Set(parts.map((p) => p.doc).filter(Boolean))]
  const catalog = new Map([['Type', N('Catalog')], ['Pages', new Ref(2)]])
  const outline = docs.flatMap((doc) => readOutline(doc, st(doc).pages, (x) => copy(doc, x)))
  if (outline.length) {
    const root = alloc()
    const { first, last, count } = writeOutline(outline, root, out, alloc)
    out[root] = new Map([['Type', N('Outlines')], ['First', first], ['Last', last], ['Count', count]])
    catalog.set('Outlines', new Ref(root))
  }
  const layers = mergeLayers(docs, copy)
  if (layers) catalog.set('OCProperties', layers)
  const form = mergeForms(docs, (doc) => st(doc).copied, copy)
  if (form) catalog.set('AcroForm', form)
  drain()
  out[1] = catalog
  out[2] = new Map([['Type', N('Pages')], ['Kids', slots.map((n) => new Ref(n))], ['Count', slots.length]])

  const pages = parts.map(({ doc, index, overlays, size, crop, text }, i) => {
    const box = size ? [0, 0, ...size] : pageBox(doc, index)
    return { slot: slots[i], dict: out[slots[i]], box, view: crop ?? box, rotate: out[slots[i]].get('Rotate'), overlays, text }
  })
  // sheets of several pages are drawn from the pages' contents, so what should show of fields and marks is painted in first
  await decorate(out, alloc, pages, { numbers, watermark, flatten: flatten || !!per, textImage, fonts })
  if (per) await impose(out, alloc, pages, per)
  if (strip) stripHidden(out)
  if (level) await optimize(out)
  const saved = LEVELS[level] || gray ? await shrinkImages(out, LEVELS[level] ?? [Infinity, 0.85], gray) : 0
  return { bytes: writePdf(out, encrypt ? await encryptAll(out, encrypt) : undefined), saved }
}

// ---- layout: several pages on one sheet ----

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
function invert([a, b, c, d, e, f]) {
  const k = a * d - b * c
  return [d / k, -b / k, -c / k, a / k, (c * f - d * e) / k, (b * e - a * f) / k]
}

// A page as a Form XObject: its content streams joined into one, clipped to what shows.
async function pageForm(out, page) {
  const resolve = (v) => (v instanceof Ref ? out[v.num] : v)
  const contents = resolve(page.dict.get('Contents'))
  const list = (Array.isArray(contents) ? contents : [page.dict.get('Contents')]).map(resolve).filter((s) => s instanceof Stream)
  const parts = []
  for (const s of list) parts.push(await decode(s, resolve), Uint8Array.of(10))
  const form = new Map([['Type', N('XObject')], ['Subtype', N('Form')], ['BBox', page.view], ['Resources', page.dict.get('Resources') ?? new Map()], ['Filter', N('FlateDecode')]])
  if (page.dict.has('Group')) form.set('Group', page.dict.get('Group')) // transparency
  return new Stream(form, await deflate(concat(parts)))
}

// per 2: two pages side by side on landscape A4 (wide pages: one above the other on portrait A4); per 4: two
// by two on portrait A4; per 1: each page fitted to A4 in its own orientation. Pages keep the rotation they are shown with. Bookmarks move to the sheets;
// links and notes don't survive being drawn as pictures of pages (fields and other annotations are painted in first).
async function impose(out, alloc, pages, per) {
  const [aw, ah] = A4, margin = per === 1 ? 0 : 18, gap = 12
  const enc = new TextEncoder()
  const kids = [], sheetOf = new Map()
  for (let g = 0; g < pages.length; g += per) {
    const group = pages.slice(g, g + per)
    const [w0, h0] = displaySize(group[0].view, group[0].rotate), wide = w0 > h0
    let sw = aw, sh = ah, cols = 2, rows = 2 // per 4
    if (per === 2) [sw, sh, cols, rows] = wide ? [aw, ah, 1, 2] : [ah, aw, 2, 1] // wide pages stack
    if (per === 1) [sw, sh, cols, rows] = wide ? [ah, aw, 1, 1] : [aw, ah, 1, 1]
    const cw = (sw - 2 * margin - (cols - 1) * gap) / cols, ch = (sh - 2 * margin - (rows - 1) * gap) / rows
    const sheet = alloc(), xobjects = new Map(), ops = []
    for (const [k, page] of group.entries()) {
      const cx = margin + (k % cols) * (cw + gap), cy = sh - margin - (Math.floor(k / cols) + 1) * ch - Math.floor(k / cols) * gap
      const [w, h] = displaySize(page.view, page.rotate), s = Math.min(cw / w, ch / h)
      // the page's own space -> as shown -> scaled into the middle of its cell
      const m = mul([s, 0, 0, s, cx + (cw - w * s) / 2, cy + (ch - h * s) / 2], invert(displayMatrix(page.view, page.rotate)))
      const n = alloc()
      out[n] = await pageForm(out, page)
      xobjects.set(`PTPg${k}`, new Ref(n))
      ops.push(`q ${m.map(num).join(' ')} cm /PTPg${k} Do Q`)
      sheetOf.set(page.slot, sheet)
    }
    const content = alloc()
    out[content] = new Stream(new Map(), enc.encode(ops.join('\n')))
    out[sheet] = new Map([['Type', N('Page')], ['Parent', new Ref(2)], ['MediaBox', [0, 0, sw, sh]],
      ['Resources', new Map([['XObject', xobjects]])], ['Contents', new Ref(content)]])
    kids.push(new Ref(sheet))
  }
  out[2] = new Map([['Type', N('Pages')], ['Kids', kids], ['Count', kids.length]])
  for (const v of out) { // outline items: Title + Dest [page ...]
    const dest = v instanceof Map && v.has('Title') ? v.get('Dest') : null
    if (Array.isArray(dest) && dest[0] instanceof Ref && sheetOf.has(dest[0].num)) v.set('Dest', [new Ref(sheetOf.get(dest[0].num)), N('Fit')])
  }
  out[1].delete('AcroForm')
  dropUnreachable(out) // the original page objects
}

// ---- lossless size savings ----

// Streams stored without compression get Flate when that's smaller, and objects that came in twice
// (the same font or logo from several merged files) are kept once.
async function optimize(out) {
  for (let n = 1; n < out.length; n++) {
    const s = out[n]
    if (!(s instanceof Stream) || s.dict.has('Filter') || s.dict.has('DecodeParms') || s.dict.get('Type') === N('Metadata') || s.data.length < 64) continue
    const packed = await deflate(s.data)
    if (packed.length < s.data.length) out[n] = new Stream(new Map([...s.dict, ['Filter', N('FlateDecode')]]), packed)
  }
  // pages, annotations (one page each), layers, fields and structure keep their identity even when equal
  const unique = (v) => v instanceof Map && ([N('Page'), N('Pages'), N('Catalog'), N('Annot'), N('OCG'), N('StructElem')].includes(v.get('Type'))
    || (v.has('Subtype') && v.has('Rect')) || v.has('FT') || v.has('Title'))
  const fnv = (b) => { let h = 0x811c9dc5; for (const x of b) h = Math.imul(h ^ x, 0x01000193); return h >>> 0 }
  for (let pass = 0; pass < 8; pass++) { // a font dict repeats only once its font file has been merged
    const seen = new Map(), alias = new Map()
    for (let n = 3; n < out.length; n++) {
      const v = out[n]
      if (v === null || unique(v)) continue
      const key = v instanceof Stream ? `S${serialize(v.dict)}#${v.data.length}#${fnv(v.data)}` : `O${serialize(v)}`
      const first = seen.get(key)
      if (first === undefined) seen.set(key, n)
      else if (!(v instanceof Stream) || out[first].data.every((b, i) => b === v.data[i])) alias.set(n, first)
    }
    if (!alias.size) break
    const swap = (x) => {
      if (x instanceof Ref) return alias.has(x.num) ? new Ref(alias.get(x.num)) : x
      if (Array.isArray(x)) return x.map(swap)
      if (x instanceof Map) return new Map([...x].map(([k, y]) => [k, swap(y)]))
      return x
    }
    for (let n = 1; n < out.length; n++) {
      const v = out[n]
      out[n] = alias.has(n) ? null : v instanceof Stream ? new Stream(swap(v.dict), v.data) : swap(v)
    }
  }
}

// ---- security ----

// What buildPdf already leaves out: the source's document info (title, author, producer) and catalog XMP.
// This also drops XMP and app data inside pages and images, and the author names on comments.
function stripHidden(out) {
  const isAnnot = (d) => d.get('Type') === N('Annot') || (d.has('Subtype') && d.has('Rect'))
  for (const v of out) {
    const d = v instanceof Stream ? v.dict : v
    if (!(d instanceof Map)) continue
    for (const k of ['Metadata', 'PieceInfo', 'LastModified']) d.delete(k)
    if (isAnnot(d) && d.get('Subtype') !== N('Widget')) d.delete('T') // a widget's T is its field name
  }
  dropUnreachable(out)
}

// objects nothing points at any more (the XMP streams above) are written as null
function dropUnreachable(out) {
  const seen = new Set([1])
  const stack = [out[1]]
  while (stack.length) {
    const v = stack.pop()
    if (v instanceof Ref) {
      if (!seen.has(v.num)) {
        seen.add(v.num)
        stack.push(out[v.num])
      }
    } else if (Array.isArray(v)) stack.push(...v)
    else if (v instanceof Map) stack.push(...v.values())
    else if (v instanceof Stream) stack.push(v.dict)
  }
  for (let n = 1; n < out.length; n++) if (!seen.has(n)) out[n] = null
}

// encrypt: { password, ownerPassword?, print?, copy? }. Encrypts every string and stream in place
// and returns the trailer entries that point at the new /Encrypt dictionary.
async function encryptAll(out, { password, ...limits }) {
  const { dict, encrypt } = await makeEncryption(password, limits)
  const walk = async (x) => {
    if (x instanceof Str) return new Str(await encrypt(x.bytes))
    if (Array.isArray(x)) return Promise.all(x.map(walk))
    if (x instanceof Map) return new Map(await Promise.all([...x].map(async ([k, y]) => [k, await walk(y)])))
    return x
  }
  for (let n = 1; n < out.length; n++) {
    const v = out[n]
    out[n] = v instanceof Stream ? new Stream(await walk(v.dict), await encrypt(v.data)) : await walk(v)
  }
  const n = out.push(new Map([
    ['Filter', N('Standard')], ['V', 5], ['R', 6], ['Length', 256],
    ['CF', new Map([['StdCF', new Map([['AuthEvent', N('DocOpen')], ['CFM', N('AESV3')], ['Length', 32]])]])],
    ['StmF', N('StdCF')], ['StrF', N('StdCF')], ['P', dict.P], ['EncryptMetadata', true],
    ...['O', 'U', 'OE', 'UE', 'Perms'].map((k) => [k, new Str(dict[k])]),
  ])) - 1
  const id = new Str(globalThis.crypto.getRandomValues(new Uint8Array(16)))
  return new Map([['Encrypt', new Ref(n)], ['ID', [id, id]]])
}

// ---- images ----

async function canvasJpeg(canvas, quality) {
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer())
}

const imageDict = (w, h, colorSpace, filter) => new Map([
  ['Type', N('XObject')], ['Subtype', N('Image')], ['Width', w], ['Height', h],
  ['ColorSpace', N(colorSpace)], ['BitsPerComponent', 8], ['Filter', N(filter)],
])

const A4 = [595.28, 841.89]

// one A4 page, image fitted and centered, landscape when the image is wider
export async function imageToPdf(file) {
  let bmp
  try {
    bmp = await createImageBitmap(file) // applies EXIF rotation
  } catch {
    throw new Error('읽을 수 없는 이미지입니다 (JPG·PNG 권장)')
  }
  const { width: w, height: h } = bmp
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bmp, 0, 0)
  bmp.close()

  const out = [null, null, null, null, null]
  if (file.type === 'image/jpeg') {
    // ponytail: photos are re-encoded once so the EXIF rotation sticks
    out[5] = new Stream(imageDict(w, h, 'DeviceRGB', 'DCTDecode'), await canvasJpeg(canvas, 0.92))
  } else { // PNG, GIF, WebP, BMP: lossless, alpha as a soft mask
    const { rgb, alpha } = splitRgba(ctx.getImageData(0, 0, w, h).data, w, h)
    out[5] = new Stream(imageDict(w, h, 'DeviceRGB', 'FlateDecode'), await deflate(rgb))
    if (alpha) {
      out[6] = new Stream(imageDict(w, h, 'DeviceGray', 'FlateDecode'), await deflate(alpha))
      out[5].dict.set('SMask', new Ref(6))
    }
  }
  const [pw, ph] = w > h ? [A4[1], A4[0]] : A4
  const s = Math.min(pw / w, ph / h)
  const content = `q ${num(w * s)} 0 0 ${num(h * s)} ${num((pw - w * s) / 2)} ${num((ph - h * s) / 2)} cm /Im0 Do Q`
  out[1] = new Map([['Type', N('Catalog')], ['Pages', new Ref(2)]])
  out[2] = new Map([['Type', N('Pages')], ['Kids', [new Ref(3)]], ['Count', 1]])
  out[3] = new Map([
    ['Type', N('Page')], ['Parent', new Ref(2)], ['MediaBox', [0, 0, pw, ph]],
    ['Resources', new Map([['XObject', new Map([['Im0', new Ref(5)]])]])], ['Contents', new Ref(4)],
  ])
  out[4] = new Stream(new Map(), new TextEncoder().encode(content))
  return writePdf(out)
}

// a one-page PDF that is a single JPEG filling a w x h point page, with the page's own /Rotate
export function picturePage(jpeg, width, height, w, h, rotate = 0) {
  return writePdf([null,
    new Map([['Type', N('Catalog')], ['Pages', new Ref(2)]]),
    new Map([['Type', N('Pages')], ['Kids', [new Ref(3)]], ['Count', 1]]),
    new Map([
      ['Type', N('Page')], ['Parent', new Ref(2)], ['MediaBox', [0, 0, w, h]], ['Rotate', rotate],
      ['Resources', new Map([['XObject', new Map([['Im0', new Ref(5)]])]])], ['Contents', new Ref(4)],
    ]),
    new Stream(new Map(), new TextEncoder().encode(`q ${num(w)} 0 0 ${num(h)} 0 0 cm /Im0 Do Q`)),
    new Stream(imageDict(width, height, 'DeviceRGB', 'DCTDecode'), jpeg),
  ])
}

// [longest side in px, JPEG quality]. public/compress-guide.html explains these numbers: change both together.
export const LEVELS = { strong: [1200, 0.5], normal: [1800, 0.65], light: [2600, 0.8] }

// images we can re-encode: JPEG, or 8-bit Flate without predictor, in gray or RGB.
// Returns { flate, channels } or null.
function shrinkable(dict, get) {
  if (get(dict.get('Subtype')) !== N('Image')) return null
  let filter = get(dict.get('Filter'))
  if (Array.isArray(filter)) filter = filter.length === 1 ? get(filter[0]) : null
  const flate = filter === N('FlateDecode')
  if (!flate && filter !== N('DCTDecode')) return null
  if (flate && (get(dict.get('BitsPerComponent')) !== 8 || dict.has('DecodeParms'))) return null
  // color-key masks and Decode arrays don't survive lossy re-encoding
  if (Array.isArray(get(dict.get('Mask'))) || dict.has('Decode')) return null
  const cs = get(dict.get('ColorSpace'))
  const name = Array.isArray(cs) ? get(cs[0]) : cs
  // CMYK, Indexed, ... decode unreliably in the browser
  const channels = name === N('DeviceRGB') ? 3 : name === N('DeviceGray') ? 1
    : name === N('ICCBased') ? get(get(cs[1])?.dict?.get('N')) : 0
  return channels === 1 || channels === 3 ? { flate, channels } : null
}

async function flateToImageData(s, get, channels) {
  const w = get(s.dict.get('Width')), h = get(s.dict.get('Height'))
  const raw = await pipe(s.data, new DecompressionStream('deflate'))
  if (raw.length < w * h * channels) throw new Error('short image data')
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const p = i * channels, g = channels === 1
    rgba[i * 4] = raw[p]
    rgba[i * 4 + 1] = raw[g ? p : p + 1]
    rgba[i * 4 + 2] = raw[g ? p : p + 2]
    rgba[i * 4 + 3] = 255
  }
  return new ImageData(rgba, w, h)
}

// PDF viewers ignore EXIF orientation, so the browser's decoder must not apply it either
function stripExif(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b
  for (let p = 2; p + 4 <= b.length && b[p] === 0xff;) {
    const marker = b[p + 1], end = p + 2 + ((b[p + 2] << 8) | b[p + 3])
    if (marker === 0xda) break // start of scan
    if (marker === 0xe1) return concat([b.subarray(0, p), b.subarray(end)])
    p = end
  }
  return b
}

// ponytail: capped by pixel size rather than effective DPI on the page; predictor-encoded,
// CMYK and 1-bit images stay as they are. Add when users bring files that don't get smaller.
// An image is only replaced when the JPEG comes out smaller, so flat diagrams keep their Flate,
// unless gray asks for grayscale: then every image it can read is replaced.
async function shrinkImages(objects, [maxSide, quality], gray) {
  const get = (v) => (v instanceof Ref ? objects[v.num] : v)
  // soft masks must stay DeviceGray, and the canvas only writes RGB JPEGs
  const masks = new Set(objects.map((o) => o instanceof Stream && o.dict.get('SMask')).filter((r) => r instanceof Ref).map((r) => r.num))
  let saved = 0
  for (let n = 1; n < objects.length; n++) {
    const s = objects[n]
    const kind = s instanceof Stream && !masks.has(n) && shrinkable(s.dict, get)
    if (!kind) continue
    try {
      const bmp = await createImageBitmap(kind.flate
        ? await flateToImageData(s, get, kind.channels)
        : new Blob([stripExif(s.data)], { type: 'image/jpeg' }))
      const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
      const canvas = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k))
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
      bmp.close()
      if (gray) {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height), px = img.data
        for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = Math.round(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114)
        ctx.putImageData(img, 0, 0)
      }
      const jpeg = await canvasJpeg(canvas, quality)
      if (!gray && jpeg.length >= s.data.length) continue
      const d = new Map([...s.dict, ...imageDict(canvas.width, canvas.height, 'DeviceRGB', 'DCTDecode')])
      d.delete('DecodeParms')
      objects[n] = new Stream(d, jpeg)
      saved += s.data.length - jpeg.length
    } catch { /* the browser can't decode this one: keep it */ }
  }
  return saved
}

// move the items whose id is in `ids` (keeping their order) to insertion index `at` of `list`
export function moveItems(list, ids, at) {
  const rest = list.filter((x) => !ids.has(x.id))
  const before = list.slice(0, at).filter((x) => !ids.has(x.id)).length
  return [...rest.slice(0, before), ...list.filter((x) => ids.has(x.id)), ...rest.slice(before)]
}
