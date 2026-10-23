import { useEffect, useRef, useState } from 'react'
import { readPdf, buildPdf, imageToPdf, picturePage, pageInfo, pageBox, moveItems, PasswordError } from './pdf.js'
import { renderThumbs, renderPages, openPages } from './render.js'
import { prepare, recognize, textLayer } from './ocr/client.js'
import { imagePixels, textPixels, turnBox, steps, textBoxPixels, tablePixels } from './decor.js'
import { zip } from './zip.js'
import { inAppBrowser } from './inapp.js'
import Editor from './Editor.jsx'
import Compare from './Compare.jsx'
import guideHtml from '../public/compress-guide.html?raw' // srcDoc: the single-file build has no file to point at

const IN_APP = inAppBrowser(navigator.userAgent, location.href)
const GUIDE_URL = `${import.meta.env.BASE_URL}compress-guide.html`
const HUES = [210, 20, 140, 280, 45, 330, 170, 100]
const UNDO_LIMIT = 50
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
const stem = (name) => name.replace(/\.[^.]+$/, '')
const size = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const pad = (i, total) => String(i).padStart(String(total).length, '0')

const LEVEL_NAMES = { lossless: '무손실 (화질 그대로)', light: '약', normal: '보통', strong: '강' }
const LAYOUTS = { 1: 'A4로 맞추기', 2: '2쪽씩 한 장에', 4: '4쪽씩 한 장에' }
const POSITIONS = { bc: '아래 가운데', br: '아래 오른쪽', bl: '아래 왼쪽', tc: '위 가운데', tr: '위 오른쪽', tl: '위 왼쪽' }
const FORMATS = { n: '1', of: '1 / 10', dash: '- 1 -' }
const OPACITY = { 0.15: '연하게', 0.3: '보통', 0.5: '진하게' }
const REDACT_DPI = 200 // a redacted page becomes a picture this sharp
const CROP_DPI = 50 // enough to find where the white margins end
const OCR_DPI = 200 // 10 pt text is about 28 px tall: plenty, as lines are scaled to the network's 36-48 px

