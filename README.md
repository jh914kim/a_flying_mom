# flying mom (비행하는 엄마)

승무원 가족을 위한 밝고 단정한 비행 스케줄 및 현재 위치·날씨·달력 웹 서비스입니다.  
사용자가 스케줄표(사진, 텍스트)를 등록하면 현재 예상 위치, 현지 시각 및 날씨, 다음 여정, 월별 비행 달력을 한눈에 확인할 수 있습니다.

---

## 🌟 핵심 특징

1. **완전한 클라이언트 독립형 (Zero Backend / Zero Auth)**
   - 백엔드, 데이터베이스, 회원가입, 로그인, 외부 계정 연동 없이 동작합니다.
   - 모든 일정은 브라우저의 `localStorage`에만 저장되며, 외부 서버로 일정이나 사진이 전송되지 않습니다.
   - 브라우저의 `storage` 이벤트를 감지하여 동일 브라우저 내 다른 탭에서도 실시간으로 변경 사항이 동기화됩니다.

2. **Google Flights 스타일의 밝고 단정한 UI**
   - 흰색 바탕, 밝은 파란색 강조, 얇은 회색 테두리, 둥근 모서리 카드, 간결한 아이콘 구성.
   - 모바일 우선(Mobile-First): 320px, 390px, 430px 등 다양한 모바일 기기에서 가로 스크롤 없이 부드럽게 동작합니다.
   - 터치 영역 $\ge 44\text{px}$, 입력 폰트 $\ge 16\text{px}$ (모바일 사파리 자동 확대 방지).

3. **화면 구성 및 순서**
   - **① 헤더**: 서비스명 `flying mom`, `일정 관리` 버튼.
   - **② 현재 상태·시각·날씨 통합 카드**:
     - 집에 있을 때: "엄마는 집에 있어요"
     - 해외 체류 시: "엄마는 지금 런던에 있어요"
     - 비행 중일 때: "엄마는 런던으로 날아가고 있어요" (도착지 기준 날씨 명시)
     - 현지 날짜/시각, 해외일 경우 한국 시각(KST), Open-Meteo 실시간 기온/아이콘/설명/갱신시각 통합.
   - **③ 컬러 지도 (OpenFreeMap + MapLibre GL JS + Leaflet)**:
     - 현재 지도는 **OpenFreeMap**을 사용했습니다 (구글 지도가 아닙니다).
     - **지도 데이터:** OpenStreetMap 기반 데이터를 OpenFreeMap에서 제공받습니다.
     - **화면 표시:** Leaflet과 MapLibre GL JS를 함께 사용합니다.
     - **지도 디자인:** Positron 스타일을 수정해 컬러를 적용하고, 상세 도로·건물을 줄여 도시 중심으로 표시했습니다.
     - **한국어 지명:** 한국어 이름을 우선 표시하고, 한국어가 없는 지명은 생략합니다.
     - **연결 실패 시:** 앱에 포함한 Natural Earth 세계 윤곽 지도를 배경으로 사용합니다. 별도의 지도 API 키는 필요 없습니다.
     - **엄마의 위치 핀과 비행 경로:** 지도 업체에서 받는 정보가 아니라, **등록한 스케줄을 기준으로 앱에서 계산해 표시**합니다.
     - 대권 경로(Great Circle) 비행 진행률 표시 및 날짜변경선(180° 자오선) 태평양 횡단 경로 왜곡 없는 분할 렌더링.
     - 지도 위 통합 뱃지 ("엄마는 집에 있어요 · 다음 일정 · 도쿄 (NRT)"), 세계 보기/현재 위치 버튼.
   - **④ NEXT JOURNEY / CURRENT JOURNEY 카드**:
     - 한국 출발부터 귀국까지 하나의 여정(예: `ICN ➔ LHR ➔ ICN`) 추적 (한국 시각 KST 기준).
     - 출국 전 `NEXT JOURNEY`, 출국 후 `CURRENT JOURNEY`, 귀국편 미등록 시 경고 안내.
   - **⑤ 비행 달력 & ⑥ 비행 목록**:
     - 이전/다음 달 이동, 오늘 강조, 비행 날짜 및 해외 체류 날짜 표시.
     - 날짜별 비행 목록 및 상세 조회, '더 보기' 접기/펼치기 지원.
   - **하단 네비게이션 (모바일)**:
     - `현재 위치`, `비행 달력`, `일정 관리` 3개 탭 지원.

