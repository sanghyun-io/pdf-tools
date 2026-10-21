import { useEffect, useRef, useState } from 'react'
import { readPdf, buildPdf, imageToPdf, pageInfo, moveItems, PasswordError } from './pdf.js'
import { renderThumbs } from './thumbs.js'

const HUES = [210, 20, 140, 280, 45, 330, 170, 100]
const UNDO_LIMIT = 50
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
const stem = (name) => name.replace(/\.[^.]+$/, '')
const size = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  Object.assign(document.createElement('a'), { href: url, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// asks for the open password until it fits or the user cancels
async function openPdf(bytes, name) {
  for (let password = ''; ;) {
    try {
      return { doc: await readPdf(bytes, password), password }
    } catch (e) {
      if (!(e instanceof PasswordError)) throw e
      const next = window.prompt(`${name}\n${e.wrong ? '암호가 틀렸습니다. 다시 입력하세요.' : '열기 암호를 입력하세요.'}`)
      if (next === null) throw new Error('암호를 입력하지 않아 건너뛰었습니다')
      password = next
    }
  }
}

export default function App() {
  // append-only so pages, undo history and thumbnails can point at an index
  const sources = useRef([]) // { name, doc, hue }
  const nextId = useRef(0)
  const dragging = useRef(null) // ids being dragged
  const thumbQueue = useRef(Promise.resolve()) // one file's thumbnails at a time
  const [pages, setPages] = useState([]) // { id, src, index, rotate, w, h, base }
  const [history, setHistory] = useState([]) // earlier `pages` arrays, for undo
  const [thumbs, setThumbs] = useState({}) // "src:index" -> image URL
  const [selected, setSelected] = useState(new Set())
  const [anchor, setAnchor] = useState(null)
  const [dropAt, setDropAt] = useState(null)
  const [level, setLevel] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

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
        const { doc, password } = await openPdf(bytes, file.name)
        const src = sources.current.push({ name: file.name, doc, hue: HUES[sources.current.length % HUES.length] }) - 1
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
  const clearAll = () => {
    commit([]) // undoable, so the loaded files stay in memory
    setSelected(new Set())
    setMessage(null)
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, select, textarea')) return
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

  async function save(onlySelected) {
    const list = onlySelected ? pages.filter((p) => selected.has(p.id)) : pages
    setBusy(true)
    setMessage(null)
    try {
      const parts = list.map((p) => ({ doc: sources.current[p.src].doc, index: p.index, rotate: p.rotate }))
      const { bytes, saved } = await buildPdf(parts, level || null)
      const name = `${stem(sources.current[list[0].src].name)}_${onlySelected ? 'selected' : 'edited'}.pdf`
      download(bytes, name)
      const shrunk = level ? (saved ? `, 이미지에서 ${size(saved)} 줄임` : ', 줄일 수 있는 이미지가 없었습니다') : ''
      setMessage({ text: `${name} 저장: ${list.length}페이지, ${size(bytes.length)}${shrunk}` })
    } catch (e) {
      setMessage({ error: true, text: `저장하지 못했습니다: ${e.message}` })
    } finally {
      setBusy(false)
    }
  }

  const picker = (
    <input
      type="file" hidden multiple accept="application/pdf,.pdf,image/*"
      onChange={(e) => { addFiles([...e.target.files]); e.target.value = '' }}
    />
  )
  const undoButton = <button disabled={!history.length} onClick={undo} title="Ctrl+Z">되돌리기</button>

  return (
    <main onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header>
        <h1>PDF 도구</h1>
        <p className="muted">
          파일은 이 PC 밖으로 나가지 않습니다. 모든 처리는 브라우저 안에서 합니다.
          {' · '}
          <a href={`${import.meta.env.BASE_URL}compress-guide.html`} target="_blank" rel="noopener">압축 방식 알아보기</a>
        </p>
      </header>

      {pages.length === 0 ? (
        <>
          <label className="drop">
            {picker}
            <strong>PDF나 이미지를 여기로 끌어놓거나 클릭해서 고르세요</strong>
            <span className="muted">여러 개를 한 번에 올릴 수 있습니다. 이미지는 A4 한 페이지가 됩니다.</span>
          </label>
          {history.length > 0 && <p>{undoButton}</p>}
        </>
      ) : (
        <>
          <div className="toolbar">
            <label className="button">{picker}+ 파일 추가</label>
            <span className="count">{selected.size ? `${selected.size}개 선택` : `${pages.length}페이지`}</span>
            <button disabled={!selected.size} onClick={() => rotateSelected(-90)} title="왼쪽으로 90°">↺ 왼쪽</button>
            <button disabled={!selected.size} onClick={() => rotateSelected(90)} title="오른쪽으로 90°">↻ 오른쪽</button>
            <button disabled={!selected.size} onClick={removeSelected}>삭제</button>
            <button onClick={() => setSelected(new Set(pages.map((p) => p.id)))}>전체 선택</button>
            {undoButton}
            <span className="spacer" />
            <select value={level} onChange={(e) => setLevel(e.target.value)} title="저장할 때 사진·스캔 이미지를 줄입니다">
              <option value="">용량 줄이기 안 함</option>
              <option value="light">용량 줄이기: 약</option>
              <option value="normal">용량 줄이기: 보통</option>
              <option value="strong">용량 줄이기: 강</option>
            </select>
            <button disabled={!selected.size || busy} onClick={() => save(true)}>선택만 저장</button>
            <button className="primary" disabled={busy} onClick={() => save(false)}>PDF로 저장</button>
            <button className="ghost" onClick={clearAll}>모두 비우기</button>
          </div>
          <p className="muted help">
            클릭 선택 · Ctrl+클릭 추가/해제 · Shift+클릭 범위 · Ctrl+A 전체 · 끌어서 옮기기 · Delete 삭제 · Ctrl+Z 되돌리기 · Esc 선택 해제
          </p>
          <div className="grid" onClick={() => setSelected(new Set())}>
            {pages.map((p, i) => {
              const src = sources.current[p.src]
              const thumb = thumbs[`${p.src}:${p.index}`]
              const turned = ((p.rotate % 360) + 360) % 360
              const k = 100 / Math.max(p.w, p.h)
              const cls = ['page',
                selected.has(p.id) && 'selected',
                dropAt === i && 'insert-before',
                dropAt === pages.length && i === pages.length - 1 && 'insert-after',
              ].filter(Boolean).join(' ')
              return (
                <div
                  key={p.id} className={cls} draggable style={{ '--hue': src.hue }}
                  onClick={(e) => clickPage(e, p.id)} onDragStart={(e) => onDragStart(e, p.id)}
                  onDragOver={(e) => onDragOverPage(e, i)} onDragEnd={endDrag}
                >
                  <div className="sheet-box">
                    <div
                      className={thumb ? 'sheet has-thumb' : 'sheet'}
                      style={{ width: p.w * k, height: p.h * k, transform: `rotate(${p.base + p.rotate}deg)` }}
                    >
                      {thumb && <img src={thumb} alt="" draggable={false} />}
                    </div>
                  </div>
                  <span className="badge" title={`${src.name}의 원래 ${p.index + 1}쪽`}>p.{p.index + 1}</span>
                  <div className="label" title={src.name}>
                    <b>{i + 1}</b> {src.name}{turned ? ` · ${turned}°` : ''}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {busy && <p className="muted">처리 중…</p>}
      {message && <p className={message.error ? 'error' : 'ok'}>{message.text}</p>}
    </main>
  )
}
