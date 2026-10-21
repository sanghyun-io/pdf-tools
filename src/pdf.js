// Self-made PDF reader/writer: just enough to merge, reorder, rotate and drop pages,
// turn images into pages and shrink JPEG images. No rendering, no encryption.
//
// Reading follows pdf-lib's approach (found with REA): ignore the xref table and scan the
// whole file for "N G obj" definitions, later definitions winning. Broken xref tables and
// incremental updates then need no special handling.

import { makeCipher, concat } from './decrypt.js'
export { PasswordError } from './decrypt.js'

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

// size in points (CropBox, else MediaBox) and the page's own rotation
export function pageInfo(doc, i) {
  const { attrs } = doc.pages[i]
  const box = doc.get(attrs.CropBox ?? attrs.MediaBox)
  const [x0, y0, x1, y1] = Array.isArray(box) && box.length === 4 ? box.map((v) => Number(doc.get(v)) || 0) : [0, 0, 612, 792]
  return { w: Math.abs(x1 - x0) || 612, h: Math.abs(y1 - y0) || 792, rotate: norm(Number(doc.get(attrs.Rotate)) || 0) }
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
function writePdf(objects) {
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
  push(`trailer\n<</Size ${objects.length} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`)
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

// parts: [{ doc, index, rotate }] in output order; level: key of LEVELS or null
export async function buildPdf(parts, level) {
  const out = [null, null, null] // 1 catalog, 2 page tree
  const alloc = () => out.push(null) - 1
  const state = new Map() // doc -> { pages: srcNum -> newNum, copied: srcNum -> newNum }
  const st = (doc) => state.get(doc) ?? state.set(doc, { pages: new Map(), copied: new Map() }).get(doc)
  const slots = parts.map(({ doc, index }) => {
    const n = alloc()
    const { ref } = doc.pages[index]
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

  parts.forEach(({ doc, index, rotate }, i) => {
    const page = doc.pages[index]
    const d = copy(doc, page.dict)
    for (const k of INHERITED) if (page.attrs[k] !== undefined) d.set(k, copy(doc, page.attrs[k]))
    d.set('Parent', new Ref(2))
    d.set('Rotate', norm((Number(doc.get(page.attrs.Rotate)) || 0) + rotate))
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

  const docs = [...new Set(parts.map((p) => p.doc))]
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

  const saved = level ? await shrinkImages(out, level) : 0
  return { bytes: writePdf(out), saved }
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
    const px = ctx.getImageData(0, 0, w, h).data
    const rgb = new Uint8Array(w * h * 3), alpha = new Uint8Array(w * h)
    let opaque = true
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = px[i * 4]
      rgb[i * 3 + 1] = px[i * 4 + 1]
      rgb[i * 3 + 2] = px[i * 4 + 2]
      alpha[i] = px[i * 4 + 3]
      if (alpha[i] < 255) opaque = false
    }
    out[5] = new Stream(imageDict(w, h, 'DeviceRGB', 'FlateDecode'), await deflate(rgb))
    if (!opaque) {
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
// An image is only replaced when the JPEG comes out smaller, so flat diagrams keep their Flate.
async function shrinkImages(objects, level) {
  const [maxSide, quality] = LEVELS[level]
  const get = (v) => (v instanceof Ref ? objects[v.num] : v)
  let saved = 0
  for (let n = 1; n < objects.length; n++) {
    const s = objects[n]
    const kind = s instanceof Stream && shrinkable(s.dict, get)
    if (!kind) continue
    try {
      const bmp = await createImageBitmap(kind.flate
        ? await flateToImageData(s, get, kind.channels)
        : new Blob([stripExif(s.data)], { type: 'image/jpeg' }))
      const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
      const canvas = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k))
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
      bmp.close()
      const jpeg = await canvasJpeg(canvas, quality)
      if (jpeg.length >= s.data.length) continue
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
