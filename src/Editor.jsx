import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { openPages } from './render.js'
import { imagePixels, textPixels, turnedUrl, turnMark, steps, PX_PER_PT, SIGN_FONT } from './decor.js'
import { MARKS } from './pdf.js'
import Signature from './Signature.jsx'

const VIEW = 1100 // px, longest side of the page picture
const COLORS = { '#000000': '검정', '#1d4ed8': '파랑', '#c62828': '빨강', '#15803d': '초록' }
const MARKERS = { '#fde047': '노랑', '#86efac': '연두', '#f9a8d4': '분홍', '#7dd3fc': '하늘' }
const WIDTHS = [1, 2, 4, 8] // pt
const MARKER_WIDTH = 12 // pt, the free highlighter
const NOTE = 20 // pt, a note's icon (NOTE_SIZE in pdf.js)
const MAX_STEPS = 100 // how far back 되돌리기 goes
// what a press on the page does
const TOOLS = {
  select: ['선택', '눌러서 고르고, 끌어서 옮기고, 오른쪽 아래 모서리로 크기를 바꿉니다. 글자를 끌어서 고르면 형광펜·밑줄·취소선을 고를 수 있습니다'],
  pen: ['펜', '끌어서 그립니다. 이어서 그린 획은 하나로 묶입니다'],
  highlight: ['형광펜', '끌어서 자유롭게 칠합니다 (스캔처럼 글자가 없는 곳). 글자에 칠하려면 선택 도구로 글자를 끌어서 고르세요'],
  square: ['네모', '끌어서 그립니다'],
  circle: ['동그라미', '끌어서 그립니다'],
  line: ['선', '끌어서 긋습니다'],
  arrow: ['화살표', '끌어서 긋습니다. 끝에 화살촉이 붙습니다'],
  note: ['메모', '누른 곳에 메모를 붙입니다. 다른 PDF 프로그램에서도 메모로 보입니다'],
}
// tool and undo icons, 24 x 24, drawn with the button's text color
const icon = (body) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{body}</svg>
)
const ICONS = {
  select: icon(<path d="M5 3l14 7.5-6.2 1.8L9.5 19z" />),
  pen: icon(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>),
  highlight: icon(<><path d="M14 4l6 6-7.5 7.5H7.5v-5z" /><path d="M7.5 12.5l5 5" /><path d="M3 21h11" stroke="#eab308" strokeWidth="3" /></>),
  square: icon(<rect x="4" y="5" width="16" height="14" rx="1" />),
  circle: icon(<ellipse cx="12" cy="12" rx="8.5" ry="7" />),
  line: icon(<path d="M5 19L19 5" />),
  arrow: icon(<><path d="M5 19L19 5" /><path d="M10 5h9v9" /></>),
  note: icon(<><path d="M4 4h16v12h-9l-5 4v-4H4z" /><path d="M8 8.5h8M8 12h5" /></>),
  undo: icon(<><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>),
  redo: icon(<><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>),
}
const TEXT_MARKS = new Set(['highlight', 'underline', 'strikeout']) // made by picking text: they don't move
const tint = (hex) => '#' + [1, 3, 5].map((i) => Math.round(255 - (255 - parseInt(hex.slice(i, i + 2), 16)) * 0.2).toString(16).padStart(2, '0')).join('')

// Text marks as line boxes { x, y, w, h } in page fractions, and back.
const lineBoxes = (it) => it.rects.map(([u, v, w, h]) => ({ x: it.view.x + u * it.view.w, y: it.view.y + v * it.view.h, w: w * it.view.w, h: h * it.view.h }))
function textMark(lines) {
  const x0 = Math.min(...lines.map((l) => l.x)), y0 = Math.min(...lines.map((l) => l.y))
  const view = { x: x0, y: y0, w: Math.max(...lines.map((l) => l.x + l.w)) - x0, h: Math.max(...lines.map((l) => l.y + l.h)) - y0 }
  return { view, rects: lines.map((l) => [(l.x - x0) / view.w, (l.y - y0) / view.h, l.w / view.w, l.h / view.h]) }
}
const sameLine = (a, b) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > Math.min(a.h, b.h) / 2
const SLIVER = 0.004 // page width, less than a letter: what is left over from picking the same text twice
const touches = (a, b) => sameLine(a, b) && Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > SLIVER
// a line box with the picked text taken out: what stays marked when part of a marked line is unmarked
function cut(box, picked) {
  let parts = [box]
  for (const s of picked) {
    parts = parts.flatMap((p) => (!touches(p, s) ? [p]
      : [{ ...p, w: s.x - p.x }, { ...p, x: s.x + s.w, w: p.x + p.w - s.x - s.w }].filter((q) => q.w > SLIVER)))
  }
  return parts
}

