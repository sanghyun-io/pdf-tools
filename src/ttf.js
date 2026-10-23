// TrueType fonts from the PC (Local Font Access gives their files) made fit to embed in a PDF: one face read
// from a .ttf or a .ttc collection, text mapped to glyph ids through its cmap, and a subset that keeps only
// the glyphs used. Glyph ids stay as they are (the others are left empty), so the PDF can use them as CIDs
// with CIDToGIDMap /Identity. Tables per the OpenType spec; the PDF needs glyf, head, hhea, hmtx, loca, maxp
// and the hinting tables (ISO 32000-2 §9.9).
import { sfnt } from './glyphless.js'

const tag = (v, at) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3))

function tablesAt(v, at) {
  const tables = {}
  for (let i = 0, n = v.getUint16(at + 4); i < n; i++) {
    const r = at + 12 + 16 * i
    tables[tag(v, r)] = { offset: v.getUint32(r + 8), length: v.getUint32(r + 12) }
  }
  return tables
}

// the PostScript name (name ID 6) of a face
function psName(v, tables) {
  const t = tables.name
  if (!t) return ''
  const count = v.getUint16(t.offset + 2), strings = t.offset + v.getUint16(t.offset + 4)
  for (let i = 0; i < count; i++) {
    const r = t.offset + 6 + 12 * i
    if (v.getUint16(r + 6) !== 6) continue
    const platform = v.getUint16(r), len = v.getUint16(r + 8), off = strings + v.getUint16(r + 10)
    const bytes = new Uint8Array(v.buffer, v.byteOffset + off, len)
    return platform === 3 || platform === 0 ? new TextDecoder('utf-16be').decode(bytes) : String.fromCharCode(...bytes)
  }
  return ''
}

// codepoint -> glyph id, from the Windows Unicode cmap (format 12 for all of Unicode, else format 4)
function cmapOf(v, t) {
  const subs = []
  for (let i = 0, n = v.getUint16(t.offset + 2); i < n; i++) {
    const r = t.offset + 4 + 8 * i
    subs.push({ platform: v.getUint16(r), encoding: v.getUint16(r + 2), at: t.offset + v.getUint32(r + 4) })
  }
  const pick = subs.find((s) => s.platform === 3 && s.encoding === 10 && v.getUint16(s.at) === 12)
    ?? subs.find((s) => s.platform === 3 && s.encoding === 1 && v.getUint16(s.at) === 4)
    ?? subs.find((s) => s.platform === 0 && v.getUint16(s.at) === 4)
  if (!pick) return () => 0
  const at = pick.at
  if (v.getUint16(at) === 12) {
    const groups = []
    for (let i = 0, n = v.getUint32(at + 12); i < n; i++) {
      const g = at + 16 + 12 * i
      groups.push([v.getUint32(g), v.getUint32(g + 4), v.getUint32(g + 8)])
    }
    return (cp) => {
      let lo = 0, hi = groups.length - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, [start, end, gid] = groups[mid]
        if (cp < start) hi = mid - 1
        else if (cp > end) lo = mid + 1
        else return gid + cp - start
      }
      return 0
    }
  }
  const segs = v.getUint16(at + 6) / 2, ends = at + 14, starts = ends + 2 * segs + 2, deltas = starts + 2 * segs, ranges = deltas + 2 * segs
  return (cp) => {
    if (cp > 0xffff) return 0
    for (let i = 0; i < segs; i++) {
      if (cp > v.getUint16(ends + 2 * i)) continue
      const start = v.getUint16(starts + 2 * i)
      if (cp < start) return 0
      const range = v.getUint16(ranges + 2 * i)
      if (!range) return (cp + v.getInt16(deltas + 2 * i)) & 0xffff
      const g = v.getUint16(ranges + 2 * i + range + 2 * (cp - start))
      return g ? (g + v.getInt16(deltas + 2 * i)) & 0xffff : 0
    }
    return 0
  }
}

