# traineddata LSTM 모델 바이트 규칙 (Tesseract 5.5.3 기준)

근거 줄 번호는 모두 `tmp-debug/ocr/src/tesseract-5.5.3/src/` 아래 경로다.
검증 스크립트: `tmp-debug/ocr/parse-model.mjs` (fast-kor, fast-eng 둘 다 lstm 항목을 남은 바이트 0으로 끝까지 읽음. 7절 참고)

---

## 0. 한눈에 보기

```
traineddata = u32 항목수(N) + i64 오프셋[N] + 항목 바이트들
lstm 항목(17) = Network(재귀) + [unicharset 텍스트]* + string network_str
               + i32 training_flags + i32 training_iteration + i32 sample_iteration
               + i32 null_char + f32 adam_beta + f32 learning_rate + f32 momentum
               + [recoder]*
   * 21번(lstm-unicharset)과 22번(lstm-recoder) 항목이 둘 다 있으면 lstm 안에 없다.
     fast-kor / fast-eng 는 둘 다 있으므로 lstm 항목에는 없음.

Network = i8 0 + string 종류이름 + i8 training + i8 needs_backprop + i32 flags
        + i32 ni + i32 no + i32 num_weights + string name + 종류별 본문

WeightMatrix(int8) = u8 mode(=133) + i32 행 + i32 열 + i8 empty + i8[행*열]
                   + u32 scale개수 + f64[scale개수]
```

---

## 1. 기본 자료형 규칙 (TFile)  — 질문 5

| 항목 | 규칙 | 근거 |
|---|---|---|
| 정수·실수 | 메모리 그대로 `memcpy`. 파일은 **리틀엔디언**(x86에서 만든 그대로). `int8/uint8/int32/uint32/int64/float(4바이트)/double(8바이트)` | serialis.h:89-92 (`FReadEndian(data, sizeof(T), count)`), serialis.cpp:239-257 |
| 바이트 순서 뒤집기 | traineddata 첫 u32(항목 수)가 1000보다 크면 "반대 엔디언 파일"로 보고 `swap`을 켠다. 켜지면 **크기가 1이 아닌 값만** 원소 단위로 뒤집는다(문자열·int8 배열은 그대로) | tessdatamanager.cpp:119-127, tessdatamanager.h:125, serialis.cpp:228-237, 각 항목 TFile 에도 같은 swap 전달: tessdatamanager.cpp:254-255 |
| 정렬(alignment) | 없음. 바로 이어 붙인다(패딩 없음) | serialis.cpp:239-257 |
| `std::string` | `u32 길이` + 그 길이만큼 바이트(UTF-8, 끝 NUL 없음). 길이 > 50,000,000 이면 실패 | serialis.cpp:98-117 |
| `std::vector<T>` (기본형) | `u32 개수` + `T[개수]`. 개수 > 50,000,000 이면 실패. 0이면 내용 없음 | serialis.h:94-102, 140-145 |
| `std::vector<클래스>` | `u32 개수` + 원소마다 `T::DeSerialize` | serialis.h:112-120 |
| 2차원 배열 `GENERIC_2D_ARRAY<T>` | `i32 dim1` + `i32 dim2` + `T empty`(1개, 버리는 값) + `T[dim1*dim2]`. dim > 65535 면 실패. 저장 순서: `a[i][j] = data[i*dim2 + j]` (dim1 이 바깥) | matrix.h:197-200, 567-584, 255-257, 283-288 |
| 읽다 모자라면 | `FRead`가 읽은 개수만 돌려주고, `DeSerialize`는 개수 불일치로 false | serialis.cpp:239-257, serialis.h:90-91 |

주의: `TFile::DeSerializeSize`(크기 보고 엔디언 자동 판정)는 LSTM 경로에서 쓰이지 않는다.

---

## 2. traineddata 컨테이너

| 순서 | 형식 | 설명 | 근거 |
|---|---|---|---|
| 1 | `u32 N` | 항목 수 (현재 24) | tessdatamanager.cpp:119-130 |
| 2 | `i64 offset[N]` | 각 항목 시작 위치(파일 맨 앞 기준). `-1` = 없음 | tessdatamanager.cpp:132-135 |
| 3 | 항목 바이트 | 항목 i 크기 = (i 다음의 첫 `-1` 아닌 오프셋) − offset[i], 마지막이면 파일 끝 − offset[i] | tessdatamanager.cpp:136-160 |

