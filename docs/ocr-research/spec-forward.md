# Tesseract 5.5.3 LSTM 순전파 명세 (글줄 그림 → 소프트맥스)

대상 망: `[1,48,0,1Ct3,3,16Mp3,3Lfys64Lfx96Lrx96Lfx384O1c1]` (한국어 fast, int8 가중치)

- 근거 경로는 모두 `tmp-debug/ocr/src/tesseract-5.5.3/src/` 기준이다. `파일:줄` 형식으로 적는다.
- Leptonica(이미지 확대·축소, 회색조 변환)는 Tesseract 소스에 들어 있지 않다. 그래서 Leptonica 1.84.1 원본(`scale1.c`, `enhance.c`, `pixconv.c`, `pix.h`)을 따로 받아 읽고 근거로 적었다. 실제 Tesseract 빌드에 링크된 Leptonica 버전은 다를 수 있다(14절).
- 가중치 파일 읽기는 다루지 않는다. 다만 계산에 필요한 배치(행렬 모양, scale의 뜻, `sample_iteration_`)는 적었다.

---

## 0. 먼저 알아야 할 전제

| 항목 | 값 | 근거 |
|---|---|---|
| 실수 타입 `TFloat` | 기본 빌드에서 **float32** (`FAST_FLOAT` 기본 ON). `--disable-float32`로 빌드하면 double | `ccutil/tesstypes.h:36-40`, `../CMakeLists.txt:95`, `../configure.ac:252-258` |
| int 모드 여부 | 모델의 `training_flags_ & TF_INT_MODE(=1)` | `lstm/lstmrecognizer.h:44-46, 87-89` |
| int 모드 전파 | `inputs->set_int_mode(IsIntMode())` 뒤, 각 층이 출력 크기를 잡을 때 입력의 int 모드를 물려받는다. 예외는 Softmax 층(항상 float 출력) | `lstm/lstmrecognizer.cpp:344`, `lstm/networkio.cpp:46-58`, `lstm/fullyconnected.cpp:133-137` |
| 행렬곱 구현 | SIMD가 없으면 `IntSimdMatrix::MatrixDotVector`(일반 C++). AVX2/SSE/NEON도 정수 누적 후 같은 식으로 scale을 곱한다 | `arch/intsimdmatrix.cpp:78-117`, `arch/intsimdmatrixavx2.cpp:98-110`, `arch/intsimdmatrixsse.cpp:76` |
| `NetworkScratch::set_int_mode` | 어디서도 호출되지 않는다. 임시 버퍼가 어느 스택에서 빌려오는지만 정하고 계산에는 영향이 없다 | `lstm/networkscratch.h:43-45, 54-57` |

JS에서 float32를 재현하려면 연산 하나마다 `Math.fround`를 씌운다(10절).

---

## 1. 망 구조와 층별 크기

### 1.1 망 기술 문자열이 만드는 층 트리

`networkbuilder.cpp`가 문자열을 다음 트리로 만든다. 가로 안의 이름은 직렬화된 타입 이름(`kTypeNames`)이다. 파일에서 읽을 때 이 이름으로 층을 구분한다.

```
Series "Series"                                   ("Series")
 ├─ Input "Input"           shape b=1,h=48,w=0,d=1 ("Input")    ni=48, no=1
 ├─ Series "ConvSeries"                            ("Series")
 │   ├─ Convolve "Convolve" half_x=1, half_y=1     ("Convolve") ni=1,  no=9
 │   └─ FullyConnected "ConvNL" NT_TANH            ("Tanh")     ni=9,  no=16
 ├─ Maxpool "Maxpool" x_scale=3, y_scale=3         ("Maxpool")  ni=16, no=16
 ├─ Reversed "XYTransLSTM" NT_XYTRANSPOSE          ("XYTranspose")
 │   └─ LSTM "Lfys64" NT_LSTM_SUMMARY              ("SummLSTM") ni=16, ns=no=64, na=80
 ├─ LSTM "Lfx96" NT_LSTM                           ("LSTM")     ni=64, ns=no=96, na=160
 ├─ Reversed "RevLSTM" NT_XREVERSED                ("RTLReversed")
 │   └─ LSTM "Lrx96" NT_LSTM                       ("LSTM")     ni=96, ns=no=96, na=192
 ├─ LSTM "Lfx384" NT_LSTM                          ("LSTM")     ni=96, ns=no=384, na=480
 └─ FullyConnected "Output" NT_SOFTMAX             ("Softmax")  ni=384, no=K
```

| 근거 | 위치 |
|---|---|
| 맨 앞 `[` → Series, 그 안의 `1,48,0,1` → Input | `training/common/networkbuilder.cpp:88-97, 123-144, 147-168` |
| `Ct3,3,16` → Series(Convolve(ni, x/2, y/2), FullyConnected(9→16, tanh)) | `networkbuilder.cpp:271-296` (`t`→NT_TANH: `249-268`) |
| Convolve 출력 수 = ni×(2hx+1)×(2hy+1) = 9 | `lstm/convolve.cpp:34-37` |
| `Mp3,3` → Maxpool(depth, x=3, y=3), 출력 깊이 = 입력 깊이 | `networkbuilder.cpp:299-309`, `lstm/maxpool.cpp:22-26` |
| `Lfys64` → LSTM(NT_LSTM_SUMMARY), `y`라서 Reversed(NT_XYTRANSPOSE)로 감쌈 | `networkbuilder.cpp:312-384` (특히 `340-343`, `378-382`) |
| `Lrx96` → LSTM을 Reversed(NT_XREVERSED) "RevLSTM"으로 감쌈 | `networkbuilder.cpp:364-368` |
| LSTM의 `na = ni + ns`(1차원, 소프트맥스 없음) | `lstm/lstm.cpp:101-124` |
| `O1c1` → `c`는 NT_SOFTMAX. 출력 수는 문자열의 1이 아니라 `num_softmax_outputs_`로 덮어씀. 입력 높이가 1이라 Reconfig 없이 FullyConnected 하나 | `networkbuilder.cpp:445-492` |
| `num_softmax_outputs_` = 학습 시 `recoder_.code_range()` | `training/unicharset/lstmtrainer.cpp:169` |
| 타입 이름 표 | `lstm/network.cpp:60-75`, 파일에서 층 생성 `214-320` |

**K(출력 수)**: 실행 시에는 파일의 Output 층 `no_`(= 가중치 행렬 행 수)를 그대로 쓴다. 한국어 모델은 recoder가 완성형 한글을 자모 코드로 쪼개므로 K는 unicharset 크기가 아니라 recoder의 코드 범위(`code_range`)다. CTC 공백 번호는 `null_char_`이고, 이것도 파일에 들어 있다.

### 1.2 층별 입출력 크기 (H×W×D, 배치 1)

W는 높이 48로 맞춘 뒤의 그림 너비다(2.3절). W' = ⌊W/3⌋.

