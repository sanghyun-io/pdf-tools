# Tesseract LSTM 출력 → 글자열 변환 명세 (fast-kor 기준)

- 근거 소스: `src/tesseract-5.5.3/src/` (아래 `파일:줄`은 이 폴더 기준)
- 실측 데이터: `tmp-debug/rea/tessdata/fast-kor.traineddata`
- 검증 스크립트: `tmp-debug/ocr/parse-charset.mjs` (`node parse-charset.mjs`). 이 문서 3.9절 빔 의사코드를 그대로 옮긴 `beamDecode`/`pathToChars` 도 들어 있다.

## 0. 요약

| 항목 | 값 (fast-kor 실측) | 근거 |
|---|---|---|
| 글자 수 (unicharset) | 1158 (id 0~1157) | lstm-unicharset 첫 줄 |
| 출력층 크기 = 코드 공간 | **144** (Softmax `no`=144 = recoder `code_range`) | 스크립트, unicharcompress.h:181-183 |
| CTC blank (null) 코드 | **143** (= code_range-1, 모델에 저장된 `null_char_`도 143) | unicharcompress.cpp:277-281, lstmrecognizer.cpp:156 |
| 공백 | id 0, 코드 `[0]` (망이 직접 출력하는 보통 글자) | unicharcompress.cpp:119-120, 174-175 |
| 한글 음절 | 1076자, 모두 3코드 `[초성, 중성, 종성]`. 초성 80..98, 중성 99..119, 종성 120..142 | unicharcompress.cpp:164-169 |
| 그 밖의 글자 | 82개, 모두 1코드 (0..79, 143) | 스크립트 |
| 망 구조 | `[1,48,0,1Ct3,3,16Mp3,3Lfys64Lfx96Lrx96Lfx384O1c1]`. 입력 높이 48, 가로 축소 3배(Maxpool 3x3 하나) | lstm 컴포넌트 끝부분 |
| 손실 | `Softmax` 층 = CTC (`is_simple_text_` = false, 같은 코드가 이어지면 하나로 접힘) | fullyconnected.cpp:49-52, lstmrecognizer.h:84-86 |
| 빔 폭 | 코드 길이별 `{5,10,16,16,...}`, 프레임마다 후보는 사실상 상위 2개 + null | recodebeam.cpp:31-33, 669-700, 782-799 |

판단 (3.8절): 그리디(프레임마다 최댓값을 고르고 반복을 접은 뒤 null 제거)는 깨끗한 입력에서는 대부분 같은 글자열을 내지만 한글 3코드 구조 때문에 깨질 수 있다(종성 코드가 null에 묻히면 음절 하나가 통째로 사라진다). **사전 부분을 뺀 Tesseract 빔을 그대로 옮기는 것이 가장 단순하면서 결과가 같은 방법**이다. 빔 코드는 약 100줄이고 스크립트에서 돌려 확인했다.

주의할 실측 사항: **fast-kor 에는 라틴 알파벳(A-Z, a-z)이 없다.** 라틴 글자는 전각 `Ｌ`, `ｌ` 두 개뿐이고 숫자, 문장부호, 한글 자모 13개가 들어 있다. 영문이 섞인 문서는 eng 모델을 따로 돌려야 한다.

---

## 1. traineddata 목차와 쓰는 항목

- 형식: `uint32 항목수(24)` + `int64 오프셋 × 항목수`. -1이면 그 항목이 없다. 항목 크기는 다음에 나오는 유효 오프셋(없으면 파일 끝)에서 자기 오프셋을 뺀 값이다 (tessdatamanager.cpp:119-155). 항목수가 `kMaxNumTessdataEntries`보다 크면 바이트 순서가 뒤집힌 파일로 본다(123-127). 우리 파일은 little-endian.
- 번호 (tessdatamanager.h:76-84): 17 `lstm`(망), 18 `lstm-punc-dawg`, 19 `lstm-word-dawg`, 20 `lstm-number-dawg`, 21 `lstm-unicharset`, 22 `lstm-recoder`, 23 version.
- 21·22번이 있으면 망(17번)에는 unicharset/recoder가 다시 들어 있지 않다 (lstmrecognizer.cpp:139-143, 171-173 → `LoadCharsets` 180-195).
- 17번 맨 끝 28바이트에 `training_flags`, `training_iteration`, `sample_iteration`, `null_char_`(int32 ×4)와 `adam_beta`, `learning_rate`, `momentum`(float ×3)가 있다. 그 바로 앞이 망 명세 문자열(`uint32 길이 + 바이트`)이다 (lstmrecognizer.cpp:144-167). fast-kor: `training_flags=65` = `TF_INT_MODE(1) | TF_COMPRESS_UNICHARSET(64)` (lstmrecognizer.h:44-47) → recoder 사용(`IsRecoding`, lstmrecognizer.h:91-93), `null_char_=143`.

---

## 2. UNICHARSET 텍스트 형식 (21번 lstm-unicharset)

### 2.1 줄 구조

- 1행: 글자 수 N (`sscanf "%d"`, unicharset.cpp:790-793).
- 2행부터 N줄: **줄 순서가 곧 id** (0부터). 줄마다 공백으로 끊어 읽는다(C++ `>>`). 그래서 글자 문자열 안에는 공백이 들어갈 수 없고, 공백 글자는 `NULL`로 적는다 (unicharset.cpp:882-886, 저장 쪽 733-737).
- 줄 버퍼는 256바이트 (unicharset.cpp:787). fast-kor에서 문제 되는 줄은 없다.

