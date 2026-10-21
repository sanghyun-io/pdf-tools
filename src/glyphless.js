// A TrueType font with no visible glyphs, for the invisible text layer that OCR adds: every character is one
// empty glyph half an em wide. Only the PDF needs a real font program for its text; nothing is ever drawn.
// Tables follow the OpenType spec (head, hhea, maxp, hmtx, loca, glyf, cmap, name, OS/2, post).

const be = (bytes) => {
  const v = new DataView(new ArrayBuffer(bytes.length * 2))
  bytes.forEach((n, i) => v.setUint16(i * 2, n & 0xffff))
  return new Uint8Array(v.buffer)
}
const u32 = (n) => [(n >>> 16) & 0xffff, n & 0xffff]

function checksum(b) {
  let sum = 0
  for (let i = 0; i < b.length; i += 4) sum = (sum + (((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0)) >>> 0
  return sum
}

export const GLYPH_WIDTH = 500 // per 1000 units

export function glyphlessFont() {
  const name = (id, s) => ({ id, s: be([...s].map((c) => c.charCodeAt(0))) })
  const names = [name(1, 'GlyphLessFont'), name(2, 'Regular'), name(4, 'GlyphLessFont'), name(6, 'GlyphLessFont')]
  let strOffset = 0
  const nameRecords = names.flatMap(({ id, s }) => {
    const r = [3, 1, 0x409, id, s.length, strOffset]
    strOffset += s.length
    return r
  })
  const tables = {
    'OS/2': be([1, GLYPH_WIDTH, 400, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50, 300, 0, // version .. sFamilyClass (86 bytes in all)
      0, 0, 0, 0, 0, // panose (10 bytes)
      ...u32(0), ...u32(0), ...u32(0), ...u32(0), // unicode ranges
      0x4e4f, 0x4e45, // achVendID "NONE"
      0x40, 0, 0xffff, 1000, 0, 0, 1000, 0, // fsSelection, first/last char, typo asc/desc/gap, win asc/desc
      ...u32(1), ...u32(0)]), // code page ranges
    cmap: be([0, 1, 3, 1, ...u32(12), // one Windows Unicode subtable, format 4 mapping nothing
      4, 24, 0, 2, 2, 0, 0, 0xffff, 0, 0xffff, 1, 0]),
    glyf: be([0, 0, 0, 0, 0, 0]), // glyph 1: a header with no contours, padded (glyph 0 takes no bytes)
    head: be([1, 0, 1, 0, 0, 0, 0x5f0f, 0x3cf5, 0x000b, 1000, 0, 0, 0, 0, 0, 0, 0, 0, // .. unitsPerEm, dates
      0, 0, GLYPH_WIDTH, 1000, 0, 8, 2, 0, 0]), // bbox, macStyle, lowestRecPPEM, direction, short loca, format
    hhea: be([1, 0, 1000, 0, 0, GLYPH_WIDTH, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2]),
    hmtx: be([GLYPH_WIDTH, 0, GLYPH_WIDTH, 0]),
    loca: be([0, 0, 6]), // offsets / 2: glyph 0 empty, glyph 1 the 12 bytes above
    maxp: be([1, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]),
    name: new Uint8Array([...be([0, names.length, 6 + 12 * names.length, ...nameRecords]), ...names.flatMap(({ s }) => [...s])]),
    post: be([3, 0, 0, 0, -100, 50, ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0)]),
  }
  const tags = Object.keys(tables).sort()
  const dir = new DataView(new ArrayBuffer(12 + 16 * tags.length))
  dir.setUint32(0, 0x00010000)
  dir.setUint16(4, tags.length)
  const pow = 2 ** Math.floor(Math.log2(tags.length))
  dir.setUint16(6, pow * 16)
  dir.setUint16(8, Math.log2(pow))
  dir.setUint16(10, tags.length * 16 - pow * 16)
  const padded = tags.map((t) => {
    const b = new Uint8Array(Math.ceil(tables[t].length / 4) * 4)
    b.set(tables[t])
    return b
  })
  let offset = 12 + 16 * tags.length
  tags.forEach((t, i) => {
    const at = 12 + 16 * i
    for (let k = 0; k < 4; k++) dir.setUint8(at + k, t.charCodeAt(k))
    dir.setUint32(at + 4, checksum(padded[i]))
    dir.setUint32(at + 8, offset)
    dir.setUint32(at + 12, tables[t].length)
    offset += padded[i].length
  })
  const font = new Uint8Array(offset)
  font.set(new Uint8Array(dir.buffer))
  let p = 12 + 16 * tags.length
  for (const b of padded) {
    font.set(b, p)
    p += b.length
  }
  // head.checkSumAdjustment makes the whole font sum to 0xB1B0AFBA
  const headAt = new DataView(dir.buffer).getUint32(12 + 16 * tags.indexOf('head') + 8)
  new DataView(font.buffer).setUint32(headAt + 8, (0xb1b0afba - checksum(font)) >>> 0)
  return font
}
