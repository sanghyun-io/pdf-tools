import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// tab title in the first browser language we have a name for (the page itself stays Korean)
const TITLES = { ko: 'PDF 도구', en: 'PDF Tools', ja: 'PDF ツール', zh: 'PDF 工具' }
const lang = navigator.languages.map((l) => l.slice(0, 2).toLowerCase()).find((l) => l in TITLES)
document.title = TITLES[lang ?? 'en']

// public/check.js already put an "unsupported browser" notice in #root
if (!window.pdfToolsUnsupported) {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