| 층 | 입력 | 출력 | 시간축 t |
|---|---|---|---|
| Input | 48×W×1 | 48×W×1 | t = y·W + x |
| Convolve | 48×W×1 | 48×W×9 | 같음 |
| ConvNL (tanh) | 48×W×9 | 48×W×16 | 같음 |
| Maxpool | 48×W×16 | 16×W'×16 | t = y'·W' + x' |
| XYTranspose(SummLSTM 64) | 16×W'×16 | 1×W'×64 | t = x' |
| LSTM 96 | 1×W'×64 | 1×W'×96 | t = x' |
| RTLReversed(LSTM 96) | 1×W'×96 | 1×W'×96 | t = x' |
| LSTM 384 | 1×W'×96 | 1×W'×384 | t = x' |
| Softmax | 1×W'×384 | 1×W'×K (float) | t = x' |

- 출력 모양 근거: `lstm/reconfig.cpp:34-42`(Maxpool은 깊이 유지), `lstm/lstm.cpp:132-142`(SUMMARY는 너비 1), `lstm/reversed.cpp:32-42`(XYTranspose는 가로세로를 바꿔 계산한 뒤 되돌림).
- 망 전체의 x 축소 비율 `XScaleFactor()` = 1·1·3·1·… = 3이다(`lstm/series.cpp:91-97`, `lstm/reconfig.cpp:50-52`, 기본값 1은 `lstm/network.h:211-213`). 이 값이 최소 크기 검사에 쓰인다(2.2절).

---

## 2. 입력 준비

### 2.1 Tesseract가 페이지에서 글줄 그림을 잘라 오는 방법 (참고)

JS에서 글줄을 직접 자른다면 이 단계는 흉내만 내도 된다. 결과를 Tesseract와 맞춰 볼 때 필요하다.

1. 상자 결정: 페이지 분석 모드가 `PSM_SINGLE_WORD`나 `PSM_RAW_LINE`이면 그림 전체를 쓴다. 그 밖에는 단어(글줄) 상자를 기준선 + descender부터 기준선 + x-height + ascender까지 위아래로 넓힌다. 근거: `ccmain/linerec.cpp:229-245`.
2. `GetRectImage(box, block, kImagePadding=4)`: 상자를 상하좌우 4px씩 넓힌 뒤 **페이지 경계로 자른다**. 넓힌 부분은 페이지의 실제 픽셀이다. 흰색 같은 인공 여백은 붙이지 않는다. 그림 전체를 쓰는 모드에서는 결국 여백이 0이다. 근거: `ccmain/linerec.cpp:164-198`, `ccstruct/imagedata.h:39`, `ccstruct/rect.h:144-148`.
3. 원본 그림 선택 `BestPix()`: 원본(컬러면 32bpp 컬러 그대로) → 회색 → 이진 순서로 고른다. 회색·컬러는 0=검정, 255=흰색이다. 근거: `ccmain/tesseractclass.h:232-248`.
4. 8bpp 미만(1bpp 이진 등)만 여기서 8bpp로 바꾼다(`pixConvertTo8(pix,false)`: 1bpp의 0→255, 1→0). **32bpp 컬러는 이 단계에서 컬러로 남는다.** 근거: `ccmain/linerec.cpp:207-214`, Leptonica `pixconv.c:3055-3080`.
5. `RecognizeLine(image_data, invert_threshold, ...)` 호출. `invert_threshold` 기본값은 0.7, `tessedit_do_invert` 기본값은 true. 근거: `ccmain/linerec.cpp:251-255`, `ccmain/tesseractclass.cpp:67-71`.

### 2.2 `LSTMRecognizer::RecognizeLine` 흐름

`lstm/lstmrecognizer.cpp:320-389`

```
SetRandomSeed()                                   // 325
min_width = network_->XScaleFactor()              // 326  → 3
pix = Input::PrepareLSTMInputs(...)               // 327  높이 48로 확대·축소 (2.3)
   └ 결과 너비 또는 높이 < 3 이면 실패               // input.cpp:93-97
inputs->set_int_mode(IsIntMode())                 // 344
SetRandomSeed()                                   // 345  ← 순전파 직전 난수 상태를 여기서 정함
Input::PreparePixInput(InputShape(), pix, ...)    // 346  회색 변환·대비 정규화 (2.4~2.6)
network_->Forward(inputs → outputs)               // 347
if invert_threshold > 0: 자동 반전 (2.8)           // 349-377
```

`SetRandomSeed()`: `seed = sample_iteration_ * 0x10000001` (int64), `set_seed(seed)` 뒤 `IntRand()`를 한 번 버린다. 근거: `lstm/lstmrecognizer.h:288-292`. `sample_iteration_`은 모델 파일에 들어 있다(`lstm/lstmrecognizer.cpp:153`). 이 난수는 Convolve 층이 그림 바깥 이웃을 채울 때 쓴다(4절, 5절).

### 2.3 높이 48로 맞추기: `ImageData::PreScale` → Leptonica `pixScale`

`lstm/input.cpp:82-99`, `ccstruct/imagedata.cpp:216-267`

- `target_height = network->NumInputs()` = Input 층의 ni = **48**. (`max_height = kMaxInputHeight = 48`은 target이 0일 때만 쓴다. `input.cpp:28`)
- 배율: `float im_factor = (float)48 / input_height;` (float32 나눗셈) — `imagedata.cpp:228`
- `pix = pixScale(src, im_factor, im_factor)` — 가로·세로 같은 배율. `imagedata.cpp:236`
- 결과 너비 W는 `pixScale`이 실제로 만든 너비다(`imagedata.cpp:243-248`). 일반 경우 `W = (int)(fround(f*ws) + 0.5)`이고, 배율이 정확히 0.5·0.25·0.125·0.0625일 때만 `⌊ws/2⌋`를 반복한다(아래 표). 높이도 같은 식으로 48이 된다.
- 컬러(32bpp)면 **컬러 상태로 확대·축소한 뒤** 2.4절에서 회색으로 바꾼다. 순서가 바뀌면 값이 달라진다.
- 확대·축소 뒤 `PreparePixInput`에서 높이가 48이 아니면 한 번 더 맞춘다(`input.cpp:131-142`). 정상적으로는 일어나지 않는다.

#### Leptonica 1.84.1 `pixScale(f, f)` 분기 (8bpp 기준)

근거: `scale1.c:254-271`(sharpfract·sharpwidth 결정), `scale1.c:419-479`(`pixScaleGeneral`), `scale1.c:766-808`(`pixScaleGrayLI`), `scale1.c:1910-2018`(`pixScaleAreaMap`).

`maxscale = f`이다. `f < 0.7`이면 sharpfract=0.2, sharpwidth=1이고, 아니면 0.4, 2다.

| 조건 (f = float32) | 처리 | 결과 너비 |
|---|---|---|
| f == 1.0 (원래 높이 48) | 그대로 복사, 선명화 없음 | ws |
| f < 0.02 | `pixScaleSmooth` (높이 2400px 초과, 사실상 없음) | — |
| f == 0.5 / 0.25 / 0.125 / 0.0625 | `pixScaleAreaMap2`를 1/2/3/4번: 2×2 평균 `(a+b+c+d)>>2` | `⌊ws/2⌋` 반복 (`scale1.c:2066`, `3657-3690`) |
| 그 밖의 f < 0.7 | 면적 평균 `scaleGrayAreaMapLow` | `(int)(fround(f*ws)+0.5)` (`scale1.c:1993`) |
| └ 위 두 경우 중 f > 0.2 | 이어서 `pixUnsharpMasking(halfwidth=1, fract=0.2)` | 같음 (`scale1.c:456-460`) |
| f == 2.0 (높이 24) | `pixScaleGray2xLI` | 2·ws |
| f == 4.0 (높이 12) | `pixScaleGray4xLI` | 4·ws |
| 그 밖의 0.7 ≤ f | 쌍선형 `scaleGrayLILow` | `(int)(fround(f*ws)+0.5)` (`scale1.c:796`) |
| └ 위 세 경우 중 f < 1.4 | 이어서 `pixUnsharpMasking(halfwidth=2, fract=0.4)` | 같음 (`scale1.c:467-471`) |

