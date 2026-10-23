import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { openPages } from './render.js'
import { imagePixels, textPixels, turnedUrl, turnMark, steps, PX_PER_PT, SIGN_FONT, TEXT_FONT, layoutText, layoutTable, HEADER_FILL, cellText, cellImage } from './decor.js'
import { MARKS } from './pdf.js'
import { DEFAULT_FONT, commonFonts, localFonts, canAskFonts, fontLabel } from './fonts.js'
import Signature from './Signature.jsx'

const VIEW = 1100 // px, longest side of the page picture
const COLORS = { '#000000': '검정', '#1d4ed8': '파랑', '#c62828': '빨강', '#15803d': '초록' }
const MARKERS = { '#fde047': '노랑', '#86efac': '연두', '#f9a8d4': '분홍', '#7dd3fc': '하늘' }
const WIDTHS = [1, 2, 4, 8] // pt
const MARKER_WIDTH = 12 // pt, the free highlighter
const NOTE = 20 // pt, a note's icon (NOTE_SIZE in pdf.js)
const TEXT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48]
const LINE_HEIGHTS = { 1.2: '줄 간격 좁게', 1.4: '줄 간격 보통', 1.8: '줄 간격 넓게' }
const BORDERS = { 0: '선 없음', 0.5: '선 가늘게', 1: '선 보통', 2: '선 굵게' }
const BOXES = new Set(['textbox', 'table']) // laid out from their content: as tall as it needs
const equalWidths = (n) => Array.from({ length: n }, () => 1 / n)
const MAX_STEPS = 100 // how far back 되돌리기 goes
// what a press on the page does
const TOOLS = {
  select: ['선택', '눌러서 고르고, 끌어서 옮기고, 오른쪽 아래 모서리로 크기를 바꿉니다. 글자를 끌어서 고르면 형광펜·밑줄·취소선을 고를 수 있습니다. 글상자와 표는 더블클릭해서 고칩니다'],
  text: ['글상자', '끌어서 폭을 정하거나 누른 곳에 상자를 만들고 바로 입력합니다. 높이는 글에 맞춰 늘어납니다'],
  table: ['표', '끌어서 폭을 정하거나 누른 곳에 3×3 표를 넣습니다. 칸을 더블클릭해 입력하고, Tab으로 다음 칸으로 갑니다'],
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
  text: icon(<path d="M5 6V4h14v2M12 4v16M9 20h6" />),
  table: icon(<><rect x="3" y="5" width="18" height="14" rx="1" /><path d="M3 10h18M3 15h18M9 5v14M15 5v14" /></>),
  left: icon(<path d="M4 6h16M4 10h10M4 14h16M4 18h10" />),
  center: icon(<path d="M4 6h16M7 10h10M4 14h16M7 18h10" />),
  right: icon(<path d="M4 6h16M10 10h10M4 14h16M10 18h10" />),
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

// One page, big, to decorate: stamps, signatures, redaction boxes, text boxes and tables written in place
// (drawn as pictures with invisible text when saving, App), and marks (see MARKS in pdf.js: pen,
// highlighter, underline, strike-out, shapes, notes) drawn with a tool. Everything can be dragged and
// resized; marks are saved as annotations. A stamp, box or mark keeps the rotation the page had when it was
// placed (decorate() in pdf.js), so after a later rotation it is shown turned here. Redaction boxes
// ({ kind: 'redact' }, no image) are burned in by App when saving. at / total: this page's place, for
// going to the page before or after (onApply(overlays, -1 | 1 | 'add')).
export default function Editor({ page, source, onApply, onClose, at = 0, total = 1 }) {
  const rot = (((page.base + page.rotate) % 360) + 360) % 360
  const [W, H] = rot % 180 ? [page.h, page.w] : [page.w, page.h] // points, as shown
  const [picture, setPicture] = useState(null)
  const [hasText, setHasText] = useState(false)
  const [items, setItems] = useState(null) // overlays + { view: box at `rot`, viewUrl }
  const [history, setHistory] = useState({ past: [], future: [] }) // earlier and undone `items`
  const [active, setActive] = useState(null)
  const [tool, setTool] = useState('select')
  const [style, setStyleState] = useState({ color: '#000000', marker: '#fde047', width: 2, fill: false, size: 12, bold: false, align: 'left', lineHeight: 1.4, border: 1, header: true, font: DEFAULT_FONT })
  const [fontList, setFontList] = useState(commonFonts) // the PC's fonts we know of: common ones, or all once allowed
  const [allFonts, setAllFonts] = useState(false)
  const [writing, setWriting] = useState(null) // the text box or table cell being typed in: { id, cell: [row, col] }
  const [draft, setDraft] = useState(null) // the stroke or shape being drawn: { tool, pts: [x, y, ...] } in page fractions
  const [picked, setPicked] = useState(null) // text picked with the select tool, line boxes: offers the text menu
  const [signing, setSigning] = useState(false)
  const [clearWhite, setClearWhite] = useState(true)
  const [error, setError] = useState(null)
  const [fit, setFit] = useState(null) // paper size in px
  const stage = useRef(null), paper = useRef(null), textLayer = useRef(null), noteText = useRef(null)
  const extend = useRef(null) // the pen drawing later strokes join, until the tool or style changes
  const typing = useRef(false) // a note, text box or cell being written: one step until it is left

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

  // every PC font, without asking, when the browser was allowed to show them before
  useEffect(() => {
    localFonts(false).then((list) => {
      if (!list) return
      setFontList(list)
      setAllFonts(true)
    })
  }, [])
  async function askFonts() {
    const list = await localFonts(true)
    if (!list) return setError('PC 글꼴 목록을 볼 수 없습니다. 허용하지 않았거나 이 브라우저(크롬·엣지에서 됨)가 지원하지 않습니다.')
    setFontList(list)
    setAllFonts(true)
  }

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

  // A text box or table in its own frame (it turns with the page it was placed on): quarter turns to how it
  // shows now, and its size there in points.
  const turnOf = (it) => steps(it.rot, rot)
  const own = (it) => (turnOf(it) % 2 ? { w: it.view.h * H, h: it.view.w * W } : { w: it.view.w * W, h: it.view.h * H })
  // as tall as its content: it grows downwards in its own frame, which is another way on screen once turned
  function fitted(it) {
    if (!BOXES.has(it.kind)) return it
    const { w, h } = own(it)
    const tall = it.kind === 'textbox' ? layoutText(it.text || ' ', { ...it, width: w }).height : layoutTable(it, w - it.border).height + it.border
    const d = tall - h, v = it.view
    const view = [{ ...v, h: v.h + d / H }, { ...v, x: v.x - d / W, w: v.w + d / W }, { ...v, y: v.y - d / H, h: v.h + d / H }, { ...v, w: v.w + d / W }][turnOf(it)]
    return { ...it, view }
  }

  const put = (item) => {
    remember()
    const id = nextId++
    setItems((list) => [...list, fitted({ id, rot, ...item })])
    setActive(id)
    return id
  }
  const update = (id, fields) => setItems((list) => list.map((it) => (it.id === id ? fitted({ ...it, ...fields }) : it)))
  // typing: one step per text box or cell typed in
  const type = (id, fields) => {
    if (!typing.current) remember()
    typing.current = true
    update(id, fields)
  }
  const write = (id, cell = null) => {
    typing.current = false
    setWriting({ id, cell })
    setActive(id)
  }
  // leaving a text box: one left empty goes
  const stopWriting = () => {
    if (!writing) return
    const it = items.find((x) => x.id === writing.id)
    if (it?.kind === 'textbox' && !it.text.trim()) setItems((list) => list.filter((x) => x.id !== it.id))
    setWriting(null)
  }
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
  const remove = () => {
    if (active === null) return
    remember()
    setItems((list) => list.filter((it) => it.id !== active))
    setActive(null)
  }
  const activeItem = items?.find((it) => it.id === active)

  const chooseTool = (t) => {
    extend.current = null
    stopWriting()
    setTool(t)
    setPicked(null)
    if (t !== 'select') setActive(null)
  }
  // A new style changes the selected mark, text box or table. With a box selected it is that box's alone (a
  // title made big doesn't make the next box big); otherwise it is what new ones get.
  function setStyle(fields) {
    extend.current = null
    const it = activeItem
    if (!BOXES.has(it?.kind)) setStyleState((s) => ({ ...s, ...fields }))
    if (!it) return
    const only = (keys) => Object.fromEntries(Object.entries(fields).filter(([k]) => keys.includes(k)))
    let f = {}
    if (it.kind === 'textbox') f = only(['font', 'size', 'bold', 'color', 'align', 'lineHeight'])
    else if (it.kind === 'table') f = only(['font', 'size', 'color', 'border', 'header'])
    else if (MARKS.has(it.kind)) {
      const marker = it.kind === 'highlight' || it.kind === 'note' || it.marker
      if (fields.color && !marker) f.color = fields.color
      if (fields.marker && marker) f.color = fields.marker
      if (fields.width && 'width' in it && !it.marker) f.width = fields.width
      if ('fill' in fields && (it.kind === 'square' || it.kind === 'circle')) f.fill = fields.fill ? tint(it.color) : null
      if (f.color && it.fill) f.fill = tint(f.color)
    }
    if (!Object.keys(f).length) return
    remember()
    update(it.id, f)
  }
  // add or take out a row or column, next to the cell being typed in (else at the end); columns stay equal
  function tableChange(op) {
    const t = activeItem
    const [r, c] = writing?.id === t.id && writing.cell ? writing.cell : [t.rows.length - 1, t.widths.length - 1]
    let rows = t.rows.map((row) => [...row]), widths = t.widths
    if (op === 'row+') rows.splice(r + 1, 0, widths.map(() => ''))
    else if (op === 'row-' && rows.length > 1) rows.splice(r, 1)
    else if (op === 'col+') { // the column splits in two
      rows = rows.map((row) => [...row.slice(0, c + 1), '', ...row.slice(c + 1)])
      widths = [...widths.slice(0, c), widths[c] / 2, widths[c] / 2, ...widths.slice(c + 1)]
    } else if (op === 'col-' && widths.length > 1) { // its width goes to the column beside it
      rows = rows.map((row) => row.filter((_, k) => k !== c))
      const to = c > 0 ? c - 1 : 1
      widths = widths.map((w, k) => (k === to ? w + widths[c] : w)).filter((_, k) => k !== c)
    } else return
    remember()
    if (writing?.id === t.id) setWriting(null)
    update(t.id, { rows, widths })
  }

  // the cell being typed in becomes value (text, or { image }): one step
  function setCell(value) {
    const t = items.find((it) => it.id === writing.id), [r, c] = writing.cell
    remember()
    update(t.id, { rows: t.rows.map((row, k) => (k === r ? row.map((v, j) => (j === c ? value : v)) : row)) })
    typing.current = false
  }

  // A table's column edge dragged: the two columns beside it trade width. Pointer moves are taken along the
  // table's own x axis, which points another way once the page has turned.
  function dragColumn(e, it, c) {
    e.preventDefault()
    e.stopPropagation()
    const n = turnOf(it), sx = e.clientX, sy = e.clientY, from = it.widths
    const inner = (own(it).w - it.border) * ppt, MIN = 0.04
    let moved = false
    const move = (ev) => {
      if (!moved) remember()
      moved = true
      const d = [ev.clientX - sx, ev.clientY - sy, sx - ev.clientX, sy - ev.clientY][n] / inner
      const pair = from[c] + from[c + 1], left = Math.min(Math.max(from[c] + d, MIN), pair - MIN)
      update(it.id, { widths: from.map((w, k) => (k === c ? left : k === c + 1 ? pair - left : w)) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function drag(e, id, mode) {
    e.preventDefault()
    e.stopPropagation()
    if (writing && writing.id !== id) stopWriting()
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
      } else if (kind === 'redact' || MARKS.has(kind) || BOXES.has(kind)) { // any shape (a box then fits its content)
        v = { ...from, w: Math.max(0.01, Math.min(from.w + dx, 1 - from.x)), h: Math.max(0.005, Math.min(from.h + dy, 1 - from.y)) }
      } else { // resize from the bottom-right corner, keeping the shape
        const w = Math.max(0.02, Math.min(from.w + dx, 1 - from.x, ((1 - from.y) * from.w) / from.h))
        v = { ...from, w, h: (w * from.h) / from.w }
      }
      setItems((list) => list.map((it) => (it.id === id ? (mode === 'move' ? { ...it, view: v } : fitted({ ...it, view: v })) : it)))
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
    if (t === 'text' || t === 'table') { // the drag sets the width (a click: a default one); the height follows the content
      const w = tiny ? (t === 'text' ? 0.4 : 0.6) : Math.max(0.05, Math.abs(x1 - x0))
      const view = { x: Math.min(tiny ? x0 : Math.min(x0, x1), 1 - w), y: Math.min(y0, y1), w, h: 0.02 }
      const id = t === 'text'
        ? put({ kind: 'textbox', view, text: '', font: style.font, size: style.size, bold: style.bold, color: style.color, align: style.align, lineHeight: style.lineHeight })
        : put({ kind: 'table', view, rows: [['', '', ''], ['', '', ''], ['', '', '']], widths: equalWidths(3), font: style.font, size: Math.min(style.size, 11), color: style.color, header: style.header, border: style.border, borderColor: '#000000' })
      setTool('select')
      write(id, t === 'table' ? [0, 0] : null)
      return
    }
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

  // what the page gets: every item back in the frame it was placed in. go: to another page after applying
  const apply = (go) => onApply(items.map(({ id: _id, view, viewUrl: _url, ...o }) => turnMark({ ...o, ...view }, steps(rot, o.rot))), go)
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
  // (a selected note has its own box beside it)
  const styled = tool !== 'select' ? tool : activeItem?.kind === 'ink' ? (activeItem.marker ? 'highlight' : 'pen') : activeItem?.kind === 'note' ? null : activeItem?.kind
  const markerStyle = styled === 'highlight' || styled === 'note'
  const textStyle = styled === 'text' || styled === 'textbox', tableStyle = styled === 'table'
  // the style a selected box has, else the one new boxes get
  const look = BOXES.has(activeItem?.kind) ? { ...style, ...activeItem } : style

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
        {(textStyle || tableStyle) && (
          <>
            <span className="sep" />
            <select
              value={look.font ?? DEFAULT_FONT} aria-label="글꼴" className="font-pick"
              title={allFonts ? 'PC에 설치된 글꼴. 저장하면 쓴 글자만 담아 글꼴을 PDF에 넣어, 다른 프로그램에서도 진짜 글자로 보이고 고칠 수 있습니다'
                : 'PC에 흔히 있는 글꼴. "PC 글꼴 모두 불러오기"를 허용하면 모든 글꼴을 고를 수 있고, 저장할 때 진짜 글자로 들어갑니다'}
              onChange={(e) => (e.target.value === '*all' ? askFonts() : setStyle({ font: e.target.value }))}
            >
              {[...new Set([look.font ?? DEFAULT_FONT, ...fontList])].map((f) => <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>{fontLabel(f)}</option>)}
              {canAskFonts && !allFonts && <option value="*all">PC 글꼴 모두 불러오기…</option>}
            </select>
            <select value={look.size} onChange={(e) => setStyle({ size: Number(e.target.value) })} aria-label="글자 크기">
              {TEXT_SIZES.map((s) => <option key={s} value={s}>{s}pt</option>)}
            </select>
            <select value={look.color} onChange={(e) => setStyle({ color: e.target.value })} aria-label="글자 색">
              {Object.entries(COLORS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </>
        )}
        {textStyle && (
          <>
            <button className="icon bold" aria-pressed={!!look.bold} onClick={() => setStyle({ bold: !look.bold })} aria-label="굵게" title="굵게">가</button>
            {['left', 'center', 'right'].map((a) => (
              <button key={a} className="icon" aria-pressed={look.align === a} onClick={() => setStyle({ align: a })} aria-label={`${{ left: '왼쪽', center: '가운데', right: '오른쪽' }[a]} 맞춤`} title={`${{ left: '왼쪽', center: '가운데', right: '오른쪽' }[a]} 맞춤`}>{ICONS[a]}</button>
            ))}
            <select value={look.lineHeight} onChange={(e) => setStyle({ lineHeight: Number(e.target.value) })} aria-label="줄 간격">
              {Object.entries(LINE_HEIGHTS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </>
        )}
        {tableStyle && (
          <>
            <select value={look.border} onChange={(e) => setStyle({ border: Number(e.target.value) })} aria-label="선 굵기">
              {Object.entries(BORDERS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <label className="check"><input type="checkbox" checked={!!look.header} onChange={(e) => setStyle({ header: e.target.checked })} /> 머리 행</label>
            {activeItem?.kind === 'table' && (
              <span className="table-ops" role="group" aria-label="행과 열">
                <button onClick={() => tableChange('row+')} title="고른 칸 아래에 행 넣기 (없으면 맨 아래)">행 +</button>
                <button onClick={() => tableChange('row-')} disabled={activeItem.rows.length < 2} title="고른 칸의 행 빼기">행 −</button>
                <button onClick={() => tableChange('col+')} title="고른 칸 오른쪽에 열 넣기">열 +</button>
                <button onClick={() => tableChange('col-')} disabled={activeItem.widths.length < 2} title="고른 칸의 열 빼기">열 −</button>
                {writing?.id === activeItem.id && writing.cell && (
                  cellImage(activeItem.rows[writing.cell[0]][writing.cell[1]]) ? (
                    <button onClick={() => setCell('')} title="고른 칸의 그림을 빼고 빈 칸으로">그림 빼기</button>
                  ) : (
                    <label className="button" title="고른 칸에 그림을 넣습니다. 칸 폭에 맞춰 비율대로 들어갑니다">
                      <input type="file" hidden accept="image/*" onChange={async (e) => {
                        const file = e.target.files[0]
                        e.target.value = ''
                        if (!file) return
                        try { setCell({ image: await imagePixels(file) }) } catch (err) { setError(err.message) }
                      }} />
                      칸에 그림
                    </label>
                  )
                )}
              </span>
            )}
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {redacting && (
        <p className="muted">가림 상자가 있는 쪽은 저장할 때 그림으로 바뀌어, 가린 글자가 파일에서 완전히 지워집니다. 그 쪽은 글자 선택·검색이 안 됩니다.</p>
      )}
      <div className="stage" ref={stage} onPointerDown={() => { stopWriting(); setActive(null); setPicked(null) }}>
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
                onDoubleClick={it.kind === 'textbox' ? () => write(it.id) : undefined}
              >
                {it.viewUrl && <img src={it.viewUrl} alt="" draggable={false} />}
                {MARKS.has(it.kind) && <Mark it={it} w={it.view.w * fit.width} h={it.view.h * fit.height} ppt={ppt} />}
                {BOXES.has(it.kind) && (
                  <Turned n={turnOf(it)} w={own(it).w * ppt} h={own(it).h * ppt}>
                    {it.kind === 'textbox' ? (
                      <TextBoxView
                        it={it} width={own(it).w} ppt={ppt} writing={writing?.id === it.id}
                        onText={(text) => type(it.id, { text })} onDone={() => { stopWriting(); setActive(it.id) }}
                      />
                    ) : (
                      <TableView
                        it={it} width={own(it).w} ppt={ppt} cell={writing?.id === it.id ? writing.cell : null}
                        onCell={(r, c, text) => type(it.id, { rows: it.rows.map((row, k) => (k === r ? row.map((s, j) => (j === c ? text : s)) : row)) })}
                        onGo={(cell) => (cell ? write(it.id, cell) : setWriting(null))}
                        onColumn={it.id === active ? (e, c) => dragColumn(e, it, c) : null}
                      />
                    )}
                  </Turned>
                )}
                {!TEXT_MARKS.has(it.kind) && it.kind !== 'note' && <span className="handle" onPointerDown={(e) => drag(e, it.id, 'resize')} />}
              </div>
            )
          })}
          {drawing && <div className="draw" onPointerDown={startDraw} title={TOOLS[tool][1]} />}
          {draft && fit && <Draft {...draft} fit={fit} style={style} ppt={ppt} />}
          {picked && fit && items && <TextMenu picked={picked} items={items} fit={fit} lineColor={style.color} onMark={markPicked} />}
          {activeItem?.kind === 'note' && fit && (
            <NoteMenu
              note={activeItem} fit={fit} textRef={noteText}
              onFocus={() => { typing.current = false }}
              onText={(text) => {
                if (!typing.current) remember()
                typing.current = true
                update(activeItem.id, { text })
              }}
              onColor={(color) => {
                if (color === activeItem.color) return
                remember()
                update(activeItem.id, { color })
                setStyleState((s) => ({ ...s, marker: color })) // and for the next note
              }}
            />
          )}
        </div>
      </div>
      <div className="actions">
        <span className="pager" role="group" aria-label="쪽 넘기기">
          <button className="icon" disabled={!items || at === 0} onClick={() => apply(-1)} aria-label="이전 쪽" title="이 쪽을 적용하고 이전 쪽으로">‹</button>
          <span>{at + 1} / {total}쪽</span>
          <button className="icon" disabled={!items || at >= total - 1} onClick={() => apply(1)} aria-label="다음 쪽" title="이 쪽을 적용하고 다음 쪽으로">›</button>
          <button disabled={!items} onClick={() => apply('add')} title="이 쪽을 적용하고, 뒤에 빈 쪽을 넣어 엽니다">쪽 추가</button>
        </span>
        <span className="muted">도구를 고르고 쪽 위에서 끌어서 그립니다. 선택 도구로 옮기고 크기를 바꾸며, 글자를 끌어서 고르면 형광펜·밑줄·취소선, 글상자와 표는 더블클릭해서 고칩니다. Ctrl+Z 되돌리기.</span>
        <button onClick={onClose}>취소</button>
        <button className="primary" disabled={!items} onClick={() => apply()}>적용</button>
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

// Beside a selected note: what it says and its color (the current one pressed). Opens on the side with room.
function NoteMenu({ note, fit, textRef, onFocus, onText, onColor }) {
  const gap = 8, width = 250 // px
  const left = note.view.x * fit.width, right = (note.view.x + note.view.w) * fit.width
  const place = { top: note.view.y * fit.height, ...(right + gap + width > fit.width ? { right: fit.width - left + gap } : { left: right + gap }) }
  return (
    <div className="note-menu" style={place} role="group" aria-label="메모" onPointerDown={(e) => e.stopPropagation()}>
      <textarea ref={textRef} rows={4} placeholder="메모 내용" value={note.text} onFocus={onFocus} onChange={(e) => onText(e.target.value)} />
      <div className="swatches">
        <span className="muted">색</span>
        {Object.entries(MARKERS).map(([c, name], i) => (
          <button key={c} className="swatch" style={{ background: c }} aria-pressed={note.color === c} aria-label={`메모 색 ${name}`} title={i ? name : `${name} (기본)`} onClick={() => onColor(c)} />
        ))}
      </div>
    </div>
  )
}

// The inside of a text box or table, drawn in its own frame (w x h px) and turned the quarter turns its page
// has made since it was placed.
function Turned({ n, w, h, children }) {
  const turn = ['none', `translateX(${h}px) rotate(90deg)`, `translate(${w}px, ${h}px) rotate(180deg)`, `translateY(${w}px) rotate(270deg)`][n]
  return <div className="turned" style={{ width: w, height: h, transform: turn }}>{children}</div>
}

const fontCss = (o, lineH, ppt, bold = o.bold) => ({ fontFamily: `"${o.font ?? DEFAULT_FONT}", ${TEXT_FONT}`, fontSize: o.size * ppt, fontWeight: bold ? 'bold' : 'normal', color: o.color, lineHeight: `${lineH * ppt}px` })
const caretAtEnd = (e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)

// A text box (width pt): its lines as they will be saved (decor.js layoutText), or a text area while typed in.
function TextBoxView({ it, width, ppt, writing, onText, onDone }) {
  const layout = useMemo(() => layoutText(it.text, { ...it, width }), [it, width])
  const font = fontCss(it, layout.lineH, ppt)
  if (writing) {
    return (
      <textarea
        className="box-text" autoFocus onFocus={caretAtEnd} value={it.text} placeholder="글을 입력하세요"
        style={{ ...font, textAlign: it.align, height: (layout.height + layout.lineH) * ppt }}
        onPointerDown={(e) => e.stopPropagation()} onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone() } }}
      />
    )
  }
  return layout.lines.map((l, i) => <div key={i} className="box-line" style={{ ...font, left: l.x * ppt, top: i * layout.lineH * ppt }}>{l.text}</div>)
}

// A table (width pt, border included) as it will be saved (decor.js layoutTable): header fill, grid, cell
// text. A double-clicked cell is typed in; Tab goes to the next cell, Shift+Tab back, Escape stops. While
// the table is selected (onColumn), its inner column edges can be dragged.
function TableView({ it, width, ppt, cell, onCell, onGo, onColumn }) {
  const layout = useMemo(() => layoutTable(it, width - it.border), [it, width])
  const k = ppt, o = it.border / 2, inner = width - it.border, cols = it.widths.length
  const grid = [...layout.cols.map((c) => c.x), inner].map((x) => `M${(o + x) * k} ${o * k}V${(o + layout.height) * k}`)
    .concat([...layout.rows.map((r) => r.y), layout.height].map((y) => `M${o * k} ${(o + y) * k}H${(o + inner) * k}`)).join('')
  const step = (r, c, back) => {
    const i = r * cols + c + (back ? -1 : 1)
    return i < 0 || i >= it.rows.length * cols ? null : [Math.floor(i / cols), i % cols]
  }
  return (
    <>
      <svg className="table-grid" width={width * k} height={(layout.height + it.border) * k}>
        {it.header && layout.rows[0] && <rect x={o * k} y={o * k} width={inner * k} height={layout.rows[0].h * k} fill={HEADER_FILL} />}
        {it.border > 0 && <path d={grid} stroke={it.borderColor} strokeWidth={it.border * k} fill="none" />}
      </svg>
      {layout.rows.flatMap((row, r) => row.cells.map((lay, c) => {
        const col = layout.cols[c], here = cell?.[0] === r && cell?.[1] === c, pad = layout.pad * k
        const font = fontCss(it, lay.lineH, k, row.bold)
        return (
          <div
            key={`${r}:${c}`} className="cell" style={{ left: (o + col.x) * k, top: (o + row.y) * k, width: col.w * k, height: row.h * k }}
            onDoubleClick={(e) => { e.stopPropagation(); onGo([r, c]) }}
          >
            {lay.image ? (
              <img src={lay.image.url} alt="" draggable={false} className={here ? 'cell-image chosen' : 'cell-image'} style={{ left: pad, top: pad, width: lay.width * k, height: lay.height * k }} />
            ) : here ? (
              <textarea
                className="box-text" autoFocus onFocus={caretAtEnd} value={cellText(it.rows[r][c])}
                style={{ ...font, left: pad, top: pad, width: col.w * k - 2 * pad, height: row.h * k - 2 * pad + lay.lineH * k }}
                onPointerDown={(e) => e.stopPropagation()} onChange={(e) => onCell(r, c, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Tab') { e.preventDefault(); onGo(step(r, c, e.shiftKey)) }
                  if (e.key === 'Escape') { e.preventDefault(); onGo(null) }
                }}
              />
            ) : lay.lines.map((l, i) => <div key={i} className="box-line" style={{ ...font, left: pad + l.x * k, top: pad + i * lay.lineH * k }}>{l.text}</div>)}
          </div>
        )
      }))}
      {onColumn && layout.cols.slice(1).map((col, i) => (
        <span
          key={i} className="col-edge" style={{ left: (o + col.x) * k, height: (layout.height + it.border) * k }}
          onPointerDown={(e) => onColumn(e, i)} title="끌어서 칸 폭 바꾸기"
        />
      ))}
    </>
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
