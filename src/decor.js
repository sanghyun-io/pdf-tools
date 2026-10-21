// Images and text turned into pixels for decorate() in pdf.js: stamps, signatures, text boxes, watermarks.
// Text is drawn into a picture with the PC's own fonts, so Korean works without shipping a font file.
import { splitRgba } from './pdf.js'

export const PX_PER_PT = 4 // text pictures at about 290 dpi: sharp in print

// Boxes are fractions of the page as shown (origin top-left). turnBox gives the same box once the page
// is turned a quarter clockwise `n` times; steps counts the quarter turns from one rotation to another.
export const steps = (from, to) => ((((to - from) / 90) % 4) + 4) % 4
export function turnBox(b, n) {
  for (let i = 0; i < n; i++) b = { x: 1 - b.y - b.h, y: b.x, w: b.h, h: b.w }
  return b
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

// text, size in points; lines split on \n; turned `angle` degrees counterclockwise
export async function textPixels(text, { size = 12, color = '#000000', opacity = 1, angle = 0, bold = false } = {}) {
  const px = size * PX_PER_PT, font = `${bold ? 'bold ' : ''}${px}px ${FONT}`, lineH = px * 1.35
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