(f == 2.0·4.0은 1.4 이상이라 선명화가 없다.)

**쌍선형 `scaleGrayLILow`** (`scale1.c:2355-2425`). ws·hs는 원본, wd·hd는 결과 크기. 모든 정수 나눗셈은 0 쪽 버림.

```
scx = fround(fround(16*ws) / wd);  scy = fround(fround(16*hs) / hd)   // float32
for i in 0..hd-1:  ypm = trunc(fround(scy*i));  yp = ypm>>4;  yf = ypm&15
  for j in 0..wd-1: xpm = trunc(fround(scx*j)); xp = xpm>>4;  xf = xpm&15
    v00 = s[yp][xp]
    xp > ws-2 이고 yp ≤ hs-2 (오른쪽 끝): v10=v00, v01=s[yp+1][xp], v11=v01
    yp > hs-2 이고 xp ≤ ws-2 (아래 끝):   v01=v00, v10=s[yp][xp+1], v11=v10
    둘 다 넘으면(오른쪽 아래 모서리):     v10=v01=v11=v00
    아니면: v10=s[yp][xp+1], v01=s[yp+1][xp], v11=s[yp+1][xp+1]
    d[i][j] = ((16-xf)(16-yf)v00 + xf(16-yf)v10 + (16-xf)yf·v01 + xf·yf·v11 + 128) / 256
```

**면적 평균 `scaleGrayAreaMapLow`** (`scale1.c:3550-3641`)

```
scx, scy는 위와 같음 (float32)
for i: yu = trunc(fround(scy*i));  yl = trunc(scy*(i+1.0))   // ← yl은 double 곱셈
       yup=yu>>4, yuf=yu&15, ylp=yl>>4, ylf=yl&15, dely=ylp-yup
  for j: xu = trunc(fround(scx*j)); xl = trunc(scx*(j+1.0))  // ← xl도 double 곱셈
       xup, xuf, xlp, xlf, delx 같은 방식
       if xlp > ws-2 or ylp > hs-2:  d = s[yup][xup]  (가장자리는 원본 한 점)
       area = ((16-xuf) + 16(delx-1) + xlf) * ((16-yuf) + 16(dely-1) + ylf)
       v00 = (16-xuf)(16-yuf)·s[yup][xup];   v10 = xlf(16-yuf)·s[yup][xlp]
       v01 = (16-xuf)·ylf·s[ylp][xup];       v11 = xlf·ylf·s[ylp][xlp]
       vin  = Σ_{k=1..dely-1} Σ_{m=1..delx-1} 256·s[yup+k][xup+m]
       vmid = Σ_{k=1..dely-1} [(16-xuf)·16·s[yup+k][xup] + xlf·16·s[yup+k][xlp]]
            + Σ_{m=1..delx-1} [16(16-yuf)·s[yup][xup+m] + 16·ylf·s[ylp][xup+m]]
       d = (v00+v01+v10+v11+vin+vmid+128) / area
```

**2배·4배 확대** (`scale1.c:2674-2853`, `2915-` 및 주석 `2890-2907`). 원본 (i,j)에서 s1=s[i][j], s2=s[i][j+1], s3=s[i+1][j], s4=s[i+1][j+1]로 두고, 결과 (k·i+a, k·j+b)(k=2 또는 4, 0≤a,b<k)는 다음과 같다.

`⌊((k−a)(k−b)s1 + (k−a)b·s2 + a(k−b)s3 + ab·s4) / k²⌋`

마지막 열은 s2=s1, s4=s3로, 마지막 행은 s3=s1, s4=s2로 바꾼다.

**선명화 `pixUnsharpMaskingGray2D`** (`enhance.c:1389-1500`). 경로는 `pixUnsharpMasking` → `Fast` → `GrayFast` → `Gray2D`(`enhance.c:979-1024, 1141-1237`). hw=halfwidth, n=2hw+1이다.

```
d = 원본 복사 (가장자리 hw 픽셀 띠는 원본 그대로 남음)
가로 합: F[i][j] = Σ_{dj=-hw..hw} s[i][j+dj]         (j ∈ [hw, w-hw))  // float에 저장
세로 + 선명화: (i ∈ [hw, h-hw), j ∈ [hw, w-hw))
  L = fround( fround(1/n²) * (F[i-hw][j] + ... + F[i+hw][j]) )   // 더하기도 float32, 위에서부터 차례로
  ival = trunc( fround(s + fround(fract*fround(s - L))) + 0.5 )  // 마지막 +0.5만 double
  d[i][j] = clamp(ival, 0, 255)
```

`norm`은 `1.0f/9.0f` 또는 `1.0f/25.0f`이고, `fract`는 float32 0.2 또는 0.4다.

컬러(32bpp)는 R·G·B 채널마다 같은 정수 식을 따로 적용한다(쌍선형: `scale1.c:2250-2336`, 선명화: `enhance.c:1169-1185`). 면적 평균 컬러판은 `scaleColorAreaMapLow`(`scale1.c:3392-`)인데, 채널별로 같은 식이라고 보고 자세히 대조하지는 않았다.

### 2.4 회색조 변환

`lstm/input.cpp:108-130`: 망 입력 깊이가 1이면 8bpp가 아닌 그림을 `pixConvertTo8(pix, false)`로 바꾼다.

- 32bpp: `pixConvertRGBToLuminance` → `pixConvertRGBToGray(0,0,0)` → 가중치 `L_RED_WEIGHT=0.3f, L_GREEN_WEIGHT=0.5f, L_BLUE_WEIGHT=0.2f` (Leptonica `pixconv.c:732-735, 815-871`, 픽셀 식은 `863-866`, `pix.h:370-372`)

  `Y = trunc( fround(fround(fround(0.3f·R) + fround(0.5f·G)) + fround(0.2f·B)) + 0.5 )`

  (곱셈과 덧셈은 float32이고, +0.5에서 double로 올라간다. 알파는 무시한다.)
- 이미 8bpp면 그대로 쓴다.

### 2.5 대비 정규화: `ComputeBlackWhite`

`lstm/networkio.cpp:127-158`, 호출은 `171-207` (입력 깊이 ≠ 3일 때만)

1. 가운데 행 `y = ⌊height/2⌋` 하나만 본다(height=48 → y=24).
2. x = 1..W−2에서 prev=p[x−1], curr=p[x], next=p[x+1]로
   - 지역 최소: `(curr < prev && curr <= next) || (curr <= prev && curr < next)` → `mins` 히스토그램에 curr를 더한다.
   - 지역 최대: `(curr > prev && curr >= next) || (curr >= prev && curr > next)` → `maxes`에 더한다.
   - 평평한 구간(prev=curr=next)은 어느 쪽에도 들지 않는다.
