import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The browser enforces "files never leave this PC": no requests to any other origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // React style attributes
  "img-src 'self' data: blob:",
  "worker-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

// build only: the dev server needs inline scripts and its HMR websocket
const csp = {
  name: 'csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
}

// https://vite.dev/config/
export default defineConfig({
  base: './', // works under any sub-path, e.g. https://<user>.github.io/pdf-tools/
  plugins: [react(), csp],
  server: { port: 17020, strictPort: true },
})
