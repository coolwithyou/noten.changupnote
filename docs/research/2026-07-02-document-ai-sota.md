# 문서 AI SOTA 대조 리서치 — cunote 문서 처리 아키텍처

작성일: 2026-07-02
대상 설계: `docs/public-support-application-guide-master-architecture.md` §3.3, §8.3~8.6

> **요지**: cunote 설계의 핵심 전제 — "bbox는 결정론적 layout 엔진이 소유하고 vision LLM은 의미 해석만 담당한다(§3.3)" — 는 2026년 현재 SOTA에서 **여전히 유효하며, 오히려 최신 벤더 문서가 이를 공식 권장 패턴으로 인정**했다. 반면 HWP 생태계와 텍스트 파서 계층은 2026년 오픈소스 급성장(kordoc, MinerU2.5, PaddleOCR-VL)으로 **재검토 여지가 크다**.
>
> 주의: 아래 벤치마크 수치는 대부분 벤더/논문 자체 주장이며, 한국어 공공문서·HWP 렌더 결과물에 대한 독립 실측은 존재하지 않는다. Gate 1/Gate 2 golden set으로 우리 도메인에서 직접 측정하기 전까지는 방향성 근거로만 취급한다.

---

## 리서치 질문별 발견

### Q1. 문서 layout/양식 이해 SOTA (표·빈칸·체크박스)

**상용 API**

| 도구 | 2026 상태 | 강점 | 가격 | 체크박스/양식 |
|---|---|---|---|---|
| Google Document AI — Form Parser | 운영 | KVP + 표 + selection mark 통합, "selection mark detector"가 체크박스를 채움/비움으로 판정 | **$30 / 1,000p** (>1M시 $20) | selection mark를 인근 텍스트와 KVP로 묶어 반환. 단, 행/열 병합 없는 단순 표만 |
| Google Document AI — Layout Parser (Gemini 기반) | 운영 | 병합 셀·복잡 헤더 표 강점, heading/header/footer/figure 구조화 | **$10 / 1,000p** | 구조/청킹 위주, KVP·selection mark는 Form Parser 쪽 |
| Azure Document Intelligence (現 Foundry Content Understanding) | 운영 | Layout 모델이 selection mark(`:selected:`/`:unselected:`) 지원, General Document가 KVP | Layout/Prebuilt **~$10 / 1,000p**, Custom ~$30 | 체크박스 정확도는 해상도·명료도에 좌우된다고 MS가 명시 |
| **Upstage Document Parse (한국)** | 운영, 2025 enhanced mode | 한국어 특화, TFLOP 표 인식 연구, 병합 표 HTML 출력 | **Parse $0.01/p, Extract +$0.03/p** (가장 저렴) | Extract 단계가 KVP 필드 추출. 한국어 문서에 최적화 주장 |

