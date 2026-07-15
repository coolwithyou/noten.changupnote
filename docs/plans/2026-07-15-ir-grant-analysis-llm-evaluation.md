# IR 공고 분석 LLM 평가 파일럿 실행 정본

상태: Gate 0 cohort freeze 완료

기준 시각: `2026-07-15T00:00:00+09:00`

이 문서는 IR 전에 공고 분석과 매칭 결과의 신뢰도를 실제로 끌어올리는 단일 실행 정본이다. 이 문서에 없는 확장 작업은 현재 파일럿에 포함하지 않는다.

## Gate 0 완료 receipt

- 실행 시각: 2026-07-15 KST
- 기준 시각: `2026-07-15T00:00:00+09:00`
- canonical product-active 모집단: 1,720건
- confirmed duplicate 포함 모집단: 1,720건
- 기존 개발셋 제외: 설정 12건 / 실제 제외 12건
- 선택 가능 모집단: 1,708건
- 동결 cohort: K-Startup 20건 + 기업마당 20건
- split: validation 24건 + sealed 16건
- public manifest SHA-256: `ea25d5180880418de239f18001baf021ae585c4b146cc6142a090ecb31b80f95`
- selection commitment SHA-256: `f4c91e3b32695c48f3f8cb87ffa9519c399efb6629198ad057f1d3f0f0115d79`
- public artifact: `tmp/grant-analysis-evaluation/2026-07-15/cohort/public-manifest.json`
- secret artifact: 같은 디렉터리의 `secret-manifest.json`, 파일 권한 `0600`, gitignored
- sealed identity/title/revision public 누수: 0건
- 외부 LLM 호출: 0건
- DB write: 없음
- 서버 실행: 없음
- 검증: focused cohort test, web typecheck, manifest pair readback, overwrite refusal, `git diff --check` 통과

층별 선택 가능 수는 다음과 같다.

| source | sparse unavailable | sparse loadable | mid density | high-density control |
| --- | ---: | ---: | ---: | ---: |
| K-Startup | 11 | 14 | 188 | 42 |
| 기업마당 | 48 | 9 | 1,337 | 59 |

최초 계획의 `sparse_no_attachment`는 K-Startup 1건, 기업마당 0건뿐이라 quota 충족이 불가능했다. 제목이나 Judge 결과를 이용해 대상을 바꾸지 않고, 가설을 더 직접 검증하는 `sparse_attachment_unavailable`과 `sparse_attachment_loadable`로 사전 층을 재정의한 뒤 동결했다.

## 1. 목표와 제품 약속

### 목표

- 현재 지원 가능한 공고 중 새로 고정한 40건에서 API 본문과 PDF/HWP 첨부파일을 읽는다.
- 각 공고를 현재 분류 체계의 22개 축으로 분석하고, 축별 상태와 원문 근거를 남긴다.
- 기존 분석 A, API 본문 재분석 B, API와 첨부파일 재분석 C를 같은 공고 리비전에서 비교한다.
- 사람 상시 라벨링 없이 고성능 LLM을 이용해 재현 가능한 `LLM proxy gold`를 만든다.
- IR 화면에서는 분석 범위, 읽은 자료, 근거, 불확실성, 매칭 변화가 한눈에 보이게 한다.

### 제품 약속

- `100% 정확`, `사람 검수 완료`처럼 사실과 다른 표현을 사용하지 않는다.
- 자료가 없거나 읽지 못한 축을 `조건 없음`으로 바꾸지 않는다.
- 근거 없는 추천 가능 판정보다 `확인 필요`를 우선한다.
- IR에서 좋은 인상은 숫자 과장이 아니라 실제 원문 근거와 일관된 동작으로 만든다.

## 2. 이번 범위

### 포함

- 새 공고 40건의 고정 cohort manifest
- 24건 validation과 16건 sealed holdout
- 원본 API, PDF/HWP 입력 수집 및 포함 여부 감사
- 22축 분석 ledger
- A/B/C 비교
- 독립 이중 LLM 판정과 불일치 재판정
- 근거 존재 여부의 결정론적 검증
- 체크포인트, 재시작, 호출 영수증, 정적 결과 화면
- 한 사업자 프로필에 대한 shadow match 비교

### 제외