// One face of a font file, or null when it can't be embedded: outlines in CFF rather than glyf, or a
// licence that forbids embedding (OS/2 fsType: restricted, or bitmaps only).
// Returns { name, unitsPerEm, ascent, descent, capHeight, bbox, italicAngle, gid(cp), advance(gid), subset(gids) }.
export function readFont(bytes, postscriptName) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let tables = tablesAt(v, 0)
  if (tag(v, 0) === 'ttcf') { // a collection: the face with that PostScript name, else the first
    const faces = Array.from({ length: v.getUint32(8) }, (_, i) => tablesAt(v, v.getUint32(12 + 4 * i)))
    tables = faces.find((t) => psName(v, t) === postscriptName) ?? faces[0]
  }
  for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf', 'cmap']) if (!tables[t]) return null
  const os2 = tables['OS/2'], fsType = os2 ? v.getUint16(os2.offset + 8) : 0
  if ((fsType & 0x000f) === 0x0002 || fsType & 0x0200) return null
  const head = tables.head.offset, hhea = tables.hhea.offset
  const unitsPerEm = v.getUint16(head + 18), longLoca = v.getInt16(head + 50) === 1
  const numGlyphs = v.getUint16(tables.maxp.offset + 4), numMetrics = v.getUint16(hhea + 34)
  const loca = (g) => (longLoca ? v.getUint32(tables.loca.offset + 4 * g) : 2 * v.getUint16(tables.loca.offset + 2 * g))
  const glyph = (g) => new Uint8Array(v.buffer, v.byteOffset + tables.glyf.offset + loca(g), loca(g + 1) - loca(g))
  const k = 1000 / unitsPerEm
  const raw = (t) => new Uint8Array(v.buffer, v.byteOffset + tables[t].offset, tables[t].length)
  return {
    name: psName(v, tables).replace(/[^\x21-\x7e]|[[\](){}<>/%#]/g, '') || 'Font',
    unitsPerEm,
    ascent: v.getInt16(hhea + 4) * k,
    descent: v.getInt16(hhea + 6) * k,
    capHeight: os2 && v.getUint16(os2.offset) >= 2 ? v.getInt16(os2.offset + 88) * k : v.getInt16(hhea + 4) * k * 0.7,
    bbox: [36, 38, 40, 42].map((o) => v.getInt16(head + o) * k),
    italicAngle: tables.post ? v.getInt32(tables.post.offset + 4) / 65536 : 0,
    gid: cmapOf(v, tables.cmap),
    advance: (g) => v.getUint16(tables.hmtx.offset + 4 * Math.min(g, numMetrics - 1)) * k, // per 1000 em
    // the font with only glyph 0, these glyphs and the glyphs their composites are made of
    subset(gids) {
      const keep = new Set([0]), todo = [...gids]
      while (todo.length) {
        const g = todo.pop()
        if (keep.has(g) || g >= numGlyphs) continue
        keep.add(g)
        const d = glyph(g), gv = new DataView(d.buffer, d.byteOffset, d.byteLength)
        if (d.length < 10 || gv.getInt16(0) >= 0) continue
        for (let p = 10, flags; ; ) { // a composite: its parts, by their flags
          flags = gv.getUint16(p)
          todo.push(gv.getUint16(p + 2))
          p += 4 + (flags & 0x0001 ? 4 : 2) + (flags & 0x0008 ? 2 : flags & 0x0040 ? 4 : flags & 0x0080 ? 8 : 0)
          if (!(flags & 0x0020)) break
        }
      }
      const parts = [], offsets = new DataView(new ArrayBuffer(4 * (numGlyphs + 1)))
      let at = 0
      for (let g = 0; g < numGlyphs; g++) {
        offsets.setUint32(4 * g, at)
        if (!keep.has(g)) continue
        const d = glyph(g), padded = new Uint8Array(Math.ceil(d.length / 4) * 4)
        padded.set(d)
        parts.push(padded)
        at += padded.length
      }
      offsets.setUint32(4 * numGlyphs, at)
      const glyf = new Uint8Array(at)
      parts.reduce((p, b) => (glyf.set(b, p), p + b.length), 0)
      const headCopy = raw('head').slice()
      new DataView(headCopy.buffer).setInt16(50, 1) // long loca offsets
      const out = { head: headCopy, hhea: raw('hhea'), maxp: raw('maxp'), hmtx: raw('hmtx'), loca: new Uint8Array(offsets.buffer), glyf }
      for (const t of ['cvt ', 'fpgm', 'prep']) if (tables[t]) out[t] = raw(t)
      return sfnt(out)
    },
  }
}
