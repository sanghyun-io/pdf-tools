// Fonts for text boxes and tables. Without asking: the common fonts this PC turns out to have. With the
// browser's permission (Local Font Access, Chrome and Edge): every installed font, and its file, so a box can
// be saved as real text with the glyphs it uses embedded (FontBook, ttf.js, embedFont in pdf.js).
import { readFont } from './ttf.js'

export const DEFAULT_FONT = 'Malgun Gothic'
const COMMON = [
  ['Malgun Gothic', '맑은 고딕'], ['Gulim', '굴림'], ['Dotum', '돋움'], ['Batang', '바탕'], ['Gungsuh', '궁서'],
  ['NanumGothic', '나눔고딕'], ['NanumMyeongjo', '나눔명조'], ['NanumBarunGothic', '나눔바른고딕'], ['NanumSquare', '나눔스퀘어'],
  ['Noto Sans KR', '본고딕 (Noto Sans KR)'], ['Noto Serif KR', '본명조 (Noto Serif KR)'], ['Apple SD Gothic Neo', '애플 SD 산돌고딕 Neo'], ['AppleMyungjo', '애플명조'],
  ['Arial', 'Arial'], ['Times New Roman', 'Times New Roman'], ['Georgia', 'Georgia'], ['Verdana', 'Verdana'], ['Courier New', 'Courier New'],
]
export const fontLabel = (family) => COMMON.find(([f]) => f === family)?.[1] ?? family

// Whether the PC has a font: text in it measures differently from the same text in each fallback font.
function installed(family) {
  const ctx = new OffscreenCanvas(1, 1).getContext('2d'), sample = 'mmmmwwwlli 가나다라 1234'
  return ['monospace', 'serif', 'sans-serif'].some((fallback) => {
    ctx.font = `40px ${fallback}`
    const plain = ctx.measureText(sample).width
    ctx.font = `40px "${family}", ${fallback}`
    return ctx.measureText(sample).width !== plain
  })
}
export const commonFonts = () => COMMON.map(([f]) => f).filter(installed)

export const canAskFonts = typeof window !== 'undefined' && 'queryLocalFonts' in window
let local = null // family -> FontData[], once the browser lets us see them
let pending = null // a look in progress (listing every font takes a few seconds): later callers wait for it

async function look(ask) {
  try {
    if (!ask && (await navigator.permissions.query({ name: 'local-fonts' })).state !== 'granted') return null
    const map = new Map()
    for (const f of await window.queryLocalFonts()) map.set(f.family, [...(map.get(f.family) ?? []), f])
    return map
  } catch {
    return null // refused, or not in this browser
  }
}

// Every installed font family (sorted), or null if not allowed. ask: show the browser's question (needs a
// click); otherwise only when it was allowed before.
export async function localFonts(ask) {
  if (!canAskFonts) return null
  if (!local) {
    pending ??= look(ask).finally(() => { pending = null })
    local = await pending
    if (!local && ask) local = await look(true) // the look in progress was a quiet one
    if (!local) return null
  }
  return [...local.keys()].sort((a, b) => fontLabel(a).localeCompare(fontLabel(b), 'ko'))
}

// The faces of the fonts used, read once, with the glyphs used so far: what a save embeds.
export class FontBook {
  faces = new Map() // "family|b" -> promise of { key, font, synthetic, used: Map gid -> text } or null

  // The face for text in that family and weight, or null when its file can't be had or embedded. Boxes ask
  // at the same time: they share one load, so every glyph is noted in the one face that is embedded.
  face(family, bold) {
    const key = `${family}|${bold ? 'b' : ''}`
    if (!this.faces.has(key)) this.faces.set(key, this.#load(key, family, bold))
    return this.faces.get(key)
  }

  async #load(key, family, bold) {
    const list = local?.get(family)
    if (!list) return null
    const regular = list.find((f) => /^(regular|normal|book|roman)$/i.test(f.style)) ?? list[0]
    const real = bold && list.find((f) => /^bold$/i.test(f.style)) // else drawn bolder (synthetic)
    const data = real || regular
    try {
      const font = readFont(new Uint8Array(await (await data.blob()).arrayBuffer()), data.postscriptName)
      return font && { key, font, synthetic: bold && !real, used: new Map() }
    } catch {
      return null
    }
  }

  // text as glyph ids in a face, noted as used; null if the face lacks one of its characters
  glyphs(face, text) {
    const gids = []
    for (const ch of text) {
      const g = face.font.gid(ch.codePointAt(0))
      if (!g && ch.trim()) return null
      gids.push(g)
      if (g && !face.used.has(g)) face.used.set(g, ch)
    }
    return gids
  }

  // what embedFont (pdf.js) writes for a face: its subset and the widths and characters of the glyphs used
  async data(key) {
    const { font, used } = await this.faces.get(key)
    return { name: font.name, file: font.subset([...used.keys()]), used, width: font.advance, ascent: font.ascent, descent: font.descent, capHeight: font.capHeight, bbox: font.bbox, italicAngle: font.italicAngle }
  }
}