- C++는 오프셋으로 이동(seek)하지 않고 표 바로 뒤부터 **순서대로** 읽는다(tessdatamanager.cpp:156). 정상 파일이면 오프셋 위치와 같다. 스크립트가 두 값이 같은지 검사한다.
- 항목 번호: 17 lstm, 18 lstm-punc-dawg, 19 lstm-word-dawg, 20 lstm-number-dawg, 21 lstm-unicharset, 22 lstm-recoder, 23 version (tessdatamanager.h:58-85).
- fast-kor 실제 오프셋: 0:196, 17:286, 18:974123, 19:976725, 20:1581999, 21:1582073, 22:1658301, 23:1677335 (나머지 -1). lstm = 974123−286 = 973,837바이트.

---

## 3. lstm 항목(17) 직렬화 순서 — 질문 1

`LSTMRecognizer::Load` → `GetComponent(TESSDATA_LSTM)` → `DeSerialize(mgr, fp)` (lstmrecognizer.cpp:75-90, 133-177)

| # | 형식 | 필드 | 근거 |
|---|---|---|---|
| 1 | Network (재귀, 4절) | 최상위 층(보통 Series) | lstmrecognizer.cpp:135 |
| 2 | (조건부) unicharset **텍스트** | `include_charsets` 일 때만 | lstmrecognizer.cpp:139-143 |
| 3 | string | `network_str_` (예: `[1,48,0,1Ct3,3,16Mp3,3Lfys64Lfx96Lrx96Lfx384O1c1]`) | :144 |
| 4 | i32 | `training_flags_` (bit0 `TF_INT_MODE`=1, bit6 `TF_COMPRESS_UNICHARSET`=64) | :147, lstmrecognizer.h:44-46, 342 |
| 5 | i32 | `training_iteration_` | :150, .h:344 |
| 6 | i32 | `sample_iteration_` | :153, .h:346 |
| 7 | i32 | `null_char_` (CTC 공백 출력 번호) | :156, .h:349 |
| 8 | f32 | `adam_beta_` | :159, .h:354 |
| 9 | f32 | `learning_rate_` | :162, .h:351 |
| 10 | f32 | `momentum_` | :165, .h:352 |
| 11 | (조건부) recoder | `include_charsets` 이고 `training_flags & 64` 일 때 | :168, :198-214 |

- **주의:** 헤더의 멤버 선언 순서(learning_rate, momentum, adam_beta)와 파일 순서(adam_beta, learning_rate, momentum)가 다르다.
- `include_charsets = mgr == nullptr || 21번 없음 || 22번 없음` (lstmrecognizer.cpp:139-140). 21·22번이 다 있으면 lstm 항목 안에는 unicharset/recoder 가 **없고**, 대신 `LoadCharsets`가 21번·22번 항목을 따로 읽는다(lstmrecognizer.cpp:171, 180-195).
- `training_flags & 64` 가 0이면 recoder 를 읽지 않고 unicharset 을 그대로 통과시키는 recoder 를 만든다(lstmrecognizer.cpp:209-212).
- 끝에 남는 바이트가 있어도 C++는 검사하지 않는다. "남은 바이트 0" 은 스크립트의 자체 검증이다.

### 3-1. 21번 lstm-unicharset (텍스트)
- 줄 단위. 1줄째 = 글자 수 N(`%d`), 이어서 N줄. 각 줄 `글자 16진속성 min_bottom,max_bottom,min_top,max_top,width,width_sd,bearing,bearing_sd,advance,advance_sd 스크립트 other_case direction mirror normed` (필드가 적은 옛 형식 몇 가지도 허용) (unicharset.cpp:784-869).
- 글자가 `NULL` 이면 공백 `" "` 으로 등록(unicharset.cpp:882-886). 줄 읽기는 `FGets(buf, 256)` → 줄당 최대 255바이트(unicharset.cpp:787-790, serialis.cpp:213-226).
- unicharset id 순서 = 줄 순서.