4. **위치 및 시간대 계산 규칙**
   - 실제 GPS가 아닌 등록된 비행 스케줄을 기반으로 위치를 추정합니다.
   - 인천(ICN)과 김포(GMP)는 동일한 수도권 거점("집")으로 취급하며, 거점 위치·날씨·시간은 **과천**(37.4292, 126.9876, Asia/Seoul)을 기준으로 계산합니다.
   - 전 세계 4,031개 상용 IATA 공항의 위도·경도·도시·국가 및 IANA 표준 시간대(`Asia/Seoul`, `Europe/London`, `America/New_York` 등)와 일광절약시간제(서머타임)를 정적 파일(`js/airports.js`, `data/airports.json`)로 내장하여 외부 공항 API 호출 없이 즉시 반영합니다 (내부 계산은 UTC, 표시는 현지 시각).
   - **공항 데이터 출처 및 라이선스**:
     - **OurAirports** (`https://ourairports.com/data/`) — Public Domain (Unlicense)
     - **OpenFlights Airport Database** (`https://openflights.org/data.html`) — Open Database License (ODbL) 1.0 / Public Domain
     - **mwgg/Airports** (`https://github.com/mwgg/Airports`) — MIT License

5. **강력한 스케줄 관리 및 브라우저 PaddleOCR 엔진**
   - 사진을 서버나 외부 AI로 전송하지 않고 API 키 없이 브라우저 내에서 실행합니다.
   - 사진 선택 시에만 **ONNX Runtime Web (1.20.1, WASM)** 및 정적 포함된 **PaddleOCR (`ch_PP-OCRv4_rec_infer.onnx`, `ppocr_keys_v1.txt`)** 모델을 지연 로딩(Lazy Loading)합니다 (`import.meta.url` 기준 상대 경로로 하위 경로 배포 지원).
   - 표의 회색 가로선·세로선을 검출해 휴대폰 상·하단 UI와 웹 메뉴를 제외하고 `DATE`, `FLIGHT`, `SHOWUP`, `SECTOR`, `STD`, `STA` 6개 열의 각 셀을 분리하여 인식합니다.
   - 각 셀에서 `RGB 평균 < 200` 기준 글자 경계 상자(bbox)를 찾아 여백을 추가한 뒤 `[1, 3, 48, 320]`(`float32`, NCHW, `pixel/127.5 - 1`)로 정규화하고 CTC 방식으로 해독합니다.
   - **SHOWUP(집합시각)을 출발 시각으로 사용하지 않음!** (항상 STD 출발 시각·STA 도착 시각 기준)
   - 같은 날 왕복(병합된 DATE 셀), 다음 날 도착, 작은 파란 편명(파란색 획 강조 전처리 비교), 붙어있는 공항 코드(`ICNNRT` 및 `ICN/NRT`), 문장부호가 섞인 6자리 시각(`04 04:2.5`) 처리.
   - 불확실한 항목(평균 점수 `< 0.95`, 후보 불일치, 공항 검증 실패, 날짜·시각 누락)은 노란색으로 강조 표시하며, 숫자가 부족하거나 불확실한 데이터를 임의로 추측해 채우지 않습니다.
   - "공항, 출발·도착 날짜와 시간 기준을 확인했어요" 확인란 체크 후에만 등록 가능.

---

## 📁 프로젝트 구조

```text
c:\work\aflyingmom\
├── index.html              # 메인 웹앱 단일 진입점 (상대 경로 참조)
├── css\
│   └── style.css           # Google Flights 스타일 및 모바일 반응형 디자인
├── data\
│   └── airports.json       # 전 세계 4,031개 상용 IATA 공항 정적 JSON 데이터 (출처·라이선스 포함)
├── models\
│   ├── ch_PP-OCRv4_rec_infer.onnx # PaddleOCR 브라우저 문자 인식 모델
│   └── ppocr_keys_v1.txt   # PaddleOCR 문자 사전 (6,623줄)
├── js\
│   ├── airports.js         # 전 세계 4,031개 IATA 공항 데이터베이스 & 과천 거점 모듈
│   ├── timezone.js         # IANA 시간대, 서머타임(DST), UTC 변환 유틸리티
│   ├── storage.js          # localStorage 월별 저장, 검증, 다중 탭 동기화, 백업/복원
│   ├── location-engine.js  # 상태 판별, 대권 항로 보간, 비행 진행률 계산
│   ├── journey.js          # 한국 입출국 기반 NEXT/CURRENT JOURNEY 생성
│   ├── weather.js          # Open-Meteo 날씨 조회 및 10분 캐싱
│   ├── map.js              # Leaflet 지도, 지연 로딩, 핀 및 비행기 렌더링
│   ├── ocr.js              # 브라우저 전용 사진 OCR 및 스케줄 텍스트 파서
│   ├── calendar.js         # 비행 달력, 체류일 계산, 일별 목록
│   ├── manager.js          # 전체화면 일정 관리 모달, 자동완성, 오류 강조
│   └── app.js              # 앱 부트스트랩, 실시간 타이머, 하단 네비게이션
├── assets\                 # 정적 리소스 디렉터리
├── dist\                   # 배포용 정적 폴더 (index.html이 루트에 위치)
└── aflyingmom-deploy.zip   # Cloudflare Pages / Netlify 원클릭 배포 ZIP
```

