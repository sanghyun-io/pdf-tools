# PDF 도구

사내용 PDF 페이지 편집기. 파일은 PC 밖으로 나가지 않고 브라우저 안에서 처리한다.

- PDF·이미지를 여러 개 올려 썸네일로 보며 페이지를 고르고, 옮기고, 돌리고, 지운 뒤 저장 (Ctrl+Z 되돌리기)
- 저장할 때 사진·스캔 이미지 용량 줄이기 (약/보통/강)
- 비밀번호 PDF: 암호 없이 열리는 파일은 바로, 열기 암호가 있으면 물어본 뒤 처리. 결과는 암호 없이 저장
- 북마크, 숨긴 레이어, 양식 입력값 유지
- PDF 읽기·쓰기·복호화는 직접 구현 (`src/pdf.js`, `src/decrypt.js`). pdf.js는 썸네일 그리기에만 사용 (`src/thumbs.js`)
- 브라우저 호환: 썸네일은 pdf.js legacy 빌드라 iOS 16.4+/Chrome 97+ 에서 동작. 그보다 오래된 브라우저는 안내만 표시 (`public/check.js`)
- 카카오톡 등 앱 안 브라우저에서는 저장이 막힐 수 있어 외부 브라우저로 열라는 안내 표시 (`src/inapp.js`)
- 탭 이름은 브라우저 언어에 따라 바뀜 (한·영·일·중, 그 외 영어)

```bash
npm install
npm run dev     # http://localhost:17020
npm test        # 출력물을 pdf.js로 다시 읽어 검증
npm run build   # dist/ 정적 파일
```

배포: `main`에 push하면 GitHub Actions가 테스트 → 빌드 → GitHub Pages 배포 (`.github/workflows/pages.yml`).
배포본에는 다른 주소로의 통신을 막는 CSP가 들어간다 (`vite.config.js`).

지원하지 않는 것: 인증서 기반 암호, RC4·AES-128 파일의 한글 열기 암호, 같은 이름의 양식 필드를 가진 파일끼리 합칠 때 필드 분리.