| # | 필드 | 의미 | 읽는 곳 |
|---|---|---|---|
| 1 | 글자 문자열 (UTF-8) | `id_to_unichar`. **출력에 쓰는 값.** `NULL` → `" "` | 824, 882-886 |
| 2 | 속성 (16진수) | 비트: 1 alpha, 2 lower, 4 upper, 8 digit, 0x10 punct | 824, 41-45, 888-892 |
| 3 | `min_bottom,max_bottom,min_top,max_top,width,width_sd,bearing,bearing_sd,advance,advance_sd` | 레거시 엔진용 글리프 통계. LSTM 셋은 모두 `0,255,0,255,0,0,0,0,0,0` | 833-836 |
| 4 | 스크립트 이름 | `Common`/`Latin`/`Hangul`/`Han`… 단어 나누기 규칙에 쓰인다(5.2절) | 835, 894 |
| 5 | other_case | 대소문자 짝 id. N 이상이면 자기 자신 | 836, 901 |
| 6 | direction | ICU `UCharDirection` 0~22 (unicharset.h:175-202) | 836, 900 |
| 7 | mirror | 양방향 거울 글자 id | 836, 902 |
| 8 | normed | 정규화 문자열. 없으면 1번과 같음 | 836, 903 |
| 그 뒤 | `\t# ...` | 주석(사람용). 무시 | - |

- 필드가 덜 있는 옛 형식도 받는다. 3번이 쉼표 3개짜리인 형식, 3번이 아예 없고 `스크립트 other_case`만 있는 형식, 스크립트만 있는 형식을 차례로 시도한다 (837-869). 공백 줄은 `NULL 0 Common 0` 형식이다.
- JS 파서 규칙: 공백·탭으로 나눈 뒤 `tok[0]`(=`NULL`이면 `" "`)과 `tok[1]`(hex)을 읽는다. `tok[2]`에 쉼표가 있으면 script=`tok[3]`, other_case=`tok[4]`, direction=`tok[5]`, mirror=`tok[6]`, normed=`tok[7]`이고, 쉼표가 없으면 script=`tok[2]`, other_case=`tok[3]`이다. (`parse-charset.mjs`의 `parseUnicharset`)

### 2.2 특수 항목

- id 0 = 공백 `" "`, id 1 = `Joined`, id 2 = `|Broken|0|1` (unicharset.h:35-41, unicharset.cpp:79-80). 모든 unicharset이 이 세 개로 시작한다.
- `has_special_codes()`: id 2가 `|Broken|0|1` 조각(fragment)이면 참 (unicharset.h:756-760). fast-kor는 참이다. 이때 recoder는 id 1과 id 2를 둘 다 null 코드로 보낸다 (unicharcompress.cpp:176-178). 학습할 때 null 글자는 `UNICHAR_BROKEN`(2)이다 (training/unicharset/lang_model_helpers.cpp:112-114, lstmtrainer.cpp:1106-1111).
- 우리가 쓸 것: **id → 1번 필드 문자열**, 그리고 4번 스크립트(Tesseract의 단어 나누기를 흉내 낼 때만). normed는 출력에 쓰지 않는다(7절).

### 2.3 fast-kor 실측

- 1158자: 스크립트 Hangul 1089 (음절 1076 + 호환 자모 등 13: `ㅣㅅㅇㄴㄷㅎㅁㅠㄱㅋㅜㅡㆍ`), Common 66, Latin 3 (`Joined`, `Ｌ`, `ｌ`). Han 없음.
- 비음절 82개: 공백, Joined, Broken, `0-9`, `. $ & _ 、 ^ 》 | 【 ＊ / " 『 ” ( : { @ # \ … 】 ， , ] + 「 。 ※ ‥ × > 』 < ： ' } “ ; % ? - 〉 ! * ｜ 《 ~ = ) \` [ 」 〈`, 위 자모 13개, `Ｌ ｌ`.
- normed가 1번 필드와 다른 글자는 25개다. 예: `Ｌ→L`, `“→"`, `…→...`, `，→,`, 호환 자모 `ㄱ→ᄀ`(U+1100 조합형). 출력은 1번 필드를 쓰므로 `Ｌ`, `“`가 그대로 나온다.
- 음절 1076자 밖의 한글(예: `똠`, `힣`)은 이 모델이 낼 수 없다.

---

## 3. Recoder (22번 lstm-recoder) — 글자 id ↔ 코드열

### 3.1 직렬화 형식

`UnicharCompress::DeSerialize`는 `encoder_` 벡터만 읽고 나머지는 읽은 뒤 계산한다 (unicharcompress.cpp:323-330, 239).

```
uint32  N                       // 항목 수 = unicharset 크기 (serialis.h:94-117, 클래스 원소는 item.DeSerialize)
N 번 반복 (항목 i = unichar id i):
  int8    self_normalized       // 디코딩에 안 씀 (unicharcompress.h:112-114)
  uint32  length                // 1..9, 9 초과면 오류 (kMaxCodeLen=9, h:37, 84-86)
  int32   code[length]          // h:80-88
```

- 모두 little-endian이다. TFile은 바이트 순서가 뒤집힌 파일에서만 swap한다 (serialis.cpp:228-237).
- 실측: N=1158, 3코드 1076개 ×17바이트 + 1코드 82개 ×9바이트 + 4 = **19,034바이트로 정확히 맞는다**.

### 3.2 읽은 뒤 만드는 표 (SetupDecoder, unicharcompress.cpp:396-439)

- `decoder`: 코드열 → id. 같은 코드열이면 **뒤 항목이 덮어쓴다**(402). fast-kor에서 코드열이 겹치는 경우는 `[143]`(id 1, 2) 하나뿐이고 `decoder[[143]] = 2`이다.
- `is_valid_start[code]`: 어떤 글자의 첫 코드인지 (403).
- `final_codes[prefix]`: 접두어 뒤에 오면 **글자가 끝나는** 코드 목록 (409-415, 433-436).
- `next_codes[prefix]`: 접두어 뒤에 올 수 있는데 **아직 글자가 안 끝나는** 코드 목록 (416-431).
- 이 둘이 접두어 트리 역할을 한다(별도 `is_final` 필드는 없다). 빔은 `final_codes(prefix)`에서 고른 코드로 글자를 끝내고, `next_codes(prefix)`에서 고른 코드로 접두어를 늘린다 (recodebeam.cpp:939-1005).
- `code_range` = 코드 최댓값 + 1 (383-393). 이 값이 출력층 크기이고 **출력 인덱스 = 코드**다 (recodebeam.h:155 "index to network output"). fast-kor는 144이고 Softmax `no`=144와 맞는다(스크립트 확인).
- 같은 코드열이 여러 글자에 대응하는 일은 없다. 그래서 디코딩은 "코드열 전체를 키로 `decoder` 조회" 하나로 끝난다 (`DecodeUnichar`, 305-315).

