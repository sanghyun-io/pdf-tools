import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// tab title in the first browser language we have a name for (the page itself stays Korean)
const TITLES = { ko: 'PDF 도구', en: 'PDF Tools', ja: 'PDF ツール', zh: 'PDF 工具' }
const lang = navigator.languages.map((l) => l.slice(0, 2).toLowerCase()).find((l) => l in TITLES)
document.title = TITLES[lang ?? 'en']

// the web build keeps itself on the PC to open offline and install as an app (src/sw.js); not from disk or the dev server
if (import.meta.env.MODE === 'production' && 'serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js')

// public/check.js already put an "unsupported browser" notice in #root
if (!window.pdfToolsUnsupported) {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