function download(bytes, name, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  Object.assign(document.createElement('a'), { href: url, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// asks for the open password until it fits or the user skips the file
async function openPdf(bytes, name, askPassword) {
  for (let password = ''; ;) {
    try {
      return { doc: await readPdf(bytes, password), password }
    } catch (e) {
      if (!(e instanceof PasswordError)) throw e
      const next = await askPassword(name, e.wrong)
      if (next === null) throw new Error('암호를 입력하지 않아 건너뛰었습니다')
      password = next
    }
  }
}

// <dialog> opened as a modal as soon as it mounts; StrictMode may call this twice, hence the open check.
// showModal() focuses the first focusable child (an iframe would swallow Esc), so focus [data-focus] after it.
const showModal = (el) => {
  if (!el || el.open) return
  el.showModal()
  el.querySelector('[data-focus]')?.focus()
}

export default function App() {
  // append-only so pages, undo history and thumbnails can point at an index
  const sources = useRef([]) // { name, doc, hue, bytes, password }
  const nextId = useRef(0)
  const dragging = useRef(null) // ids being dragged
  const thumbQueue = useRef(Promise.resolve()) // one file's thumbnails at a time
  const crops = useRef(new Map()) // "src:index" -> crop box without the white margins (null: blank page)
  const ocrCache = useRef(new Map()) // "src:index:rotation" -> text layer (null: the page had text)
  const ocrPages = useRef(0) // pages read in the current save, for the progress line
  const blackPages = useRef(new Set()) // pages (as numbered on screen) drawn pure black in the current save
  const [progress, setProgress] = useState(null)
  const [pages, setPages] = useState([]) // { id, src, index, rotate, w, h, base, overlays? } or { id, blank, w, h, ... }
  const [history, setHistory] = useState([]) // earlier `pages` arrays, for undo
  const [thumbs, setThumbs] = useState({}) // "src:index" -> image URL
  const [selected, setSelected] = useState(new Set())
  const [anchor, setAnchor] = useState(null)
  const [dropAt, setDropAt] = useState(null)
  const [opts, setOpts] = useState({
    level: '', numbers: '', format: 'of', start: 1,
    mark: '', markText: '대외비', markFile: null, opacity: 0.3,
    scope: 'all', out: 'pdf', split: 'each', splitN: 2, imageType: 'jpeg', dpi: 150,
    password: '', noPrint: false, noCopy: false, strip: false, flatten: false,
    gray: false, impose: '', autocrop: false, ocr: false,
  })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  // an in-page password form: in-app browsers may block window.prompt
  const [ask, setAsk] = useState(null) // { name, wrong, resolve }
  const [guide, setGuide] = useState(false) // compression guide in a dialog: a new tab may not open in-app
  const [editing, setEditing] = useState(null) // page id in the editor
  const [comparing, setComparing] = useState(null) // the files offered, fixed while the dialog is open
  const [inAppNotice, setInAppNotice] = useState(!!IN_APP)

  const option = (key, parse = String) => (e) => setOpts((o) => ({ ...o, [key]: parse(e.target.value) }))
  const flag = (key) => (e) => setOpts((o) => ({ ...o, [key]: e.target.checked }))
  const askPassword = (name, wrong) => new Promise((resolve) => setAsk({ name, wrong, resolve }))
  const answer = (value) => {
    ask.resolve(value)
    setAsk(null)
  }

  const remember = () => setHistory((h) => [...h.slice(1 - UNDO_LIMIT), pages])
  const commit = (next) => {
    remember()
    setPages(next)
  }
  const undo = () => {
    if (!history.length) return
    setPages(history.at(-1))
    setHistory((h) => h.slice(0, -1))
    setSelected(new Set())
  }

  async function addFiles(list) {
    setBusy(true)
    setMessage(null)
    remember() // one undo step per batch of files
    const errors = []
    for (const file of list) {
      try {
        if (!isPdf(file) && !file.type.startsWith('image/')) throw new Error('PDF나 이미지 파일이 아닙니다')
        const bytes = isPdf(file) ? new Uint8Array(await file.arrayBuffer()) : await imageToPdf(file)
        const { doc, password } = await openPdf(bytes, file.name, askPassword)
        const src = sources.current.push({ name: file.name, doc, hue: HUES[sources.current.length % HUES.length], bytes, password }) - 1
        const added = doc.pages.map((_, index) => {
          const { w, h, rotate } = pageInfo(doc, index)
          return { id: nextId.current++, src, index, rotate: 0, w, h, base: rotate }
        })
        setPages((ps) => [...ps, ...added])
        thumbQueue.current = thumbQueue.current.then(() =>
          renderThumbs(bytes, password, (index, url) => setThumbs((t) => ({ ...t, [`${src}:${index}`]: url }))))
      } catch (e) {
        errors.push(`${file.name}: ${e.message}`)
      }
    }
    setBusy(false)
    if (errors.length) setMessage({ error: true, text: errors.join('\n') })
  }

  function clickPage(e, id) {
    e.stopPropagation()
    const ids = pages.map((p) => p.id)
    const from = ids.indexOf(anchor), to = ids.indexOf(id)
    if (e.shiftKey && from >= 0) {
      const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1)
      setSelected((s) => new Set(e.ctrlKey || e.metaKey ? [...s, ...range] : range))
      return
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const next = new Set(s)
        if (!next.delete(id)) next.add(id)
        return next
      })
    } else setSelected(new Set([id]))
    setAnchor(id)
  }

  // rotate accumulates past 360 so the CSS transition keeps turning the same way; buildPdf normalizes it
  const rotateSelected = (deg) =>
    commit(pages.map((p) => (selected.has(p.id) ? { ...p, rotate: p.rotate + deg } : p)))
  const removeSelected = () => {
    if (!selected.size) return
    commit(pages.filter((p) => !selected.has(p.id)))
    setSelected(new Set())
  }
  // a blank page after the last selected one (or at the end), shaped like the page before it as shown
  const addBlank = () => {
    const at = selected.size ? Math.max(...pages.map((p, i) => (selected.has(p.id) ? i : -1))) + 1 : pages.length
    const near = pages[at - 1] ?? pages[0]
    const turned = near && (((near.base + near.rotate) % 180) + 180) % 180 !== 0
    const blank = { id: nextId.current++, blank: true, w: turned ? near.h : near.w, h: turned ? near.w : near.h, base: 0, rotate: 0 }
    commit([...pages.slice(0, at), blank, ...pages.slice(at)])
    setSelected(new Set([blank.id]))
    setAnchor(blank.id)
  }
  // a document from nothing: one blank A4 page, straight into the page editor
  const newDocument = (landscape) => {
    const [w, h] = landscape ? [841.89, 595.28] : [595.28, 841.89]
    const blank = { id: nextId.current++, blank: true, w, h, base: 0, rotate: 0 }
    commit([blank])
    setSelected(new Set([blank.id]))
    setEditing(blank.id)
  }
  const clearAll = () => {
    commit([]) // undoable, so the loaded files stay in memory
    setSelected(new Set())
    setMessage(null)
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, select, textarea') || document.querySelector('dialog[open]')) return
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'Delete') removeSelected()
      else if (e.key === 'Escape') setSelected(new Set())
      else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelected(new Set(pages.map((p) => p.id)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // OCR ticked: get its data ready while the user goes on, not when the first page is read
  useEffect(() => { if (opts.ocr) prepare() }, [opts.ocr])

  function onDragStart(e, id) {
    const ids = selected.has(id) ? selected : new Set([id])
    if (!selected.has(id)) {
      setSelected(ids)
      setAnchor(id)
    }
    dragging.current = ids
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', '') // Firefox won't start a drag without data
  }
  function onDragOverPage(e, i) {
    if (!dragging.current) return
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    setDropAt(e.clientX > r.left + r.width / 2 ? i + 1 : i)
  }
  function onDrop(e) {
    e.preventDefault()
    const ids = dragging.current
    if (ids && dropAt !== null) commit(moveItems(pages, ids, dropAt))
    else if (!ids && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files])
    endDrag()
  }
  function endDrag() {
    dragging.current = null
    setDropAt(null)
  }

  // the options panel as buildPdf options; the watermark picture is made here, at its final opacity
  async function decorations() {
    let image = null
    if (opts.mark === 'text' && opts.markText.trim()) {
      image = await textPixels(opts.markText, { size: 60, color: '#808080', opacity: opts.opacity, angle: 45, bold: true })
    } else if (opts.mark === 'image' && opts.markFile) {
      image = await imagePixels(opts.markFile, { opacity: opts.opacity })
    }
    return {
      numbers: opts.numbers ? { pos: opts.numbers, format: opts.format, start: opts.start || 1 } : null,
      watermark: image && { image },
      flatten: opts.flatten,
      textImage: (text) => textPixels(text, { size: 12 }), // fields that have a value but no appearance
      strip: opts.strip,
      impose: Number(opts.impose) || null,
    }
  }
  const compression = () => ({ level: opts.level || null, gray: opts.gray })

  // the page's visible box without its white margins, found on a small picture of it
  async function whiteCrop(p) {
    const key = `${p.src}:${p.index}`
    if (crops.current.has(key)) return crops.current.get(key)
    const src = sources.current[p.src]
    let crop = null
    await renderPages(src.bytes, { password: src.password, pages: [p.index], rotation: 0, scale: () => CROP_DPI / 72 }, (_, canvas) => {
      const { width: w, height: h } = canvas, px = canvas.getContext('2d').getImageData(0, 0, w, h).data
      let x0 = w, y0 = h, x1 = -1, y1 = -1
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          if (px[i] < 235 || px[i + 1] < 235 || px[i + 2] < 235) {
            x0 = Math.min(x0, x)
            x1 = Math.max(x1, x)
            y0 = Math.min(y0, y)
            y1 = Math.max(y1, y)
          }
        }
      }
      if (x1 < 0) return // nothing on it
      const pad = Math.round(Math.max(w, h) * 0.02), fx = (x) => Math.min(Math.max(x / w, 0), 1), fy = (y) => Math.min(Math.max(y / h, 0), 1)
      const [bx0, by0, bx1, by1] = pageBox(src.doc, p.index), bw = bx1 - bx0, bh = by1 - by0
      crop = [bx0 + fx(x0 - pad) * bw, by1 - fy(y1 + 1 + pad) * bh, bx0 + fx(x1 + 1 + pad) * bw, by1 - fy(y0 - pad) * bh]
    })
    crops.current.set(key, crop)
    return crop
  }

  // Text boxes and tables go to buildPdf as their pictures, with their words for the invisible text (decor.js);
  // the picture's height is the laid-out one.
  async function withPictures(p) {
    return Promise.all((p.overlays ?? []).map(async (o) => {
      if (o.kind !== 'textbox' && o.kind !== 'table') return o
      const [W, H] = o.rot % 180 ? [p.h, p.w] : [p.w, p.h] // the page as shown when the box was placed
      const { image, height, runs } = o.kind === 'textbox' ? await textBoxPixels(o, o.w * W) : await tablePixels(o, o.w * W - o.border)
      return { image, runs, x: o.x, y: o.y, w: o.w, h: height / H, rot: o.rot }
    }))
  }

  // what buildPdf gets for each page; withText adds an OCR text layer to pages that have no text
  async function partOf(p, withText) {
    const overlays = (await withPictures(p)).filter((o) => o.kind !== 'redact')
    if (p.blank) return { size: [p.w, p.h], rotate: p.rotate, overlays }
    const src = sources.current[p.src]
    const crop = opts.autocrop ? await whiteCrop(p) : null
    if (!p.overlays?.some((o) => o.kind === 'redact')) {
      const part = { doc: src.doc, index: p.index, rotate: p.rotate, overlays, crop }
      if (withText) part.text = await ocrText(p, src.bytes, src.password, p.index, pageBox(src.doc, p.index), `${p.src}:${p.index}:${p.base + p.rotate}`)
      return part
    }
    const { picture, ...part } = await burnRedactions(p)
    const [bx0, by0] = pageBox(src.doc, p.index) // the picture page starts at 0, 0
    // read the redacted picture, never the original: what the boxes cover must not come back as text
    if (withText) part.text = await ocrText(p, picture, '', 0, [0, 0, p.w, p.h])
    return { ...part, overlays, crop: crop && crop.map((v, k) => v - (k % 2 ? by0 : bx0)) }
  }

  // The page drawn as the user sees it (so a scan stored sideways reads upright), read in the OCR worker,
  // and the words placed back in the page's own space. null when the page already has text.
  async function ocrText(p, bytes, password, index, box, key) {
    if (key && ocrCache.current.has(key)) return ocrCache.current.get(key)
    const rot = (((p.base + p.rotate) % 360) + 360) % 360
    const doc = await openPages(bytes, password)
    let text = null
    try {
      if (!(await doc.hasText(index))) {
        const canvas = await doc.draw(index, () => OCR_DPI / 72, rot)
        const { width: W, height: H } = canvas
        const px = canvas.getContext('2d').getImageData(0, 0, W, H).data, gray = new Uint8Array(W * H)
        for (let i = 0; i < gray.length; i++) gray[i] = Math.round(px[i * 4] * 0.3 + px[i * 4 + 1] * 0.5 + px[i * 4 + 2] * 0.2)
        ocrPages.current++
        const result = await recognize(gray, W, H, (done, total) => setProgress(`글자 인식 ${ocrPages.current}쪽째 · ${done}/${total}줄`))
        text = textLayer(result, W, H, box, rot, OCR_DPI)
      }
    } finally {
      await doc.close()
    }
    if (key) ocrCache.current.set(key, text)
    return text
  }
  const locked = opts.password || opts.noPrint || opts.noCopy
  const security = () => (locked ? { encrypt: { password: opts.password, print: !opts.noPrint, copy: !opts.noCopy } } : {})

  // A page with redaction boxes becomes one picture with the boxes painted black, so what they cover is gone
  // from the file, not just hidden. Stamps stay stamps: the picture keeps the page's size and own rotation.
  async function burnRedactions(p) {
    const src = sources.current[p.src]
    let pdf
    await renderPages(src.bytes, { password: src.password, pages: [p.index], rotation: 0, scale: () => REDACT_DPI / 72 }, async (_, canvas) => {
      if (canvas.black) blackPages.current.add(pages.indexOf(p) + 1)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#000'
      for (const o of p.overlays) {
        if (o.kind !== 'redact') continue
        const b = turnBox(o, steps(o.rot, 0)), x = Math.floor(b.x * canvas.width), y = Math.floor(b.y * canvas.height)
        ctx.fillRect(x, y, Math.ceil((b.x + b.w) * canvas.width) - x, Math.ceil((b.y + b.h) * canvas.height) - y)
      }
      const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', 0.85))
      pdf = picturePage(new Uint8Array(await blob.arrayBuffer()), canvas.width, canvas.height, p.w, p.h, p.base)
    })
    return { doc: await readPdf(pdf), index: 0, rotate: p.rotate, overlays: p.overlays.filter((o) => o.kind !== 'redact'), picture: pdf }
  }

  // pages per output file when splitting
  function splitGroups(list) {
    if (opts.split === 'file') { // runs of pages from the same file; a blank page stays with the run it's in
      return list.reduce((groups, p, i) => {
        if (i && (list[i - 1].src === p.src || p.blank)) groups.at(-1).push(p)
        else groups.push([p])
        return groups
      }, [])
    }
    const n = opts.split === 'each' ? 1 : Math.max(1, opts.splitN || 1)
    return Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n))
  }

  // opts.scope: 'all' | 'selected'; opts.out: 'pdf' | 'split' (one PDF per group, zipped) | 'images' (JPG/PNG per page)
  async function save() {
    const kind = opts.out, picked = opts.scope === 'selected'
    const list = picked ? pages.filter((p) => selected.has(p.id)) : pages
    setBusy(true)
    setMessage(null)
    ocrPages.current = 0
    blackPages.current.clear()
    try {
      const withText = opts.ocr && kind !== 'images'
      const parts = async (ps) => { // one at a time: rendering and OCR are heavy
        const out = []
        for (const p of ps) out.push(await partOf(p, withText))
        return out
      }
      const read = () => (ocrPages.current ? `, 글자 인식 ${ocrPages.current}쪽` : withText ? ', 글자를 인식할 쪽(스캔본)이 없었습니다' : '')
      const nameOf = (ps) => {
        const p = ps.find((x) => !x.blank)
        return p ? stem(sources.current[p.src].name) : 'blank'
      }
      const base = nameOf(list)
      const decor = await decorations()
      const after = locked ? ', 암호 걸림' : ''
      // shown as a warning: the file is saved, but a black page is almost never what the user meant
      const done = (text) => {
        const black = [...blackPages.current].sort((a, b) => a - b)
        setMessage(black.length
          ? { error: true, text: `${text}. 그런데 ${black.join(', ')}쪽이 새까맣게 그려졌습니다. 원래 검은 쪽이 아니면 다른 탭을 닫고 다시 저장해 주세요` }
          : { text })
      }
      if (kind === 'split') {
        const groups = splitGroups(list), used = new Map(), files = []
        for (const [i, group] of groups.entries()) {
          let name = opts.split === 'file' ? nameOf(group) : `${base}_${pad(i + 1, groups.length)}`
          const n = used.set(name, (used.get(name) ?? 0) + 1).get(name)
          if (n > 1) name += `_${n}`
          files.push({ name: `${name}.pdf`, bytes: (await buildPdf(await parts(group), { ...compression(), ...decor, ...security() })).bytes })
        }
        const bytes = zip(files)
        download(bytes, `${base}_split.zip`, 'application/zip')
        done(`${base}_split.zip 저장: PDF ${files.length}개, ${size(bytes.length)}${read()}${after}`)
      } else if (kind === 'images') {
        const { bytes: pdf } = await buildPdf(await parts(list), decor)
        const [type, ext] = opts.imageType === 'png' ? ['image/png', 'png'] : ['image/jpeg', 'jpg']
        const files = []
        await renderPages(pdf, { scale: () => opts.dpi / 72 }, async (i, canvas) => {
          const blob = await new Promise((ok) => canvas.toBlob(ok, type, 0.9))
          const no = pages.indexOf(list[i]) + 1 // the page's place on screen: picked pages 3 and 7 come out as _03 and _07
          if (canvas.black) blackPages.current.add(no)
          files.push({ name: `${base}_${pad(no, pages.length)}.${ext}`, bytes: new Uint8Array(await blob.arrayBuffer()) })
        })
        const [bytes, name] = files.length === 1 ? [files[0].bytes, files[0].name] : [zip(files), `${base}_images.zip`]
        download(bytes, name, files.length === 1 ? type : 'application/zip')
        done(`${name} 저장: 이미지 ${files.length}장, ${size(bytes.length)}`)
      } else {
        const { bytes, saved } = await buildPdf(await parts(list), { ...compression(), ...decor, ...security() })
        const name = `${base}_${picked ? 'selected' : 'edited'}.pdf`
        download(bytes, name)
        const notes = [
          opts.level && opts.level !== 'lossless' && (saved > 0 ? `이미지에서 ${size(saved)} 줄임` : '줄일 수 있는 이미지가 없었습니다'),
          opts.gray && '이미지 흑백',
        ].filter(Boolean).map((s) => `, ${s}`).join('')
        done(`${name} 저장: ${list.length}페이지, ${size(bytes.length)}${notes}${read()}${after}`)
      }
    } catch (e) {
      setMessage({ error: true, text: `저장하지 못했습니다: ${e.message}` })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const picker = (
    <input
      type="file" hidden multiple accept="application/pdf,.pdf,image/*"
      onChange={(e) => { addFiles([...e.target.files]); e.target.value = '' }}
    />
  )
  const undoButton = <button disabled={!history.length} onClick={undo} title="Ctrl+Z">되돌리기</button>
  const editPage = pages.find((p) => p.id === editing)
  // files with a page on screen, for the compare dialog (sources keeps cleared ones for undo)
  const shown = [...new Set(pages.filter((p) => !p.blank).map((p) => p.src))].sort((a, b) => a - b).map((i) => sources.current[i])
  const active = [
    opts.level && `용량 줄이기 ${LEVEL_NAMES[opts.level]}`,
    opts.numbers && '쪽 번호',
    opts.mark && '워터마크',
    opts.password && '열기 암호',
    (opts.noPrint || opts.noCopy) && '인쇄·복사 막기',
    opts.strip && '숨은 정보 지우기',
    opts.flatten && '양식·주석 굳히기',
    opts.gray && '흑백',
    opts.impose && LAYOUTS[opts.impose],
    opts.autocrop && '흰 여백 자르기',
    opts.ocr && '글자 인식',
  ].filter(Boolean)

  return (
    <main onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header>
        <h1>PDF 도구</h1>
        <p className="muted">
          파일은 이 PC 밖으로 나가지 않습니다. 모든 처리는 브라우저 안에서 합니다.
          {' · '}
          <a href={GUIDE_URL} target="_blank" rel="noopener" onClick={(e) => { e.preventDefault(); setGuide(true) }}>
            압축 방식 알아보기
          </a>
        </p>
      </header>

      {inAppNotice && (
        <div className="notice">
          <p>
            <b>{IN_APP.app ?? '앱 안 브라우저'}에서 열렸습니다.</b> 여기서는 PDF 저장이 안 될 수 있어요.
            {IN_APP.open ? ' 외부 브라우저로 열어 주세요.' : ' 화면 메뉴(⋯)에서 "Safari로 열기"를 눌러 주세요.'}
          </p>
          {IN_APP.open && <a className="button" href={IN_APP.open}>외부 브라우저로 열기</a>}
          <button className="ghost" onClick={() => setInAppNotice(false)}>닫기</button>
        </div>
      )}

      {pages.length === 0 ? (
        <>
          <label className="drop">
            {picker}
            <strong>PDF나 이미지를 여기로 끌어놓거나 클릭해서 고르세요</strong>
            <span className="muted">여러 개를 한 번에 올릴 수 있습니다. 이미지는 A4 한 페이지가 됩니다.</span>
          </label>
          <p className="start-blank">
            <span className="muted">또는</span>
            <button onClick={() => newDocument(false)}>빈 문서 만들기 (A4 세로)</button>
            <button onClick={() => newDocument(true)}>A4 가로</button>
          </p>
          {history.length > 0 && <p>{undoButton}</p>}
        </>
      ) : (
        <>
          <div className="toolbar">
            <div className="row">
              <label className="button">{picker}+ 파일 추가</label>
              <span className="count">{selected.size ? `${selected.size}개 선택` : `${pages.length}페이지`}</span>
              <button disabled={!selected.size} onClick={() => rotateSelected(-90)} title="왼쪽으로 90°">↺ 왼쪽</button>
              <button disabled={!selected.size} onClick={() => rotateSelected(90)} title="오른쪽으로 90°">↻ 오른쪽</button>
              <button disabled={!selected.size} onClick={removeSelected}>삭제</button>
              <button onClick={addBlank} title="선택한 쪽 뒤(없으면 맨 끝)에 넣습니다">빈 쪽</button>
              <button onClick={() => setSelected(new Set(pages.map((p) => p.id)))}>전체 선택</button>
              {undoButton}
              <button disabled={shown.length < 2} onClick={() => setComparing(shown)} title="올린 파일 두 개를 쪽마다 겹쳐 봅니다">비교</button>
              <span className="spacer" />
              <button className="ghost" onClick={clearAll}>모두 비우기</button>
            </div>
            <div className="row">
              <span className="spacer" />
              <select value={opts.scope} onChange={option('scope')} aria-label="저장할 쪽">
                <option value="all">전체 {pages.length}쪽</option>
                <option value="selected" disabled={!selected.size}>선택한 {selected.size}쪽</option>
              </select>
              <select value={opts.out} onChange={option('out')} aria-label="저장 형식" title="나누기·이미지 설정은 저장 옵션에 있습니다">
                <option value="pdf">PDF 하나로</option>
                <option value="split">나누어 ZIP으로</option>
                <option value="images">이미지로</option>
              </select>
              <button
                className="primary" onClick={save}
                disabled={busy || (opts.scope === 'selected' && !selected.size)}
                title={opts.scope === 'selected' && !selected.size ? '저장할 쪽을 먼저 고르세요' : undefined}
              >저장</button>
            </div>
          </div>

          <details className="options">
            <summary>저장 옵션{active.length ? `: ${active.join(', ')}` : ''}</summary>
            <div className="option-rows">
              <div>용량 줄이기
                <select value={opts.level} onChange={option('level')} aria-label="용량 줄이기" title="저장할 때 사진·스캔 이미지를 줄입니다">
                  <option value="">안 함</option>
                  {Object.entries(LEVEL_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <label className="check" title="사진·스캔 이미지를 흑백으로 바꿉니다. 글자 색은 그대로입니다">
                  <input type="checkbox" checked={opts.gray} onChange={flag('gray')} /> 사진·스캔 흑백으로
                </label>
              </div>
              <div>배치
                <select value={opts.impose} onChange={option('impose')} aria-label="모아 찍기" title="모아 찍으면 북마크는 그 장을 가리키고, 양식 칸과 주석은 그려 넣으며, 링크와 메모는 빠집니다">
                  <option value="">쪽 그대로</option>
                  {Object.entries(LAYOUTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <label className="check" title="쪽마다 내용이 없는 흰 테두리를 잘라냅니다 (스캔 여백 등)">
                  <input type="checkbox" checked={opts.autocrop} onChange={flag('autocrop')} /> 흰 여백 자르기
                </label>
              </div>
              <label>쪽 번호
                <select value={opts.numbers} onChange={option('numbers')}>
                  <option value="">안 넣음</option>
                  {Object.entries(POSITIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                {opts.numbers && (
                  <>
                    <select value={opts.format} onChange={option('format')} title="모양">
                      {Object.entries(FORMATS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                    <input type="number" min="1" value={opts.start} onChange={option('start', Number)} title="시작 번호" />
                    <span className="muted">부터</span>
                  </>
                )}
              </label>
              <label>워터마크
                <select value={opts.mark} onChange={option('mark')}>
                  <option value="">안 넣음</option>
                  <option value="text">글자</option>
                  <option value="image">이미지</option>
                </select>
                {opts.mark === 'text' && <input value={opts.markText} onChange={option('markText')} placeholder="예: 대외비" />}
                {opts.mark === 'image' && (
                  <input type="file" accept="image/*" onChange={(e) => setOpts((o) => ({ ...o, markFile: e.target.files[0] ?? null }))} />
                )}
                {opts.mark && (
                  <select value={opts.opacity} onChange={option('opacity', Number)} title="진하기">
                    {Object.entries(OPACITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                )}
              </label>
              <div>보안
                <input value={opts.password} onChange={option('password')} placeholder="열기 암호 (비우면 없음)" autoComplete="off" aria-label="열기 암호" />
                <label className="check"><input type="checkbox" checked={opts.noPrint} onChange={flag('noPrint')} /> 인쇄 막기</label>
                <label className="check"><input type="checkbox" checked={opts.noCopy} onChange={flag('noCopy')} /> 복사 막기</label>
              </div>
              <div>글자 인식
                <label className="check" title="스캔본처럼 글자 정보가 없는 쪽을 읽어, 검색·복사되는 보이지 않는 글자를 얹습니다 (한국어·영어)">
                  <input type="checkbox" checked={opts.ocr} onChange={flag('ocr')} /> 스캔된 쪽의 글자 인식 (OCR)
                </label>
                <span className="muted">글자가 없는 쪽만, 쪽마다 몇 초 걸립니다</span>
              </div>
              <div>정리
                <label className="check" title="작성 프로그램 기록, 쪽·이미지 안의 XMP 정보, 메모 작성자 이름. 제목·작성자 같은 문서 정보는 원래 옮기지 않습니다">
                  <input type="checkbox" checked={opts.strip} onChange={flag('strip')} /> 숨은 정보 지우기
                </label>
                <label className="check" title="양식 칸의 값과 펜·형광펜·도형 같은 주석을 쪽에 그려 넣어, 더는 고치거나 지울 수 없게 합니다. 메모는 메모로 남습니다">
                  <input type="checkbox" checked={opts.flatten} onChange={flag('flatten')} /> 양식·주석 굳히기
                </label>
              </div>
              <label>나누어 저장
                <select value={opts.split} onChange={option('split')}>
                  <option value="each">한 쪽씩</option>
                  <option value="n">몇 쪽씩</option>
                  <option value="file">원래 파일별로</option>
                </select>
                {opts.split === 'n' && <><input type="number" min="1" value={opts.splitN} onChange={option('splitN', Number)} /><span className="muted">쪽씩, ZIP 파일 하나로</span></>}
                {opts.split !== 'n' && <span className="muted">ZIP 파일 하나로</span>}
              </label>
              <label>이미지로 저장
                <select value={opts.imageType} onChange={option('imageType')}>
                  <option value="jpeg">JPG</option>
                  <option value="png">PNG</option>
                </select>
                <select value={opts.dpi} onChange={option('dpi', Number)} title="해상도">
                  <option value="96">화면용 (96dpi)</option>
                  <option value="150">보통 (150dpi)</option>
                  <option value="300">인쇄용 (300dpi)</option>
                </select>
              </label>
            </div>
          </details>

          <p className="muted help">
            클릭 선택 · Ctrl+클릭 추가/해제 · Shift+클릭 범위 · Ctrl+A 전체 · 끌어서 옮기기 · 연필 단추나 더블클릭으로 꾸미기 · Delete 삭제 · Ctrl+Z 되돌리기 · Esc 선택 해제
          </p>
          <div className="grid" onClick={() => setSelected(new Set())}>
            {pages.map((p, i) => {
              const src = sources.current[p.src]
              const thumb = thumbs[`${p.src}:${p.index}`]
              const turned = ((p.rotate % 360) + 360) % 360
              const k = 100 / Math.max(p.w, p.h)
              const cls = ['page',
                p.blank && 'blank',
                selected.has(p.id) && 'selected',
                dropAt === i && 'insert-before',
                dropAt === pages.length && i === pages.length - 1 && 'insert-after',
              ].filter(Boolean).join(' ')
              return (
                <div
                  key={p.id} className={cls} draggable style={{ '--hue': src?.hue ?? 0 }}
                  onClick={(e) => clickPage(e, p.id)} onDoubleClick={() => setEditing(p.id)} onDragStart={(e) => onDragStart(e, p.id)}
                  onDragOver={(e) => onDragOverPage(e, i)} onDragEnd={endDrag}
                >
                  <div className="sheet-box">
                    <div
                      className={thumb || p.blank ? 'sheet has-thumb' : 'sheet'}
                      style={{ width: p.w * k, height: p.h * k, transform: `rotate(${p.base + p.rotate}deg)` }}
                    >
                      {thumb && <img src={thumb} alt="" draggable={false} />}
                    </div>
                  </div>
                  <button
                    className="edit" aria-label="꾸미기" title="꾸미기: 도장·서명·글상자·가림·펜·형광펜·도형·메모 (쪽을 더블클릭해도 됩니다)"
                    onClick={(e) => { e.stopPropagation(); setEditing(p.id) }} onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" />
                    </svg>
                  </button>
                  {p.overlays?.length > 0 && <span className="decor" title="꾸민 것 (도장·글상자·펜·도형·메모 등)">꾸밈 {p.overlays.length}</span>}
                  {src && <span className="badge" title={`${src.name}의 원래 ${p.index + 1}쪽`}>p.{p.index + 1}</span>}
                  <div className="label" title={src?.name}>
                    <b>{i + 1}</b> {src?.name ?? '빈 쪽'}{turned ? ` · ${turned}°` : ''}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {busy && <p className="muted">처리 중…{progress && ` ${progress}`}</p>}
      {message && <p className={message.error ? 'error' : 'ok'}>{message.text}</p>}

      {editPage && (
        <Editor
          key={editPage.id} page={editPage} source={sources.current[editPage.src] ?? null} onClose={() => setEditing(null)}
          at={pages.indexOf(editPage)} total={pages.length}
          onApply={(overlays, go) => { // go: -1 / 1 to the page before / after, 'add' to a new blank page after this one
            const at = pages.indexOf(editPage)
            let next = pages.map((p) => (p.id === editPage.id ? { ...p, overlays } : p)), to = null
            if (go === 'add') {
              const turned = (((editPage.base + editPage.rotate) % 180) + 180) % 180 !== 0
              const blank = { id: nextId.current++, blank: true, w: turned ? editPage.h : editPage.w, h: turned ? editPage.w : editPage.h, base: 0, rotate: 0 }
              next = [...next.slice(0, at + 1), blank, ...next.slice(at + 1)]
              to = blank.id
            } else if (go) to = next[at + go]?.id ?? null
            commit(next)
            setEditing(to)
            if (to !== null) setSelected(new Set([to]))
          }}
        />
      )}
      {comparing && <Compare files={comparing} onClose={() => setComparing(null)} />}
      {ask && (
        <dialog className="modal" ref={showModal} onClose={() => answer(null)}>
          <form onSubmit={(e) => { e.preventDefault(); answer(e.currentTarget.password.value) }}>
            <p><b>{ask.name}</b><br />{ask.wrong ? '암호가 틀렸습니다. 다시 입력하세요.' : '열기 암호를 입력하세요.'}</p>
            <input name="password" type="password" autoComplete="off" data-focus />
            <div className="actions">
              <button type="button" onClick={() => answer(null)}>건너뛰기</button>
              <button className="primary">열기</button>
            </div>
          </form>
        </dialog>
      )}
      {guide && (
        <dialog
          className="modal guide" ref={showModal} onClose={() => setGuide(false)}
          onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()} // backdrop click
        >
          <iframe srcDoc={guideHtml} title="압축 방식 알아보기" />
          <form method="dialog"><button className="primary" data-focus>닫기</button></form>
        </dialog>
      )}
    </main>
  )
}