### 3.3 코드열을 만든 규칙 (ComputeEncoding, unicharcompress.cpp:109-226)

JS는 이 규칙을 다시 계산할 필요 없이 `encoder_`를 그대로 읽으면 된다. 아래는 값을 해석하고 검산하는 데 필요한 내용이다.

1. 처음 번호 매김:
   - 비한글·비한자 글자는 `direct_set`에 들어간 순서대로 번호를 받는다. 공백이 0, `<nul>`이 1, 그 뒤로 unicharset 순서대로 새 코드포인트가 나올 때마다 하나씩 붙는다 (119-124, 172-201).
   - 한글은 `hangul_offset = unicharset.size()`부터 초성 19, 중성 21, 종성 28칸을 쓴다 (128-134).
2. 한글 음절(U+AC00..U+D7A3, 코드포인트 하나)의 분해 (164-169, 367-380):
   ```
   o = u - 0xAC00;  l = floor(o / 588);  v = floor((o % 588) / 28);  t = o % 28
   code = [hangul_offset + l, hangul_offset + 19 + v, hangul_offset + 40 + t]   // 항상 3개, 받침 없음(t=0)도 코드 하나를 차지
   ```
3. 특수 id(1, 2)와 null은 `<nul>` 코드로 간다 (176-178). 공백은 `[0]`이다 (174-175).
4. `DefragmentCodeValues` (254-291): 쓰이지 않는 코드 번호를 지워 앞으로 당기고, null 코드를 **맨 끝**(`code_range-1`)으로 보낸다 (277-281).
5. 로드할 때 공백 코드가 0인지 확인한다 (lstmrecognizer.cpp:204-207).

fast-kor 실측 표 (스크립트 출력):

| 위치 | 코드 | 규칙 |
|---|---|---|
| 비한글 1코드 글자 | 0..79 | 공백 0, `3`→1, `Ｌ`→2, … `1`→8, `.`→12 (unicharset에 처음 나온 순서) |
| 초성 l (0..18) | 80 + l | 19개 모두 사용 |
| 중성 v (0..20) | 99 + v | 21개 모두 사용 |
| 종성 t | 120..142 (23개) | t: `0:120 1:121 2:122 4:123 5:124 6:125 7:126 8:127 9:128 10:129 11:130 15:131 16:132 17:133 18:134 19:135 20:136 21:137 22:138 23:139 25:140 26:141 27:142`. 3(ㄳ), 12(ㄽ), 13(ㄾ), 14(ㄿ), 24(ㅋ)는 1076자 중 쓰는 음절이 없어 빠졌다 |
| null (CTC blank) | 143 | |

예: `가`=[80,99,120], `한`=[98,99,123], `글`=[80,117,127], `1`=[8], `' '`=[0], `ㄱ`(호환 자모 U+3131, 음절 범위 밖)=[24], `.`=[12].

- 초성, 중성, 종성 코드는 서로 겹치지 않고 비한글 코드와도 겹치지 않는다(스크립트 assert). 따라서 같은 코드가 연달아 나와서 생기는 CTC 접힘 문제는 한글 안에서는 생기지 않는다.

---

## 4. 디코딩: RecodeBeamSearch

### 4.1 호출 흐름

```
LSTMRecognizer::RecognizeLine(..., line_box, words)                     lstmrecognizer.cpp:247-291
  RecognizeLine(inner) → 망 forward, 필요하면 반전 재시도                    320-389
  search_ = new RecodeBeamSearch(recoder_, null_char_, SimpleTextOutput(), dict_)  259
  search_->Decode(outputs, kDictRatio=2.25, kCertOffset=-0.085, worst_dict_cert, &unicharset)  262 (사전 유무와 관계없이 이 값)
  search_->ExtractBestPathAsWords(line_box, scale_factor, ...)          264
```

- 입력: 프레임 t(0..T-1)마다 144개 **softmax 확률**(float, 합 1). Softmax 층은 int 모드 모델에서도 float로 낸다 (fullyconnected.cpp:133-134, 214-215).
- `ProbToCertainty(p) = p > e^-20 ? ln p : -20` (networkio.cpp:30-32, 582-584).

### 4.2 사전(DAWG) 없이 쓸 때 바뀌는 것

- `dict_ == nullptr`이면 사전 빔을 t=0에서 아예 만들지 않는다 (recodebeam.cpp:754-758). 이후 모든 노드가 `use_dawgs=false`가 된다.
- 모든 노드의 permuter는 `TOP_CHOICE_PERM`이다 (1020, 1178).
- `space_delimited_`는 true (68-70). 사전이 없을 때는 쓰이지 않는다.
- 사전이 없어도 `dict_ratio=2.25`, `cert_offset=-0.085`는 그대로 들어가서 **모든 노드 확신도가 `2.25 × (ln p − 0.085)`**가 된다 (1021, 1175). 프레임마다 노드 하나씩 같은 식으로 더하므로 경로 순위에는 영향이 없고 확신도 값에만 영향이 있다.

### 4.3 빔 구조