### 3-2. 22번 lstm-recoder (이진)
- `vector<RecodedCharID>`: `u32 개수` + 원소마다 `i8 self_normalized` + `u32 length(≤9)` + `i32 code[length]` (unicharcompress.cpp:323-330, unicharcompress.h:80-88, 114-118).
- 원소 순서 = unicharset id. `code_range = max(모든 code) + 1` = 소프트맥스 출력 수 (unicharcompress.cpp:383-393).
- 공백(id 0)의 code(0)이 0이 아니면 로드 실패(lstmrecognizer.cpp:203-208).

---

## 4. Network::CreateFromFile — 질문 2

### 4-1. 공통 머리 (모든 층)

| # | 형식 | 필드 | 근거 |
|---|---|---|---|
| 1 | i8 | 종류 번호. **현재 형식은 항상 0**, 0이면 다음에 종류 이름 문자열 | network.cpp:156-163(쓰기), 191-209(읽기) |
| 2 | string | 종류 이름 (아래 표). 0이 아닌 옛 파일이면 이 문자열 없이 i8 값이 곧 enum | network.cpp:196-207 |
| 3 | i8 | training. `1`(TS_ENABLED)일 때만 학습 상태, 그 밖의 값은 비활성 | network.cpp:226-229, network.h:89-97 |
| 4 | i8 | needs_to_backprop (0이 아니면 true) | network.cpp:230-233 |
| 5 | i32 | network_flags (64 = NF_LAYER_SPECIFIC_LR, 128 = NF_ADAM) | network.cpp:234, network.h:82-86 |
| 6 | i32 | ni | network.cpp:237 |
| 7 | i32 | no | network.cpp:240 |
| 8 | i32 | num_weights (이 층 + 하위 층 가중치 원소 수 합, 바이어스 포함) | network.cpp:243 |
| 9 | string | name | network.cpp:246 |
| 10 | 종류별 본문 | 아래 | network.cpp:256-318 |

- ni/no/num_weights 가 음수면 실패(network.cpp:250-254).
- 종류 이름 ↔ enum (network.cpp:60-75, network.h:40-78):
  `Invalid, Input, Convolve, Maxpool, Parallel, Replicated, ParBidiLSTM, DepParUDLSTM, Par2dLSTM, Series, Reconfig, RTLReversed, TTBReversed, XYTranspose, LSTM, SummLSTM, Logistic, LinLogistic(=POSCLIP), LinTanh(=SYMCLIP), Tanh, Relu, Linear, Softmax, SoftmaxNoCTC, LSTMSoftmax, LSTMBinarySoftmax, TensorFlow`
- `TensorFlow` 는 지원 안 함(network.cpp:292-294).

### 4-2. 종류별 본문

| 종류 | 본문 (공통 머리 뒤) | ni/no 처리 | 근거 |
|---|---|---|---|
| **Input** | StaticShape: `i32 batch, i32 height, i32 width, i32 depth, i32 loss_type` (loss: 0 NONE, 1 CTC, 2 SOFTMAX, 3 LOGISTIC). 0 = 실행 시 결정 | ni/no 는 머리값 그대로 (fast 모델은 ni=height, no=depth) | network.cpp:260-262, input.cpp:30-31, 45-47, static_shape.h:29-34, 83-89 |
| **Convolve** | `i32 half_x, i32 half_y` (커널 = (2·half_x+1)×(2·half_y+1)) | no = ni·(2hx+1)·(2hy+1) 로 다시 계산 | network.cpp:257-259, convolve.cpp:45-73, convolve.h:65-66 |
| **Maxpool** | `i32 x_scale, i32 y_scale` (Reconfig 와 같은 본문) | no = ni | network.cpp:269-271, maxpool.cpp:29-33, reconfig.cpp:60-83 |
| **Reconfig** | `i32 x_scale, i32 y_scale` | no = ni·x_scale·y_scale | network.cpp:280-282, reconfig.cpp:60-83, reconfig.h:77-78 |
| **Series / Parallel 계열**(Parallel, Replicated, ParBidiLSTM, DepParUDLSTM, Par2dLSTM) **/ Reversed 계열**(RTLReversed=x뒤집기, TTBReversed=y뒤집기, XYTranspose) | `u32 하위층 수(≤10000)` + 하위 Network × 개수(재귀) + (**flags & 64 이면**) `vector<float> learning_rates` = `u32 개수 + f32[개수]` | 머리의 ni/no 는 버리고 하위 층으로 계산: 첫 하위의 ni/no, Series 는 이후 no = 마지막 하위 no(앞 no == 뒤 ni 강제), Parallel 계열은 no = 하위 no 합(ni 모두 같아야 함). Reversed 는 하위 1개 | network.cpp:272-279, 283-291, plumbing.cpp:84-96, 215-240, plumbing.h:150, series.cpp:29-31, parallel.cpp:34-36, reversed.cpp:26-28 |
| **LSTM 계열**(LSTM, SummLSTM, LSTMSoftmax, LSTMBinarySoftmax) | `i32 na` + 게이트 WeightMatrix: **CI, GI, GF1, GO** 순서, 2D 이면 이어서 **GFS** + (LSTMSoftmax/LSTMBinarySoftmax 이면) 내장 소프트맥스 Network 1개(재귀, FullyConnected) | ns = CI 행렬의 행 수. nf = LSTMSoftmax 면 no, LSTMBinarySoftmax 면 ceil(log2 no), 그 밖은 0. is_2d = (na − nf == ni + 2·ns). GFS 는 is_2d 일 때만 읽음 | network.cpp:263-268, lstm.cpp:253-287, lstm.h:32-40, 131-143 |
| **FullyConnected 계열**(Logistic, LinLogistic, LinTanh, Tanh, Relu, Linear, Softmax, SoftmaxNoCTC) | WeightMatrix 1개 | ni/no 머리값 그대로. 종류가 곧 활성 함수 | network.cpp:295-305, fullyconnected.cpp:123-125, 203-219 |

