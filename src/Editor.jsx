import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { renderPages } from './render.js'
import { imagePixels, textPixels, turnedUrl, turnBox, steps, PX_PER_PT } from './decor.js'

const VIEW = 1100 // px, longest side of the page picture
const COLORS = { '#000000': '검정', '#1d4ed8': '파랑', '#c62828': '빨강' }

let nextId = 0

// One page, big, with stamps, signatures, text boxes and redaction boxes to drag and resize. A stamp keeps
// the rotation the page had when it was placed (decorate() in pdf.js), so after a later rotation it is
// shown turned here. Redaction boxes ({ kind: 'redact' }, no image) are burned in by App when saving.
export default function Editor({ page, source, onApply, onClose }) {
  const rot = (((page.base + page.rotate) % 360) + 360) % 360
  const [W, H] = rot % 180 ? [page.h, page.w] : [page.w, page.h] // points, as shown
  const [picture, setPicture] = useState(null)
  const [items, setItems] = useState(null) // overlays + { view: box at `rot`, viewUrl }
  const [active, setActive] = useState(null)
  const [text, setText] = useState({ value: '', size: 12, color: '#000000' })
  const [clearWhite, setClearWhite] = useState(true)
  const [error, setError] = useState(null)
  const [fit, setFit] = useState(null) // paper size in px
  const stage = useRef(null), paper = useRef(null)

  useEffect(() => {
    if (source) { // a blank page has none: the paper stays white
      renderPages(source.bytes, { password: source.password, pages: [page.index], rotation: rot, scale: (w, h) => VIEW / Math.max(w, h) },
        (_, canvas) => setPicture(canvas.toDataURL('image/jpeg', 0.9))).catch((e) => setError(`쪽을 그리지 못했습니다: ${e.message}`))
    }
    Promise.all((page.overlays ?? []).map(async (o) => {
      const n = steps(o.rot, rot)
      return { ...o, id: nextId++, view: turnBox(o, n), viewUrl: o.image && (n ? await turnedUrl(o.image.url, n * 90) : o.image.url) }
    })).then(setItems)
  }, [page, source, rot])

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

  const add = (fields, w, h) => {
    const k = Math.min(1, 0.9 / w, 0.9 / h)
    const view = { x: (1 - w * k) / 2, y: (1 - h * k) / 2, w: w * k, h: h * k }
    const item = { id: nextId++, rot, view, viewUrl: fields.image?.url, ...fields }
    setItems((list) => [...list, item])
    setActive(item.id)
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
    setItems((list) => list.filter((it) => it.id !== active))
    setActive(null)
  }

  function drag(e, id, mode) {
    e.preventDefault()
    e.stopPropagation()
    setActive(id)
    const r = paper.current.getBoundingClientRect()
    const { view: from, kind } = items.find((it) => it.id === id)
    const sx = e.clientX, sy = e.clientY
    const move = (ev) => {
      const dx = (ev.clientX - sx) / r.width, dy = (ev.clientY - sy) / r.height
      let v
      if (mode === 'move') {
        v = { ...from, x: Math.min(Math.max(0, from.x + dx), 1 - from.w), y: Math.min(Math.max(0, from.y + dy), 1 - from.h) }
      } else if (kind === 'redact') { // any shape
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

  const apply = () => onApply(items.map(({ kind, image, rot: r, view }) => ({ kind, image, rot: r, ...turnBox(view, steps(rot, r)) })))
  const redacting = items?.some((it) => it.kind === 'redact')
  const onKey = (e) => {
    if (e.key === 'Delete' && active !== null && !e.target.closest('input, textarea, select')) remove()
  }

  return (
    <dialog className="modal editor" ref={(el) => el && !el.open && el.showModal()} onClose={onClose} onKeyDown={onKey}>
      <div className="editor-tools">
        <label className="button">
          <input type="file" hidden accept="image/*" onChange={(e) => { if (e.target.files[0]) addImage(e.target.files[0]); e.target.value = '' }} />
          도장·서명 이미지 넣기
        </label>
        <label className="check"><input type="checkbox" checked={clearWhite} onChange={(e) => setClearWhite(e.target.checked)} /> 흰 배경 투명하게</label>
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
      {error && <p className="error">{error}</p>}
      {redacting && (
        <p className="muted">가림 상자가 있는 쪽은 저장할 때 그림으로 바뀌어, 가린 글자가 파일에서 완전히 지워집니다. 그 쪽은 글자 선택·검색이 안 됩니다.</p>
      )}
      <div className="stage" ref={stage} onPointerDown={() => setActive(null)}>
        <div className="paper" ref={paper} style={fit ?? undefined}>
          {picture ? <img src={picture} alt="" draggable={false} /> : source && <span className="muted">쪽을 그리는 중…</span>}
          {items?.map((it) => (
            <div
              key={it.id} className={['item', it.kind, it.id === active && 'active'].filter(Boolean).join(' ')}
              style={{ left: `${it.view.x * 100}%`, top: `${it.view.y * 100}%`, width: `${it.view.w * 100}%`, height: `${it.view.h * 100}%` }}
              onPointerDown={(e) => drag(e, it.id, 'move')}
            >
              {it.viewUrl && <img src={it.viewUrl} alt="" draggable={false} />}
              <span className="handle" onPointerDown={(e) => drag(e, it.id, 'resize')} />
            </div>
          ))}
        </div>
      </div>
      <div className="actions">
        <span className="muted">끌어서 옮기고, 오른쪽 아래 모서리로 크기를 바꿉니다. Delete로 지웁니다.</span>
        <button onClick={onClose}>취소</button>
        <button className="primary" disabled={!items} onClick={apply}>적용</button>
      </div>
    </dialog>
  )
}
