// Resizing an 8-bit gray line picture to the network's height, the way Tesseract's image library (Leptonica
// 1.84.1 pixScale on 8 bpp) does it, so the network sees the same pixels: area averaging below 0.7x, bilinear
// above, exact 2x/4x enlargement, 2x2 averaging for 1/2^n, and an unsharp mask on the in-between factors.
// Integer division truncates toward zero as in C; float32 steps use Math.fround (scale1.c, enhance.c).

const f32 = Math.fround

// gray: Uint8Array w*h, row by row. Returns { gray, w, h }.
export function scaleGray(gray, w, h, factor) {
  const f = f32(factor)
  if (f === 1) return { gray: gray.slice(), w, h }
  let out
  if (f === 0.5 || f === 0.25 || f === 0.125 || f === 0.0625) {
    out = { gray, w, h }
    for (let k = f; k < 1; k *= 2) out = half(out.gray, out.w, out.h)
  } else if (f === 2 || f === 4) return enlarge(gray, w, h, f)
  else {
    const wd = Math.trunc(f32(f * w) + 0.5), hd = Math.trunc(f32(f * h) + 0.5)
    out = f < 0.7 ? areaMap(gray, w, h, wd, hd) : bilinear(gray, w, h, wd, hd)
  }
  if (f < 0.7 ? f > 0.2 : f < 1.4) out.gray = unsharp(out.gray, out.w, out.h, f < 0.7 ? 1 : 2, f < 0.7 ? 0.2 : 0.4)
  return out
}

// pixScaleAreaMap2: plain 2x2 average
function half(s, ws, hs) {
  const w = ws >> 1, h = hs >> 1, d = new Uint8Array(w * h)
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < w; j++) {
      const a = 2 * i * ws + 2 * j
      d[i * w + j] = (s[a] + s[a + 1] + s[a + ws] + s[a + ws + 1]) >> 2
    }
  }
  return { gray: d, w, h }
}

// scaleGrayLILow: bilinear in 1/16 pixel steps
function bilinear(s, ws, hs, wd, hd) {
  const d = new Uint8Array(wd * hd)
  const scx = f32(f32(16 * ws) / wd), scy = f32(f32(16 * hs) / hd)
  for (let i = 0; i < hd; i++) {
    const ypm = Math.trunc(f32(scy * i)), yp = ypm >> 4, yf = ypm & 15
    for (let j = 0; j < wd; j++) {
      const xpm = Math.trunc(f32(scx * j)), xp = xpm >> 4, xf = xpm & 15
      const r = yp * ws, v00 = s[r + xp]
      let v10, v01, v11
      const right = xp > ws - 2, bottom = yp > hs - 2
      if (right && bottom) v10 = v01 = v11 = v00
      else if (right) { v10 = v00; v01 = v11 = s[r + ws + xp] }
      else if (bottom) { v01 = v00; v10 = v11 = s[r + xp + 1] }
      else { v10 = s[r + xp + 1]; v01 = s[r + ws + xp]; v11 = s[r + ws + xp + 1] }
      d[i * wd + j] = Math.trunc(((16 - xf) * (16 - yf) * v00 + xf * (16 - yf) * v10 + (16 - xf) * yf * v01 + xf * yf * v11 + 128) / 256)
    }
  }
  return { gray: d, w: wd, h: hd }
}

// scaleGrayAreaMapLow: each target pixel averages the source area it covers, in 1/16 pixel steps
function areaMap(s, ws, hs, wd, hd) {
  const d = new Uint8Array(wd * hd)
  const scx = f32(f32(16 * ws) / wd), scy = f32(f32(16 * hs) / hd)
  for (let i = 0; i < hd; i++) {
    const yu = Math.trunc(f32(scy * i)), yl = Math.trunc(scy * (i + 1.0))
    const yup = yu >> 4, yuf = yu & 15, ylp = yl >> 4, ylf = yl & 15, dely = ylp - yup
    for (let j = 0; j < wd; j++) {
      const xu = Math.trunc(f32(scx * j)), xl = Math.trunc(scx * (j + 1.0))
      const xup = xu >> 4, xuf = xu & 15, xlp = xl >> 4, xlf = xl & 15, delx = xlp - xup
      if (xlp > ws - 2 || ylp > hs - 2) {
        d[i * wd + j] = s[yup * ws + xup]
        continue
      }
      const area = ((16 - xuf) + 16 * (delx - 1) + xlf) * ((16 - yuf) + 16 * (dely - 1) + ylf)
      const at = (y, x) => s[y * ws + x]
      let sum = (16 - xuf) * (16 - yuf) * at(yup, xup) + xlf * (16 - yuf) * at(yup, xlp)
        + (16 - xuf) * ylf * at(ylp, xup) + xlf * ylf * at(ylp, xlp)
      for (let k = 1; k < dely; k++) {
        for (let m = 1; m < delx; m++) sum += 256 * at(yup + k, xup + m)
        sum += (16 - xuf) * 16 * at(yup + k, xup) + xlf * 16 * at(yup + k, xlp)
      }
      for (let m = 1; m < delx; m++) sum += 16 * (16 - yuf) * at(yup, xup + m) + 16 * ylf * at(ylp, xup + m)
      d[i * wd + j] = Math.trunc((sum + 128) / area)
    }
  }
  return { gray: d, w: wd, h: hd }
}

// pixScaleGray2xLI / 4xLI
function enlarge(s, ws, hs, k) {
  const w = ws * k, h = hs * k, d = new Uint8Array(w * h)
  for (let i = 0; i < hs; i++) {
    for (let j = 0; j < ws; j++) {
      const s1 = s[i * ws + j], s2 = j < ws - 1 ? s[i * ws + j + 1] : s1
      const s3 = i < hs - 1 ? s[(i + 1) * ws + j] : s1, s4 = i < hs - 1 ? (j < ws - 1 ? s[(i + 1) * ws + j + 1] : s3) : s2
      for (let a = 0; a < k; a++) {
        for (let b = 0; b < k; b++) {
          d[(k * i + a) * w + k * j + b] = Math.trunc(((k - a) * (k - b) * s1 + (k - a) * b * s2 + a * (k - b) * s3 + a * b * s4) / (k * k))
        }
      }
    }
  }
  return { gray: d, w, h }
}

// pixUnsharpMaskingGray2D: d = s + fract * (s - mean of the (2hw+1)^2 box); the hw-wide border stays as it was
function unsharp(s, w, h, hw, fract) {
  const d = s.slice()
  const F = new Float32Array(w * h)
  for (let i = 0; i < h; i++) {
    for (let j = hw; j < w - hw; j++) {
      let sum = 0
      for (let k = -hw; k <= hw; k++) sum += s[i * w + j + k]
      F[i * w + j] = sum
    }
  }
  const norm = f32(1 / ((2 * hw + 1) * (2 * hw + 1))), fr = f32(fract)
  for (let i = hw; i < h - hw; i++) {
    for (let j = hw; j < w - hw; j++) {
      let acc = F[(i - hw) * w + j]
      for (let k = -hw + 1; k <= hw; k++) acc = f32(acc + F[(i + k) * w + j])
      const L = f32(norm * acc), v = s[i * w + j]
      const ival = Math.trunc(f32(v + f32(fr * f32(v - L))) + 0.5)
      d[i * w + j] = ival < 0 ? 0 : ival > 255 ? 255 : ival
    }
  }
  return d
}
