import { useEffect, useRef, useState } from 'react'
import { openPages } from './render.js'

const VIEW = 1000 // px, width of the detailed picture
const SCAN = 300 // px, width used to find which pages differ
const INK = 40 // brightness difference that counts as a change

// Two pictures of the same width -> one picture: B faded, red where only B has ink (added),
// blue where only A has (removed), orange where both have ink but it changed. Returns the changed share.
function difference(a, b) {
  const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height)
  const pixels = (c) => {
    const ctx = Object.assign(document.createElement('canvas'), { width: w, height: h }).getContext('2d', { willReadFrequently: true })
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    if (c) ctx.drawImage(c, 0, 0)
    return ctx.getImageData(0, 0, w, h)
  }
  const pa = pixels(a).data, out = pixels(b), pb = out.data
  let changed = 0
  for (let i = 0; i < pb.length; i += 4) {
    const la = pa[i] * 0.299 + pa[i + 1] * 0.587 + pa[i + 2] * 0.114, lb = pb[i] * 0.299 + pb[i + 1] * 0.587 + pb[i + 2] * 0.114
    const moved = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > INK * 1.5
    let rgb
    if (!moved) rgb = [255 - (255 - lb) * 0.35, 255 - (255 - lb) * 0.35, 255 - (255 - lb) * 0.35]
    else if (lb < la - INK) rgb = [220, 38, 38] // only in B
    else if (la < lb - INK) rgb = [37, 99, 235] // only in A
    else rgb = [234, 140, 0]
    if (moved) changed++
    ;[pb[i], pb[i + 1], pb[i + 2]] = rgb
  }
  return { image: out, share: changed / (w * h) }
}

const fitWidth = (px) => (w) => px / w

// Page-by-page picture comparison of two of the files: [{ name, bytes, password }].
export default function Compare({ files, onClose }) {
  const [pick, setPick] = useState([0, 1])
  const [docs, setDocs] = useState(null) // [A, B] opened
  const [page, setPage] = useState(0)
  const [scan, setScan] = useState({}) // page -> changed share
  const [error, setError] = useState(null)
  const canvas = useRef(null)
  const total = docs ? Math.max(docs[0].count, docs[1].count) : 0

  const choose = (k, i) => {
    setPick((p) => p.map((v, j) => (j === k ? i : v)))
    setDocs(null)
    setScan({})
    setPage(0)
  }

  useEffect(() => {
    let live = true, opened = []
    Promise.all(pick.map((i) => openPages(files[i].bytes, files[i].password)))
      .then((d) => { opened = d; if (live) setDocs(d); else d.forEach((x) => x.close()) })
      .catch((e) => setError(e.message))
    return () => {
      live = false
      opened.forEach((x) => x.close())
    }
  }, [pick, files])

  // which pages differ, in the background, small
  useEffect(() => {
    if (!docs) return
    let live = true
    ;(async () => {
      for (let i = 0; i < total && live; i++) {
        const [a, b] = await Promise.all(docs.map((d) => (i < d.count ? d.draw(i, fitWidth(SCAN)) : null)))
        if (live) setScan((s) => ({ ...s, [i]: a && b ? difference(a, b).share : 1 }))
      }
    })().catch(() => {})
    return () => { live = false }
  }, [docs, total])

  // the page in detail
  useEffect(() => {
    if (!docs) return
    let live = true
    Promise.all(docs.map((d) => (page < d.count ? d.draw(page, fitWidth(VIEW)) : null))).then(([a, b]) => {
      if (!live || !canvas.current) return
      const { image } = difference(a, b)
      Object.assign(canvas.current, { width: image.width, height: image.height }).getContext('2d').putImageData(image, 0, 0)
    }).catch((e) => setError(e.message))
    return () => { live = false }
  }, [docs, page])

  const label = (i) => (scan[i] === undefined ? '…' : scan[i] === 0 ? '같음' : scan[i] < 0.0005 ? '거의 같음' : '다름')
  return (
    <dialog className="modal compare" ref={(el) => el && !el.open && el.showModal()} onClose={onClose}>
      <div className="compare-tools">
        {['A', 'B'].map((name, k) => (
          <label key={name}>{name}
            <select value={pick[k]} onChange={(e) => choose(k, Number(e.target.value))}>
              {files.map((f, i) => <option key={i} value={i}>{f.name}</option>)}
            </select>
          </label>
        ))}
        <span className="legend"><i className="add" />B에만 있음 <i className="del" />A에만 있음 <i className="chg" />바뀜</span>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="compare-body">
        <ol className="compare-pages">
          {Array.from({ length: total }, (_, i) => (
            <li key={i}>
              <button className={[i === page && 'current', label(i) === '다름' && 'differs'].filter(Boolean).join(' ')} onClick={() => setPage(i)}>
                {i + 1}쪽 · {label(i)}
              </button>
            </li>
          ))}
        </ol>
        <div className="compare-view">
          {docs ? <canvas ref={canvas} /> : <span className="muted">여는 중…</span>}
          {docs && page >= Math.min(docs[0].count, docs[1].count) && (
            <p className="muted">{page >= docs[0].count ? 'A' : 'B'}에는 {page + 1}쪽이 없습니다.</p>
          )}
        </div>
      </div>
      <div className="actions">
        <span className="muted">글자가 아니라 그려진 모습을 비교합니다. 줄이 밀리면 그 아래가 모두 다르게 나옵니다.</span>
        <button className="primary" onClick={onClose}>닫기</button>
      </div>
    </dialog>
  )
}