- 기존 12건을 holdout으로 재사용
- 과거 공고 전체 마이그레이션
- 운영 DB 쓰기 또는 기존 공고 criteria 자동 교체
- 22축 분류 체계 변경
- 매칭 점수 공식 전면 재작성
- 벡터 검색 또는 새로운 검색 인프라
- 매칭 화면 전면 디자인 개편
- 첨부파일 변환기 전면 교체

## 3. cohort 정책

### 고정 원칙

- cohort는 LLM 호출 전에 읽기 전용으로 생성하고 파일로 고정한다.
- 전체 활성 모집단을 `limit + 1`로 읽고 overflow가 있으면 일부 모집단으로 표본을 만들지 않고 실패시킨다.
- 공고 키, canonical grant id, source revision, 제목, 출처, 마감일, split, stratum, deterministic rank를 기록한다.
- 첨부파일은 artifact id, 파일명, content type, byte 크기, 원본 해시, 변환 상태, 변환 텍스트 해시, converter/OCR 버전을 기록한다.
- `sourceRevisionV1`은 raw payload 해시와 attachment summary 해시를 함께 묶는다. 기존 `raw_hash`만 source revision으로 사용하지 않는다.
- cohort freeze에서는 계획된 C commitment를 기록하고, markdown 로드 후 유료 호출 직전 두 번째 freeze에서 API-only와 API+attachment 최종 입력 해시, artifact 포함 순서, 입력 제한 정책 해시를 확정한다.
- 최상위에는 schema/selector 버전, 고정 seed, 모집단 수와 해시, 제외 목록 해시, quota, shortfall/replacement ledger, 코드 revision을 기록한다.
- 고정 후 공고 교체는 입력 자체가 사라진 경우에만 허용하며 교체 사유를 기록한다.
- validation 결과를 본 뒤 sealed holdout의 구성이나 리비전을 바꾸지 않는다.

### 표본 선택 입력 경계

- 선택 전에 사용할 수 있는 값은 source, source id, canonical active/deadline 상태, raw revision, 첨부파일 형식·크기·해시·변환 가능성, 기존 A의 구조적 criteria 개수뿐이다.
- Judge/B/C 결과, match 결과, proxy label, 제목의 의미 해석, `reviewedAt`, labeled review log는 선택에 사용하지 않는다.
- 층별 후보 순서는 `selectorVersion + fixedSeed + source + sourceId + rawRevision`의 SHA-256 순으로 정한다.
- 기존 12건과 이전에 Judge가 읽은 공고는 모두 제외하고 제외 목록 해시를 남긴다.

### 40건 구성

- 출처: K-Startup 20건, 기업마당 20건을 목표로 한다.
- 각 출처: `sparse_attachment_unavailable` 8건, `sparse_attachment_loadable` 4건, `baseline_density_mid` 4건, `baseline_density_high_control` 4건으로 고정한다.
- `sparse_attachment_unavailable`은 baseline criteria 0~1개이며 content-bound 변환 markdown을 읽을 수 없는 공고다.
- `sparse_attachment_loadable`은 baseline criteria 0~1개이며 원본 archive 해시, 변환 markdown 위치와 markdown SHA-256이 모두 있는 공고다.
- `baseline_density_mid`는 baseline criteria 2~5개, `baseline_density_high_control`은 6개 이상이다. 두 이름은 현재 구조화 밀도만 뜻하며 품질이나 정답을 뜻하지 않는다.
- PDF/HWP 첨부파일 유무와 변환 가능 여부가 한쪽으로 몰리지 않게 한다.
- 현재 지원 가능 여부와 source revision을 기준 시각에 고정한다.
- 정확한 40건을 확보하지 못하면 부족한 층을 숨기지 않고 manifest에 기록한다.

### 분할

- validation 24건: 구현과 단 한 번의 보정에 사용한다.
- sealed holdout 16건: 프롬프트, 모델, 스키마, 변환 정책을 모두 고정한 뒤 한 번만 실행한다.
- 출처별로 validation 12건, sealed 8건을 배정한다.
- 출처별 validation/sealed 배분은 unavailable 5/3, loadable 2/2, mid 3/1, high-control 2/2로 고정한다.
- validation manifest에는 24건을 공개하고, sealed 16건은 salted commitment만 공개한다. 실제 sealed mapping은 repo 밖 ignored artifact로 분리한다.
- 같은 실행에서 sealed mapping과 평가 결과 또는 reveal key를 함께 생성하지 않는다.
- 기존 파일럿 12건: 개발 회귀셋으로만 사용하며 최종 성능 분모에서 제외한다.

