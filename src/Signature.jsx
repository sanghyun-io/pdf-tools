import { useRef, useState } from 'react'
import { SIGN_FONT } from './decor.js'

const PAD = [480, 180] // the drawing pad's own units
const KEY = 'pdf-tools:signatures'
const MAX_KEPT = 6
// signatures used before, kept in this browser only; a private window may keep nothing
const load = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? [] } catch { return [] }
}
const keep = (list) => {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_KEPT))) } catch { /* not kept */ }
}

// Make a signature: draw it with the mouse or a finger (as the editor's pen), or write a name in a
// handwriting font. onPick({ lines, aspect }) for a drawing, points 0..1 of its own box, aspect = width /
// height; onPick({ text }) for a name. What is used is kept for next time.
export default function Signature({ onPick, onClose }) {
  const [mode, setMode] = useState('draw')
  const [lines, setLines] = useState([]) // in pad units
  const [name, setName] = useState('')
  const [kept, setKept] = useState(load)
  const pad = useRef(null)

  function draw(e) {
    e.preventDefault()
    const r = pad.current.getBoundingClientRect()
    const at = (ev) => [((ev.clientX - r.left) * PAD[0]) / r.width, ((ev.clientY - r.top) * PAD[1]) / r.height]
    const pts = at(e)
    let last = [e.clientX, e.clientY]
    const done = lines
    setLines([...done, pts])
    const move = (ev) => {
      if (Math.hypot(ev.clientX - last[0], ev.clientY - last[1]) <= 2) return
      last = [ev.clientX, ev.clientY]
      pts.push(...at(ev))
      setLines([...done, [...pts]])
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function choose(sig) {
    const list = [sig, ...kept.filter((s) => JSON.stringify(s) !== JSON.stringify(sig))]
    keep(list)
    setKept(list)
    onPick(sig)
  }
  function pickDrawing() { // trimmed to the strokes, as 0..1 of their own box
    const all = lines.flat(), xs = all.filter((_, k) => k % 2 === 0), ys = all.filter((_, k) => k % 2 === 1)
    const x0 = Math.min(...xs) - 2, y0 = Math.min(...ys) - 2, w = Math.max(...xs) + 2 - x0, h = Math.max(...ys) + 2 - y0
    choose({ lines: lines.map((l) => l.map((v, k) => Math.round((k % 2 ? (v - y0) / h : (v - x0) / w) * 10000) / 10000)), aspect: w / h })
  }
  const ready = mode === 'draw' ? lines.length > 0 : name.trim().length > 0

  return (
    <dialog className="modal signature" ref={(el) => el && !el.open && el.showModal()} onClose={onClose} onPointerDown={(e) => e.stopPropagation()}>
      <div className="tabs" role="group">
        <button aria-pressed={mode === 'draw'} onClick={() => setMode('draw')}>그리기</button>
        <button aria-pressed={mode === 'name'} onClick={() => setMode('name')}>이름 쓰기</button>
      </div>
      {mode === 'draw' ? (
        <svg className="pad" ref={pad} viewBox={`0 0 ${PAD.join(' ')}`} onPointerDown={draw}>
          <line x1="24" x2={PAD[0] - 24} y1={PAD[1] - 40} y2={PAD[1] - 40} stroke="#d9dde3" />
          <path d={lines.map((l) => l.map((v, k) => (k % 2 ? '' : `${k ? 'L' : 'M'}${v} ${l[k + 1]}`)).join('') + (l.length === 2 ? 'h0' : '')).join('')}
            fill="none" stroke="#1d2129" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <input className="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="이름" style={{ fontFamily: SIGN_FONT }} autoFocus />
      )}
      {kept.length > 0 && (
        <>
          <p className="muted">전에 쓴 서명 (이 브라우저에만 남습니다)</p>
          <div className="kept">
            {kept.map((s, i) => (
              <button key={i} onClick={() => choose(s)} title="이 서명 넣기">
                {s.text ? <span style={{ fontFamily: SIGN_FONT }}>{s.text}</span> : (
                  <svg viewBox={`-0.05 -0.05 ${s.aspect + 0.1} 1.1`} height="36">
                    <path d={s.lines.map((l) => l.map((v, k) => (k % 2 ? '' : `${k ? 'L' : 'M'}${v * s.aspect} ${l[k + 1]}`)).join('')).join('')}
                      fill="none" stroke="#1d2129" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="actions">
        {mode === 'draw' && <button className="ghost" disabled={!lines.length} onClick={() => setLines([])}>지우기</button>}
        <button onClick={onClose}>취소</button>
        <button className="primary" disabled={!ready} onClick={() => (mode === 'draw' ? pickDrawing() : choose({ text: name.trim() }))}>넣기</button>
      </div>
    </dialog>
  )
}