- 프레임마다 힙(beam)이 `2(사전/비사전) × 3(NodeContinuation) × 10(현재 글자 안에서 이미 낸 코드 수 0..9)` = 60개 있다 (recodebeam.h:254-273). 사전이 없으면 30개만 쓴다.
- 힙 크기 상한 = `kBeamWidths[길이]` = `{5,10,16,16,16,16,16,16,16,16}` (recodebeam.cpp:31-33). 길이 0(글자 경계에 있는 노드)이 5, 한글 초성 뒤(길이 1)가 10, 초·중성 뒤(길이 2)가 16이다.
- 노드 (recodebeam.h:92-188): `code`, `unichar_id`(글자를 끝내는 코드 노드와 그 반복 노드에만 유효, 나머지는 -1), `duplicate`(직전 코드의 반복), `certainty`(이 프레임 몫), `score`(경로 누적), `prev`, `code_hash`.
- NodeContinuation (recodebeam.h:37-81). CTC 경로 합을 흉내 내려고 전이 프레임에서 확률을 더하는 장치다.
  - `NC_ANYTHING`: 자기 확률만 썼다. 뒤에 무엇이든 올 수 있다.
  - `NC_ONLY_DUP`: 새 코드 X에 `p(X)+p(null)`(조건이 맞으면 `+p(직전 코드)`)을 썼다. **바로 다음 프레임은 X 반복이어야 한다.**
  - `NC_NO_DUP`: X 반복 노드에 `p(X)+p(null)`을 썼다. 다음 프레임에 X 반복은 못 온다.
- Top-N 표시 (ComputeTopN, 669-700, 상위 5개): 1·2위 = `TN_TOP2`, 3~5위 = `TN_TOPN`, 나머지 = `TN_ALSO_RAN`. **null은 무조건 `TN_TOP2`** (699). `top_code_`, `second_code_`는 실제 1·2위다(null 포함).
- 프레임 처리 (DecodeStep, 740-811): t=0은 `TN_TOP2`만 쓴다 (750-753). t>0은 `TN_TOP2` → `TN_TOPN` → `TN_ALSO_RAN` 순서로, 지금 프레임에 `NC_ANYTHING` 노드가 하나라도 생기면 멈춘다 (782-799). null 확장은 언제나 `TN_TOP2`라서 `NC_ANYTHING` 노드가 거의 항상 생긴다. 따라서 **실제 후보는 프레임마다 상위 2개 코드와 null, 그리고 직전 코드의 반복**이다.

### 4.4 확장 규칙 (ContinueContext, recodebeam.cpp:888-1006, 사전 없음 기준)

직전 노드 `prev`(힙 `(cont, len)` 소속)와 현재 프레임 확률 `p`, 현재 단계 `tn`에 대해:

1. `prefix` 만들기: `prev`부터 거꾸로 가면서 반복 노드와 null 노드는 건너뛰고 코드 `len`개를 모은다 (898-905).
2. `prev`가 있을 때 (906-938):
   - `flag[prev.code]==tn`이고 `cont != NO_DUP`이면 **반복 노드**를 넣는다: 코드 `prev.code`, `dup=true`, `uid=prev.uid`, 확률 `p[prev.code]`, `NC_ANYTHING`, 같은 len (908-914).
   - `flag[prev.code]==tn`이고 `cont==ANYTHING`, `tn==TOP2`, `prev.code != null`이면 **결합 반복 노드**를 넣는다: 확률 `p[prev.code]+p[null]`, `NC_NO_DUP` (915-923).
   - `cont==ONLY_DUP`이면 여기서 끝 (925-927).
   - `prev.code != null`이고 `len>0`이고 `flag[null]==tn`이면 **글자 중간의 null**을 넣는다: `dup=false`, uid -1, 같은 len, `NC_ANYTHING` (928-937). null이 연속되는 경우는 위 반복 규칙(null 반복)이 처리한다.
3. `final_codes(prefix)`의 각 code (939-977): `flag[code]!=tn`이거나 `code==prev.code`이면 건너뛴다. 같은 코드를 두 글자로 내려면 사이에 null이 있어야 한다는 CTC 규칙이다. `ln p[code] + off < -20`이고 null이 아니어도 건너뛴다.
   - `uid = decoder[prefix+code]`. 단, `len==0 && code==null`이면 uid -1 (953-957).
   - 길이 0 힙에 `NC_ANYTHING` 노드를 넣는다. 확신도 `(ln p + off) × 2.25` (962-963 → 1019-1022).
   - `tn==TOP2`이고 null이 아니면 `NC_ONLY_DUP` 노드도 넣는다. 확률 `p[code]+p[null]`에, `prev.cont==ANYTHING`이고 `prev.code`가 null이 아니며 `{prev.code, code}`가 `{1위, 2위}`이면 `+p[prev.code]`를 더한다 (964-975).
4. `next_codes(prefix)`의 각 code (978-1005): 위와 같은 조건으로 건너뛰고, `len+1` 힙에 uid -1 노드를 `NC_ANYTHING`으로, `tn==TOP2`이면 `NC_ONLY_DUP`으로도 넣는다. 이쪽에는 -20 사전 검사가 없다.
- 반복·null·다음 코드 노드는 `PushDupOrNoDawgIfBetter`를 거친다 (1163-1182): 확신도에 2.25를 곱하고, `≥ -20`이거나 null일 때만 넣는다.
- 힙 넣기 (PushHeapIfBetter, 1187-1213): `score = cert + prev.score`. 힙이 덜 찼거나 최악 노드보다 좋을 때만 넣는다. 넣기 전에 **같은 `code`와 같은 `code_hash`인 노드가 이미 있으면 점수가 높은 쪽 하나만 남긴다** (1234-1256). 넘치면 최악 노드를 뺀다.
- `code_hash` (1259-1270): 반복도 null도 아닌 코드가 나올 때만 `h = h*code_range + ((h>>32)*code_range>>32) + code`(uint64, 2^64에서 넘침)로 갱신한다. 지금까지 낸 코드열이 같으면 해시도 같다.

### 4.5 최종 경로와 글자 추출

