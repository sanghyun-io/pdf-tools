// Browsers embedded in other apps (KakaoTalk, Naver, Instagram, ...), where saving a file often doesn't work.
// Returns null for a normal browser, else { app, open }: open hands the page to an external browser, or is null
// on iOS, where only the app's own menu can do that.
export function inAppBrowser(ua, href) {
  const android = /Android/i.test(ua)
  const ios = /iPhone|iPad|iPod/i.test(ua)
  const kakao = /KAKAOTALK/i.test(ua)
  const embedded = kakao
    || /NAVER\(inapp|Line\/|Instagram|FBAN|FBAV|DaumApps|everytimeApp/i.test(ua)
    || (android && /; wv\)/.test(ua)) // Android WebView
    || (ios && !/Safari\//.test(ua)) // iOS WKWebView: no Safari token, unlike Safari, Chrome, Firefox, Edge
  if (!embedded) return null
  if (kakao) return { app: '카카오톡', open: `kakaotalk://web/openExternal?url=${encodeURIComponent(href)}` }
  if (android) {
    const [scheme, rest] = href.split('://')
    return { app: null, open: `intent://${rest}#Intent;scheme=${scheme};end` }
  }
  return { app: null, open: null }
}
