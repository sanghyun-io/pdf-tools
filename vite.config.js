import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The browser enforces "files never leave this PC": no requests to any other origin.
const policy = (script, worker) => [
  "default-src 'self'",
  `script-src ${script}`,
  "style-src 'self' 'unsafe-inline'", // React style attributes
  "img-src 'self' data: blob:",
  `worker-src ${worker}`,
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')
const WEB = policy("'self'", "'self'")

// build only: the dev server needs inline scripts and its HMR websocket
const csp = {
  name: 'csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${WEB}" />`),
}

// `vite build --mode single` adds dist/pdf-tools.html: one file that works opened straight from disk, offline,
// OCR data included (about 4 of its 6 MB). file:// refuses module scripts and workers loaded from other
// files, so everything goes inline.
const single = (fileName) => ({
  name: 'single',
  generateBundle: {
    order: 'post', // after Vite fills in its own placeholders (__VITE_PRELOAD__) in the chunks
    handler(_, bundle) {
      const hashes = []
      const script = (code, attrs = '') => {
        code = code.replaceAll('</script', '<\\/script')
        if (code.includes('<!--')) throw new Error('inline script contains "<!--", which the HTML parser misreads')
        hashes.push(`'sha256-${createHash('sha256').update(code).digest('base64')}'`)
        return `<script${attrs}>${code}</script>`
      }
      const inline = (html, tag, replacement) => {
        if (!html.includes(tag)) throw new Error(`not in index.html: ${tag}`)
        return html.replace(tag, () => replacement)
      }
      const icon = `data:image/png;base64,${readFileSync('public/favicon-32.png').toString('base64')}`
      let html = bundle['index.html'].source
        .replace(/ *<link rel="(icon|apple-touch-icon)".*\n/g, '')
        // after the charset: from disk there is no HTTP header, so it must sit in the first 1024 bytes
        .replace('<meta charset="UTF-8" />', (m) => `${m}\n    <link rel="icon" href="${icon}" />`)
      html = inline(html, '<script src="./check.js"></script>', script(readFileSync('public/check.js', 'utf8')))
      const code = Object.values(bundle).map((f) => f.code ?? '').join('')
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === 'chunk') html = inline(html, `<script type="module" crossorigin src="./${name}"></script>`, script(file.code, ' type="module"'))
        else if (name.endsWith('.css')) html = inline(html, `<link rel="stylesheet" crossorigin href="./${name}">`, `<style>${file.source}</style>`)
        // emitted but unused, like the web build's worker file
        else if (name !== 'index.html' && code.includes(name.split('/').pop())) throw new Error(`cannot inline ${name}`)
        delete bundle[name]
      }
      html = inline(html, WEB, policy(hashes.join(' '), 'blob:'))
      this.emitFile({ type: 'asset', fileName, source: html })
    },
  },
})

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const one = mode === 'single' ? 'pdf-tools.html' : null
  return {
    base: './', // works under any sub-path, e.g. https://<user>.github.io/pdf-tools/
    plugins: [react(), csp, one && single(one)],
    assetsInclude: ['**/*.traineddata.gz'], // the OCR data, inlined into pdf-tools.html (src/ocr/client.js)
    server: { port: 17020, strictPort: true },
    // single files go next to the web build instead of replacing it
    ...(one && { publicDir: false, build: { emptyOutDir: false, rolldownOptions: { output: { codeSplitting: false } } } }),
  }
})