- ExtractBestPaths (1276-1323): 마지막 프레임의 **길이 0** 힙 중 `NC_ANYTHING`과 `NC_NO_DUP`만 본다(`NC_ONLY_DUP` 제외). 점수 최고 노드에서 `prev`를 따라가면 프레임마다 노드가 하나씩 있는 경로가 나온다. 글자 중간에서 끝나는 경로는 뽑히지 않는다.
- ExtractPathAsUnicharIds (565-630):
  ```
  t=0
  반복 {
    cert=0, rating=0
    uid<0 인 노드(null, 글자 중간 코드)를 지나며: cert=min(cert,c); rating-=c        // 582-588
    starts.push(t)
    t<W 이면:
      uid = 이 노드 uid (글자의 마지막 코드 노드)
      uid==공백 이고 이미 글자가 있으면: 지금까지 쌓은 cert/rating 을 앞 글자에 넘기고 0 으로   // 592-602 (사전 없으면 permuter≠NO_PERM 이라 항상)
      x = t
      이 노드와 뒤따르는 dup 노드들: cert=min(cert,c); rating-=c                     // 605-614
      ends.push(t); 글자 {uid, x, cert, rating} 추가
    아니면 (끝): 남은 cert/rating 을 마지막 글자에 합침                               // 618-623
  }
  starts.push(W)
  ```
  - 글자의 **시간축 위치 x = 마지막 코드(한글이면 종성 코드)가 처음 나온 프레임**이다.
  - 글자 certainty = 그 글자 앞의 null·중간 코드 프레임부터 자기 반복 프레임까지 최솟값이다. 공백 앞 null 몫은 앞 글자에, 줄 끝 null은 마지막 글자에 붙는다.

### 4.6 확신도 → conf

| 단계 | 식 | 근거 |
|---|---|---|
| 노드 | `2.25 × (ln p_used − 0.085)`, `p_used`는 결합 노드면 합친 확률 | 4.2절 |
| 글자 certainty | 위 4.5의 최솟값 (음수) | recodebeam.cpp:565-630 |
| 단어 certainty | 단어 안 글자 certainty 최솟값, rating은 합 | ratngs.h:437-447, pageres.cpp:931-954 |
| 단어 최종 | `7 × min(space_certainty, 단어 certainty)`. `space_certainty` = min(단어 앞 공백 cert, 뒤 공백 cert), 공백이 없으면 0 | recodebeam.cpp:290-300, linerec.cpp:32, 289-298 |
| API 단어/줄 conf | `clip(100 + 5 × certainty, 0, 100)`. 줄은 단어 값의 평균 | ltrresultiterator.cpp:93-142 (139) |
| API 글자 conf | `clip(100 + 5 × 글자 certainty)` (×7 없음) | 같은 함수 RIL_SYMBOL, ratngs.h:442 |

검산값: 사전 없이 모든 프레임 p=1이어도 글자 conf 최대는 99.0, 단어 conf 최대는 `100 + 35 × 2.25 × (−0.085)` = 93.3이다. 사전 단어는 ×2.25가 빠져서 최대 97.0이 된다.

### 4.7 CTC blank·반복 처리 정리

- 연속된 같은 코드는 반복 노드(dup)가 되어 하나로 접힌다. 같은 코드를 새로 내는 것은 금지(`code==prev.code` 건너뜀)이므로 `11`은 반드시 `1 null 1`이어야 한다.
- null은 글자 경계에서도(길이 0, `final_codes([])`에 들어 있음) 글자 중간(초성과 중성 사이 등)에서도 허용된다.
- 한글 한 음절을 끝내려면 초성 → 중성 → 종성 코드가 이 순서로, 사이에 null·반복을 끼고 모두 나와야 한다. 빔은 이 순서를 어기는 경로를 만들지 않는다.

### 4.8 그리디로 충분한가 — 판단

**경로 점수가 그리디와 같아지는 조건.** 사전이 없으면 경로 점수는 프레임별 (ln p + 상수)의 합이다. 제약이 없다면 그리디 경로가 이 합의 최댓값이다. 따라서 그리디가 낸 코드열이 recoder상 유효하고 결합 노드가 끼어들지 않으면 빔 결과도 같은 글자열이 된다.

**다를 수 있는 두 경우** (둘 다 확률이 애매한 프레임에서 생긴다):
1. **무효 코드열.** 예를 들어 한 프레임에서 종성 코드가 2등(0.29)이고 null이 1등(0.6)이며 다른 프레임에서도 종성이 1등이 못 되면, 그리디는 `[초,중]` 다음에 바로 다음 음절의 초성을 만난다. DecodeLabel 식 디코딩(lstmrecognizer.cpp:559-594)으로는 앞 음절을 복구할 수 없다(`<Undecodable>`). 빔은 2등 코드를 써서 유효한 음절을 끝낸다. 스크립트에서 확인한 결과: 그리디 `"<Undecodable><Undecodable>글 1"`, 빔 `"한글 1"`.
2. **결합 확률.** 1등 Y(0.4) < 2등 X(0.35) + null(0.25)이면 빔은 Y를 버리고 X가 이어진다고 볼 수 있다. 이것은 CTC가 모든 경로의 확률을 더하는 방식에 가까운 선택이다.

추가로 확신도 값은 그리디로는 같게 나오지 않는다. 결합 노드의 확률이 certainty에 들어가기 때문이다.

**결론.** "거의 같은 결과"가 목표라면 그리디만으로는 한글에서 음절이 빠질 위험이 있다. 반면 빔 축소판은 다음만 옮기면 되고 비용도 무시할 만하다. 프레임마다 후보가 3~4개이고 힙이 30개, 힙마다 최대 16개다.
- 4.4절의 확장 규칙
- 힙 30개와 같은 코드열 병합
- 마지막 길이 0 힙에서 최고 노드 선택

그래서 **빔 축소판을 기본 디코더로 권장**한다. 그리디는 디버깅용이나 대조용으로 남긴다.

### 4.9 권장 의사코드 (사전 없는 빔 축소판)

