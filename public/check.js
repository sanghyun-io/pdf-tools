// Runs before the app bundle, written so any browser can parse it: on a browser that lacks what the app
// needs, show a notice instead of a blank page. Keep the list in sync with the APIs src/ relies on.
(function () {
  var ok = typeof DecompressionStream === 'function'
    && typeof CompressionStream === 'function'
    && typeof OffscreenCanvas === 'function'
    && typeof OffscreenCanvas.prototype.convertToBlob === 'function'
    && typeof createImageBitmap === 'function'
    && !!(window.crypto && window.crypto.subtle)
    && typeof Array.prototype.findLast === 'function'
  if (ok) return
  window.pdfToolsUnsupported = true
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('root').innerHTML =
      '<main><h1>PDF 도구</h1><div class="notice"><p><b>이 브라우저에서는 쓸 수 없습니다.</b> ' +
      'Chrome, Edge, Safari(iPhone은 iOS 16.4 이상)의 최신 버전으로 열어 주세요.</p></div></main>'
  })
})()