3. mins가 비면 0 하나, maxes가 비면 255 하나를 넣는다.
4. `black = (float) mins.ile(0.25)`, `white = (float) maxes.ile(0.75)`
5. `contrast = fround(fround(white - black) / 2)`, `contrast <= 0`이면 1.

`STATS::ile(frac)` (`ccstruct/statistc.cpp:172-197`, 계산은 double, 버킷은 0..255):

```
target = clamp(frac * total, 1.0, total)
sum = 0; index = 0
while index <= 255 and sum < target: sum += bucket[index]; index++
return index - (sum - target) / bucket[index-1]   // index > 0일 때
```

예를 들어 한 값 v만 n(≥4)번 들어 있으면 ile(0.25) = v + 0.25, ile(0.75) = v + 0.75가 된다. 정수가 아니다.

### 2.6 픽셀 → 망 입력값: `SetPixel`

`lstm/networkio.cpp:290-297`

```
float_pixel = fround( fround( fround(pixel - black) / contrast ) - 1.0f )
float 모드: f[t][0] = float_pixel                         (잘라내지 않음, ±1을 넘을 수 있음)
int 모드:   i[t][0] = clamp( IntCastRounded_f32( fround(128 * float_pixel) ), -127, 127 )
```

- `[black, black + 2·contrast] = [black, white]`가 `[-1, +1]`에 대응한다(주석 `networkio.cpp:209-215`).
- **극성**: 회색값 0이 검정이다. 그래서 **어두운 글자는 음수(≈ −1, int −127)**, **밝은 바탕은 양수(≈ +1, int +127)**가 된다.
- **int 모드는 128을 곱한다(`INT8_MAX + 1`).** 다른 층은 모두 int8 값을 `/127`로 읽고 `×127`로 쓴다(3.3절). 입력층만 다르다.
- 배치 순서는 `Copy2DImage`(`networkio.cpp:216-251`)가 정한다. y = 0..47(위→아래), 그 안에서 x = 0..W−1(왼→오), `t`는 1씩 증가한다. 망 너비가 0(가변)이므로 목표 너비 = 그림 너비이고, 잡음 채움(`Randomize`)은 일어나지 않는다. 그림 높이가 48보다 작을 때만 남는 행을 난수로 채운다.

`IntCastRounded` (`ccutil/helpers.h:184-195`): `x >= 0 ? (int)(x + 0.5) : -(int)(-x + 0.5)`. float 판은 `+0.5F`를 **float32로** 더한다(JS: `Math.trunc(Math.fround(v + 0.5))`). double 판은 double로 더한다.

### 2.7 여백

- 망에 넣기 전 좌우·상하에 인공 여백을 붙이지 않는다. 2.1절의 4px는 페이지의 실제 픽셀이다.
- 가장자리 처리는 Convolve 층에서 그림 바깥 이웃을 **0이 아니라 난수**로 채우는 것뿐이다(5절).

### 2.8 자동 반전 (순전파를 한 번 더 할 수 있음)

`lstm/lstmrecognizer.cpp:294-316, 349-377`

1. 첫 결과의 `OutputStats`를 구한다. 각 t에서 전체 K개 중 최댓값 라벨을 찾는다(`>` 비교라 동점이면 앞 번호, `networkio.cpp:503-518`). 그 라벨이 `null_char_`가 아니면 `(int)(127 * p)`(버림)를 0..127 히스토그램에 넣는다. mean = 히스토그램 평균 / 127이다. 하나도 없으면 mean = 0.
2. `mean < 0.7`이면 `SetRandomSeed()`를 다시 하고, 확대·축소가 끝난 pix를 `pixInvert`(255 − v, 컬러면 채널마다)한다. 그다음 2.4~2.6과 순전파를 다시 한다.
3. 반전한 쪽의 mean이 더 크면 그 결과를 쓴다.

---

## 3. NetworkIO와 StrideMap: 데이터 배치

### 3.1 시간축 t

`lstm/stridemap.h:32-37`, `lstm/stridemap.cpp:131-150, 180-185`

- 텐서는 언제나 [batch][y][x] × depth이고, 메모리는 2차원 배열 `[t][feature]`다.
- `t_inc[WIDTH]=1`, `t_inc[HEIGHT]=W`, `t_inc[BATCH]=H·W`이므로 **`t = (b·H + y)·W + x`**다. x가 가장 빨리 변한다(행 우선).
- `Index::Increment()`는 x → y → b 순서로 올라간다(`stridemap.cpp:75-87`). 모든 층의 반복이 이 순서다.
- `AddOffset(off, dim)`은 그 차원만 옮긴 뒤 모든 차원이 범위 안인지 돌려준다(`stridemap.cpp:24-37, 67-71`).
- 크기 변경:
  - Maxpool `ScaleXY(3,3)`: H/3, W/3 정수 나눗셈으로 나머지는 버린다(`stridemap.cpp:153-163`).
  - Summary `ReduceWidthTo1`(`166-170`)
  - XYTranspose `TransposeXY`: H와 W를 바꾼다(`173-177`).

### 3.2 int 모드와 float 모드

`lstm/networkio.h:332-338`: `f_`(float)와 `i_`(int8) 중 하나만 쓴다.

| 동작 | int 모드 | float 모드 | 근거 |
|---|---|---|---|
| 읽기 `ReadTimeStep` | `v = i / 127` | `v = f` | `networkio.cpp:612-624` |
| 쓰기 `WriteTimeStep(Part)` | `clamp(IntCastRounded_f32(fround(x·127)), -127, 127)` | `f = (float)x` | `networkio.cpp:658-676` |
| 입력 그림 `SetPixel` | `×128`(2.6) | 그대로 | `networkio.cpp:290-297` |
| 잡음 `Randomize` | `IntCastRounded_f64(SignedRand(127))` | `SignedRand(1.0)` | `networkio.cpp:417-431` |

- int 모드의 int8 값 q는 실수 q/127을 뜻한다. −128은 나오지 않는다.
- SIMD용 패딩(`GetPadding`)은 일반 구현에서 0이다. 패딩이 있어도 행렬곱은 앞의 `ni`개만 읽는다(`networkio.cpp:994-1000`).

---

## 4. 난수 생성기 TRand (Convolve 가장자리에 필요)

`ccutil/helpers.h:71-102`

```
seed: uint64
IntRand():  seed = seed * 6364136223846793005 + 1442695040888963407  (mod 2^64)
            return (int32)(seed >> 33)                 // 0 .. 2^31-1
SignedRand(range) = range * 2.0 * IntRand() / INT32_MAX - range      // double, 왼쪽부터 계산
```

JS (BigInt):

```js
const M64 = (1n << 64n) - 1n;
let seed = (BigInt(sampleIteration) * 0x10000001n) & M64;   // SetRandomSeed
const intRand = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & M64; return Number(seed >> 33n); };
intRand();                                                  // SetRandomSeed가 한 번 버림
const signedRand = (r) => r * 2.0 * intRand() / 2147483647 - r;
const rand8 = () => intCastRoundedF64(signedRand(127));     // int 모드 Randomize
```

