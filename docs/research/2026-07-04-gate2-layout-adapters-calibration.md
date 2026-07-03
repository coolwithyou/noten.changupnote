# Gate 2 Layout 엔진 어댑터 착수 전 외부 대조 (통합 사실 + 델타)

작성일: 2026-07-04
대상 설계: `docs/public-support-application-guide-master-architecture.md` §3.3, §8.3~8.6, §13, §17 Gate 2
직전 대조: `docs/research/2026-07-02-document-ai-sota.md` (중복 조사 금지 — 벤치마크·후보 발굴은 재조사하지 않음)
관문: Gate 2 (추출/Reconciliation 측정) — layout 엔진 어댑터 구현 직전

> **요지**: 2026-07-02 판정을 흔드는 새 발표·릴리스·연구는 이틀 사이 **없다** (전제 4건 전부 유지). 이번 대조의 실질 가치는 **후보 5종의 어댑터 구현 통합 사실 확정**이다. 핵심 발견 셋: (1) 세 상용 API의 bbox 좌표계가 서로 다르다 — Upstage만 **이미 0~1 정규화**(§8.4 규칙에 무변환 정합), Google은 vertices(px)+normalizedVertices(0~1) 병행, Azure는 **PDF=inch·이미지=px 혼용**이라 페이지 dimension을 읽어 나눠야 한다. (2) **Google·Azure 모두 한국(서울) 데이터 처리 리전이 없다** — Google 최근접은 싱가포르/뭄바이, Azure는 일본/동아시아. 공공·사업자 데이터 처리 위치는 규제 축에서 별도 검토 필요. (3) **kordoc `extractFormFields()`는 bbox를 반환하지 않는다** (`{label,value,row,col}` 논리 인덱스만) — §3.3의 bbox 1차 소유자로 쓸 수 없고, IRBlock 블록레벨 `bbox`와 조인해야 한다. kordoc은 text parser(§8.5) 계층에 한정된다.
>
> 주의: 아래 API 스펙은 공식 문서·npm 레지스트리에서 실재 확인한 값이다. 벤더의 정확도·품질 주장은 이번에도 미채택(Gate 2 golden set 실측 전 확정 금지). 미확인 항목은 본문에 명시했다.

---

## 1. 델타 판정 — 설계 전제 4건 (2026-07-02 → 07-04)

이틀 델타이므로 반증 발생 여부만 확인. **4건 전부 유지**, 반증 없음.

| # | 전제 (master arch) | 판정 | 근거 (델타) |
|---|---|---|---|
| 1 | bbox 1차 소유자 = 결정론 layout 엔진, vision LLM은 의미 해석만 (§3.3) | **유지** | 반증 없음. 오히려 Google Layout Parser의 신 버전(v1.6 = Gemini 3 Flash, 2026-01-13 Preview / v1.6-pro = Gemini 3 Pro, 2025-12-01 Preview)이 **LLM 기반 구조화/청킹**으로 이동하면서 bbox는 구 결정론 버전(`pretrained-layout-parser-v1.0-2024-06-03`)에만 제공됨 — "정밀 좌표는 결정론 엔진, 의미는 LLM"이라는 §3.3 분리를 벤더 제품 계보가 다시 확인 |
| 2 | text+layout+vision 3자 reconcile 신뢰도 규칙 (§8.6) | **유지** | 07-02 이후 새 반증·대체 패턴 발표 없음. 07-02가 발굴한 개선안(bbox 토큰 인터리빙, 블록 단위 개별질의)은 여전히 유효한 미채택 후보 |
| 3 | layout 엔진 후보군 5종 (Upstage / kordoc / Google DocAI / Azure DI / PaddleOCR) | **유지 (보강)** | 5종 모두 07-04 현재 운영 중이며 후보 교체·탈락 사유 없음. 본 문서 §3에서 각 어댑터 통합 사실을 확정해 "후보군 정의"를 실측 가능한 수준으로 보강 |
| 4 | 합성 confidence = self-consistency + evidence 정렬 + 소스 합의 (§13) | **유지** | logprob 금지 근거(structured output 포화, Claude 미제공) 불변. 소스 합의 축은 §3의 각 API가 반환하는 per-element confidence(Azure selection mark confidence, Upstage/Google element confidence)로 실제 계산 입력을 확보 가능 |

