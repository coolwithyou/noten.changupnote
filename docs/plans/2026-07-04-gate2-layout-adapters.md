# Gate 2 — layout 엔진 어댑터 5종 실행 인프라 (트랙 C)

> **🟢 상태 (2026-07-05 갱신)**: 외부 대조(델타) 완료·판정 반영 → **구현·검증 완료.** 어댑터 5종 + 정규화 + 러너/캐시 + 메트릭 + 0030 마이그레이션(적용됨, enum 반영 DB 확인). 검증 증거: typecheck 통과, normalize 픽스처 12/12, **kordoc 실측 44/45 문서 후보 2,565건**(세션 6에서 batch4 no_source 해소 — 아래 한계), **Google Form Parser 실호출 1p 검증**(doc42, 후보 78건, 재실행 캐시 히트 apiUnits=0). 남음: 사용자 키(`UPSTAGE_API_KEY`·Azure) 등록 시 해당 엔진 실측, PaddleOCR 로컬 docker 기동, golden 15~20건 시점 조기 측정.
>
> **알려진 한계 (2026-07-05 갱신)**: ~~batch4 14건 no_source~~ **해소됨** — `spike-labels/source-map.json`(docId→원본 경로, 아카이브 DB sha256 대조로 도출)을 러너가 이름 매칭보다 우선 적용. kordoc PDF 파싱에는 `pdfjs-dist` peer가 필요해 **4.10.38 고정 설치**(kordoc 3.13은 `>=4`를 기대하나 v6은 `doc.destroy` API 부재로 비호환). 잔여 1건: doc54(구형 바이너리 `.doc`)는 kordoc 미지원 형식(OLE HWP로 오인, "FileHeader 스트림 없음") — 엔진 한계로 기록. bbox 4개 엔진은 페이지 이미지 입력이라 45건 전부 커버.
>
> 범위 주의 (2026-07-03 사용자 합의): **실행 인프라까지만.** 통과 판정·임계값 캘리브레이션은 리뷰팀 검수로 golden이 쌓인 후(15~20건 시점 조기 측정 시작). 지금은 "어댑터 5종 + 정규화 + 러너 + 메트릭 계산"을 만들어 두고, golden 없이도 후보 산출까지는 돌아가게 한다.

## 1. 목적 (마스터 §17 Gate 2)

layout 엔진 후보 5종을 같은 입력(골든 45문서)에 돌려 후보 필드를 산출하고, golden field map과 비교해 coverage·manual recall·비용을 측정할 수 있는 인프라. 마스터 §8.4의 "결정론 layout 엔진이 bbox 소유" 전제를 실측으로 검증하는 도구다.

## 2. 후보 5종과 입력 경로

| 엔진 | 입력 | bbox | 비고 |
|---|---|---|---|
| Upstage Document Parse | 렌더 PDF 또는 페이지 이미지 | 있음 | 한국어 특화, $0.01/p. **API 키 필요 (사용자)** |
| Google Document AI (Form/Layout Parser) | PDF/이미지 | 있음 | changupnote-com GCP에서 프로세서 프로비저닝 가능 (이 세션에서 처리) |
| Azure Document Intelligence (Layout) | PDF/이미지 | 있음(polygon) | **Azure 리소스·키 필요 (사용자)** |
| kordoc `extractFormFields()` | **원본 HWP/HWPX/PDF** (`spike-samples/files`) | **없음(row/col 확정)** — layout 엔진 아님, §8.5 text parser 계층 후보 | npm 3.13.0 핀, 키 불필요. label 매칭으로만 평가, 측정표에서 layout 열과 분리 |
| PaddleOCR PP-StructureV3 | 페이지 이미지 | 있음 | 셀프호스팅(Docker, CPU) — 로컬 맥에서 실행 |

입력 데이터 (이미 확보):
- 페이지 이미지 343장: 로컬 `spike-labels/pages/docNN-PP.png` (R2 `label-review/pages/` 동일본)
- 원본 문서 45건: `spike-samples*/files/` (HWP/HWPX/PDF/DOCX)
- 골든(진행형): `field_map_review_docs.labelJson` — 검수 확정분이 `golden_set(kind=field_map)`으로 승격됨. 라벨 bbox는 `[x,y,w,h]` 0~1 정규화, page 1-기준

## 3. 레포 아키텍처

```
apps/web/src/lib/server/layout-eval/
  types.ts            LayoutEngineAdapter 인터페이스 + NormalizedFieldCandidate
  normalize.ts        엔진별 좌표계 → 0~1 상대좌표 변환 (마스터 §8.4 규칙)
  adapters/
    upstage.ts        각 어댑터: extract(input) → { candidates, rawRef, cost, engineVersion }
    google-docai.ts
    azure-di.ts
    kordoc.ts
    paddleocr.ts
  run-layout-eval.ts  러너 CLI (기본 dry-run, --write 로 eval_runs 기록 — 레포 CLI 관례)
  metrics.ts          coverage / manual recall / (bbox 있으면 IoU 매칭) 계산
  eval-cache/         원시 응답 캐시 (gitignore, 키 = sha256+engine+version) — API 재과금 방지
```