let nextId = 0

// One page, big, to decorate: stamps, signatures, text boxes and redaction boxes, and marks (see MARKS in
// pdf.js: pen, highlighter, underline, strike-out, shapes, notes) drawn with a tool. Everything can be
// dragged and resized; marks are saved as annotations. A stamp or mark keeps the rotation the page had when
// it was placed (decorate() in pdf.js), so after a later rotation it is shown turned here. Redaction boxes
// ({ kind: 'redact' }, no image) are burned in by App when saving.
export default function Editor({ page, source, onApply, onClose }) {
  const rot = (((page.base + page.rotate) % 360) + 360) % 360
  const [W, H] = rot % 180 ? [page.h, page.w] : [page.w, page.h] // points, as shown
  const [picture, setPicture] = useState(null)
  const [hasText, setHasText] = useState(false)
  const [items, setItems] = useState(null) // overlays + { view: box at `rot`, viewUrl }
  const [history, setHistory] = useState({ past: [], future: [] }) // earlier and undone `items`
  const [active, setActive] = useState(null)
  const [tool, setTool] = useState('select')
  const [style, setStyleState] = useState({ color: '#000000', marker: '#fde047', width: 2, fill: false })
  const [draft, setDraft] = useState(null) // the stroke or shape being drawn: { tool, pts: [x, y, ...] } in page fractions
  const [picked, setPicked] = useState(null) // text picked with the select tool, line boxes: offers the text menu
  const [signing, setSigning] = useState(false)
  const [text, setText] = useState({ value: '', size: 12, color: '#000000' })
  const [clearWhite, setClearWhite] = useState(true)
  const [error, setError] = useState(null)
  const [fit, setFit] = useState(null) // paper size in px
  const stage = useRef(null), paper = useRef(null), textLayer = useRef(null), noteText = useRef(null)
  const extend = useRef(null) // the pen drawing later strokes join, until the tool or style changes
  const typing = useRef(false) // a note's text being written: one step until the box is left

  useEffect(() => {
    let live = true
    if (source) { // a blank page has none: the paper stays white
      (async () => {
        const doc = await openPages(source.bytes, source.password)
        try {
          const canvas = await doc.draw(page.index, (w, h) => VIEW / Math.max(w, h), rot)
          if (!live) return
          setPicture(canvas.toDataURL('image/jpeg', 0.9))
          canvas.width = 0
          textLayer.current.replaceChildren()
          if (await doc.textLayer(page.index, rot, textLayer.current, VIEW / Math.max(W, H)) && live) setHasText(true)
        } finally {
          await doc.close()
        }
      })().catch((e) => live && setError(`쪽을 그리지 못했습니다: ${e.message}`))
    }
    Promise.all((page.overlays ?? []).map(async (o) => {
      const n = steps(o.rot, rot), t = turnMark(o, n)
      return { ...t, id: nextId++, view: { x: t.x, y: t.y, w: t.w, h: t.h }, viewUrl: o.image && (n ? await turnedUrl(o.image.url, n * 90) : o.image.url) }
    })).then((list) => live && setItems(list))
    return () => { live = false }
  }, [page, source, rot, W, H])

  // the largest paper with the page's shape that fits the stage
  useLayoutEffect(() => {
    const el = stage.current
    const measure = () => {
      const k = Math.min(el.clientWidth / W, el.clientHeight / H)
      setFit({ width: W * k, height: H * k })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [W, H])

  // Every edit calls this first: the list as it is becomes a step to go back to, and steps undone before are
  // gone, as in any editor.
  const remember = () => setHistory((h) => ({ past: [...h.past, items].slice(-MAX_STEPS), future: [] }))
  const restore = (list) => {
    setItems(list)
    setActive(null)
    extend.current = null
  }
  const undo = () => {
    if (!history.past.length) return
    setHistory({ past: history.past.slice(0, -1), future: [items, ...history.future] })
    restore(history.past.at(-1))
  }
  const redo = () => {
    if (!history.future.length) return
    setHistory({ past: [...history.past, items], future: history.future.slice(1) })
    restore(history.future[0])
  }

  const put = (item) => {
    remember()
    const id = nextId++
    setItems((list) => [...list, { id, rot, ...item }])
    setActive(id)
    return id
  }
  const update = (id, fields) => setItems((list) => list.map((it) => (it.id === id ? { ...it, ...fields } : it)))
  const add = (fields, w, h) => {
    const k = Math.min(1, 0.9 / w, 0.9 / h)
    put({ view: { x: (1 - w * k) / 2, y: (1 - h * k) / 2, w: w * k, h: h * k }, viewUrl: fields.image?.url, ...fields })
  }
  const image = (img) => ({ image: img })
  async function addImage(file) {
    setError(null)
    try {
      const img = await imagePixels(file, { clearWhite })
      const w = 0.2 // a fifth of the page width, keeping the picture's shape
      add(image(img), w, (w * (img.height / img.width) * W) / H)
    } catch (e) {
      setError(e.message)
    }
  }
  async function addText() {
    if (!text.value.trim()) return
    const img = await textPixels(text.value, { size: text.size, color: text.color })
    add(image(img), img.width / PX_PER_PT / W, img.height / PX_PER_PT / H)
    setText((t) => ({ ...t, value: '' }))
  }
  const remove = () => {
    if (active === null) return
    remember()
    setItems((list) => list.filter((it) => it.id !== active))
    setActive(null)
  }
  const activeItem = items?.find((it) => it.id === active)

  const chooseTool = (t) => {
    extend.current = null
    setTool(t)
    setPicked(null)
    if (t !== 'select') setActive(null)
  }
  // a new color, width or fill also changes the selected mark
  function setStyle(fields) {
    extend.current = null
    setStyleState((s) => ({ ...s, ...fields }))
    const it = activeItem
    if (!it || !MARKS.has(it.kind)) return
    const marker = it.kind === 'highlight' || it.kind === 'note' || it.marker
    const f = {}
    if (fields.color && !marker) f.color = fields.color
    if (fields.marker && marker) f.color = fields.marker
    if (fields.width && 'width' in it && !it.marker) f.width = fields.width
    if ('fill' in fields && (it.kind === 'square' || it.kind === 'circle')) f.fill = fields.fill ? tint(it.color) : null
    if (f.color && it.fill) f.fill = tint(f.color)
    if (!Object.keys(f).length) return
    remember()
    update(it.id, f)
  }

  function drag(e, id, mode) {
    e.preventDefault()
    e.stopPropagation()
    setActive(id)
    extend.current = null
    const r = paper.current.getBoundingClientRect()
    const { view: from, kind } = items.find((it) => it.id === id)
    const sx = e.clientX, sy = e.clientY
    let moved = false // a click that only selects is no step
    const move = (ev) => {
      if (!moved) remember()
      moved = true
      const dx = (ev.clientX - sx) / r.width, dy = (ev.clientY - sy) / r.height
      let v
      if (mode === 'move') {
        v = { ...from, x: Math.min(Math.max(0, from.x + dx), 1 - from.w), y: Math.min(Math.max(0, from.y + dy), 1 - from.h) }
      } else if (kind === 'redact' || MARKS.has(kind)) { // any shape
        v = { ...from, w: Math.max(0.01, Math.min(from.w + dx, 1 - from.x)), h: Math.max(0.005, Math.min(from.h + dy, 1 - from.y)) }
      } else { // resize from the bottom-right corner, keeping the shape
        const w = Math.max(0.02, Math.min(from.w + dx, 1 - from.x, ((1 - from.y) * from.w) / from.h))
        v = { ...from, w, h: (w * from.h) / from.w }
      }
      setItems((list) => list.map((it) => (it.id === id ? { ...it, view: v } : it)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- drawing with a tool ----

  // strokes as one pen drawing: its box (the strokes plus half a stroke) and the points inside it
  function inkBox(lines, width) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0
    for (const l of lines) {
      for (let k = 0; k < l.length; k += 2) {
        x0 = Math.min(x0, l[k]); x1 = Math.max(x1, l[k])
        y0 = Math.min(y0, l[k + 1]); y1 = Math.max(y1, l[k + 1])
      }
    }
    x0 -= width / 2 / W; x1 += width / 2 / W; y0 -= width / 2 / H; y1 += width / 2 / H
    const w = x1 - x0, h = y1 - y0
    return { view: { x: x0, y: y0, w, h }, lines: lines.map((l) => l.map((v, k) => (k % 2 ? (v - y0) / h : (v - x0) / w))) }
  }
  const absLines = (it) => it.lines.map((l) => l.map((v, k) => (k % 2 ? it.view.y + v * it.view.h : it.view.x + v * it.view.w)))

  function addStroke(pts, marker) {
    const look = marker ? { color: style.marker, width: MARKER_WIDTH, marker: true } : { color: style.color, width: style.width, marker: false }
    const prev = items.find((it) => it.id === extend.current && it.kind === 'ink' && it.color === look.color && it.width === look.width && !!it.marker === look.marker)
    const drawing = { kind: 'ink', ...look, ...inkBox([...(prev ? absLines(prev) : []), pts], look.width) }
    if (prev) { // one step per stroke, so 되돌리기 takes the last stroke off
      remember()
      update(prev.id, drawing)
      setActive(prev.id)
    } else extend.current = put(drawing)
  }

  function finish(t, pts, r) {
    const [x0, y0] = pts, [x1, y1] = pts.slice(-2)
    const tiny = Math.hypot((x1 - x0) * r.width, (y1 - y0) * r.height) < 4 // a click, not a drag
    if (t === 'note') {
      const w = NOTE / W, h = NOTE / H
      put({ kind: 'note', view: { x: Math.min(x0, 1 - w), y: Math.min(y0, 1 - h), w, h }, color: style.marker, text: '' })
      setTool('select')
      requestAnimationFrame(() => noteText.current?.focus())
      return
    }
    if (t === 'pen' || t === 'highlight') return addStroke(pts, t === 'highlight')
    if (t === 'square' || t === 'circle') {
      const box = tiny
        ? { x: Math.min(Math.max(0, x0 - 0.1), 0.8), y: Math.min(Math.max(0, y0 - 0.05), 0.9), w: 0.2, h: 0.1 }
        : { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
      return put({ kind: t, view: box, color: style.color, width: style.width, fill: style.fill ? tint(style.color) : null })
    }
    // line, arrow: a box around the two ends, a few px across at least so it can be grabbed
    const [a, b] = tiny ? [[Math.max(0, x0 - 0.1), y0], [Math.min(1, x0 + 0.1), y0]] : [[x0, y0], [x1, y1]]
    const box = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) }
    for (const [pos, size, px] of [['x', 'w', r.width], ['y', 'h', r.height]]) {
      if (box[size] * px < 10) { box[pos] -= (10 / px - box[size]) / 2; box[size] = 10 / px }
    }
    put({ kind: t, view: box, color: style.color, width: style.width, ends: [(a[0] - box.x) / box.w, (a[1] - box.y) / box.h, (b[0] - box.x) / box.w, (b[1] - box.y) / box.h] })
  }

  function startDraw(e) {
    e.preventDefault()
    const t = tool, r = paper.current.getBoundingClientRect()
    const at = (ev) => [Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1), Math.min(Math.max((ev.clientY - r.top) / r.height, 0), 1)]
    const pts = at(e)
    let last = [e.clientX, e.clientY]
    setDraft({ tool: t, pts })
    const move = (ev) => {
      if (Math.hypot(ev.clientX - last[0], ev.clientY - last[1]) <= 2) return // pdf.js drops points this close: noise
      last = [ev.clientX, ev.clientY]
      pts.push(...at(ev))
      setDraft({ tool: t, pts: [...pts] })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDraft(null)
      finish(t, pts, r)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // The text picked in the text layer, one box per line in page fractions (as pdf.js's getSelectionBoxes,
  // then joined: runs that overlap by half their height and sit closer than a line is tall are one line).
  // ponytail: assumes text runs left to right as shown; vertical text gets one box per run.
  function pickedLines() {
    const sel = document.getSelection(), layer = textLayer.current
    if (!sel.rangeCount || sel.isCollapsed || !layer.contains(sel.getRangeAt(0).commonAncestorContainer)) return []
    const r = paper.current.getBoundingClientRect(), boxes = []
    for (let i = 0; i < sel.rangeCount; i++) {
      for (const b of sel.getRangeAt(i).getClientRects()) if (b.width && b.height) boxes.push({ x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height })
    }
    const lines = []
    for (const b of boxes.sort((p, q) => p.y - q.y || p.x - q.x)) {
      const l = lines.find((q) => Math.min(q.y + q.h, b.y + b.h) - Math.max(q.y, b.y) > Math.min(q.h, b.h) / 2 && b.x <= q.x + q.w + q.h && b.x + b.w >= q.x - q.h)
      if (!l) { lines.push({ ...b }); continue }
      const x1 = Math.max(l.x + l.w, b.x + b.w), y1 = Math.max(l.y + l.h, b.y + b.h)
      Object.assign(l, { x: Math.min(l.x, b.x), y: Math.min(l.y, b.y) })
      Object.assign(l, { w: x1 - l.x, h: y1 - l.y })
    }
    return lines.map((l) => ({ x: l.x / r.width, y: l.y / r.height, w: l.w / r.width, h: l.h / r.height }))
  }
  // with the select tool, text dragged over is picked and the text menu offered for it
  function pickText() {
    const up = () => {
      window.removeEventListener('pointerup', up)
      const lines = pickedLines()
      setPicked(lines.length ? lines : null)
    }
    window.addEventListener('pointerup', up)
  }
  // From the text menu, one step: [[kind, color or null to take it off]] for the picked text. The picked part
  // is first taken out of marks of that kind, so a part of a marked line can be recolored or unmarked.
  function markPicked(changes, lineColor) {
    if (lineColor) setStyleState((s) => ({ ...s, color: lineColor })) // also for underlines made later
    if (!changes.length) return
    remember()
    const sel = picked
    setItems((list) => changes.reduce((next, [kind, color]) => [
      ...next.flatMap((it) => {
        if (it.kind !== kind) return [it]
        const left = lineBoxes(it).flatMap((box) => cut(box, sel))
        return left.length ? [{ ...it, ...textMark(left) }] : []
      }),
      ...(color ? [{ id: nextId++, rot, kind, color, ...textMark(sel) }] : []),
    ], list))
  }

  async function addSignature(sig) {
    setSigning(false)
    if (sig.text) { // a name in a handwriting font, as a picture like a text box
      const img = await textPixels(sig.text, { size: 28, color: style.color, family: SIGN_FONT })
      return add(image(img), img.width / PX_PER_PT / W, img.height / PX_PER_PT / H)
    }
    // a drawing: a third of the page wide (less if that is too tall), in the middle
    let w = 0.3, h = (w * W) / sig.aspect / H
    if (h > 0.3) [w, h] = [(w * 0.3) / h, 0.3]
    put({ kind: 'ink', view: { x: (1 - w) / 2, y: (1 - h) / 2, w, h }, lines: sig.lines, color: style.color, width: 2, marker: false })
  }

  const apply = () => onApply(items.map(({ id: _id, view, viewUrl: _url, ...o }) => turnMark({ ...o, ...view }, steps(rot, o.rot))))
  const redacting = items?.some((it) => it.kind === 'redact')
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select, .signature')) return // text boxes keep their own undo and Delete
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase()
    if (e.key === 'Delete') remove()
    else if (mod && key === 'z' && !e.shiftKey) {
      e.preventDefault()
      undo()
    } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
      e.preventDefault()
      redo()
    }
  }
  const selecting = tool === 'select' && hasText // text can be picked under the stamps and marks
  const drawing = tool !== 'select'
  const ppt = fit ? fit.width / W : 1 // px per point
  // which style controls to show: for the tool, else for the selected mark
  const styled = tool !== 'select' ? tool : activeItem?.kind === 'ink' ? (activeItem.marker ? 'highlight' : 'pen') : activeItem?.kind
  const markerStyle = styled === 'highlight' || styled === 'note'

  return (
    <dialog className="modal editor" ref={(el) => el && !el.open && el.showModal()} onClose={onClose} onKeyDown={onKey}>
      <div className="editor-tools">
        <label className="button">
          <input type="file" hidden accept="image/*" onChange={(e) => { if (e.target.files[0]) addImage(e.target.files[0]); e.target.value = '' }} />
          도장·서명 이미지 넣기
        </label>
        <label className="check"><input type="checkbox" checked={clearWhite} onChange={(e) => setClearWhite(e.target.checked)} /> 흰 배경 투명하게</label>
        <button onClick={() => setSigning(true)} title="마우스나 손가락으로 그리거나, 이름을 손글씨체로 씁니다">서명 만들기</button>
        <span className="sep" />
        <textarea
          rows={1} placeholder="글상자에 넣을 글" value={text.value}
          onChange={(e) => setText((t) => ({ ...t, value: e.target.value }))}
        />
        <select value={text.size} onChange={(e) => setText((t) => ({ ...t, size: Number(e.target.value) }))} title="글자 크기">
          {[9, 10, 12, 14, 16, 20, 24, 32, 48].map((s) => <option key={s} value={s}>{s}pt</option>)}
        </select>
        <select value={text.color} onChange={(e) => setText((t) => ({ ...t, color: e.target.value }))} title="글자 색">
          {Object.entries(COLORS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <button disabled={!text.value.trim()} onClick={addText}>글상자 넣기</button>
        <span className="sep" />
        <button onClick={() => add({ kind: 'redact' }, 0.3, 0.04)} title="가릴 곳을 검게 칠해 파일에서 지웁니다">가림 상자</button>
        <button disabled={active === null} onClick={remove}>선택한 것 지우기</button>
      </div>
      <div className="editor-tools">
        <button className="icon" disabled={!history.past.length} onClick={undo} aria-label="되돌리기" title="되돌리기 (Ctrl+Z)">{ICONS.undo}</button>
        <button className="icon" disabled={!history.future.length} onClick={redo} aria-label="다시 하기" title="다시 하기 (Ctrl+Y)">{ICONS.redo}</button>
        <span className="sep" />
        <div className="tools" role="group" aria-label="도구">
          {Object.entries(TOOLS).map(([k, [label, title]]) => (
            <button key={k} className="icon" aria-pressed={tool === k} onClick={() => chooseTool(k)} aria-label={label} title={`${label}: ${title}`}>{ICONS[k]}</button>
          ))}
        </div>
        <span className="tool-name">{TOOLS[tool][0]}</span>
        {styled && styled !== 'select' && MARKS.has(styled === 'pen' ? 'ink' : styled) && (
          <>
            <span className="sep" />
            {markerStyle ? (
              <select value={style.marker} onChange={(e) => setStyle({ marker: e.target.value })} aria-label="색">
                {Object.entries(MARKERS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            ) : (
              <select value={style.color} onChange={(e) => setStyle({ color: e.target.value })} aria-label="색">
                {Object.entries(COLORS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            )}
            {['pen', 'square', 'circle', 'line', 'arrow'].includes(styled) && (
              <select value={style.width} onChange={(e) => setStyle({ width: Number(e.target.value) })} aria-label="굵기">
                {WIDTHS.map((w) => <option key={w} value={w}>{w}pt</option>)}
              </select>
            )}
            {(styled === 'square' || styled === 'circle') && (
              <label className="check"><input type="checkbox" checked={style.fill} onChange={(e) => setStyle({ fill: e.target.checked })} /> 연하게 채우기</label>
            )}
          </>
        )}
        {activeItem?.kind === 'note' && (
          <textarea
            ref={noteText} className="note-text" rows={2} placeholder="메모 내용" value={activeItem.text}
            onFocus={() => { typing.current = false }}
            onChange={(e) => {
              if (!typing.current) remember()
              typing.current = true
              update(activeItem.id, { text: e.target.value })
            }}
          />
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {redacting && (
        <p className="muted">가림 상자가 있는 쪽은 저장할 때 그림으로 바뀌어, 가린 글자가 파일에서 완전히 지워집니다. 그 쪽은 글자 선택·검색이 안 됩니다.</p>
      )}
      <div className="stage" ref={stage} onPointerDown={() => { setActive(null); setPicked(null) }}>
        <div className={['paper', drawing && 'drawing', selecting && 'selecting'].filter(Boolean).join(' ')} ref={paper} style={fit ?? undefined}>
          {picture ? <img src={picture} alt="" draggable={false} /> : source && <span className="muted">쪽을 그리는 중…</span>}
          <div className="textLayer" ref={textLayer} style={{ '--total-scale-factor': ppt }} onPointerDown={selecting ? pickText : undefined} />
          {fit && items?.map((it) => {
            const box = { left: `${it.view.x * 100}%`, top: `${it.view.y * 100}%`, width: `${it.view.w * 100}%`, height: `${it.view.h * 100}%` }
            const shape = it.kind === 'square' || it.kind === 'circle'
            return (
              <div
                key={it.id} className={['item', it.kind, it.marker && 'marker', it.id === active && 'active'].filter(Boolean).join(' ')}
                style={shape ? { ...box, border: `${it.width * ppt}px solid ${it.color}`, background: it.fill ?? 'none' } : box}
                onPointerDown={(e) => drag(e, it.id, 'move')} title={it.kind === 'note' ? it.text : undefined}
              >
                {it.viewUrl && <img src={it.viewUrl} alt="" draggable={false} />}
                {MARKS.has(it.kind) && <Mark it={it} w={it.view.w * fit.width} h={it.view.h * fit.height} ppt={ppt} />}
                {!TEXT_MARKS.has(it.kind) && it.kind !== 'note' && <span className="handle" onPointerDown={(e) => drag(e, it.id, 'resize')} />}
              </div>
            )
          })}
          {drawing && <div className="draw" onPointerDown={startDraw} title={TOOLS[tool][1]} />}
          {draft && fit && <Draft {...draft} fit={fit} style={style} ppt={ppt} />}
          {picked && fit && items && <TextMenu picked={picked} items={items} fit={fit} lineColor={style.color} onMark={markPicked} />}
        </div>
      </div>
      <div className="actions">
        <span className="muted">도구를 고르고 쪽 위에서 끌어서 그립니다. 선택 도구로 옮기고 크기를 바꾸며, 글자를 끌어서 고르면 형광펜·밑줄·취소선을 고릅니다. Delete 지우기, Ctrl+Z 되돌리기, Ctrl+Y 다시 하기.</span>
        <button onClick={onClose}>취소</button>
        <button className="primary" disabled={!items} onClick={apply}>적용</button>
      </div>
      {signing && <Signature onPick={addSignature} onClose={() => setSigning(false)} />}
    </dialog>
  )
}

// The menu over text picked with the select tool: what the text has now (pressed), and changes to it.
function TextMenu({ picked, items, fit, lineColor, onMark }) {
  const on = (kind) => items.filter((it) => it.kind === kind && lineBoxes(it).some((box) => picked.some((s) => touches(box, s))))
  const highlight = on('highlight')[0]?.color ?? null, underline = on('underline'), strikeout = on('strikeout')
  const color = underline[0]?.color ?? strikeout[0]?.color ?? lineColor
  const x0 = Math.min(...picked.map((l) => l.x)), x1 = Math.max(...picked.map((l) => l.x + l.w))
  const y0 = Math.min(...picked.map((l) => l.y)), y1 = Math.max(...picked.map((l) => l.y + l.h))
  const below = y0 * fit.height < 56 // no room above the text
  const half = 200 // px, about half the menu: kept inside the page
  const place = { left: Math.min(Math.max(((x0 + x1) / 2) * fit.width, half), fit.width - half), top: (below ? y1 : y0) * fit.height }
  return (
    <div
      className={['text-menu', below && 'below'].filter(Boolean).join(' ')} style={place} role="toolbar" aria-label="고른 글자"
      onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.target.tagName !== 'SELECT' && e.preventDefault()} // keep the text picked
    >
      <span className="muted">형광펜</span>
      {Object.entries(MARKERS).map(([c, name]) => (
        <button key={c} className="swatch" style={{ background: c }} aria-pressed={highlight === c} aria-label={`형광펜 ${name}`} title={name} onClick={() => onMark([['highlight', c]])} />
      ))}
      <button aria-pressed={!highlight} onClick={() => onMark([['highlight', null]])} title="형광펜 지우기">없음</button>
      <span className="sep" />
      <button aria-pressed={underline.length > 0} onClick={() => onMark([['underline', underline.length ? null : color]])}>밑줄</button>
      <button aria-pressed={strikeout.length > 0} onClick={() => onMark([['strikeout', strikeout.length ? null : color]])}>취소선</button>
      <select
        value={color} aria-label="줄 색" title="밑줄·취소선 색"
        onChange={(e) => onMark([...(underline.length ? [['underline', e.target.value]] : []), ...(strikeout.length ? [['strikeout', e.target.value]] : [])], e.target.value)}
      >
        {Object.entries(COLORS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
    </div>
  )
}

const pathOf = (lines, w, h) => lines.map((l) => (l.length === 2
  ? `M${l[0] * w} ${l[1] * h}h0` // a dot
  : l.map((v, k) => (k % 2 ? '' : `${k ? 'L' : 'M'}${v * w} ${l[k + 1] * h}`)).join(''))).join('')

function arrowHead([x1, y1, x2, y2], len) {
  const d = Math.hypot(x2 - x1, y2 - y1) || 1, [ux, uy] = [(x1 - x2) / d, (y1 - y2) / d]
  const wing = (s) => `${x2 + len * (ux * Math.cos(s) - uy * Math.sin(s))} ${y2 + len * (ux * Math.sin(s) + uy * Math.cos(s))}`
  return `M${wing(Math.PI / 6)}L${x2} ${y2}L${wing(-Math.PI / 6)}`
}

// A mark as the saved annotation will show it (pdf.js markAnnotation): w, h its size in px, ppt px per point.
// Squares and circles are their item's border.
function Mark({ it, w, h, ppt }) {
  const stroke = { fill: 'none', stroke: it.color, strokeWidth: (it.width ?? 1) * ppt, strokeLinecap: 'round', strokeLinejoin: 'round' }
  const svg = (body) => <svg width={w} height={h}>{body}</svg>
  switch (it.kind) {
    case 'ink':
      return svg(<path d={pathOf(it.lines, w, h)} {...stroke} opacity={it.opacity ?? 1} />)
    case 'highlight':
      return svg(it.rects.map(([u, v, rw, rh], i) => <rect key={i} x={u * w} y={v * h} width={rw * w} height={rh * h} fill={it.color} />))
    case 'underline':
    case 'strikeout':
      return svg(it.rects.map(([u, v, rw, rh], i) => {
        const y = (v + rh * (it.kind === 'underline' ? 0.92 : 0.55)) * h
        return <line key={i} x1={u * w} x2={(u + rw) * w} y1={y} y2={y} stroke={it.color} strokeWidth={Math.max(0.5, rh * h * 0.07)} />
      }))
    case 'line':
    case 'arrow': {
      const e = [it.ends[0] * w, it.ends[1] * h, it.ends[2] * w, it.ends[3] * h]
      return svg(<path d={`M${e[0]} ${e[1]}L${e[2]} ${e[3]}${it.kind === 'arrow' ? arrowHead(e, Math.max(8, it.width * 4) * ppt) : ''}`} {...stroke} />)
    }
    case 'note': // the icon pdf.js's markAnnotation draws, in its 20 x 20 space with y up
      return (
        <svg width={w} height={h} viewBox="0 0 20 20">
          <g transform="matrix(1 0 0 -1 0 20)" stroke="#404040" strokeWidth="1" strokeLinejoin="round">
            <path d="M1.5 18.5L18.5 18.5L18.5 5.5L10 5.5L4 1.5L5 5.5L1.5 5.5Z" fill={it.color} />
            <path d="M4.5 14.5H15.5M4.5 12H15.5M4.5 9.5H11.5" />
          </g>
        </svg>
      )
    default:
      return null
  }
}

// the stroke or shape being drawn, in px over the paper
function Draft({ tool, pts, fit, style, ppt }) {
  const [x0, y0] = [pts[0] * fit.width, pts[1] * fit.height], [x1, y1] = [pts.at(-2) * fit.width, pts.at(-1) * fit.height]
  const pen = tool === 'pen' || tool === 'highlight'
  const color = tool === 'highlight' ? style.marker : style.color
  const look = { fill: 'none', stroke: color, strokeWidth: (tool === 'highlight' ? MARKER_WIDTH : style.width) * ppt, strokeLinecap: 'round', strokeLinejoin: 'round' }
  let body = null
  if (pen) body = <path d={pathOf([pts], fit.width, fit.height)} {...look} />
  else if (tool === 'square') body = <rect x={Math.min(x0, x1)} y={Math.min(y0, y1)} width={Math.abs(x1 - x0)} height={Math.abs(y1 - y0)} {...look} />
  else if (tool === 'circle') body = <ellipse cx={(x0 + x1) / 2} cy={(y0 + y1) / 2} rx={Math.abs(x1 - x0) / 2} ry={Math.abs(y1 - y0) / 2} {...look} />
  else if (tool === 'line' || tool === 'arrow') body = <path d={`M${x0} ${y0}L${x1} ${y1}${tool === 'arrow' ? arrowHead([x0, y0, x1, y1], Math.max(8, style.width * 4) * ppt) : ''}`} {...look} />
  return <svg className={['draft', tool === 'highlight' && 'marker'].filter(Boolean).join(' ')} width={fit.width} height={fit.height}>{body}</svg>
}
