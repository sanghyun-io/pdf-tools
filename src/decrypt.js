// PDF Standard security handler, decryption only (ISO 32000-2 §7.6): RC4 40/128, AES-128, AES-256.
// MD5 and RC4 are written here; SHA-2 and AES come from the browser's WebCrypto.

export class PasswordError extends Error {
  constructor(wrong) {
    super(wrong ? '암호가 틀렸습니다' : '열기 암호가 필요합니다')
    this.wrong = wrong
  }
}

const subtle = globalThis.crypto.subtle

export function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let p = 0
  for (const c of chunks) { out.set(c, p); p += c.length }
  return out
}

const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)

// RFC 1321
export function md5(data) {
  const size = (((data.length + 8) >>> 6) + 1) * 64
  const buf = new Uint8Array(size)
  buf.set(data)
  buf[data.length] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(size - 8, (data.length * 8) >>> 0, true)
  view.setUint32(size - 4, Math.floor((data.length * 8) / 2 ** 32), true)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let off = 0; off < size; off += 64) {
    let a = a0, b = b0, c = c0, d = d0
    for (let i = 0; i < 64; i++) {
      let f, g
      if (i < 16) { f = (b & c) | (~b & d); g = i }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { f = c ^ (b | ~d); g = (7 * i) % 16 }
      const x = (a + f + K[i] + view.getUint32(off + g * 4, true)) | 0
      const s = S[(i >> 4) * 4 + (i % 4)]
      a = d
      d = c
      c = b
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }
  const out = new Uint8Array(16)
  const ov = new DataView(out.buffer)
  ;[a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v >>> 0, true))
  return out
}

export function rc4(key, data) {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i)
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255
    const t = s[i]; s[i] = s[j]; s[j] = t
  }
  const out = new Uint8Array(data.length)
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255
    j = (j + s[i]) & 255
    const t = s[i]; s[i] = s[j]; s[j] = t
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255]
  }
  return out
}

const aesKey = (key) => subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt', 'decrypt'])

// data = 16-byte IV + ciphertext with PKCS#7 padding, as PDF stores it
async function aesDecrypt(key, data) {
  if (data.length < 32 || data.length % 16) return new Uint8Array(0)
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: data.subarray(0, 16) }, await aesKey(key), data.subarray(16)))
  } catch {
    return new Uint8Array(0) // bad padding: treat as empty rather than fail the whole file
  }
}

// AES-CBC without padding, which WebCrypto doesn't offer directly
async function aesRaw(mode, key, iv, data) {
  const k = await aesKey(key)
  if (mode === 'encrypt') return new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, k, data)).subarray(0, data.length)
  // append the encryption of a full padding block so decrypt's padding check passes
  const pad = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: data.subarray(-16) }, k, new Uint8Array(0)))
  return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, k, concat([data, pad])))
}

const sha = async (alg, data) => new Uint8Array(await subtle.digest(alg, data))

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

// Algorithms 2 and 6 (R2-R4)
function legacyKey(p, password) {
  // ponytail: password as Latin-1 bytes; non-Latin passwords on RC4/AES-128 files won't match
  const pw = Uint8Array.from(password.slice(0, 32), (c) => c.charCodeAt(0) & 255)
  const perms = new Uint8Array(4)
  new DataView(perms.buffer).setInt32(0, p.P, true)
  const n = p.R === 2 ? 5 : p.V >= 4 ? 16 : p.length / 8
  let h = md5(concat([pw, PAD.subarray(0, 32 - pw.length), p.O.subarray(0, 32), perms, p.id,
    p.R >= 4 && !p.encryptMetadata ? Uint8Array.of(255, 255, 255, 255) : new Uint8Array(0)]))
  if (p.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n))
  const key = h.subarray(0, n)
  let check
  if (p.R === 2) check = equal(rc4(key, PAD), p.U.subarray(0, 32))
  else {
    let x = rc4(key, md5(concat([PAD, p.id])))
    for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x)
    check = equal(x, p.U.subarray(0, 16))
  }
  if (!check) throw new PasswordError(password !== '')
  return key
}

// Algorithm 2.B (R6; R5 is the plain SHA-256 that came before it)
async function hash2B(pw, salt, R) {
  let k = await sha('SHA-256', concat([pw, salt]))
  if (R === 5) return k
  let e = new Uint8Array(0)
  for (let i = 0; i < 64 || e.at(-1) > i - 32; i++) {
    const block = concat([pw, k])
    const k1 = new Uint8Array(block.length * 64)
    for (let j = 0; j < 64; j++) k1.set(block, j * block.length)
    e = await aesRaw('encrypt', k.subarray(0, 16), k.subarray(16, 32), k1)
    k = await sha(['SHA-256', 'SHA-384', 'SHA-512'][e.subarray(0, 16).reduce((s, b) => s + b, 0) % 3], e)
  }
  return k.subarray(0, 32)
}

// Algorithms 2.A and 11 (R5, R6), user password only
async function aes256Key(p, password) {
  const pw = new TextEncoder().encode(password).subarray(0, 127)
  if (!equal(await hash2B(pw, p.U.subarray(32, 40), p.R), p.U.subarray(0, 32))) throw new PasswordError(password !== '')
  return aesRaw('decrypt', await hash2B(pw, p.U.subarray(40, 48), p.R), new Uint8Array(16), p.UE.subarray(0, 32))
}

// p: { V, R, O, U, UE, P, length, id, encryptMetadata, stmf, strf } with stmf/strf in RC4 | AESV2 | AESV3 | null.
// Throws PasswordError when the password doesn't open the file.
// Returns { stream, string }: (bytes, objNum, gen) => Promise<bytes>, or null when that kind isn't encrypted.
export async function makeCipher(p, password) {
  const key = p.R >= 5 ? await aes256Key(p, password) : legacyKey(p, password)
  const objectKey = (num, gen, salt) => md5(concat([key,
    Uint8Array.of(num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255),
    salt ? Uint8Array.of(0x73, 0x41, 0x6c, 0x54) : new Uint8Array(0)])).subarray(0, Math.min(key.length + 5, 16))
  const make = (method) => {
    if (method === 'RC4') return async (data, num, gen) => rc4(objectKey(num, gen, false), data)
    if (method === 'AESV2') return (data, num, gen) => aesDecrypt(objectKey(num, gen, true), data)
    if (method === 'AESV3') return (data) => aesDecrypt(key, data)
    return null
  }
  return { stream: make(p.stmf), string: make(p.strf) }
}