실행 가능한 같은 코드: `parse-charset.mjs`의 `beamDecode`, `pathToChars`.

```js
const R = 2.25, OFF = -0.085, MINC = -20, WIDTH = [5,10,16,16,16,16,16,16,16,16];
const ANY = 0, ONLY_DUP = 1, NO_DUP = 2, NUL = 143;           // NUL = recoder 의 null 코드 = code_range-1
const lnp = p => (p > Math.exp(-20) ? Math.log(p) : -20);

function beamDecode(probs /* [T][144] softmax */) {
  let prevBeams;
  for (t of 0..T-1) {
    p = probs[t];
    rank = 확률 내림차순(동률이면 작은 코드 먼저);  top = rank[0]; second = rank[1];
    flag[c] = 2;  flag[rank[0..1]] = 0;  flag[rank[2..4]] = 1;  flag[NUL] = 0;
    beams = Map<"cont,len", node[]>();
    if (t == 0) expand(null, len=0, ANY, tn=0);
    else for (tn of [0,1,2]) {                               // 보통 tn=0 에서 끝난다
      for (node of prevBeams 전체) expand(node, node.len, node.cont, tn);
      if (beams 에 cont==ANY 인 노드가 있음) break;
    }
    prevBeams = beams;
  }
  best = prevBeams["ANY,0"] ∪ prevBeams["NO_DUP,0"] 중 score 최대;
  return best 에서 prev 를 따라 거꾸로 모은 경로(프레임마다 노드 1개);

  function expand(prev, len, cont, tn) {
    prefix = prev 부터 거꾸로, dup·NUL 노드를 건너뛰며 코드 len 개;
    if (prev) {
      if (flag[prev.code] == tn) {
        if (cont != NO_DUP) pushDup(len, ANY, prev.code, prev.uid, true, lnp(p[prev.code]) + OFF);
        if (cont == ANY && tn == 0 && prev.code != NUL)
          pushDup(len, NO_DUP, prev.code, prev.uid, true, lnp(p[prev.code] + p[NUL]) + OFF);
      }
      if (cont == ONLY_DUP) return;
      if (prev.code != NUL && len > 0 && flag[NUL] == tn) pushDup(len, ANY, NUL, -1, false, lnp(p[NUL]) + OFF);
    }
    comb = c => lnp(p[c] + p[NUL] + ((prev && cont==ANY && prev.code!=NUL &&
                ((prev.code==top && c==second) || (c==top && prev.code==second))) ? p[prev.code] : 0)) + OFF;
    for (c of finalCodes[prefix]) {
      if (flag[c] != tn || (prev && prev.code == c)) continue;
      cert = lnp(p[c]) + OFF;  if (cert < MINC && c != NUL) continue;
      uid = (len == 0 && c == NUL) ? -1 : decoder[prefix + c];
      push(0, ANY, c, uid, false, cert * R);
      if (tn == 0 && c != NUL) push(0, ONLY_DUP, c, uid, false, comb(c) * R);
    }
    for (c of nextCodes[prefix]) {
      if (flag[c] != tn || (prev && prev.code == c)) continue;
      pushDup(len + 1, ANY, c, -1, false, lnp(p[c]) + OFF);
      if (tn == 0 && c != NUL) pushDup(len + 1, ONLY_DUP, c, -1, false, comb(c));
    }
    function pushDup(l, k, c, u, dup, cert) { cert *= R; if (cert >= MINC || c == NUL) push(l, k, c, u, dup, cert); }
    function push(l, k, c, u, dup, cert) {
      heap = beams["k,l"]; score = cert + (prev?.score ?? 0);
      if (heap.length >= WIDTH[l] && score <= min(heap).score) return;
      hash = prev?.hash ?? 0n;
      if (!dup && c != NUL) hash = (hash*RANGE + ((hash>>32n)*RANGE>>32n) + BigInt(c)) & (2n**64n-1n);
      same = heap 에서 code==c && hash==hash 인 노드;
      if (same) { if (score > same.score) same 를 새 노드로 교체; return; }
      heap.push({code:c, uid:u, dup, cert, score, prev, hash, len:l, cont:k});
      if (heap.length > WIDTH[l]) heap 에서 score 최소 노드 제거;
    }
  }
}
```

- 그 다음 4.5절 `ExtractPathAsUnicharIds` → 5.3절 글자 경계 → 5.2절 단어.
- Tesseract와 어긋날 수 있는 것은 점수가 같을 때 GenericHeap이 무엇을 남기는지 정도다(재현하지 않음).
- 화이트리스트/블랙리스트가 필요하면 `final_codes` 루프에서 금지된 uid를 건너뛴다 (recodebeam.cpp:958-961).

### 4.10 그리디 (대조용)

```js
labels = [];  prev = -1;
for (t) { c = argmax(probs[t]); if (c != prev && c != NUL) labels.push({c, t}); prev = c; }  // 반복 접기 + blank 제거
// DecodeLabel(lstmrecognizer.cpp:559-594): 코드를 하나씩 붙이다가, decoder 에 있고
// (끝이거나 길이 9 이거나 다음 코드가 is_valid_start) 이면 그 글자로 확정. 못 찾으면 <Undecodable>
```

---

## 5. 띄어쓰기, 단어 경계, 위치

### 5.1 공백

- 공백은 **망이 직접 내는 글자**다(id 0, 코드 0, 1코드). 빔에서도 보통 글자처럼 `final_codes([])`로 나온다. 레이아웃 분석의 단어 간격과는 별개다.

### 5.2 단어 나누기 (ExtractBestPathAsWords, recodebeam.cpp:238-320)

- 글자열을 앞에서부터 단어로 자른다. 다음 글자가 아래 중 하나면 거기서 끊는다 (272-289):
  1. 공백 (277-279)
  2. 노드의 `start_of_word` (281-283). 사전이 있을 때만 의미가 있다.
  3. permuter가 `TOP_CHOICE_PERM`이고 이 글자나 앞 글자가 **띄어쓰기 없는 스크립트**일 때 (284-288). `IsSpaceDelimited`는 Han, Thai, **Hangul**, Hiragana, Katakana에서 false다 (unicharset.h:668-676).