---

## 🚀 로컬 실행 방법

이 프로젝트는 빌드 과정이나 `npm install` 패키지 설치가 필요 없는 순수 HTML/CSS/JS 정적 웹앱입니다.

### 방법 1. Python 내장 웹 서버 사용 (권장)
터미널 또는 PowerShell에서 프로젝트 디렉터리로 이동한 후 실행합니다:
```bash
cd c:\work\aflyingmom
python -m http.server 8080
```
브라우저에서 `http://localhost:8080` 으로 접속합니다.

### 방법 2. VS Code Live Server 사용
VS Code에서 `c:\work\aflyingmom` 폴더를 열고 `index.html` 우클릭 -> **"Open with Live Server"** 클릭.

---

## ☁️ 배포 방법

내부 리소스가 모두 상대 경로(`./css/style.css`, `./js/app.js` 등)로 작성되어 있어 루트 도메인뿐만 아니라 **하위 경로(Subpath)**에 배포해도 문제없이 작동합니다.

### 1. Cloudflare Pages 배포
1. [Cloudflare 대시보드](https://dash.cloudflare.com/)에 로그인합니다.
2. **Workers & Pages** -> **Create application** -> **Pages** 탭을 선택합니다.
3. **Direct Upload (직접 업로드)**를 선택합니다.
4. 프로젝트 이름을 `aflyingmom`으로 입력합니다.
5. `dist` 폴더를 드래그 앤 드롭하거나 `aflyingmom-deploy.zip`의 압축을 풀어 해당 폴더를 업로드합니다.
6. **Deploy site**를 클릭하면 즉시 전 세계 CDN을 통해 서비스가 활성화됩니다.

### 2. Netlify 배포
1. [Netlify 대시보드](https://app.netlify.com/)에 로그인합니다.
2. **Sites** 메뉴로 이동합니다.
3. 페이지 하단의 **"Want to deploy a new site without connecting to Git? Drag and drop your site output folder here"** 영역으로 `dist` 폴더를 끌어다 놓습니다.
4. 업로드 완료 즉시 공개 URL이 발급됩니다.

---

## 🧪 자체 검증 및 테스트 결과

| 항목 | 검증 기준 | 결과 |
| :--- | :--- | :---: |
| **로그인 없는 실행** | 별도 계정 생성 없이 접속 즉시 사용 가능 | **PASS** |
| **정적·하위 경로 배포** | 상대 경로 참조로 도메인 하위 경로에서도 정적 로드 정상 동작 | **PASS** |
| **새로고침 후 유지** | `localStorage`에 월별 영구 보존되어 새로고침 후에도 유지 | **PASS** |
| **브라우저별 독립 저장** | 타 기기·타 브라우저로 데이터가 전송되지 않는 로컬 저장소 원칙 준수 | **PASS** |
| **다중 탭 변경 반영** | `window.onstorage` 이벤트를 통한 다중 탭 실시간 동기화 | **PASS** |
| **월별 추가·교체·삭제** | 10월 등록 후 11월 추가 시 10월 유지, 11월 재등록 시 11월만 원자적 교체 | **PASS** |
| **백업 및 복원** | JSON 내보내기/불러오기 지원, 손상된 파일 부분 저장 원천 차단 | **PASS** |
| **OCR 파싱 신뢰성** | SHOWUP 출발시간 미사용, ICNNRT/0409:00 분리, Merged row 날짜 보존, 노란색 강조 | **PASS** |
| **사진·일정 보안** | 사진 및 일정을 서버로 일절 전송하지 않음 | **PASS** |
| **상태 전환** | 집(과천) ➔ 비행 중 ➔ 해외 체류 ➔ 집 상태 전환 및 날짜변경선 경로 보정 | **PASS** |
| **시간대 & 날씨** | IANA 시간대 반영, Open-Meteo 10분 캐싱, 실패 시 '확인 불가' 표시 | **PASS** |
| **모바일 반응성** | 320px, 390px, 430px 가로 스크롤 없음, 터치 영역 $\ge 44\text{px}$, 폰트 $\ge 16\text{px}$ | **PASS** |