- WeightMatrix 의 `training` 인자는 그 층의 training(머리 3번)이다(lstm.cpp:269, fullyconnected.cpp:124). int8 행렬에는 영향 없음, float 행렬일 때만 뒤에 학습용 배열이 더 붙는다(5절).
- **flags=192(64+128)인 fast 모델에서는 Series/Reversed 층마다 learning_rates 벡터가 붙어 있다.** 이걸 빼먹으면 바로 어긋난다.
- LSTM 행렬 크기: 각 게이트 `ns × (na+1)`. 열 순서 = LSTM 입력 벡터 `[입력 ni | 소프트맥스 피드백 nf | 직전 출력 ns | (2D) 다른 방향 직전 출력 ns | 바이어스]` (lstm.cpp:364-371, 182-183).
- FullyConnected 행렬 크기: `no × (ni+1)`, 마지막 열 바이어스 (fullyconnected.cpp:86).
- 활성 함수: Tanh=tanh, Logistic=시그모이드, LinLogistic=[0,1] 자르기, LinTanh=[-1,1] 자르기, Relu, Linear=그대로, Softmax/SoftmaxNoCTC=소프트맥스 (fullyconnected.cpp:203-219, functions.h:75-118). LSTM 게이트: CI=tanh(GFunc), GI/GF1/GO/GFS=시그모이드(FFunc), 출력=tanh(state)·GO (lstm.cpp:386-455).

---

## 5. WeightMatrix::DeSerialize — 질문 3

| # | 형식 | 설명 | 근거 |
|---|---|---|---|
| 1 | u8 mode | bit0(1) = int8 모드, bit2(4) = adam, bit7(128) = "double 형식"(새 형식 표시) | weightmatrix.cpp:229-235, 281-289 |

**새 형식 (mode & 128 ≠ 0)** — fast 모델은 mode = 133 = 128+4+1

int8 모드 (mode & 1):

| # | 형식 | 설명 | 근거 |
|---|---|---|---|
| 2 | `GENERIC_2D_ARRAY<int8>` | `i32 행(=출력 수)`, `i32 열(=입력 수+1, 마지막 열 바이어스)`, `i8 empty`, `i8[행·열]` 행 우선 | weightmatrix.cpp:291, weightmatrix.h:166, matrix.h:197-200 |
| 3 | u32 | scale 개수 (> 100,000,000 이면 실패) | weightmatrix.cpp:294-301 |
| 4 | **f64** × 개수 | 행마다 scale 1개. 파일 값 = (그 행 float 가중치의 \|최대\|) / 127. 로드 시 다시 **/127** 해서 메모리에 둔다 | weightmatrix.cpp:302-319(읽기), 249-261(쓰기 시 ×127), 183-205(변환) |