- 공백 글자는 어느 단어에도 들어가지 않는다. 다음 단어의 `leading_space`와 `space_certainty`로만 남는다 (290-295, 316-318).
- **사전 없이 한국어를 돌리면 3번 규칙 때문에 한글 음절 하나하나가 별도 WERD_RES가 된다.**
  - 최종 텍스트(ResultIterator)는 기본값 `preserve_interword_spaces=false`(tesseractclass.cpp:425)에서 단어마다 앞에 공백을 하나 넣는다 (resultiterator.cpp:743-750). 결과는 "한 글"처럼 음절마다 띄어진 문자열이다.
  - `preserve_interword_spaces=1`이면 `word->space()`(= `leading_space`, 망이 낸 공백) 개수만큼만 넣는다(745). 결과는 망이 낸 띄어쓰기 그대로다.
  - 코드 흐름을 읽어서 낸 결론이고 실행해서 확인하지는 않았다.
- **JS 권장**: 단어는 망이 낸 공백으로만 나눈다(`preserve_interword_spaces=1`과 같은 결과). 3번 규칙은 흉내 내지 않는다. 연속 공백이 나오면 Tesseract는 두 번째 공백을 다음 단어의 첫 글자로 넣는다(273-279 루프 구조). JS에서는 하나로 합치면 된다.
- 참고: Tesseract는 보통 줄 전체를 한 번에 망에 넣는다. 레이아웃 단어들을 높이·간격 조건으로 묶는다 (pageres.cpp:120-175, `merge_similar_words`=LSTM 사용 시 true, baseapi.cpp:786). 묶음 사이 띄어쓰기는 레이아웃 값이다 (pageres.cpp:1391-1395).

### 5.3 글자의 시간축 범위 (calculateCharBoundaries, recodebeam.cpp:186-197)

`starts`, `ends`는 4.5절에서 만든 배열이다. 공백도 글자로 센다.

```
bounds = [0]
for i in 0..글자수-1:  bounds.push(ends[i] + trunc((starts[i+1] - ends[i]) / 2))
bounds.pop();  bounds.push(W)          // W = 프레임 수
글자 i 의 시간축 범위 = [bounds[i], bounds[i+1])
```

- 줄 전체를 빈틈없이 나눈다. 첫 글자는 0, 마지막 글자는 W까지 간다.
- 경계는 앞 글자의 마지막 반복 프레임 끝과 **다음 글자의 마지막 코드 프레임** 사이의 중간이다. 한글은 마지막 코드가 종성이라 경계가 실제보다 오른쪽으로 치우칠 수 있다. 더 정확히 하려면 다음 글자의 첫 코드(초성) 프레임을 쓰면 된다. 다만 그러면 Tesseract와 달라진다.

### 5.4 프레임 → 원본 x 좌표

- 망 가로 축소 배율 `XScaleFactor` = 층들의 x_scale 곱 = **3** (Series 곱 series.cpp:91-97, Reconfig/Maxpool x_scale reconfig.cpp:50-52; fast-kor에서 x를 줄이는 층은 `Mp3,3` 하나뿐).
- 출력 폭 `T = floor(W48 / 3)` (stridemap.cpp:153-163, reconfig.cpp:34-41). `W48`은 높이 48로 줄인 줄 이미지의 너비다.
- 줄 이미지 준비 (input.cpp:28, 82-99; imagedata.cpp:216-267): `im_factor = 48 / H`(H = 잘라낸 줄 이미지 높이), 가로세로 같은 배율로 `pixScale`.
- RecognizeLine: `scale_factor = XScaleFactor / im_factor = 3·H/48` (lstmrecognizer.cpp:326, 343).
- 글자 i 상자 (InitializeWord, recodebeam.cpp:643-651):
  ```
  x0 = floor(bounds[i]   * scale_factor) + line_box.left
  x1 = ceil (bounds[i+1] * scale_factor) + line_box.left
  y  = line_box 의 위아래 전체 (줄 높이 그대로)
  ```
  `line_box`는 레이아웃 상자에 사방 4px(`kImagePadding`, imagedata.h:39)을 더하고 이미지 경계로 자른 상자다 (linerec.cpp:164-168, 191, 246). 망에 넣은 이미지의 원점과 같다.
- 정리: **프레임 t는 원본 x ∈ [left + 3t·H/48, left + 3(t+1)·H/48)**에 해당한다.
- Tesseract API가 돌려주는 최종 상자는 이 "가짜 상자"가 아니다. 레이아웃 단계의 실제 연결 요소(blob)를 x 중심이 가짜 상자 경계 중간점 안에 드는 글자에 나눠 준 합집합이다 (pageres.cpp:1281-1309, 1424-1468). 실제 blob이 없으면 가짜 상자를 쓴다(1463-1466). JS에서는 가짜 상자 식으로 시작하고, 필요하면 연결 요소로 좁힌다.

---

## 6. 단어·글자 출력 조립 (사전 없는 JS 기준 권장)

```
chars = pathToChars(beamDecode(probs))          // {uid, x, cert, rating} + bounds
words = 공백(uid 0)으로 나눈 연속 구간
word.text = 각 글자 unicharset[uid].str 이어붙임
word.box  = 첫 글자 x0 ~ 마지막 글자 x1, 줄 높이
word.conf = clip(100 + 5 * 7 * min(단어 글자 cert 최솟값, 앞뒤 공백 cert 최솟값), 0, 100)
line.text = words 를 " " 로 연결
```

---

## 7. 출력 문자열 후처리

