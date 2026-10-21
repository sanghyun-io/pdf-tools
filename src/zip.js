// Minimal ZIP writer for saving several files at once. Entries are stored, not compressed:
// PDFs, JPEGs and PNGs are compressed already. Names are UTF-8 (flag bit 11), so Korean names survive.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})

export function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// files: [{ name, bytes }] -> Uint8Array. ponytail: no ZIP64, so under 4 GB and 65535 entries
export function zip(files, now = new Date()) {
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const enc = new TextEncoder()
  const chunks = [], central = []
  let offset = 0
  for (const { name, bytes } of files) {
    const n = enc.encode(name), crc = crc32(bytes)
    // the fields shared by the local header (from byte 4) and the central directory entry (from byte 6)
    const common = (v, at) => {
      v.setUint16(at, 20, true) // version needed
      v.setUint16(at + 2, 0x0800, true) // UTF-8 names
      v.setUint16(at + 4, 0, true) // stored
      v.setUint16(at + 6, time, true)
      v.setUint16(at + 8, date, true)
      v.setUint32(at + 10, crc, true)
      v.setUint32(at + 14, bytes.length, true)
      v.setUint32(at + 18, bytes.length, true)
      v.setUint16(at + 22, n.length, true)
    }
    const local = new Uint8Array(30 + n.length), lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    common(lv, 4)
    local.set(n, 30)
    const entry = new Uint8Array(46 + n.length), cv = new DataView(entry.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    common(cv, 6)
    cv.setUint32(42, offset, true)
    entry.set(n, 46)
    chunks.push(local, bytes)
    central.push(entry)
    offset += local.length + bytes.length
  }
  const size = central.reduce((s, e) => s + e.length, 0)
  const end = new Uint8Array(22), ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, size, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + size + 22)
  let p = 0
  for (const c of [...chunks, ...central, end]) {
    out.set(c, p)
    p += c.length
  }
  return out
}