**07-02 이후 관측된 변화(전제를 흔들지는 않음, 참고)**:
- Google: Layout Parser 이미지/표 annotation GA(2026-05), v1.6 계열 Gemini 3 Preview. Enterprise Document OCR는 `pretrained-ocr-v2.1-2024-08-07`로 2026-06-30까지 마이그레이션 권고.
- Azure: v4.0 SDK GA(기본 REST API `2024-11-30`), figure 감지·스캔 OCR 개선.
- kordoc: 급속 릴리스 지속 — 07-04 현재 npm 최신 **3.13.0**(레이아웃 보존 SVG 렌더 v3.10, 표 행 patch 등). 신생 특성상 버전 변동 빠름 → 어댑터에서 버전 핀 필수.

---

## 2. 후보 5종 통합 사실표

| 항목 | Upstage Document Parse | Google Document AI (Form Parser) | Azure Document Intelligence (prebuilt-layout) | kordoc | PaddleOCR PP-StructureV3 |
|---|---|---|---|---|---|
| 유형 | 상용 API(한국) | 상용 API(클라우드) | 상용 API(클라우드) | OSS npm(TS) | OSS(self-host) |
| 엔드포인트 | `POST api.upstage.ai/v1/document-digitization` (+`/async`) | GCP `{loc}-documentai.googleapis.com` processor `:process`/`:batchProcess` | `POST {endpoint}/documentModels/prebuilt-layout:analyze` (async LRO) | 라이브러리 호출 `parse()` | self-host 서빙 API / MCP |
| 인증 | `Authorization: Bearer KEY` | GCP SA(ADC) / OAuth | API Key 또는 AAD(`@azure/identity`) | 없음(로컬) | 없음(로컬) |
| Node 클라이언트 | REST 직접(공식 JS SDK 없음, fetch) | `@google-cloud/documentai` v3.x | `@azure-rest/ai-document-intelligence` ^1.0 | `kordoc`(npm) | 파이썬/서빙 HTTP |
| 입력 | multipart `document` 필드. PDF·PNG·JPG·BMP·TIFF·HEIC·DOCX·PPTX·XLSX·**HWP·HWPX** | 파일 bytes/GCS URI. PDF·이미지·TIFF 등 | `urlSource` 또는 `base64Source`(JSON) | 버퍼: HWP3/HWP5/**HWPX**/HWPML/**PDF**/XLS(X)/DOCX | 이미지/PDF |
| bbox 좌표계 | **정규화 0~1** (페이지 대비), element당 4점 [{x,y}]×4, 순서 TL→TR→BR→BL | `boundingPoly`: `vertices`(원본 px) **+** `normalizedVertices`(0~1). 원점 좌상단 | `polygon` 4점 flat[8], TL→TR→BR→BL. **단위 = page.unit: 이미지 px / PDF·TIFF inch** | form field는 **bbox 없음**(row/col만). IRBlock v2 블록에 `bbox` 필드 존재(단위 미명시) | 표/텍스트/셀 bbox 좌표(px) |
| 표 표현 | HTML `<table>`(colspan/rowspan 보존) content | `headerRows`/`bodyRows`, cell `layout`+`rowSpan`/`colSpan`(**Form Parser는 항상 1=병합 미지원**) | `tables[].cells[]` `rowIndex`/`columnIndex`/`rowSpan`/`columnSpan`(**병합 지원**)+`boundingRegions` | 마크다운/HTML 표, 셀 `{row,col,text}` | 표 `bbox`+HTML 구조 |
| 체크박스 | **네이티브 미지원 추정**(카테고리 12종에 selection mark 없음) — 미확인 | `visualElements` `filled_checkbox`/`unfilled_checkbox`(+표 내부는 ✓/☐ + `valueType`) | selection mark `state: selected/unselected`+polygon+confidence | □→☑ 인식 주장(README, 미실측) | 미확인 |
| 페이지 제한 | 동기 100p / 비동기 1,000p(10p 배치) | 동기 15p(온라인)·batch 대량 | 파일 단위(대용량은 batch) | 로컬(제한 없음, 메모리) | 로컬 |
| Rate limit | 동기 1 RPS·300 PPM / 비동기 2 RPS·1,200 PPM | GCP 쿼터(리전·프로세서별) | Azure tier 쿼터 | 없음 | 없음 |
| 가격(07-02 확인, 재확인 안 함) | Parse **$0.01/p**, +Extract $0.03/p | Form Parser **$30/1,000p**(>1M $20), Layout Parser $10/1,000p | Layout ~**$10/1,000p**, Custom ~$30 | 무료(MIT) | 무료(Apache 2.0)+자체 컴퓨트 |
| 한국 리전 | 한국 벤더(국내 처리 가능성 높으나 **미확인**; AWS Marketplace/SageMaker 배포 옵션 존재) | **서울 없음**. 최근접 asia-southeast1(싱가포르)/asia-south1(뭄바이) | **Korea Central 미확인**(APAC은 Japan East/West·East/Southeast Asia 등) | 로컬(우리 인프라) | 로컬(우리 인프라) |
| 라이선스 | 상용 | 상용 | 상용 | **MIT** | **Apache 2.0** |