- **정규화 스키마**: `NormalizedFieldCandidate { page, bbox: [x,y,w,h] | null, kind, label, text, raw }` — 골든 라벨 필드와 직접 비교 가능한 형태
- **비교(메트릭)**: bbox 있는 엔진은 IoU≥0.5 + label 유사도로 골든 필드 매칭, kordoc은 label/text 매칭만. 산출: 필드 coverage(Gate 2 기준 80%), 서명·동의·직인 manual recall(기준 99%), 엔진별 페이지당 비용
- **DB**: `eval_runs`에 기록 — `eval_target` enum에 `field_map` 추가 (마이그레이션 0030, `db:generate`→`db:migrate` 준수). `version_refs`에 `{engine, engineVersion, goldenVer, docCount}`, `metrics`에 수치
- golden이 0건이어도 러너는 후보 산출·캐시까지 수행하고 "골든 없음 — 메트릭 생략"으로 종료 (검수 진행과 병렬 가동 전제)

## 4. 시크릿/프로비저닝

| 항목 | 담당 |
|---|---|
| `UPSTAGE_API_KEY` (.env.local) | ✋ 사용자 (console.upstage.ai) |
| Google Document AI: API 활성화 + 프로세서 생성 + 인증(gcloud ADC) | 이 세션 (changupnote-com 재사용) |
| `AZURE_DI_ENDPOINT` / `AZURE_DI_KEY` | ✋ 사용자 (Azure 포털, Document Intelligence 리소스) |
| kordoc | 불필요 (`pnpm add kordoc` — apps/web devDeps 또는 전용 위치, 구현 시 결정) |
| PaddleOCR 서빙 컨테이너 | 구현 시 docker run 지침 포함, 로컬 실행 |

키가 없는 엔진은 러너가 "미설정 — 스킵"으로 우아하게 건너뛴다. **kordoc·PaddleOCR·Google은 사용자 키 없이도 측정 가능**하므로 사용자 키 대기와 무관하게 인프라 완성·부분 측정이 가능하다.

## 5. 위임 스펙 (Opus 서브에이전트 — 2026-07-04 발주)

API 통합 사실(엔드포인트·좌표계·제한)은 대조 문서 §2~§5가 단일 원천 — 구현 시 그대로 따른다. 이 섹션은 레포 측 결정만 확정한다.

1. **입력 단위 = 페이지 이미지** (`spike-labels/pages/docNN-PP.png`): 골든 bbox가 이 이미지 기준 0~1 정규화이므로 좌표 정합이 자명. Upstage/Google/Azure/PaddleOCR 모두 이미지 입력 수용. kordoc만 원본 파일(`spike-samples*/files`) 입력, page 미상 후보는 문서 전역 label 매칭
2. **정규화**: 4점 polygon → min/max AABB `[x,y,w,h]` 0~1. Google은 normalizedVertices 채택 + **0 생략 보정**, Azure는 이미지 입력이라 px/px, 회전각은 메타 보존 (대조 문서 §4·§5)
3. **인증**: Upstage `UPSTAGE_API_KEY`, Azure `AZURE_DI_ENDPOINT`/`AZURE_DI_KEY`, PaddleOCR `PADDLEOCR_SERVER_URL` (전부 .env.local, 미설정 엔진은 스킵). Google은 `gcloud auth print-access-token` 자식 프로세스 호출(SA 키 관리 회피) + `GOOGLE_DOCAI_PROCESSOR`(`projects/.../locations/.../processors/...`) env
4. **Google 프로세서**: Form Parser, 리전 `us`(기본 멀티리전 — asia 단일리전은 프로세서 타입 가용성 확인 후. 규제 판정은 이월된 상태로 측정 목적 한정)
5. **캐시**: `apps/web/src/lib/server/layout-eval/eval-cache/`(gitignore) 키 = `{engine}/{engineVersion}/{docId}-{page}`. 2회차 실행 시 API 호출 0건
6. **rate limit 준수**: Upstage 1 RPS 직렬 + 재시도(429 backoff). Google/Azure도 보수적 직렬
7. **메트릭** (골든 = DB `golden_set(kind=field_map)` 승격분만; `--golden-source labels`는 미검수 참고용 경고 출력): 필드 coverage(IoU≥0.5 ∨ label 정규화 유사도), signature/stamp/consent manual recall, 페이지당 비용 추정. `eval_runs`(`target=field_map`, 0030 마이그레이션) 기록은 `--write` 시에만
8. **커밋 금지** — 메인 세션 검수 후 커밋. 마이그레이션은 `pnpm db:generate`로 생성만 하고 `db:migrate`는 메인 세션이 실행

## 6. 검증 계획

1. 어댑터 단위: 고정 픽스처(문서 1건)로 각 어댑터 요청→정규화 왕복, 좌표 정규화 스냅샷 테스트
2. 러너: 45문서 × 가용 엔진 실행, eval-cache 멱등(2회차 API 호출 0건) 확인
3. golden 0건 상태에서 dry-run 정상 종료 + 검수 확정 1건 만들어 메트릭 계산 경로 확인 (확정 취소로 원복)
4. `pnpm typecheck` + 기존 테스트 무회귀