- 파일 scale 은 항상 8바이트 double. 빌드 옵션 FAST_FLOAT(기본 ON)이면 메모리에는 `float(파일값/127)` (double 로 나눈 뒤 float 로 줄임), 아니면 double (weightmatrix.cpp:302-319, tesstypes.h:36-40, CMakeLists.txt:95, configure.ac:252-258).
- scale 개수는 보통 행 수와 같다. 다만 SIMD 가 켜진 기계에서 `ConvertToInt` 로 만든 모델은 행 수를 SIMD 단위로 올림한 개수(남는 값 0)가 저장될 수 있다(weightmatrix.cpp:208-212). 계산에는 앞 `행 수` 개만 쓰인다. fast-kor/eng 는 모두 `scale 개수 == 행 수`.
- 실제 데이터 확인: 모든 int8 행의 \|최대\| 가 정확히 127, -128 은 하나도 없음(kor 2,720행, eng 1,855행). `float 가중치 ≈ int8 × 파일scale` 해석과 맞다.

float 모드 (mode & 1 == 0, "best" 모델):

| # | 형식 | 근거 |
|---|---|---|
| 2 | `GENERIC_2D_ARRAY<double>`: `i32 행, i32 열, f64 empty, f64[행·열]` (FAST_FLOAT 빌드는 읽은 뒤 float 로 변환) | weightmatrix.cpp:68-79, 326-328 |
| 3 | training 이면 `GENERIC_2D_ARRAY<double>` updates_ | weightmatrix.cpp:329-333 |
| 4 | training 이고 adam 이면 `GENERIC_2D_ARRAY<double>` dw_sq_sum_ | weightmatrix.cpp:334-338 |

**옛 형식 (mode & 128 == 0)** — `DeSerializeOld` (weightmatrix.cpp:346-386). **FAST_FLOAT 빌드(기본)는 아예 지원 안 함**(ASSERT, :348-351).
- int8: `GENERIC_2D_ARRAY<int8>` + `vector<float>` scales(`u32 개수 + f32[]`). 이 값은 **/127 하지 않고 그대로** 메모리 scale 로 쓴다(:353-364).
- float: `GENERIC_2D_ARRAY<float>`(f32 empty + f32 데이터) (:365-371).
- training 이면 (int/float 무관) `GENERIC_2D_ARRAY<float>` 두 개(updates, 폐기된 errs)가 더 붙는다(:372-383).

---

## 6. 8비트 계산 방식 — 질문 4

### 6-1. 입력 벡터를 int8 로 만드는 법 (고정 배율, 벡터별 동적 배율 없음)

int 모드 여부는 `training_flags & 1`(TF_INT_MODE)로 정한다: `inputs->set_int_mode(IsIntMode())` (lstmrecognizer.cpp:344, lstmrecognizer.h:87-88). fast-kor/eng 는 training_flags = 65 → int 모드 + recoder.

- 층 사이 값(float, 대략 [-1,1])을 int 버퍼에 쓸 때 (networkio.cpp:664-669):
  `q = clip( IntCastRounded(x * 127), -127, 127 )`
- 이미지 픽셀(Input 단계) (networkio.cpp:290-296):
  `f = (pixel − black) / contrast − 1`,  `q = clip( IntCastRounded(f * 128), -127, 127 )` ← 여기만 **128**
- `IntCastRounded` = 0에서 먼 쪽 반올림: `x ≥ 0 ? (int)(x+0.5) : -(int)(-x+0.5)` (helpers.h:184-195). JS 의 `Math.round` 와 음수 .5 처리가 다르다(−2.5 → C++ −3, JS −2).
- int 버퍼를 float 로 읽을 때는 `x = q / 127` (networkio.cpp:612-617).
- LSTM 은 매 시점 입력 버퍼 `source_` 에 `[입력 ni(이미 int8 이면 그대로 복사) | 피드백 nf | 직전 출력 ns | (2D) ns]` 를 위 식으로 양자화해 쓴 뒤 게이트 행렬곱에 넣는다. 직전 출력(재귀 입력)도 매 시점 `round(x·127)` 로 다시 양자화된다(lstm.cpp:364-371, 381-423).
- 층 출력: Softmax(NT_SOFTMAX) 출력은 항상 float 버퍼(fullyconnected.cpp:133-137). 그 밖의 FullyConnected·LSTM 출력은 입력이 int 면 int 버퍼에 위 식으로 저장(fullyconnected.cpp:136, 166; lstm.cpp:301, 477).