## 4. 사람을 대체하는 LLM proxy-gold 정책

### 판정 순서

1. Judge 1과 Judge 2는 A/B/C 결과를 보지 않고 원본 API와 첨부파일만 읽는다.
2. 두 Judge는 각 축에 대해 상태, 정규화 값, 원문 근거, 위치, 확신도를 구조화해 출력한다.
3. 두 Judge의 의미가 일치하면 해당 축의 proxy label을 확정한다.
4. 불일치 축만 Judge 3가 원본과 두 판정을 보고 재판정한다.
5. Judge 3도 확정하지 못하면 `unresolved`로 남긴다. 억지로 다수결 정답을 만들지 않는다.
6. A/B/C는 확정된 proxy label과 기계적으로 비교한다.

### 독립성

- 추출 모델과 Judge는 서로 다른 모델 계열을 사용한다.
- Judge 1과 Judge 2도 서로 다른 모델 계열을 사용한다.
- 한 제공자만 사용할 수 있으면 smoke와 IR 시연용 proxy 평가는 가능하지만 운영 go 판정에는 사용할 수 없다. 이때 서로 다른 프롬프트 역할과 독립 호출을 사용하고 그 한계를 화면과 보고서에 명시한다.
- Judge에게 후보 이름 A/B/C, 기존 점수, 현재 UI 판정을 노출하지 않는다.
- 기존 A/B/C blind-review packet을 proxy-gold 입력으로 재사용하지 않고 raw-only Judge packet을 별도로 만든다.

### 축별 출력

- 상태: `condition_present`, `explicit_no_condition`, `unknown`, `unresolved`
- 정규화된 조건 또는 조건 목록
- 원문 인용구
- 입력 artifact id와 페이지 또는 문단 위치
- 확신도
- 조건의 예외, AND/OR, 적용 기간
- 판단 메모

### 자동 검증

- 인용구가 실제 모델 입력에 존재해야 한다.
- 모델 입력 block 자체에 artifact id와 페이지/문단 marker를 보존하고, 인용구가 해당 block에 존재하는지 검증한다.
- 페이지 또는 문단 위치가 포함된 artifact와 일치하지 않으면 grounding 실패로 처리한다.
- 읽지 못한 예상 첨부파일이 있으면 `explicit_no_condition`을 확정할 수 없다.
- 숫자, 날짜, 지역, 업력 구간의 정규화 전후 값을 함께 보존한다.
- 출력 잘림이나 스키마 복구가 발생하면 해당 축을 확정 label로 사용하지 않는다.

## 5. 성공 지표와 배포 게이트

### 품질 지표

- 핵심 자격조건 precision 95% 이상
- 핵심 자격조건 recall 85% 이상
- 근거 grounding 98% 이상
- 20개 inspectable 축의 상태 정확도 90% 이상
- 화면에는 22개 축을 모두 표시하되 `premises`, `export_performance` 2개 reserved 축은 accuracy/recall 분모에서 제외한다.
- 불완전한 입력에서 잘못 확정한 `explicit_no_condition` 0건
- 부적격 기업을 `추천 가능`으로 만든 critical false pass 0건
- 첨부파일 cohort에서 C의 recall이 B보다 10%p 이상 향상
- 위 향상에서 precision 하락은 3%p 이내
- sealed holdout 출력 잘림 0건

### 판정

- B와 C 모두 통과: 비용과 latency를 비교해 기본값을 선택하고 첨부파일 필요 시 C로 승격한다.
- B만 통과: API-only를 우선 출시하고 첨부파일 경로를 수정한다.
- C만 recall을 높이고 precision을 해침: C를 운영에 쓰지 않고 조건 병합과 근거 검증을 수정한다.
- critical false pass가 1건이라도 발생: 운영 교체 금지, shadow만 유지한다.
- sealed holdout이 실패하면 같은 holdout에 맞춰 튜닝하지 않는다. 새 validation 원인을 수정한 뒤 다음 리비전에서 새 holdout을 만든다.

## 6. 빠른 실행 순서와 결정 게이트

### Gate 0: population freeze