- **정규화 없음.** 출력은 `WERD_CHOICE::string_and_lengths` → `id_to_unichar_ext`이다 (ratngs.cpp:427-439). unicharset 1번 필드를 그대로 쓰고, 사용자 영역 합자(U+E003 등 `kCustomLigatures`)만 풀어 준다 (unicharset.cpp:61-67, 287-303). fast-kor에는 해당 글자가 없다. NFC/NFKC 같은 유니코드 정규화도, normed 치환도 하지 않는다. normed는 디버그와 학습용 `DecodeLabel`(lstmrecognizer.cpp:591)에서만 쓴다.
- **방향.** ResultIterator가 문단 방향과 반대 방향인 구간 앞에만 LRM/RLM을 넣는다 (resultiterator.cpp:31-32, 703-711, 437-442). 한국어 왼쪽→오른쪽 문단에는 아무것도 붙지 않는다.
- **줄과 문단.** 줄 끝에 `\n`, 문단 끝에 `\n`을 하나 더 붙인다 (resultiterator.cpp:758-762).
- **자동 반전** (디코딩 전 출력 검사, lstmrecognizer.cpp:349-377): 프레임별 최댓값 코드(null 제외) 확률의 평균이 `invert_threshold`(0.7, tesseractclass.cpp:71)보다 낮으면, 이미지를 반전해 다시 forward하고 평균이 더 높은 쪽 출력을 쓴다(OutputStats 294-316). 어두운 바탕에 밝은 글자를 처리하는 장치다.
- `fix_fuzzy_spaces`는 LSTM이 아닐 때만 돈다 (control.cpp:393-399). LSTM 결과에는 레거시 띄어쓰기 보정이 없다.

---

## 8. 검증 결과 (`node parse-charset.mjs`, 2026-10-21)

```
목차 항목 24개, unicharset 1158개, recoder 항목 1158개, code_range 144
특수 id: 0=' ' code=[0], 1=Joined code=[143], 2=|Broken|0|1 code=[143]
null(CTC blank) 코드 = 143 = code_range-1, decoder 에서 [143] -> id 2
코드열 중복: [143] <- id 1,2
코드 길이 분포: {"1":82,"3":1076}, 스크립트: {"Common":66,"Latin":3,"Hangul":1089}
한글 음절 1076개 모두 3코드. L 코드 80..98 (19개), V 코드 99..119 (21개), T 코드 120..142 (23개)
lstm 컴포넌트: network_str_="[1,48,0,1Ct3,3,16Mp3,3Lfys64Lfx96Lrx96Lfx384O1c1]", training_flags=65, null_char_=143
  층 Softmax "Output" ni=384 no=144
  층 Maxpool "Maxpool" ni=16 no=16 x_scale=3 y_scale=3
가 50 [80,99,120] / 한 72 [98,99,123] / 글 304 [80,117,127] / 1 10 [8] / ' ' 0 [0] / ㄱ 991 [24] / . 28 [12]
A, a, 똠, 힣: 이 unicharset 에 없음
그리디 합성: [143 98 98 143 99 123 123 143 80 117 117 127 143 0 143 8 8 143] -> "한글 1"
받침 코드가 2등인 합성 출력: 그리디 "<Undecodable><Undecodable>글 1", 빔 "한글 1"
  한 x=3 cert=-2.976 [0,5) / 글 x=7 cert=-0.453 [5,8) / ' ' x=9 cert=-1.026 [8,10) / 1 x=11 cert=-0.453 [10,13)
```

스크립트가 assert로 확인하는 것:
- recoder 바이트 수가 정확히 맞는지
- 공백 코드가 0인지
- null이 끝 번호이고, 모델의 `null_char_`, recoder, Softmax 크기가 서로 맞는지
- 한글 1076자 전부가 초성·중성·종성 표 하나로 일관되고 세 위치의 코드가 서로 겹치지 않는지
- 시험 글자들이 id → 코드열 → id로 되돌아오는지
- 그리디와 빔이 합성 입력에서 예상 글자열을 내는지

---

## 9. 확인 못 한 점

1. **실제 망 출력으로 맞춰 보지 않았다.** 원본을 실행·빌드하지 않았으므로 빔 축소판은 합성 확률로만 확인했다. Tesseract와 글자 단위로 같은지는 JS forward가 생긴 뒤 같은 줄 이미지로 대조해야 한다. 점수 동률일 때 GenericHeap이 무엇을 남기는지는 재현하지 않았다.
2. **사전(DAWG) 경로는 다루지 않았다.** Tesseract 기본 실행은 lstm-word/punc/number DAWG를 쓴다. 사전 단어는 확신도에 ×2.25가 빠지고 단어가 음절마다 쪼개지지 않으며, 경로 순위가 바뀔 수 있다 (ContinueDawg 1054-1133). 그래서 기본 설정 Tesseract와 비교하면 글자열과 conf가 조금 다를 수 있다.
3. 5.2절의 "사전 없이 kor를 돌리면 음절마다 띄어진 텍스트가 나온다"는 코드 흐름(`IsSpaceDelimited`가 Hangul에서 false)으로 낸 결론이고 실행으로 확인하지 않았다.
4. 줄 이미지 전처리는 범위 밖이다. 높이 48 축소(leptonica `pixScale` 보간·반올림), 망 입력 정규화(`PreparePixInput`)는 다루지 않았다. 원본 x 좌표 식의 `W48`, `H`는 이 단계와 같게 맞춰야 한다.
5. 최종 상자를 실제 연결 요소로 다시 나누는 부분(5.4절 끝)은 레이아웃 분석 결과에 기대므로 요약만 했다.
6. `lstm_choice_mode`(글자별 대안 후보, `DecodeSecondaryBeams`)는 다루지 않았다.
7. fast-eng에는 스크립트를 돌려 보지 않았다. 한글 전용 검사와 시험 글자가 들어 있어 그대로는 실패한다. recoder가 없는 모델(`IsRecoding` false → `SetupPassThrough`, 글자 id = 코드, lstmrecognizer.cpp:209-212)도 데이터로 확인하지 않았다.