### 6-2. int8 행렬 × int8 벡터 (SIMD 없는 기준 구현)

`IntSimdMatrix::MatrixDotVector` (intsimdmatrix.cpp:78-117), 호출: weightmatrix.cpp:398-406 (SIMD 객체가 없을 때 = `dotproduct=generic`, simddetect.cpp:140-143, 301-304. 기본값은 `auto` 라 CPU 가 되면 AVX2 등 SIMD 경로를 탄다, simddetect.cpp:88).

```
num_in  = 열 수 − 1                       (마지막 열은 바이어스)
total_i = Σ_{j<num_in} W[i][j] * u[j]     (32비트 int 누적)
v[i]    = (total_i + W[i][num_in] * 127) * scale_mem[i]
scale_mem[i] = 파일scale[i] / 127
```

- 바이어스는 "입력 끝에 1이 있다고 보고" int 로 **×127** 해서 더한다(1.0 을 int8 로 나타낸 값 = 127).
- 실수 값으로 풀면 `v[i] = Σ (W[i][j]·S[i]) · (u[j]/127) + W[i][num_in]·S[i]`, S = 파일scale. 즉 float 가중치 ≈ W·S, float 입력 ≈ u/127.
- 누적값 범위: \|total\| ≤ 127·127·num_in. fast-kor 최대 num_in = 480 → 약 774만 < 2^24 이므로 float 로 바꿔도 정확하다.
- 정밀도: 기본 빌드(FAST_FLOAT)는 `scale_mem` 이 float 이고 `int * float` 가 float 곱셈 → JS 로 똑같이 하려면 `scaleF = Math.fround(fileScale / 127)`, `v = Math.fround((total + bias*127) * scaleF)`. double 빌드면 `Math.fround` 없이 그대로.
- SIMD 구현(AVX2/SSE/NEON)도 같은 식(바이어스 ×127, scale 곱)이고, 가중치 배치만 다르다(intsimdmatrixavx2.cpp:99-105, intsimdmatrixsse.cpp:72-77, intsimdmatrix.cpp:27-72).
- 그 뒤 활성 함수(4-2 표)는 float 로 계산한다. Tanh/Logistic 은 4096칸 표 + 선형 보간(functions.h:34-72, 표 값은 functions.cpp).

---

## 7. 실제 파일 검증 (parse-model.mjs)

실행: `node tmp-debug/ocr/parse-model.mjs [traineddata]` → 결과 `kor-out.txt`, `eng-out.txt`.
검사 항목: 남은 바이트 0, 행렬 크기(LSTM `ns×(na+1)`, FC `no×(ni+1)`), na = ni+nf+ns(·2), scale 개수 ≥ 행 수, 층마다 num_weights = 실제 원소 수 합, Series 연결 ni/no, 머리 ni/no = 계산값, 출력 수 = recoder code_range. 하나라도 틀리면 exit 1.
음성 시험: lstm 항목을 1바이트 늘린 파일 → "남은 바이트 1" 로 exit 1, 1바이트 줄인 파일 → "데이터 부족" 오류.

### fast-kor (lstm 973,837바이트 → 973,837 읽음, 남은 바이트 0)