- 현재 지원 가능한 공고 모집단과 층별 건수를 출력한다.
- 정확한 40건 manifest와 예상 외부 호출 수를 사용자에게 제시한다.
- 전체 모집단을 다 읽었는지 population count/hash로 증명하며 overflow나 quota shortfall이면 실패를 명시한다.
- 이 단계에서는 외부 LLM을 호출하지 않고 DB도 쓰지 않는다.

### Gate 1: contract implementation

- proxy-gold schema, 판정 합의, 근거 검증, checkpoint 계약을 먼저 테스트한다.
- 기존 12건 중 3건을 이용해 네트워크 없는 fixture 테스트를 통과시킨다.
- 기존 12건 runner를 확장하지 않고 새 evaluation runner를 만든다. 기존 runner의 blind packet과 reveal key 동시 생성 동작을 상속하지 않는다.
- checkpoint는 run version뿐 아니라 manifest, 입력, converter, extractor, Judge model/prompt/schema의 전체 fingerprint가 일치해야 재사용한다.

### Gate 2: 3건 paid smoke

- 희소 공고 1건, 첨부파일 공고 1건, 구조화 대조군 1건만 실행한다.
- 3건은 validation 24건 안에서 고르며 이후 전체 호출 수에도 포함한다.
- 출력 잘림, 근거 누락, `조건 없음` 오판, checkpoint 복구를 확인한다.
- 실패가 있으면 전체 배치를 시작하지 않는다.

### Gate 3: validation 24건

- 체크포인트 단위로 실행하고 실패 공고만 재시도한다.
- 결과를 보고 프롬프트 또는 스키마를 단 한 번만 보정할 수 있다.
- 보정 후 모델, 프롬프트, extractor, judge, 입력 해시를 모두 freeze한다.

### Gate 4: sealed holdout 16건

- 중간 결과를 보고 튜닝하지 않는다.
- config freeze receipt 없이는 sealed runner가 시작되지 않는다.
- sealed 실행 중에는 공고별 점수와 중간 aggregate를 출력하지 않고 완료 여부와 실패 영수증만 남긴다.
- 완료 후 별도 reveal 명령에서만 key를 열고 지표와 critical false pass를 계산한다.

### Gate 5: IR surface

- 공고별 22축 분석 상태와 근거를 보여준다.
- 읽은 API/PDF/HWP 수와 실패 artifact를 보여준다.
- 현재 방식과 개선 방식의 매칭 판정 변화를 보여준다.
- proxy-gold와 실제 운영 반영 여부를 명확히 구분한다.

## 7. 외부 호출과 반복 예산

- 외부 호출은 plan 모드에서 예상 수량을 먼저 출력한다.
- paid mode는 명시적 confirmation 문자열 없이는 실행되지 않아야 한다.
- 40건 전체의 절대 상한은 extraction B 40회, 서로 다른 C 입력 최대 40회, Judge 1/2 합계 80회, Judge 3 최대 40회로 총 200회다. 재시도도 이 상한에 포함한다.
- runner는 다음 호출 전 persisted call ledger를 확인하고 `--maxCalls`를 넘으면 fail closed한다.
- plan 모드는 gate별 호출 수, 입력 token 추정치, 모델별 비용 추정치를 출력한다.
- 공고와 stage 단위 checkpoint를 먼저 기록하고 성공 결과를 재호출하지 않는다.
- B 성공 뒤 C가 실패해도 B 결과와 사용량 영수증을 보존하며 C만 재시도한다.
- checkpoint에는 stage별 시도 횟수를 저장한다.
- 동일 실패는 한 번만 재시도한다. 두 번째 실패부터는 실패 artifact로 남기고 다음 공고로 진행한다.
- 전체 배치 재실행을 금지하고 실패 checkpoint만 선택적으로 재처리한다.
- validation 프롬프트 보정은 한 번만 허용한다.
- sealed holdout 재실행은 provider 장애나 손상된 checkpoint처럼 결과와 무관한 실행 실패에만 허용한다.
- 같은 원인으로 두 차례 구현 수정이 실패하면 해당 경로를 중단하고 coordinator decision gate로 올린다.

## 8. 오케스트레이션 운영 계약

### coordinator 책임