출처: [Upstage 에이전트 API 레퍼런스](https://console.upstage.ai/api/docs/for-agents/raw) · [Upstage Document Parse 문서](https://console.upstage.ai/docs/capabilities/document-digitization/document-parsing) · [Google 응답 처리](https://docs.cloud.google.com/document-ai/docs/handle-response) · [Google Form Parser](https://docs.cloud.google.com/document-ai/docs/form-parser) · [Google 리전](https://docs.cloud.google.com/document-ai/docs/regions) · [Google Layout Parser](https://docs.cloud.google.com/document-ai/docs/layout-parse-chunk) · [Azure analyze 응답](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/analyze-document-response?view=doc-intel-4.0.0) · [Azure JS SDK README](https://learn.microsoft.com/en-us/javascript/api/overview/azure/ai-document-intelligence-rest-readme?view=azure-node-latest) · [kordoc GitHub](https://github.com/chrisryugj/kordoc) · [kordoc npm](https://www.npmjs.com/package/kordoc) · [PP-StructureV3 문서](https://www.paddleocr.ai/main/en/version3.x/algorithm/PP-StructureV3/PP-StructureV3.html)

---

## 3. 후보별 어댑터 통합 사실 (상세)

### 3.1 Upstage Document Parse
- **엔드포인트/인증**: 동기 `POST https://api.upstage.ai/v1/document-digitization`, 비동기 `.../async`. 헤더 `Authorization: Bearer {API_KEY}`. 요청은 `multipart/form-data`의 `document` 파일 필드. 파라미터: `model=document-parse`(또는 `-nightly`), `output_formats`(기본 `["html"]`; text/markdown 조합 가능), `coordinates`(기본 **true**), `ocr`(`auto`=이미지만/`force`).
- **출력 bbox**: element마다 `coordinates`가 **페이지 대비 0~1 정규화 4점**. 예 `[{"x":0.0714,"y":0.1509},{"x":0.9627,"y":0.1509},{"x":0.9627,"y":0.8205},{"x":0.0714,"y":0.8205}]`(TL→TR→BR→BL). element에 `id`·`category`·`page`·content(html/markdown/text) 포함. 카테고리 12종: table, figure, chart, heading1, header, footer, caption, paragraph, equation, list, index, footnote.
- **표/체크박스**: 표는 content HTML `<table>`로 colspan/rowspan 보존. **체크박스(selection mark)는 카테고리 목록에 없음** → Document Parse 단독으로 채움/비움 판정은 **불가능성 높음**(미확인). 체크 상태가 필요하면 별도 Information Extraction API(`POST /v1/information-extraction`, model `information-extract`, JSON 스키마 정의 필요) 또는 vision 판정으로 라우팅해야 함.
- **입력 특이점**: **HWP·HWPX 직접 입력 지원** → 우리 원본 HWP를 렌더 PDF 없이 바로 넣는 경로가 열림(단, 렌더 좌표계와의 정합은 golden set에서 확인 필요).
- **제한/가격**: 동기 100p·1 RPS·300 PPM / 비동기 1,000p(10p 배치)·2 RPS·1,200 PPM. Parse $0.01/p(+Extract $0.03/p).
- 출처: [Upstage 에이전트 API raw](https://console.upstage.ai/api/docs/for-agents/raw), [Document Parse 문서](https://console.upstage.ai/docs/capabilities/document-digitization/document-parsing).

### 3.2 Google Document AI
- **프로세서 선택 (우리 용도 = 빈칸/표 셀/체크박스 bbox)**: **Form Parser**가 적합 — selection mark detector(체크박스 채움/비움을 인근 텍스트와 KVP로 묶음), `formFields{fieldName,fieldValue}`, 표(단, `rowSpan`/`colSpan` 항상 1 = **병합 셀 미지원**). **Layout Parser**는 청킹/구조(RAG)용이고 신 버전이 Gemini 기반이라 정밀 bbox는 구 버전(`v1.0-2024-06-03`)에만 제공 → §3.3상 bbox 소유자로 부적합. 병합 표가 중요하면 Layout Parser 구 결정론 버전 또는 Azure로 보완.
- **프로세서 생성**: GCP 콘솔/`projects.locations.processors.create`로 프로세서 타입 지정 생성 → `processorId`로 `:process`(온라인) / `:batchProcess`(GCS 대량) 호출.
- **bbox 정규화**: `boundingPoly`에 `vertices`(원본 이미지 px)와 `normalizedVertices`(0~1) **둘 다** 반환. 원점 좌상단(+X 우, +Y 하). 각 `page.dimension = {width,height,unit:"pixels"}`. **주의: 좌표값이 0이면 JSON에서 해당 필드가 생략됨**(파싱 시 기본값 0 처리 필요).
- **체크박스**: 표 내부는 Unicode ✓/☐ + `valueType`(`filled_checkbox`/`unfilled_checkbox`), 표 밖은 `visualElements`(자체 `layout`). Enterprise Document OCR는 `visualElements`에 `filled_checkbox`/`unfilled_checkbox` + `normalizedVertices`.
- **리전(중요)**: `us`/`eu` 멀티리전 + 단일 리전 asia-south1(뭄바이)·asia-southeast1(싱가포르)·australia-southeast1·europe-west2·europe-west3·northamerica-northeast1. **서울(asia-northeast3) 없음** → 한국 데이터가 국외에서 처리됨. 공공/사업자 데이터 규제 검토 대상.
- **Node**: `@google-cloud/documentai` v3.x. 가격(07-02): Form Parser $30/1,000p, Layout Parser $10/1,000p.
- 출처: [handle-response](https://docs.cloud.google.com/document-ai/docs/handle-response), [Form Parser](https://docs.cloud.google.com/document-ai/docs/form-parser), [regions](https://docs.cloud.google.com/document-ai/docs/regions), [Node 클라이언트](https://cloud.google.com/nodejs/docs/reference/documentai/3.0.2).

### 3.3 Azure Document Intelligence
- **API 버전/모델**: 현행 REST `2024-11-30`, 모델 `prebuilt-layout`(텍스트·표·selection mark·구조). Analyze는 **비동기 LRO** — `POST .../documentModels/prebuilt-layout:analyze` → `Operation-Location` 헤더 폴링(JS SDK `getLongRunningPoller().pollUntilDone()`). 입력은 `urlSource` 또는 `base64Source`(JSON). `outputContentFormat: markdown` 옵션(LLM 소비용).
- **selection mark**: `state`(`selected`/`unselected`) + polygon + confidence. **주의: "selection mark는 주변 단어 안에 위치 지정되지 않는다"** → 체크박스↔라벨 연결은 기하 근접으로 우리가 계산해야 함.
- **polygon 좌표계(중요)**: 4점 사각형, TL→TR→BR→BL, flat 8숫자. **단위 = `page.unit`: 이미지는 px, PDF·TIFF는 inch.** page에 `width`/`height`/`unit`/`angle`. **주의: docx/xlsx/pptx/html은 렌더링 안 되어 boundingRegions 미반환** → 우리는 렌더 PDF 입력이므로 문제 없으나 원본 직접 입력 시 함정.
- **표**: `cells[]`에 `rowIndex`/`columnIndex`/`rowSpan`/`columnSpan`(**병합 지원**) + `boundingRegions`. 3사 중 병합 표에 가장 견고.
- **리전**: Korea Central 지원 여부 **미확인**(APAC은 Japan East/West·East/Southeast Asia 등 확인). Node: `@azure-rest/ai-document-intelligence` ^1.0(`npm i`), API Key 또는 `@azure/identity`. 가격(07-02): Layout ~$10/1,000p.
- 출처: [analyze 응답](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/analyze-document-response?view=doc-intel-4.0.0), [JS SDK README](https://learn.microsoft.com/en-us/javascript/api/overview/azure/ai-document-intelligence-rest-readme?view=azure-node-latest).

### 3.4 kordoc (npm, self-host)
- **버전/라이선스**: npm `kordoc` **3.13.0**, **MIT**(레지스트리 실측). (스코프판 `@clazic/kordoc`도 존재하나 공식 README 배지는 `kordoc`.)
- **`extractFormFields()` 시그니처/반환(중요)**: `extractFormFields(blocks: IRBlock[]): FormResult`. 반환 필드는 **`{label, value, row, col}` + `confidence`** — **기하 bbox 없음, 논리 표 인덱스(row/col)만**. 즉 **kordoc은 §3.3의 bbox 1차 소유자로 쓸 수 없다.** text parser(§8.5) 계층 후보로 한정.
- **bbox 경로**: 블록 파서 산출 `IRBlock v2`에는 `bbox` 필드가 있음(heading/paragraph/table/list/image/separator). 따라서 어댑터가 bbox를 얻으려면 form field(row/col)를 해당 table 블록의 셀 좌표로 **조인**해야 함. IRBlock `bbox` 단위는 README에 명시 없음(PDF는 pt, HWPX는 HWPUNIT 추정 — **미확인**).
- **입력**: `parse(buffer)`가 HWP3/HWP5/HWPX/HWPML/**PDF**/XLS(X)/DOCX 직접 수용(`detectFormat()`). 우리는 **원본 HWP와 렌더 PDF 둘 다** 넣어 교차 검증 가능. 배포용(열람제한) HWP도 AES-128 복호화로 파싱(rhwp 포팅).
- **폼 채우기**: `fillHwpx(buffer, values)`가 HWPX XML 직접 조작으로 원본 서식 보존(값만 교체). `fillFormFields`(IR)/`fillHwpx`(원본보존) 두 경로 정합. 병합 라벨칸 값 소실 버그는 최근 수정됨.
- **레이아웃 렌더**: `renderHwpxToSvg()`는 **한컴 저장본 HWPX 1페이지 한정**(조판 캐시 좌표 기반) — 범용 렌더 아님(Gate 0 LibreOffice 확정과 별개).
- 출처: [kordoc GitHub README](https://github.com/chrisryugj/kordoc), [kordoc npm](https://www.npmjs.com/package/kordoc).

### 3.5 PaddleOCR PP-StructureV3 (self-host)
- **배포**: PaddleX 서비스형 배포(다언어 클라이언트: C++/C#/Java/Go/PHP) + PaddleOCR 3.0 경량 **MCP 서버**(OCR·PP-StructureV3 파이프라인을 도구로 노출). 공식 Docker는 커뮤니티 이미지(`jarvis1tube/paddleocr-server` 등) 위주 — 공식 단일 이미지 표준화 여부 **미확인**.
- **출력**: layout detection(box+label+score) + 표(bbox+HTML) + 텍스트 문단. 셀·텍스트 좌표 세분 제공(px).
- **CPU-only**: 가능하나 느림 — Intel 8350C 기준 이미지당 약 **3.74초**(GPU 권장). 대량 사전변환(§8.3 첨부 아카이브 전량 실행)에는 컴퓨트 비용/지연 고려.
- **라이선스**: **Apache 2.0**(상용 자유).
- 출처: [PP-StructureV3 문서](https://www.paddleocr.ai/main/en/version3.x/algorithm/PP-StructureV3/PP-StructureV3.html), [PaddleOCR 3.0 리포트](https://arxiv.org/html/2507.05595v1).

---

## 4. bbox → 0~1 상대좌표 정규화 변환표 (§8.4 규칙 대응)

§8.4: "저장 좌표는 페이지 크기 기준 0~1 상대좌표로 정규화한다." 각 후보 원 좌표계에서의 변환:

| 후보 | 원 좌표계 | 정규화 변환 | 주의 |
|---|---|---|---|
| **Upstage** | **이미 0~1** (4점 {x,y}) | 변환 불필요. 4점→AABB로 `{x,y,w,h}` 환산만 | 가장 저마찰. 4점(비직교 가능)이므로 AABB 감쌀 때 min/max 사용 |
| **Google** | `vertices`(px) + `normalizedVertices`(0~1) | `normalizedVertices` 직접 사용 권장 | **좌표 0은 JSON에서 생략** → 누락 키를 0으로 채운 뒤 정규화 |
| **Azure** | polygon(**이미지 px / PDF inch**) | `x/page.width`, `y/page.height`. **`page.unit`로 분모 단위 일치 확인 필수** | PDF 입력이면 polygon=inch, page.width=inch로 자연 상쇄. 이미지 입력이면 px/px. 혼동 시 스케일 붕괴 |
| **kordoc** | IRBlock `bbox`(단위 미명시, PDF pt/HWPX HWPUNIT 추정) | 페이지 크기(pt/HWPUNIT)로 나눔 — **단위 확정 후 구현** | form field엔 bbox 없음 → table 블록 셀과 조인 필요 |
| **PaddleOCR** | px | 렌더 DPI 페이지 px로 나눔 | 우리 렌더 DPI(220/300)와 PP-Structure 내부 렌더 DPI 일치 확인 |

- **공통 원점**: Upstage/Google/Azure/PaddleOCR 모두 좌상단(0,0), +X 우·+Y 하 — §8.4 저장 규약과 일치.
- **페이지 매핑**: 정규화 분모는 반드시 **해당 element가 속한 page의 dimension**을 써야 함(문서 첫 페이지 크기 재사용 금지 — 혼합 페이지 크기 양식 존재).

---

## 5. 어댑터 구현 주의점

1. **좌표 단위 정규화가 어댑터의 핵심 책임**. Upstage는 무변환, Google은 `normalizedVertices` 채택(0 생략 보정), Azure는 `page.unit` 분기(inch/px), kordoc/Paddle은 px/pt 분모 확정. 어댑터 인터페이스는 **항상 0~1 `{x,y,w,h}` + `bboxSource`(§8.4 스키마)로 통일** 출력.
2. **4점 polygon → AABB**. Upstage·Azure·Google normalizedVertices는 4점. 회전 문서(Azure `page.angle`, Upstage 회전 개선)에서 비직교 사각형이 나올 수 있으므로 min/max로 AABB를 감싸되, 회전각을 메타로 보존해 viewer snap(§8.4)에 활용.
3. **비동기/폴링 처리 상이**. Azure는 LRO(Operation-Location 폴링), Upstage 비동기는 10p 배치 + 폴링, Google batchProcess는 GCS 결과. 어댑터는 **동기/비동기 공통 인터페이스 + 진행상태 콜백**으로 추상화(§8.3 on-demand 진행 UI 연동).
4. **체크박스는 벤더별 표현 상이**. Google/Azure는 네이티브 selection mark, Upstage는 네이티브 부재(추정)로 vision/Extract 라우팅, kordoc은 □/☑ 문자 인식. **selection mark ↔ 라벨 연결은 우리가 기하 근접으로 계산**(Azure는 명시적으로 미제공). §8.6 "서명/동의/직인 manual 강제" recall 99%(Gate 2 기준)는 이 계층 정확도에 좌우.
5. **표 병합 지원 차이**. Azure(rowSpan/colSpan) > Google Layout Parser 구버전 > Upstage(HTML colspan) > **Google Form Parser(병합 미지원, span 항상 1)**. 병합 셀 많은 공공 양식이면 Form Parser 단독은 위험 — reconcile에서 다른 소스로 보완.
6. **캐시 키에 extractor 버전 포함**(§8.3 기설계). Upstage `document-parse` vs `-nightly`, Google 프로세서 버전(`v1.0-2024-06-03` 등), Azure `2024-11-30`, kordoc `3.13.0`(신생·변동 빠름 → 핀 필수)를 캐시 키·artifact 메타에 기록.
7. **kordoc은 layout bbox 소유자 아님**. §3.3 역할 분리에서 kordoc은 text parser(§8.5) 후보이지 layout 엔진(bbox 1차 소유자) 후보가 아니다. Gate 2 측정 시 kordoc을 layout 엔진 열에 넣지 말 것(row/col→bbox 조인 없이는 비교 불가).
8. **데이터 처리 위치(규제 인접)**. Google·Azure는 국내 리전 부재/미확인 → 국외 전송. self-host(kordoc·PaddleOCR)와 Upstage(국내 벤더, 미확인)는 국내 처리 여지. Gate 2는 정확도 측정이지만, **후보 채택 시 데이터 위치 제약을 실측표에 병기**해 규제 축(필드 테스트 전 수행 예정)으로 넘길 것.

---

## 6. 실패 교훈 (같은 5종 비교 공개 사례)

이틀 델타 범위에서 "이 5종을 동일 golden set으로 측정한 한국 공공문서 대상 공개 실측"은 **여전히 확인되지 않음**(07-02 결론 불변). 확보된 일반 교훈:

- **OmniDocBench 포화**(07-02): 상위 모델 격차 소수점대 → 순위 변별력 낮음. **우리 golden set 직접 측정만이 유효.**
- **Google normalizedVertices 0 생략**: 좌표 0이 JSON에서 빠지는 문서화된 함정 — 파서가 키 부재를 0으로 처리하지 않으면 bbox가 페이지 밖으로 어긋남.
- **Azure selection mark 위치 미지정 + docx/xlsx/pptx/html 미렌더**: 라벨 연결·bbox 부재 함정. 우리는 렌더 PDF 입력이라 후자는 회피되나 전자는 상수 리스크.
- **PaddleOCR 프로덕션 운영 난이도**(커뮤니티): CPU 지연·의존성·서빙 구성 비용이 실측(3.74s/img)보다 운영에서 더 큰 비용. self-host TCO를 상용 API 페이지 단가와 함께 비교해야 공정.
- **kordoc 신생 리스크**: 07-02→07-04에도 버전 급증(→3.13.0). 자체 품질 주장(93/100)·폼필드 인식은 **Gate 1 golden 검수 후에만 승격**(순환성 회피, CLAUDE.md 규칙).

출처: [PaddleOCR 프로덕션 후기](https://medium.com/@ankitladva11/what-it-really-takes-to-use-paddleocr-in-production-systems-d63e38ded55e), [OmniDocBench saturated](https://www.llamaindex.ai/blog/omnidocbench-is-saturated-what-s-next-for-ocr-benchmarks), [Google handle-response](https://docs.cloud.google.com/document-ai/docs/handle-response), [Azure analyze 응답](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/analyze-document-response?view=doc-intel-4.0.0).

---

## 7. 벤더 주장 vs 실측 / 불확실성 명시

- **실재 확인(공식 문서·레지스트리)**: 엔드포인트·인증·입력 포맷·bbox 좌표계·페이지/rate 제한·라이선스·리전 목록·kordoc 3.13.0/MIT·PaddleOCR Apache 2.0. → 어댑터 구현 사실로 사용 가능.
- **미확인(본문 명시)**: Upstage 체크박스 네이티브 판정 가능 여부, Upstage 국내 데이터 처리 위치, Azure Korea Central 지원, kordoc IRBlock `bbox` 단위, PaddleOCR 공식 표준 Docker 이미지, 07-02 가격의 07-04 재확인(가격은 재조사 안 함).
- **벤더 주장(미채택)**: 각사 정확도·한국어 우위·kordoc 품질점수·OmniDocBench 순위 → **Gate 2 golden set 실측 전 확정 금지**(§17 관문 공통 의례, CLAUDE.md).
- 과장 없음: 어느 후보도 "정답"으로 표기하지 않음. 이 문서는 **어댑터 구현 사실 + 측정 설계 입력**이다.

---

## 8. 범위 제한 (감독자 결정)

**제품·규제 축은 2일 델타로 이번 대조에서 생략한다** (감독자 결정, `docs/research/CALIBRATION-TEMPLATE.md` 사전 등재표상 필드 테스트 전 수행 예정). 단, 데이터 처리 위치(국내/국외) 사실은 어댑터 채택 판단에 직결되므로 본 문서 §2·§3·§5-8에 기술 사실로만 병기했고, 규제 판정(공공데이터·개인정보 이전 적법성)은 규제 축 대조로 이월한다.