- `RecognizeLine`은 `SetRandomSeed`를 두 번 부르지만(325, 345줄) 둘 다 시드를 새로 정하므로 결과는 "시드 설정 + 한 번 버림" 상태다.
- 이 상태에서 Convolve 전에 난수를 쓰는 곳은 없다. 그림 높이가 48이면 `Copy2DImage`의 잡음 채움도 일어나지 않는다.

---

## 5. Convolve + ConvNL (`Ct3,3,16`)

### 5.1 Convolve: 3×3 이웃을 9차원으로 모으기

`lstm/convolve.cpp:77-111`. half_x = half_y = 1, ni = 1.

```
for (y, x) in Increment 순서 (y 바깥, x 안쪽):
  out_ix = 0
  for dx = -1, 0, +1:                       // 바깥 루프가 x 오프셋
    if x+dx가 그림 밖:  feature[out_ix .. out_ix+2] = 난수 3개 (dy=-1,0,+1 순서)
    else:
      for dy = -1, 0, +1:
        feature[out_ix + (dy+1)] = (y+dy가 그림 밖) ? 난수 1개 : in[y+dy][x+dx]
    out_ix += 3
```

- **특징 번호 k = 3·(dx+1) + (dy+1)**: 열(x) 단위로 묶고, 그 안에서 위→아래다. 일반식은 `k = ((dx+hx)(2hy+1) + (dy+hy))·ni + c`.
- **가장자리는 0으로 채우지 않는다.** 그림 바깥 이웃은 TRand 난수로 채운다. int 모드에서는 `rand8()`(±127 균등)이다. 난수를 쓰는 순서는 위 루프 순서 그대로다. x 오프셋이 밖이면 y가 밖이든 아니든 3개를 쓰고, x는 안인데 y만 밖이면 1개를 쓴다.
- int 모드에서는 입력 int8 값을 그대로 복사한다(`CopyTimeStepGeneral`, `networkio.cpp:405-414`).

### 5.2 ConvNL: FullyConnected(9 → 16, tanh)

`lstm/fullyconnected.cpp:129-187, 203-234`

```
각 t:  z = MatVecI8(W_conv[16][10], scales[16], feature_i8[9])   // 9절
       a_i = Tanh(z_i)                                            // LUT, 7.2절
       출력 int8 = q8(a_i) = clamp(IntCastRounded_f32(fround(a_i*127)), -127, 127)
```

---

## 6. Maxpool (`Mp3,3`)

`lstm/maxpool.cpp:37-67`, `lstm/networkio.cpp:679-702`

- 창 3×3, 보폭 3(겹치지 않음). 출력 H' = ⌊48/3⌋ = 16, W' = ⌊W/3⌋. 남는 오른쪽 열(W mod 3개)은 버린다.
- `out[y'][x'][f] = max_{dx∈0..2, dy∈0..2} in[3y'+dy][3x'+dx][f]`. 특징마다 따로 고르고, int8 그대로 비교한다. 동점이면 먼저 본 값을 남기지만, 순전파 값에는 영향이 없다.

---

## 7. LSTM

### 7.1 한 시퀀스(행)를 처리하는 식 (1차원, int 모드)

`lstm/lstm.cpp:291-504`. 게이트 순서는 `CI, GI, GF1, GO`이고, `GFS`는 2차원일 때만 쓴다. 이 모델에는 없다. 근거: `lstm/lstm.h:32-40`, `lstm.cpp:253-287`.

입력 벡터 `src`의 길이는 na = ni + ns다. **[입력 ni개 | 직전 출력 ns개]** 순서이고, 바이어스는 가중치 행렬의 마지막 열(na번)에 있다. 입력에는 1이 붙어 있지 않고, 행렬곱이 `bias·127`을 더한다(9절). 근거: `lstm.cpp:364-371`, `lstm.h:128-131`.

```
행이 시작할 때: c[0..ns-1] = 0 (float32),  h[0..ns-1] = 0 (float32)          // 316-318
for 행 안의 각 t (x 증가 순서):
  src[0..ni-1]      = 입력 int8                                  // 364  그대로 복사
  src[ni..ni+ns-1]  = q8(h)                                      // 368  직전 출력을 int8로 양자화
  ci = Tanh    ( MatVecI8(W_CI , s_CI , src) )                   // 381-386
  gi = Logistic( MatVecI8(W_GI , s_GI , src) )                   // 390-395
  gf = Logistic( MatVecI8(W_GF1, s_GF1, src) )                   // 399-404
  go = Logistic( MatVecI8(W_GO , s_GO , src) )                   // 418-423
  c_i = fround(c_i * gf_i)                                       // 427  MultiplyVectorsInPlace
  c_i = fround(c_i + fround(ci_i * gi_i))                        // 442  MultiplyAccumulate
  c_i = clamp(c_i, -100, 100)                                    // 444  kStateClip = 100 (71줄)
  h_i = fround(Tanh(c_i) * go_i)                                 // 455  FuncMultiply<HFunc>
  출력[t] = q8(h)                                                // 477  (SUMMARY는 7.3)
  행의 마지막 x이면: c = 0, h = 0                                 // 486-489
```

- 셀 상태 c와 출력 h는 float32이고, 다음 단계 입력으로 들어갈 때만 h를 int8로 바꾼다.
- 출력 NetworkIO에 쓰는 값과 다음 단계 재귀 입력은 둘 다 `q8(h)`로 같은 양자화 결과다.
- 활성 함수: `CI`는 tanh(`GFunc`), `GI·GF1·GO`는 logistic(`FFunc`), 출력 쪽은 tanh(`HFunc`). 근거: `lstm/functions.h:75-79, 114-118, 140-144`.
- 상태 자르기: c만 ±100으로 자른다. 게이트 전 값(pre-activation)은 자르지 않지만, LUT가 |x| ≥ 4095/256 ≈ 16에서 ±1로 포화된다.
- 2차원 LSTM(GFS, 위쪽 이웃)은 `is_2d_ = (na − nf == ni + 2ns)`일 때만 쓴다(`lstm.cpp:274`). 이 모델의 네 LSTM은 모두 1차원이다. 참고로 2차원이면 src 뒤에 위쪽 이웃 출력 ns개가 더 붙는다. 그리고 `gf < gfs`인 원소는 `c = gfs × (위쪽 c)`로 바뀐다(`lstm.cpp:369-371, 428-441`).

가중치 모양: 게이트마다 `[ns][na+1]`(행 = 출력 유닛, 열 = 입력 ni + 재귀 ns + 바이어스 1)이다.

| 층 | ni | ns | 게이트 하나의 행렬 | 게이트 수 |
|---|---|---|---|---|
| Lfys64 | 16 | 64 | 64×81 | 4 |
| Lfx96 | 64 | 96 | 96×161 | 4 |
| Lrx96 | 96 | 96 | 96×193 | 4 |
| Lfx384 | 96 | 384 | 384×481 | 4 |

### 7.2 활성 함수 근사표 (LUT)

`lstm/functions.h:34-72`, `lstm/generate_lut.py:9-26`, 표 값은 `lstm/functions.cpp:4-4101`(Tanh), `4102-8199`(Logistic)