- 가격만 보면 **Upstage가 Google Form Parser의 1/3~1/4** 수준(Parse $0.01 vs $0.03/page). 한국어 공공문서에 대한 특화 주장이 있으나, 우리 HWP→렌더 PDF 결과물에 대한 독립 실측은 없음.
- 출처: [Google DocAI pricing](https://cloud.google.com/document-ai/pricing), [Google Layout Parser](https://docs.cloud.google.com/document-ai/docs/layout-parse-chunk), [Google Form Parser](https://docs.cloud.google.com/document-ai/docs/form-parser), [Azure Layout](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0), [Azure pricing](https://azure.microsoft.com/en-us/pricing/details/document-intelligence/), [Upstage pricing](https://www.upstage.ai/pricing/api), [Upstage Document Parse](https://www.upstage.ai/products/document-parse), [Upstage 표 인식(TFLOP)](https://www.upstage.ai/blog/en/ai-powered-table-recognition-just-got-smarter)

**오픈소스 (OmniDocBench CVPR2025 / v1.5 기준)**

- **MinerU2.5**: OmniDocBench overall **90.67**로 오픈소스 선두급, 텍스트 edit distance 0.047. decoupled VLM 구조로 고해상도 문서 효율 처리.
- **dots.ocr**: overall 88.41.
- **PaddleOCR (PP-StructureV3 / PaddleOCR-VL 0.9B)**: 텍스트 인식에서 최상위권, PaddleOCR-VL-1.5가 overall 94.5대까지. 다국어 표·수식·필기 지원.
- **GLM-OCR (0.9B)**: OmniDocBench v1.5 overall **94.62**로 신규 SOTA 주장 — Gemini 3 Pro·GPT-5.2 프론티어 모델까지 상회한다고 논문이 주장(자체 측정). 한국어 지원 목록에 포함.
- **Docling (IBM)**: DocLayNet 레이아웃 + TableFormer 표. 프레임워크형, 형식 지원 넓음.
- **Marker / Surya**: Surya가 90+ 언어 detection·layout·reading order·표. Marker가 그 위에서 markdown 출력.
- **Unstructured**: 전처리 파이프라인형, RAG 인입에 강함.
- 벤치마크 자체 포화 경고: LlamaIndex는 "OmniDocBench가 saturated 됐다"고 지적 — 최고 모델 간 격차가 소수점대로 좁아져 순위 변별력이 떨어짐.
- 출처: [OmniDocBench](https://github.com/opendatalab/OmniDocBench), [MinerU2.5 논문](https://arxiv.org/abs/2509.22186), [OmniDocBench 1.5 리더보드](https://llm-stats.com/benchmarks/omnidocbench-1.5), [GLM-OCR 기술보고서](https://arxiv.org/html/2603.10910v1), [PaddleOCR-VL 논문](https://arxiv.org/html/2510.14528v1), [Docling/Marker 비교](https://modal.com/blog/8-top-open-source-ocr-models-compared), [OmniDocBench saturated](https://www.llamaindex.ai/blog/omnidocbench-is-saturated-what-s-next-for-ocr-benchmarks)

> **한국어 공공문서/표 중심 양식에 강한 것**: 명확한 독립 근거는 없다. 정황상 후보는 (1) **Upstage**(한국어 특화 + 최저가 + 병합표 HTML), (2) **kordoc**(HWP/HWPX 네이티브·한국 공문서 label-value 패턴 내장, Q4 참조). OmniDocBench는 영어/중국어 중심이라 한국어 순위는 미검증. **Gate 2에서 우리 golden set으로 직접 측정해야 함.**

---

### Q2. Vision LLM의 문서 구조 이해 — "vision bbox는 신뢰 불가" 전제가 유효한가?

**결론: 우리 전제는 2026년에도 유효하며, 벤더가 이를 공식 확인했다.**

- **Gemini 3 (Google 공식)**: "Gemini 3 does not perform layout detection of objects in documents. 엄격한 bbox로 특정 문단/숫자의 출처를 하이라이트해야 하는 애플리케이션이면 Gemini 3 단독은 부적합할 수 있다." — Google 스스로 layout 엔진 병용을 권장. ([Tensorlake/Gemini3 OCR](https://dev.to/tensorlake/gemini-3-is-now-available-as-an-ocr-model-in-tensorlake-4kfh))
- **ExStrucTiny 벤치마크(2026)**: 문서 이미지 구조 추출에서 open·closed 모델 모두 **localization 최대 IoU 14.4%**에 그침. "텍스트 예측이 맞아도 공간 grounding이 맞는다는 보장이 없다(calibration gap)". bbox 예측의 연속·고분산 특성과 layout scale 민감성이 원인. → 정확한 evidence 위치가 필요한 산업 응용에 주의 요망. ([ExStrucTiny](https://arxiv.org/pdf/2602.12203))
- **visual grounding 벤치(GroundingME 등)**: 최상위도 42.6%(Seed-1.6-Vision) 수준, Gemini-2.5 계열은 중급 오픈소스와 유사. Qwen3-VL은 스케일에 비례(2B→32B: 21→39%대)하나 절대 수준은 여전히 낮음. ([Qwen3-VL 기술보고서](https://arxiv.org/pdf/2511.21631), [GroundingME](https://arxiv.org/html/2512.17495))
- **프론티어 모델 OCR grounding 한계(2026)**: GPT-5급·Gemini 계열 모두 노이즈·모호한 시각 조건에서 텍스트 hallucination·토큰 누락·오역이 여전. ([다국어 OCR 파인튜닝 논문](https://arxiv.org/html/2605.16409))

> 즉 최신 VLM은 **텍스트 읽기(OCR)·의미 해석**은 매우 좋아졌지만 **정밀 좌표(bbox) 산출은 여전히 약하다.** cunote가 vision에 의미 해석만 맡기고 bbox를 layout 엔진에 귀속시킨 §3.3 분리는 SOTA 정합. 단, "vision을 anchor·보정 신호로 쓴다"는 부분은 유효하되 **vision bbox의 layout snap이 필수**임이 재확인됨(단독 사용 금지).

---

### Q3. 양식 필드 추출 연구 (KVP / form understanding, 2024~2026)

- **"Problem Solved? Information Extraction Design Space for Layout-Rich Documents using LLMs"(2025)**: layout-rich 문서 IE의 설계 공간을 정리. 텍스트 세그먼트화 + LLM 조합이 유효. ([arxiv 2502.18179](https://arxiv.org/pdf/2502.18179))
- **"IE from Visually Rich Documents via LLM-based Organization into Independent Textual Segments"(2025)**: 문서를 독립 텍스트 세그먼트로 재조직 후 LLM 추출 — **우리 reconciliation의 "layout 블록 단위로 잘라 vision에 의미만 묻는다"와 사실상 동형.** ([arxiv 2505.13535](https://arxiv.org/pdf/2505.13535))
- **"A Bounding Box is Worth One Token: Interleaving Layout and Text"(ACL2025 Findings)**: bbox를 토큰으로 인터리빙해 LLM에 layout을 주입 — 우리가 layout 좌표를 vision 컨텍스트에 anchor로 넣는 접근의 학술적 뒷받침. ([ACL 2025](https://aclanthology.org/2025.findings-acl.379.pdf))
- **ARIAL(2026)**: DocVQA에 정밀 answer localization을 붙인 에이전트 프레임워크 — 텍스트 답과 좌표를 분리해 결합. ([arxiv 2511.18192](https://arxiv.org/pdf/2511.18192))
- **BuDDIE(2024)** / **XFUND / DocLLM**: form IE 데이터셋·layout-aware 생성 모델 계보. ([BuDDIE](https://arxiv.org/pdf/2404.04003))

> **우리 3자 reconcile(text + layout + vision)와 유사·상회 패턴**: 연구계는 우리와 같은 방향(layout 결정론 + LLM 의미)으로 수렴 중. 더 나은 패턴 후보 두 가지 — (a) **layout bbox를 LLM 프롬프트에 토큰으로 인터리빙**(단순 nearbyText 대신 좌표까지 컨텍스트로), (b) **문서를 layout 블록 단위 독립 세그먼트로 분해 후 필드별 개별 질의**(§8.4 vision pass를 블록 단위 배치로). 둘 다 §8.6 reconcile에 저비용으로 편입 가능.

---

### Q4. HWP 생태계 최신 (2025~2026) — **가장 실행 임팩트 큰 발견**

Rust/TS로 HWP 파싱·렌더·**폼 채우기**가 급성장. 특히 두 가지가 cunote 로드맵과 정면으로 겹친다.

- **kordoc** (chrisryugj, MIT, 2026-03 생성, 1개월 내 800+ stars): HWP3/HWP5/HWPX/HWPML/PDF/XLS/DOCX → Markdown. **결정적으로 cunote가 §3.2에서 "후속 단계로 미룬" filled export를 이미 구현.**
  - `fillHwpx()`: HWPX XML 직접 조작으로 **원본 서식(글꼴·크기·정렬) 100% 보존한 채 값만 교체.**
  - `extractFormFields()`: 공문서 label-value 셀 패턴·체크박스(□→☑)·괄호 빈칸·어노테이션 자동 인식 → `{ label, value, row, col }[]` + confidence.
  - `compare()`: HWP↔HWPX 크로스 포맷 신구대조(diff).
  - PDF 선기반/클러스터 표 감지(Hancom OpenDataLoader 알고리즘 포팅), 한국 공문서 `구분/항목/종류/기준` KV 패턴 자동 2열 변환, PDF 품질 신호(`needsOcr`, PUA/control char 비율)로 OCR 라우팅.
  - MCP 서버(8 도구: `parse_form`, `fill_form` 등). 배포용 DRM HWP COM fallback, HWP3 구버전까지.
  - 제작자: 광진구청 7년차 공무원, 5개 공공 프로젝트 수천 건 실문서 검증.
  - ([kordoc GitHub](https://github.com/chrisryugj/kordoc))
- **rhwp** (edwardkim, MIT): Rust+WASM HWP/HWPX 뷰어/에디터. 브라우저 직접 렌더, 배포용 AES-128 복호화·lenient CFB 복구 알고리즘 (kordoc이 이걸 포팅). ([rhwp](https://github.com/edwardkim/rhwp))
- **hwpers** (Indosaram): HWP5 full layout rendering + SVG export, memory-safe Rust. ([hwpers](https://github.com/Indosaram/hwpers))
- **openhwp / hwp-rs (hahnlee)**: HWP/HWPX read·write, 한컴 공식 포맷 문서 기반 파서. ([openhwp](https://github.com/openhwp/openhwp), [hwp-rs](https://github.com/hahnlee/hwp-rs))
- **hwp2md**: HWP/HWPX ↔ Markdown 양방향(Rust).

> **커뮤니티 동향**: 2026년 상반기 한국 문서 AI 생태계가 "HWP를 markdown/구조로 뽑고 다시 HWPX로 되돌리는" 왕복 파이프라인 + MCP 통합으로 빠르게 성숙. cunote의 §8.3 렌더러 체인 4순위였던 pyhwp `hwp5html`보다 kordoc/rhwp 계열이 **텍스트 추출·표 복원·폼 필드 인식·filled export 전부에서 우위**일 가능성이 높다(단, 독립 실측 필요 — kordoc 자체 품질점수 93/100은 자기 주장).

---

### Q5. 무구조(AcroForm 없는) PDF 양식 필드 감지

cunote PoC 관찰(배치4): 수집 PDF 양식 10건 전부 AcroForm 없음 → 무구조가 기본. SOTA 관행:

- **acroforge**: flat PDF → AcroForm 자동 생성. underline(밑줄→텍스트필드), 표/그리드 셀(라벨 인지), vector 체크박스 사각형, glyph 체크박스(□/☑ 문자) 감지. **단 vector 전용 — 스캔/이미지 PDF는 `ScannedPDFError`로 거부**(OCR 없이 거짓 필드 만들지 않겠다는 설계). "detect → 초안 manifest 검토 → 수정 → 확정" 휴먼인더루프 워크플로우를 명시. ([acroforge](https://dev.to/san64777/acroforge-turn-a-flat-pdf-into-a-real-fillable-acroform-with-a-deterministic-core-and-zero-50k5))
- **Adobe Acrobat 자동 감지**: 밑줄·텍스트박스·명확한 표 → 텍스트필드, stroked 사각/원/다이아 → 체크박스. 업계 표준 휴리스틱.
- **Google Form Parser / Azure Layout**: OCR 기반이므로 스캔형에도 selection mark·KVP 감지 가능(vector 전용 acroforge와 상보적).

> **베스트 프랙티스 합의**: (1) 밑줄·괄호·표 셀·stroked shape 결정론 감지 → (2) 초안 필드 manifest → (3) **사람 검토·수정 후 확정**. cunote의 §8.6 "confidence 낮으면 운영 검수 큐" + §13 품질게이트 + Gate1 라벨링과 정확히 일치. 스캔형 PDF는 결정론 감지가 불가하므로 **OCR 계층(vision/layout API)로 라우팅**해야 — kordoc의 `needsOcr` 신호가 그 라우터로 유용.

---

## 우리 설계와의 대조표

| 설계 항목 (master arch) | SOTA 대비 판정 | 근거 |
|---|---|---|
| §3.3 bbox 1차 소유자 = 결정론 layout 엔진, vision는 의미만 | **유지 (강화됨)** | Gemini 3이 layout detection 미지원·병용 권장(Google 공식); ExStrucTiny IoU 14.4%; grounding 벤치 최고 42.6%. 전제가 SOTA 정설로 확립 |
| §3.3 vision bbox를 anchor/보정으로만, layout snap | **유지** | "텍스트 맞아도 공간 grounding 별개(calibration gap)". 단독 신뢰 금지·snap 필수 재확인 |
| §8.4 vision pass가 "layout 놓친 요소 지목 + 의미 판정" | **유지** | 연구계가 동일 방향(layout 결정론 + LLM 의미)으로 수렴 (2505.13535, ACL2025) |
| §8.6 text+layout+vision 3자 reconcile | **유지 (개선 여지)** | 학술 뒷받침 확보. 개선: layout bbox를 LLM에 토큰 인터리빙 / 블록 단위 개별 질의 |
| §8.3 렌더러 체인 4순위 pyhwp hwp5html | **재고** | kordoc/rhwp/hwpers가 텍스트·표·폼필드·filled export에서 우위 후보. 체인 재편 검토 |
| §8.5 text parser `extractGrantDocumentFields()` (후보 생성기) | **보강** | kordoc `extractFormFields()`가 한국 공문서 label-value·체크박스·괄호빈칸 패턴 내장 — 자체 파서 대체/보강 후보 |
| §3.2 filled export를 "후속 단계로 미룸"(HWPX/DOCX) | **재고(가속 가능)** | kordoc `fillHwpx()`가 원본 서식 100% 보존 폼필 이미 구현. MVP filled export 앞당길 지렛대 |
| §8.3 무구조 PDF·AcroForm 희귀 | **유지** | 업계도 flat PDF 기본 전제. acroforge/Acrobat 휴리스틱과 우리 접근 일치 |
| §8.6 confidence 낮으면 운영 검수 큐 + §13 품질게이트 | **유지** | acroforge "detect→검토→확정" 휴먼인더루프가 동일 철학. Gate1 라벨링과 정합 |
| §8.3 layout 추출을 Document AI Layout/Form Parser 등으로 | **보강** | Upstage(한국어 특화·최저가 $0.01/p·병합표 HTML)를 후보에 추가. Gate2에서 Google/Azure/Upstage/오픈소스 비교 측정 권장 |
| §8.4 vision LLM 모델 선택 (미지정) | **정보 추가** | 의미 해석용이면 Gemini 3/GPT-5급이 최적(OCR·이해 강함, bbox는 안 씀). 순수 파싱은 MinerU2.5/PaddleOCR-VL/GLM-OCR |

---

## 구체적 개선 후보

### A. kordoc를 text parser 계층에 도입 (§8.5 보강) — **최우선**
- **무엇**: `extractGrantDocumentFields()` 대신/보완으로 kordoc `parse()` + `extractFormFields()`를 텍스트/표/폼필드 후보 생성기로 사용. MCP 서버 또는 npm(TS, cunote와 동일 스택) 직접 임포트.
- **도입 비용**: 낮음. MIT·순수 TS·`npm install kordoc`. 기존 hwp-markdown 경로와 A/B 비교부터.
- **기대 효과**: 한국 공문서 label-value·체크박스·괄호빈칸 패턴 즉시 확보. 표 병합 복원·PDF `needsOcr` 라우팅 신호 획득. §8.5 자체 파서 유지보수 부담 감소.
- **리스크**: kordoc 품질점수(93/100)는 자체 주장 — **Gate1 golden set으로 실측 후 채택.** 렌더 시각 결과물이 아닌 텍스트/구조 계층에 한정(§8.3 Gate0 렌더 확정과 별개).

### B. filled export(HWPX) 로드맵 가속 (§3.2 재고)
- **무엇**: kordoc `fillHwpx()`(원본 서식 100% 보존)를 §5.5 Draft Package의 "filled_hwpx" artifact 생성기로 PoC.
- **도입 비용**: 낮음~중. HWPX 한정(HWP5 바이너리 제외). Gate3 이후 실험 브랜치.
- **기대 효과**: "시각 가이드"를 넘어 **실제 채워진 HWPX** 제공 — 사용자 가치 급상승. §7.4 DocumentArtifact에 이미 `filled_hwpx` kind 정의됨(설계 선견).
- **리스크**: 서식 보존·병합셀·검증 필요. 휴먼터치(§14) 정책 유지 — 자동 제출 아님.

### C. layout 추출 벤더 비교에 Upstage 추가 (§8.3 보강)
- **무엇**: Gate2에서 Google Layout/Form Parser · Azure · **Upstage Document Parse** · 오픈소스(MinerU2.5/PaddleOCR-VL)를 우리 golden set으로 coverage·표 TEDS·체크박스 recall·비용 동시 측정.
- **도입 비용**: 중(측정 공수). Upstage $0.01/p로 실험 비용 최저.
- **기대 효과**: 한국어 특화 + 최저가 후보 검증. §8.3 캐시 키에 extractor version 이미 포함 — 교체 인프라 준비됨.
- **불확실**: Upstage 한국어 우위는 마케팅 주장, 우리 렌더 PDF 입력에 대한 독립 실측 없음.

### D. reconcile에 layout-bbox 토큰 인터리빙 (§8.6 개선)
- **무엇**: vision pass 프롬프트에 nearbyText뿐 아니라 layout bbox 좌표를 토큰으로 주입(ACL2025 패턴). 블록 단위 개별 질의(2505.13535 패턴)도 병행 검토.
- **도입 비용**: 낮음(프롬프트/파이프라인 변경). Gate2 이후.
- **기대 효과**: vision의 문항-입력칸 연결 정확도 향상 기대. 다만 학술 결과라 우리 도메인 효과는 미검증 — ablation으로 확인.

### E. 순수 파싱 벤치 모델 후보 목록화 (참고)
- 시각 렌더가 아닌 "이미지→구조 텍스트"가 필요한 보조 경로엔 MinerU2.5(overall 90.67)·PaddleOCR-VL·GLM-OCR(94.62 주장) 후보. 단 OmniDocBench 포화·한국어 미검증이라 **참고용**.

---

## 과장/불확실성 경계 (명시)

- OmniDocBench 수치·GLM-OCR 94.62·MinerU 90.67·Upstage 한국어 우위·kordoc 93점은 **모두 벤더/논문 자체 주장**. 한국어 공공문서 + HWP 렌더 결과물에 대한 독립 3자 실측은 검색 범위에서 확인 안 됨.
- OmniDocBench는 영어/중국어 중심(한국어는 5개 언어 중 하나지만 언어별 세부 순위 미공개). **한국어 순위는 미지수.**
- ExStrucTiny/grounding 벤치의 "bbox 신뢰 불가"는 재현성 높은 다수 논문 합의 → 우리 전제 근거로 **강함**.
- kordoc는 2026-03 생성으로 **매우 신생**(성숙도·장기 유지보수 리스크). 채택 전 Gate1 실측 필수.
- 결론적으로 어느 개선안도 **Gate1(라벨)·Gate2(측정) 통과 전 확정 금지.** 본 리서치는 후보 선정·측정 설계 입력이다.