- 이 문서를 범위 정본으로 유지한다.
- 작업 시작 전에 입력, 출력, 소유 파일, 검증 명령, 금지 사항을 각 worker에 전달한다.
- worker 결과를 직접 확인한 뒤에만 다음 gate를 연다.
- 범위 변경, 유료 호출 확대, 운영 DB 쓰기, 운영 게시에는 별도 decision gate를 둔다.
- 구현 중 새 아이디어는 현재 작업에 섞지 않고 후속 목록으로만 남긴다.

### worker 분리

- Cohort worker: 모집단, 층화, manifest만 담당한다.
- Judge worker: proxy-gold 계약과 판정 코드만 담당한다.
- Report worker: 집계와 IR 정적 화면만 담당한다.
- Reviewer: 파일 수정 없이 입력 누수, 근거 환각, false pass, sealed holdout 오염을 검토한다.
- 두 worker가 같은 파일을 동시에 수정하지 않는다.

### 반복 한도

- 한 gate는 구현 1회, 독립 검토 1회, 수정 1회를 기본 한도로 한다.
- 검증은 focused test에서 시작해 gate 단위로 넓힌다. 매 수정마다 전체 빌드를 반복하지 않는다.
- 15분 이상 진행 변화가 없으면 같은 방법을 반복하지 않고 checkpoint와 blocker를 보고한다.
- worker가 범위를 벗어나면 coordinator가 즉시 중단하고 남은 작업을 재분할한다.
- 장기 실행은 60초 이내 상태를 남기고, 사용자에게 숨긴 채 수 시간 반복하지 않는다.

## 9. 파일과 변경 경계

### 기존 파일럿 표면

- `packages/core/src/evaluation/grant-analysis-pilot.ts`
- `apps/web/src/lib/server/ingestion/grantAnalysisPilotCohort.ts`
- `apps/web/src/lib/server/ingestion/grantAnalysisPilotInputs.ts`
- `apps/web/src/lib/server/ingestion/grantAnalysisPilotExtractor.ts`
- `apps/web/src/lib/server/ingestion/grantAnalysisPilotVariants.ts`
- `apps/web/src/lib/server/matches/run-grant-analysis-pilot.ts`

위 표면은 기존 12건 개발 회귀셋이다. 새 40건 평가는 다음 additive 표면으로 분리한다.

- `packages/core/src/evaluation/grant-analysis-evaluation.ts`
- `packages/core/src/evaluation/grant-analysis-evaluation.test.ts`
- `apps/web/src/lib/server/ingestion/grantAnalysisEvaluationCohort.ts`
- `apps/web/src/lib/server/ingestion/grantAnalysisEvaluationCohort.test.ts`
- `apps/web/src/lib/server/ingestion/grantAnalysisEvaluationJudge.ts`
- `apps/web/src/lib/server/ingestion/grantAnalysisEvaluationJudge.test.ts`
- `apps/web/src/lib/server/matches/run-grant-analysis-evaluation.ts`
- `apps/web/src/lib/server/matches/run-grant-analysis-evaluation.test.ts`
- `apps/web/src/lib/server/matches/render-grant-analysis-evaluation.ts`

### 작업트리 보호

- 현재 작업트리의 apply-workspace, 디자인, 발표자료 변경은 이 트랙 소유가 아니다.
- `git add -A`, 광범위 포맷, 관련 없는 파일 수정은 금지한다.
- 개발 서버는 사용자가 소유하며 이 파일럿이 시작하지 않는다.
- DB 쓰기와 운영 게시 기능은 추가하지 않는다.

## 10. 완료 산출물

- 정확한 40건 cohort manifest
- 실행 설정과 모델/프롬프트/입력 해시
- 공고별 22축 proxy-gold ledger
- A/B/C 비교 결과
- 외부 호출 및 실패 영수증
- validation과 sealed holdout 분리 지표
- critical false pass 목록
- IR용 정적 분석 화면
- go/no-go 및 점진 전환 권고

## 11. 점진 전환 정책

파일럿 통과 후에도 기존 구조를 한 번에 교체하지 않는다.

1. 신규 수집 공고에 analysis-v2를 shadow로 생성한다.
2. 현재 지원 가능한 공고 중 revision이 바뀐 공고만 다시 분석한다.
3. 품질 gate를 통과한 분석만 기존 criteria 게시 후보로 만든다.
4. 운영 게시의 기존 사람 검토 요건은 별도 정책 변경 전까지 유지한다.
5. 과거 종료 공고 backfill은 IR과 신규 수집 안정화 이후에 판단한다.