- 크기 `kTableSize = 4096`, 배율 `kScaleFactor = 256`이다. 표가 덮는 범위는 x ∈ [0, 16)이다.
- `TanhTable[i] = tanh(i/256)`, `LogisticTable[i] = 1/(1+exp(-i/256))`. 소스에는 double 리터럴로 적혀 있고, `TFloat = float`이라 float32로 저장된다.
- 함수 (float32):

```
Tanh(x):     if x < 0: return -Tanh(-x)
             x = fround(x * 256);  idx = trunc(x)          // static_cast<unsigned>
             if idx >= 4095: return 1
             a = T[idx]; b = T[idx+1]
             return fround(a + fround(fround(b - a) * fround(x - idx)))
Logistic(x): if x < 0: return fround(1 - Logistic(-x))
             나머지는 같은 방식(표 L), idx >= 4095 → 1
```

- 검증: Node(V8)에서 `Math.tanh(i/256)`은 4096개 리터럴과 double로 모두 같았다. logistic `1/(1+Math.exp(-i/256))`은 double로 16개가 달랐지만 `Math.fround` 뒤에는 모두 같았다. 따라서 `Float32Array`에 JS로 직접 만들어 넣어도 된다. (검증 스크립트는 세션 scratchpad에 두었고 저장소에는 없다.)

### 7.3 Lfys64: y 방향으로 돌고 마지막만 남기기

`lstm/reversed.cpp:52-60, 78-86`, `lstm/networkio.cpp:908-926`, `lstm/lstm.cpp:298-299, 470-475`