```
Series "Series" ni=48 no=144 weights=951088 flags=192   learning_rates(8)
  Input "Input" ni=48 no=1  shape(b,h,w,d,loss)=1,48,0,1,0
  Series "ConvSeries" ni=1 no=16 weights=160              learning_rates(2)
    Convolve "Convolve" ni=1 no=9  half_x=1 half_y=1
    Tanh "ConvNL" ni=9 no=16      W: int8 16x10, scale 16
  Maxpool "Maxpool" ni=16 no=16  x_scale=3 y_scale=3
  XYTranspose "XYTransLSTM" ni=16 no=64                   learning_rates(1)
    SummLSTM "Lfys64" ni=16 no=64 na=80 ns=64 nf=0 2d=false   CI/GI/GF1/GO: int8 64x81, scale 64
  LSTM "Lfx96" ni=64 no=96 na=160 ns=96                    CI/GI/GF1/GO: int8 96x161, scale 96
  RTLReversed "RevLSTM" ni=96 no=96                        learning_rates(1)
    LSTM "Lrx96" ni=96 no=96 na=192 ns=96                  CI/GI/GF1/GO: int8 96x193, scale 96
  LSTM "Lfx384" ni=96 no=384 na=480 ns=384                 CI/GI/GF1/GO: int8 384x481, scale 384
  Softmax "Output" ni=384 no=144                           W: int8 144x385, scale 144
trailer: network_str 위와 같음, training_flags=65, training_iteration=1458300,
         sample_iteration=1458333, null_char=143, adam_beta=0.999, learning_rate=0.001, momentum=0.5
22번 recoder: 1158개, code_range=144 (=Softmax no), 21번 unicharset: 1158글자. 두 항목 모두 남은 바이트 0
모든 행렬 mode=133 (int8+adam+double형식), 모든 층 train=0
```

### fast-eng (lstm 401,636바이트 → 401,636 읽음, 남은 바이트 0)

구조는 같고 크기만 다르다: Input 1,36,0,1 / Lfys48 / Lfx96 / Lrx96 / Lfx192 / Softmax 111. null_char=110, recoder 112개·code_range=111, unicharset 112글자. version 항목에는 망 문자열이 없다(`4.00.00alpha:eng:synth20170629`).

### 바이트 예시 (fast-kor lstm 항목 맨 앞)

```
00                      i8  종류번호 0 → 이름 문자열이 뒤따름
06 00 00 00 "Series"    string 종류
00 00                   training=0, needs_backprop=0
c0 00 00 00             flags=192
30 00 00 00 / 90 00 00 00   ni=48 / no=144
30 83 0e 00             num_weights=951088
06 00 00 00 "Series"    name
08 00 00 00             하위 층 8개
00 05 00 00 00 "Input" 00 00 c0 00 00 00 30 00 00 00 01 00 00 00 00 00 00 00
05 00 00 00 "Input" 01 00 00 00 30 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00  (shape 1,48,0,1,0)
...
(끝) ... 6f 12 83 3a 23 5d 39 39   ← 최상위 Series 의 learning_rates 마지막 값들 (f32 0.001, 0.000177)
31 00 00 00 "[1,48,0,1Ct3,...O1c1]"  network_str (49바이트)
41 00 00 00  7c 40 16 00  9d 40 16 00  8f 00 00 00   flags=65, iter=1458300, sample=1458333, null=143
77 be 7f 3f  6f 12 83 3a  00 00 00 3f                adam_beta=0.999, lr=0.001, momentum=0.5
```

---

## 8. 확인 못 한 점 / 주의

- 원본 C++ 를 빌드·실행하지 않았으므로(지시대로 읽기만), "C++ 와 같은 값을 읽었다"는 비교는 못 했다. 검증은 "규칙대로 읽으면 남는 바이트 없이 정확히 끝나고, 크기·개수·num_weights·code_range 가 서로 맞는다"는 내부 일관성까지다.
- 큰 엔디언 파일, 옛 형식(mode 에 128 없음), float("best") 모델, 2D LSTM(GFS), LSTMSoftmax 계열, Parallel/Reconfig, `include_charsets` 경우(lstm 안에 unicharset·recoder 내장)는 코드에는 넣었지만 실제 파일로 시험하지 못했다(가진 파일 둘 다 해당 없음).
- 21번 unicharset 은 줄 수만 셌고 각 줄 필드는 파싱하지 않았다.
- 순전파 의미(Convolve 가장자리 처리, Maxpool, XYTranspose, SummLSTM 이 행 끝에서만 출력, 이미지 → Input 정규화의 black/contrast 계산, CTC/빔 탐색 디코딩)는 형식 범위 밖이라 다루지 않았다. 정확한 재현이 필요하면 다음으로 볼 곳: input.cpp(PreparePixInput), networkio.cpp(FromPix 계열), convolve.cpp/maxpool.cpp/reversed.cpp 의 Forward, lstm.cpp:291-504, recodebeam.cpp.
- 활성 함수 표(TanhTable/LogisticTable)는 functions.cpp 의 생성 상수라 그대로 옮겨야 비트 단위로 같은 결과가 나온다(이번에는 확인 안 함).