1. **XYTranspose**: Maxpool 출력(16×W'×16)을 전치해 H_T = W', W_T = 16으로 만든다. `T[y_T = x'][x_T = y'] = in[y'][x']`
2. LSTM(SUMMARY)이 전치된 텐서의 각 "행"(= 원래의 열 x')을 x_T = 0..15, 즉 **원래 y' = 0(위) → 15(아래)** 순서로 돈다. 행마다 c, h를 0으로 시작한다.
3. 행의 마지막(x_T = 15, 맨 아래)에서만 `q8(h)`를 출력 `dest_index`에 쓰고 `dest_index`를 1 올린다. 출력 맵은 `ResizeXTo1`로 H = W', W = 1이다.
4. 다시 전치해 1×W'×64가 된다. 결과: **`seq1[x'] = 열 x'를 위에서 아래로 16칸 돈 뒤의 마지막 출력`**

### 7.4 Lfx96: x 정방향

입력 1×W'×64. x' = 0 → W'−1 순서로 한 시퀀스를 돈다. 처음에 상태는 0이다. 출력 `seq2[x']` (96).

### 7.5 Lrx96: Reversed로 x 역방향

`lstm/reversed.cpp:52-60`, `lstm/networkio.cpp:890-905`

입력을 x 방향으로 뒤집고(`rev[W'-1-x'] = in[x']`) LSTM을 정방향으로 돌린 뒤, 출력을 다시 뒤집는다. 결과는 **x' = W'−1 → 0 순서로 돈 출력을 원래 위치 x'에 둔 것**과 같다. 상태는 오른쪽 끝에서 0으로 시작한다. 출력 `seq3[x']` (96).

### 7.6 Lfx384

입력 `seq3` 96차원, 정방향, 출력 `seq4[x']` (384).

층마다 직렬 순서는 `lstm/series.cpp:107-125` 그대로다(앞 층 출력이 다음 층 입력).

---

## 8. 출력층 O1c1 (Softmax)

`lstm/fullyconnected.cpp:129-137, 203-219, 230-234`, `lstm/functions.h:180-207`

```
출력 버퍼는 항상 float (ResizeFloat)                                // 133-134
각 t = x':
  z = MatVecI8(W_out[K][385], s_out[K], seq4_i8[x'])                 // int 경로 (9절)
  m = max_i z_i     (i=0부터, '>' 비교)
  p_i = fround(exp( clamp(fround(z_i - m), -86, 0) ))                // expf
  total = fround(total + p_i)   (i 순서대로)
  if total > 0: p_i = fround(p_i / total)
  probs[x'][i] = p_i
```

- 출력 수 K는 Output 층 행렬의 행 수다(1.1절).
- 결과 `probs`는 W'×K float32 배열이고, CTC/recoder 빔 탐색(`RecodeBeamSearch::Decode`)의 입력이 된다.

---

## 9. int8 행렬곱 (SIMD 없는 일반 구현)

`arch/intsimdmatrix.cpp:78-117`, 호출 `lstm/weightmatrix.cpp:398-406`

가중치 `W`: int8, 모양 `[no][ni+1]`(행 우선)이다. 열 0..ni−1은 입력 가중치, 열 ni는 바이어스. 입력 `u`: int8 ni개.

```
for i in 0..no-1:
  total = Σ_{j=0..ni-1} W[i][j] * u[j]                    // int32 누적
  v[i]  = fround( (total + W[i][ni] * 127) * scale[i] )   // int → float 변환 후 float32 곱
```

- 4행씩 묶는 것은 벡터화를 위한 것일 뿐이고 결과는 같다.
- 바이어스는 "입력 1.0"을 int8로 127이라 보고 `bias·127`을 더한다.
- **scale의 뜻**: 메모리의 `scale[i]` = 파일에 저장된 double 값 / 127이고, float32로 저장한다. 근거: `weightmatrix.cpp:302-310`, 기록할 때 `×127`은 `253-260`.
  - 변환 원리(`weightmatrix.cpp:183-213`): 행마다 `S = max|w| / 127`, `w_q = round(w/S)`, 파일에는 S를 쓴다. 따라서 `v ≈ Σ (w_q·S)(u_q/127) + b_q·S`이고, 이는 실수 `W·u + b`의 근사다.
  - 행이 모두 0이면 파일 값 0, `w_q = 0`이다.
- 정확성: |u|, |w| ≤ 127이고 입력 수가 가장 많은 경우가 Lfx384 게이트(ni+1 = 481)다. 그래서 |total + 127·b| ≤ 481·127² ≈ 7.76M < 2²⁴이다. int → float 변환이 정확하고, JS에서 `Math.fround((total + b*127) * scaleF32)`가 C++ float 곱과 비트까지 같다.
- 입력을 int8로 바꾸는 시점: 각 층 출력을 NetworkIO에 쓸 때(`WriteTimeStep`)와 LSTM 재귀 입력을 넣을 때(`lstm.cpp:368`)다. 계산 중간값(게이트 값, c, h, 소프트맥스 입력)은 float32다.
- SIMD 경로는 가중치를 재배치(`IntSimdMatrix::Init`, `intsimdmatrix.cpp:27-72`)하고 입력을 패딩하지만, 정수합·바이어스·scale 처리는 같다. AVX2의 `maddubs` 16비트 포화는 |값| ≤ 127이라 일어나지 않는다(127·127·2 < 32767).

int 모드 데이터 흐름 요약:

| 단계 | 입력 표현 | 계산 | 출력 표현 |
|---|---|---|---|
| 그림 → Input | 회색 0..255 | 2.6 (×128) | int8 |
| Convolve | int8 | 복사 + 가장자리 난수 | int8 |
| ConvNL | int8 ×9 | MatVecI8 → Tanh | q8 → int8 |
| Maxpool | int8 | 최댓값 | int8 |
| LSTM ×4 | int8 + q8(h) | MatVecI8 ×4 → LUT → float32 c, h | q8 → int8 |
| Output | int8 ×384 | MatVecI8 → softmax | **float32** |

---

## 10. float32 재현 방법 (JS)

- `TFloat` 값(게이트, c, h, 소프트맥스 입력·출력, black, white, contrast, scale)은 모두 `Math.fround`로 감싼다. 이항 연산 하나마다 감싼다. 두 float32의 합·곱을 double로 계산한 뒤 `fround`하면 C++ float 연산과 같은 값이 된다.
- `Float32Array`에 대입하면 저절로 `fround`된다.
- `IntCastRounded(float)`는 `+0.5F`를 float32로 더한다. `Math.trunc(Math.fround(v + 0.5))`
- `Randomize`, `ile`는 double 경로이므로 `fround`를 쓰지 않는다.
- Leptonica 확대·축소의 `scx`·`scy`와 `scx*j`는 float32이고, `scx*(j+1.0)`(면적 평균의 끝점)과 `+0.5`는 double이다.
- **FMA 축약 주의**: 컴파일러가 `c + ci*gi` 같은 식을 FMA로 합치면(ARM64 기본, x86에서 `-mfma`·`-march=native`) Tesseract 빌드마다 마지막 비트가 다를 수 있다. 기본 x86-64 빌드는 FMA를 쓰지 않는다고 본다.

---

## 11. float 모델(best)과의 차이 (참고)

- 입력: `SetPixel`이 잘라내지 않는다. Convolve 난수는 `SignedRand(1.0)`이다.
- FullyConnected·LSTM: `MatrixDotVectorInternal`을 쓴다. `total = DotProduct(w_i, u, ni)` 뒤에 `+ w_i[ni]`(바이어스 × 1)이다. 일반 `DotProductGeneric`은 float32로 차례대로 더한다. 근거: `weightmatrix.cpp:99-111, 393-396`, `arch/simddetect.cpp:127-133`. SIMD판은 덧셈 순서가 달라 마지막 비트가 다를 수 있다.
- LSTM 재귀 입력을 양자화하지 않는다(`source_.ReadTimeStep`, `lstm.cpp:372-374`).

---

## 12. 전체 순전파 의사코드 (int 모드)

```js
const f = Math.fround;
const icrF = (v) => (v >= 0 ? Math.trunc(f(v + 0.5)) : -Math.trunc(f(-v + 0.5)));  // IntCastRounded(float)
const icrD = (v) => (v >= 0 ? Math.trunc(v + 0.5) : -Math.trunc(-v + 0.5));        // IntCastRounded(double)
const clip127 = (r) => (r < -127 ? -127 : r > 127 ? 127 : r);
const q8 = (x) => clip127(icrF(f(x * 127)));                                        // WriteTimeStep

// grey: Uint8Array H×W (H = 48, 2.3~2.4 처리 후)
function prepareInput(grey, W) {
  const H = 48, [black, white] = computeBlackWhite(grey, W, H);                     // 2.5 (double → f32)
  let contrast = f(f(white - black) / 2); if (contrast <= 0) contrast = 1;
  const x = new Int8Array(H * W);                                                   // t = y*W + x
  for (let t = 0; t < H * W; t++) x[t] = clip127(icrF(f(128 * f(f(f(grey[t] - black) / contrast) - 1))));
  return x;
}

function convolve(inp, H, W, rand8) {                                               // 5.1, ni = 1
  const out = new Int8Array(H * W * 9);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 9;
    for (let dx = -1; dx <= 1; dx++) {
      const base = o + (dx + 1) * 3, xx = x + dx;
      if (xx < 0 || xx >= W) { for (let k = 0; k < 3; k++) out[base + k] = rand8(); continue; }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        out[base + dy + 1] = (yy < 0 || yy >= H) ? rand8() : inp[yy * W + xx];
      }
    }
  }
  return out;
}

function matVecI8(Wq, scale, no, ni, u, uOff, out) {                                // 9절, Wq: Int8Array no×(ni+1)
  for (let i = 0; i < no; i++) {
    const r = i * (ni + 1); let tot = 0;
    for (let j = 0; j < ni; j++) tot += Wq[r + j] * u[uOff + j];
    out[i] = f((tot + Wq[r + ni] * 127) * scale[i]);                                // out: Float32Array
  }
}

// seqIn: Int8Array len*ni, 시퀀스 하나. order: 처리할 위치 목록(정방향이면 0..len-1, 역방향이면 len-1..0).
function lstmRun(L, seqIn, order, writeAll) {                                       // 7.1
  const { ni, ns, g } = L;                                                          // g[CI|GI|GF1|GO] = {Wq, scale}
  const c = new Float32Array(ns), h = new Float32Array(ns), src = new Int8Array(ni + ns);
  const z = [0, 1, 2, 3].map(() => new Float32Array(ns));
  const out = writeAll ? new Int8Array(seqIn.length / ni * ns) : new Int8Array(ns);
  for (const t of order) {
    src.set(seqIn.subarray(t * ni, t * ni + ni), 0);
    for (let i = 0; i < ns; i++) src[ni + i] = q8(h[i]);
    for (let k = 0; k < 4; k++) matVecI8(g[k].Wq, g[k].scale, ns, ni + ns, src, 0, z[k]);
    for (let i = 0; i < ns; i++) {
      const ci = tanhLut(z[0][i]), gi = logiLut(z[1][i]), gf = logiLut(z[2][i]), go = logiLut(z[3][i]);
      let s = f(c[i] * gf); s = f(s + f(ci * gi)); c[i] = s < -100 ? -100 : s > 100 ? 100 : s;
      h[i] = f(tanhLut(c[i]) * go);
    }
    if (writeAll) for (let i = 0; i < ns; i++) out[t * ns + i] = q8(h[i]);
  }
  if (!writeAll) for (let i = 0; i < ns; i++) out[i] = q8(h[i]);                    // SUMMARY: 마지막만
  return out;
}
```

조립 순서:

1. `prepareInput` (48×W×1)
2. `convolve` (난수: 4절)
3. ConvNL: t마다 `matVecI8` → `tanhLut` → `q8` (48×W×16)
4. Maxpool 3×3/3 (16×W'×16)
5. Lfys64: x'마다 열 `[in[0][x'], …, in[15][x']]`(16칸, 위→아래)를 `lstmRun(..., writeAll=false)`에 넣어 `seq1[x']`를 얻는다.
6. Lfx96: `lstmRun(seq1, 0..W'-1, true)`
7. Lrx96: `lstmRun(seq2, W'-1..0, true)` (결과는 원래 위치에 저장)
8. Lfx384: `lstmRun(seq3, 0..W'-1, true)`
9. Output: x'마다 `matVecI8` → softmax(8절) → `probs[x'][K]`

---

## 13. 구현할 때 틀리기 쉬운 점

1. **입력층만 ×128**이다. 나머지 층은 int8을 ×127로 쓰고 /127로 읽는다. 입력도 127로 바꾸면 모든 값이 약 0.8% 작아진다.
2. **Convolve 가장자리는 0이 아니라 난수**다. 시드는 `sample_iteration_ * 0x10000001`이고 한 번 버린 상태에서 시작한다. 위→아래, 왼→오 순서이고, x 오프셋이 밖이면 3개씩 쓴다. 0으로 채우면 가장자리 열의 확률이 Tesseract와 조금 달라진다.
3. **Convolve 특징 순서는 열 우선**이다(k = 3(dx+1) + (dy+1)). 행 우선(3(dy+1)+(dx+1))으로 모으면 ConvNL 가중치와 어긋난다.
4. **극성**: 어두운 글자가 −1이다. 흰 글자·검은 바탕이면 자동 반전(2.8)이 필요하다.
5. **대비 정규화는 가운데 행 하나의 지역 극값만 쓴다.** 그림 전체 최소·최대가 아니다. `ile`은 보간된 실수다(값 v만 있으면 v+0.25, v+0.75).
6. **회색 변환은 확대·축소 뒤**에 한다(컬러 입력일 때). 가중치는 0.3/0.5/0.2이고 BT.601(0.299/0.587/0.114)이 아니다.
7. **확대·축소는 Leptonica 알고리즘**이다. 배율 < 0.7은 면적 평균, 0.7 ≤ f < 1.4는 쌍선형 + 선명화, 0.5·0.25 같은 정확한 값과 2·4배는 특수 경로다. 0.2 < f < 0.7(1.84.1 기준)과 0.7 ≤ f < 1.4에서는 선명화(unsharp)가 붙는다. 브라우저 `drawImage` 스케일링으로는 비트 일치가 안 된다.
8. **너비 W**: 일반 경우 `trunc(fround(f·ws) + 0.5)`, 0.5배 특수 경로는 `⌊ws/2⌋`다.
9. **Maxpool 나머지 열은 버린다**: W' = ⌊W/3⌋. 출력 시간축 길이도 W'다.
10. **Lfys64는 위→아래로 돌고 마지막(맨 아래) 출력만 남긴다.** 열마다 상태를 0으로 시작한다.
11. **Lrx96의 출력은 원래 위치에 둔다.** 뒤집힌 순서로 저장하면 Lfx384 입력이 어긋난다.
12. **LSTM 재귀 입력도 int8로 양자화**한다(`q8(h)`). 셀 상태 c는 float32 그대로 두고 ±100으로만 자른다.
13. **LSTM 입력 벡터 순서는 [입력 | 직전 출력]**이고 바이어스는 마지막 열이다. 게이트 파일 순서는 CI, GI, GF1, GO다.
14. **scale은 파일 값 / 127**이다. 바이어스 항은 `W[i][ni]·127`이다.
15. **tanh·logistic은 LUT 선형보간**이다. `Math.tanh`를 바로 쓰면 비트 일치가 안 된다. |x| ≥ 4095/256이면 ±1(logistic은 0 또는 1)로 포화한다.
16. **float32**: `Math.fround`를 빠뜨리면 LSTM 수백 단계에서 오차가 쌓인다. `IntCastRounded(float)`의 +0.5도 float32 덧셈이다.
17. 소프트맥스는 `max`를 빼고 `[-86, 0]`으로 자른 뒤 `exp`를 한다. 합이 0보다 클 때만 나눈다.

---

## 14. 확인 못 한 점

1. **Leptonica 버전**: 1.84.1 원본으로 확인했다. Tesseract 5.5.3이 실제로 링크한 Leptonica(배포판·tesseract.js 등)가 다르면 선명화 조건(특히 `maxscale > 0.2`인 축소 선명화)이나 가장자리 처리가 다를 수 있다. 비교 대상 빌드의 Leptonica 버전을 확인해야 한다.
2. **컬러 면적 평균**(`scaleColorAreaMapLow`)과 컬러 2·4배 특수 경로는 채널별로 같다고만 보고 줄 단위로 대조하지 않았다. Tesseract와 비교할 때는 **8bpp 회색 그림을 넣는 것**이 안전하다.
3. **`expf` 대 `Math.exp`**: C 라이브러리의 `expf`는 올바른 반올림이 보장되지 않는다. `fround(Math.exp(x))`와 1ulp 다를 수 있다. 확률의 마지막 비트에만 영향이 있다.
4. **FMA 축약·컴파일러 차이**: 빌드(ARM64, `-march=native`, MSVC)마다 float32 마지막 비트가 다를 수 있다. 원본을 빌드·실행하지 않았으므로 실제 출력과의 비트 비교는 하지 못했다.
5. **이 모델의 실제 직렬화 내용**: 층 트리는 망 기술 문자열과 `networkbuilder.cpp`로 추정했다. 파일 안의 층 순서·이름·`no_`(K)·`sample_iteration_`·`training_flags_`(int 모드 여부)는 파일 형식 담당의 결과로 확인해야 한다. 특히 int 모드가 아니면(float 모델) 11절 경로가 된다.
6. **`TFloat = double` 빌드**(`--disable-float32`)이면 scale도 double이고 모든 중간값이 double이다. 비교 대상 Tesseract가 기본 빌드(float)인지 확인해야 한다.
7. **2.1절(페이지에서 글줄 자르기)**은 레이아웃 분석 결과(기준선, ascender/descender)에 달려 있어 JS에서 같은 상자를 얻는 방법은 다루지 않았다.
8. 디코딩(`RecodeBeamSearch`, 사전, recoder 코드 → 글자)은 범위 밖이다.

---

## 15. 근거 파일 목록

Tesseract 5.5.3 (`tmp-debug/ocr/src/tesseract-5.5.3/src/`)

- `lstm/lstmrecognizer.cpp`, `lstm/lstmrecognizer.h` — RecognizeLine, SetRandomSeed, OutputStats
- `lstm/input.cpp` — PrepareLSTMInputs, PreparePixInput
- `ccstruct/imagedata.cpp`, `ccstruct/imagedata.h` — PreScale, kImagePadding
- `ccmain/linerec.cpp`, `ccmain/tesseractclass.h`, `ccmain/tesseractclass.cpp` — 글줄 자르기, BestPix, 반전 매개변수
- `lstm/networkio.cpp`, `lstm/networkio.h` — 배치, SetPixel, 양자화, 대비 정규화
- `lstm/stridemap.cpp`, `lstm/stridemap.h` — t 정의
- `ccstruct/statistc.cpp` — STATS::ile, mean
- `ccutil/helpers.h` — TRand, IntCastRounded, ClipToRange
- `lstm/convolve.cpp`, `lstm/maxpool.cpp`, `lstm/reconfig.cpp`
- `lstm/fullyconnected.cpp`, `lstm/weightmatrix.cpp`, `arch/intsimdmatrix.cpp`, `arch/intsimdmatrixavx2.cpp`, `arch/simddetect.cpp`, `arch/dotproduct.cpp`
- `lstm/lstm.cpp`, `lstm/lstm.h`, `lstm/reversed.cpp`, `lstm/series.cpp`, `lstm/plumbing.cpp`, `lstm/network.cpp`, `lstm/network.h`, `lstm/networkscratch.h`
- `lstm/functions.h`, `lstm/functions.cpp`, `lstm/generate_lut.py`
- `ccutil/tesstypes.h`, `../CMakeLists.txt`, `../configure.ac`
- `training/common/networkbuilder.cpp`, `training/unicharset/lstmtrainer.cpp`

Leptonica 1.84.1 (`src/`): `scale1.c`, `enhance.c`, `pixconv.c`, `pix.h`
