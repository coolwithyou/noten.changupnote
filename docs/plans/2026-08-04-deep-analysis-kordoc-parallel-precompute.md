# 딥 분석 시점 Kordoc 바이너리 선분석 통합 계획

> 작성일: 2026-08-04  
> 상태: 체크포인트 1·2 완료 · 체크포인트 3 제한 운영 검증 완료 · Kordoc 상시 worker 활성화 완료(딥분석 worker는 observe-only 유지)
> 범위: 딥 분석과 HWP/HWPX 빠른 작성 분석의 실행 시점·결과 결속·서빙 준비 보장  
> 비범위: 공고 수집 정책 변경, 22축 매칭 규칙 변경, 사용자 지원서 작성 UI 재설계, 별도 범용 workflow/Cloud Run Job 신설

## 1. 결론

바이너리 첨부 분석은 사용자가 지원서 작업공간에 들어온 뒤 시작하면 안 된다. 공고의 22축 딥 분석을 시작하는 시점에 다음 두 작업을 **같은 공고 실행의 형제 작업**으로 동시에 시작한다.

1. 공고문·첨부 markdown을 이용한 22축 신청 자격 딥 분석
2. 원본 HWP/HWPX 바이트를 Kordoc으로 구조 파싱하고, 높은 수준의 모델로 빠른 작성 필드를 판정하는 지원서 분석

두 작업을 하나의 프롬프트나 하나의 모델 응답으로 합치지는 않는다. 22축 분석은 의미 자격 판정이고 Kordoc 분석은 바이너리 좌표·표·양식 개체를 보존해야 하므로 입력과 실패 형태가 다르다. 대신 같은 `grantId`·같은 실행 수명주기에서 병렬로 실행하고, 불변 산출물끼리 ID와 원본 SHA-256으로 결속한다.

사용자 작업공간은 더 이상 최초 분석을 소유하지 않는다. 작업공간 진입 시의 분석 트리거는 누락·구버전·원본 변경을 복구하는 안전망으로만 남긴다.

## 2. 반드시 지켜야 할 제품 불변식

### 2.1 실행 시점

- 딥 분석 대상 공고가 실행을 시작하면 지원 양식 분석도 같은 시점에 시작한다.
- 같은 공고의 두 분석은 `Promise.allSettled` 의미로 병렬 실행한다.
- Kordoc 실패가 22축 분석 성공을 실패로 바꾸지 않고, 22축 실패도 이미 완료된 Kordoc 산출물을 폐기하지 않는다.
- 공고마다 외부 병렬 단위는 `22축 1개 + Kordoc 1개`로 제한한다.
- Kordoc 내부 문서는 순차 파싱을 유지하고, 구독 CLI 후보 판정 호출의 동시성은 최대 1~2개로 제한한다.

### 2.2 사용자 접근 전 준비

지원 HWP/HWPX 원본이 있는 공고는 서빙·승격 전에 다음 중 하나의 명시적 종결 상태를 가져야 한다.

| 상태 | 의미 | 사용자 동작 |
|---|---|---|
| `complete` | 구조 검수까지 통과하고 빠른 작성 필드가 준비됨 | 선계산 필드를 즉시 사용 |
| `partial` | 안전하게 확정한 필드는 준비됐으나 일부 구조는 직접 편집 필요 | 확정 필드 사용 + 직접 편집 안내 |
| `review_required` | 자동 위치 확정이 안전하지 않음 | 문서 직접 편집 모드 제공 |
| `not_applicable` | HWP/HWPX가 없거나 지원 양식이 아님 | 빠른 작성 미노출 |
| `failed` | 원본·파서·모델·저장 실패 | 운영 재처리 대상으로 분리, 사용자에게 지연 분석을 시작하지 않음 |

`pending` 또는 결과 부재인 지원 양식을 빠른 작성 준비 완료로 조용히 표시하지 않는다. 이 상태는 **공고 열람·22축 매칭 전체를 차단하지 않고 빠른 작성 capability에만 적용**한다. 체크포인트 2의 capability 게이트 전까지는 이 규칙을 관측만 하고 기존 서빙을 차단하지 않는다.

### 2.3 모델과 비용

- Kordoc 자체 파싱과 결정적 후보 검출에는 모델 비용이 들지 않는다.
- 모델은 실제 사용자 입력 후보의 맥락 판정에만 사용한다.
- 로컬 분석실에서는 `ANALYSIS_LAB_TRANSPORT=claude-cli`를 그대로 재사용하고 기본 고급 모델은 현재 딥 분석 모델(`claude-opus-5`)을 상속한다.
- 필요할 때만 `ANALYSIS_LAB_ROUNDTRIP_MODEL`로 별도 모델을 명시한다.
- 구독 CLI 실패 뒤 API로 자동 폴백하지 않는다. 의도하지 않은 API 비용을 막기 위해 heuristic 결과 또는 명시적 실패로 종결한다.
- Cloud Run·사용자 대면 운영 경로는 구독 CLI를 사용하지 않고 API transport만 사용한다.

## 3. 현재 구조와 정확한 결손

### 이미 있는 자산

- `analysis-lab/analyze.ts`: 공고별 22축 분석, 구독/API transport, 불변 `LabRun` 저장
- `application-roundtrip/analyze.ts`: R2 원본 HWP/HWPX 로드, Kordoc 문서 분석, 불변 roundtrip 산출물 저장
- `application-roundtrip/analyze-document.ts`: Kordoc 파싱, 문서 역할 분류, 필드·객관식·coverage 검수
- `application-roundtrip/field-planner.ts`: 모델을 이용한 후보별 입력 여부 판정
- `documents/applicationFieldAnalysis.ts`: 작업공간의 운영 필드 materialization
- `batch-runner.ts`: 기간 가드, 대상별 동시성, 비용·구독 윈도 중단

### 결손

1. 두 분석이 별도 진입점이라 딥 분석 완료가 Kordoc 준비 완료를 뜻하지 않는다.
2. roundtrip planner에는 `fetchImpl` 심이 있지만 상위 호출부가 구독 transport를 전달하지 않는다.
3. roundtrip 산출물에 부모 `LabRun`, transport, 요청 모델, timeout의 provenance가 부족하다.
4. 현재 planner는 문서 한 건의 후보 chunk를 모두 `Promise.all`로 실행해 구독 CLI 프로세스를 과도하게 띄울 수 있다.
5. 작업공간 진입 트리거가 사실상 최초 Kordoc 분석을 수행해 사용자가 대기한다.
6. 승격·서빙은 22축 결과만 보고 바이너리 준비 상태를 요구하지 않는다.

## 4. 목표 구조

```text
공고가 딥 분석 대상으로 확정됨
          |
          v
  grant analysis coordinator
          |
          +------------------------------+
          |                              |
          v                              v
  22축 의미 분석                   지원 바이너리 분석
  markdown + 고급 모델            R2 original HWP/HWPX
  LabRun                           Kordoc 구조 파싱
                                   + 고급 모델 필드 판정
          |                              |
          +--------------+---------------+
                         v
              결속된 불변 분석 산출물
       grantId / parentRunId / sourceSha256 / versions
                         |
                         v
             승격 시 운영 필드 materialization
                         |
                         v
            사용자 접근 시 선계산 결과만 조회
```

로컬 구독 분석실은 위 구조를 한 프로세스의 `Promise.allSettled`로 구현한다. 향후 운영 worker는 같은 의미 계약을 **processor의 입력 seal 검증 직후**에 구현하되, Kordoc 전용 멱등 작업을 enqueue하고 22축 primary를 즉시 시작한다. 운영에서 Kordoc R2/CPU/DB 작업을 deep worker 안에 오래 붙잡아 두지 않으며 두 worker의 lease·retry·heartbeat도 분리한다.

### 깊은 모듈 경계

호출부가 DB·R2·Kordoc·Claude 세부를 각각 조립하지 않도록 다음 역할을 한 경계 안에 둔다.

```ts
runGrantAnalysisPrecompute({
  grantId,
  transport,
  deepModel,
  roundtripModel,
}): Promise<{
  deepAnalysis: LabRun;
  applicationDocuments: ApplicationPrecomputeReference;
}>
```

이 경계가 보장할 것은 다음뿐이다.

- 두 작업을 같은 시점에 시작한다.
- 한쪽 실패가 다른 쪽 결과를 지우지 않는다.
- 두 산출물의 결속 ID와 provenance를 기록한다.
- 구독 윈도 소진을 상위 배치 중단 신호로 올린다.

DB materialization, 사용자 draft 생성, UI 응답은 이 경계에 넣지 않는다.

## 5. 결과 계약

### 5.1 딥 분석 런의 참조

`LabRun`에 하위 호환 optional 참조를 추가한다.

```ts
applicationRoundtrip?: {
  status: "complete" | "partial" | "review_required" | "not_applicable" | "failed";
  runId: string | null;
  transport: "api" | "claude-cli";
  model: string;
  documentCount: number;
  sourceCount: number;
  errorCode: string | null;
  error: string | null;
};
```

### 5.2 Roundtrip provenance

`ApplicationRoundtripRun`과 문서별 field planning 요약에 다음을 추가한다.

- `parentLabRunId`
- `transport`
- `requestedModel`
- `timeoutMs`
- `candidateLimit`
- `failureCode`
- 원본별 `storageKey`·`sourceSha256`는 기존 manifest를 그대로 사용

### 5.3 멱등성 키

같은 원본을 불필요하게 다시 분석하지 않는 키는 다음 조합이다.

실제 분석·저장의 정본은 문서 surface별이다.

```text
surfaceId
+ storageKey
+ sourceSha256
+ APPLICATION_ROUNDTRIP_VERSION
+ Kordoc engineVersion
+ field planner prompt/version
+ requestedModel
+ transport class(api | claude-cli)
```

공고 sibling run의 aggregate identity는 정렬된 `(surfaceId, storageKey, sourceSha256)` 목록의 manifest SHA-256이다. 공고 상태는 surface별 결과에서 파생하며, 한 문서의 `review_required`가 다른 문서의 `complete` 필드 사용을 가리지 않게 한다.

체크포인트 1은 불변 산출물과 결속을 먼저 만들고, 체크포인트 2에서 이 키로 기존 산출물 재사용과 DB materialization 멱등성을 구현한다. 문서 처리 상한에 걸린 surface는 버리지 않고 `skipped_limit`으로 명시한 뒤 다음 bounded job에서 처리한다.

## 6. 실패 정책

| 실패 | 22축 결과 | Kordoc 결과 | 다음 행동 |
|---|---|---|---|
| HWP/HWPX 없음 | 그대로 | `not_applicable` | 정상 종결 |
| 일부 문서 파싱 실패 | 그대로 | 성공 문서 기준 `partial` 또는 `review_required` | 실패 원본 운영 노출 |
| 전 문서 파싱 실패 | 그대로 | `failed` | 운영 재처리 |
| 필드 LLM 일반 실패 | 그대로 | heuristic 결과 + `partial/review_required` | API 자동 폴백 금지 |
| 구독 윈도 소진 | 진행 중 작업은 완료 | `failureCode=window_exhausted` | 배치 신규 착수 중단 |
| 22축 모델 실패 | error LabRun 저장 | Kordoc은 완료 가능 | Kordoc 산출물 보존 |
| 저장 실패 | 각 산출물별 실패 | 성공한 다른 산출물 보존 | 재실행 대상 |

`complete`는 field coverage가 실제 `complete`이고 필요한 산출물이 모두 저장됐을 때만 사용한다. heuristic fallback을 무조건 `complete`로 승격하지 않는다.

## 7. 구현 체크포인트

### 체크포인트 1 — 로컬 구독 분석에서 동시 선계산

상태: **구현·검증 완료** (2026-08-04)

검증 증거:

- `pnpm lab:roundtrip:test`
- `pnpm lab:application-precompute:test`
- `pnpm lab:batch-runner:test`
- `pnpm --filter @cunote/web typecheck`
- `pnpm --filter @cunote/web build`
- 운영 `deep-analysis/` 경로의 `claude-cli-transport`·`ANALYSIS_LAB_TRANSPORT` 참조 0건

유료 모델 호출·운영 DB 쓰기·Cloud Run/Vercel 배포는 수행하지 않았다.

목표: 사용자가 요구한 실행 시점과 고급 구독 모델 배선을 먼저 실제 코드로 만든다. 운영 DB·서빙은 건드리지 않는다.

구현:

1. application-roundtrip에 `fetchImpl`, explicit model, timeout, transport, parent run ID를 관통시킨다.
2. field planner chunk 호출을 bounded concurrency로 제한한다.
3. lab 공고 실행 coordinator가 22축과 roundtrip을 동시에 시작하고 `allSettled`로 결속한다.
4. roundtrip 결과를 딥 분석 런에 참조로 기록한다.
5. `lab:batch`에 명시적 `--with-application-roundtrip`을 먼저 추가한다.
6. 구독 transport일 때 고급 딥 분석 모델을 roundtrip 기본 모델로 상속한다.
7. 첨부 부재·부분 실패·윈도 소진을 구분해 저장한다.

검증:

- 두 작업이 서로 완료되기 전에 모두 시작됐음을 barrier 테스트로 증명
- roundtrip 실패가 `LabRun.error`를 바꾸지 않음을 증명
- explicit model·transport·timeout이 fake fetch까지 전달됨을 증명
- planner 최대 동시 호출 수가 설정값을 넘지 않음을 증명
- 기존 API/heuristic 작업공간 호출이 변하지 않음을 회귀 테스트
- 운영 worker 사슬에서 `claude-cli-transport` 참조가 0건임을 `rg`로 검증
- 유료 모델 호출 없이 테스트·typecheck 수행

커밋 기준: 위 검증이 전부 통과한 한글 커밋 1개. Cloud Run·Vercel 배포 없음.

### 체크포인트 2 — 승격 materialization과 사용자 대기 제거

상태: **구현·검증 완료** (2026-08-04)

구현 결과:

- `LabRun`·roundtrip run·manifest의 grant/parent/version/source SHA seal을 검증한다.
- surface별 `field_candidates` JSON을 content-addressed R2 key에 저장하고, 원본 SHA·분석 버전 identity가 바뀌면 과거 artifact pointer를 덮지 않는다.
- 22축 승격이 완료된 뒤 별도 짧은 transaction에서 `grant_document_fields` projection을 적용한다. 실패는 observe-only로 기록해 유효한 매칭 승격을 되돌리지 않는다.
- `complete/partial`만 안전 필드를 materialize하고 `review_required/not_applicable/failed`는 종결 artifact만 보존한다.
- 작업공간은 current artifact를 먼저 읽고, missing/stale 또는 완료 artifact의 projection 누락일 때만 사용자 진입 복구 분석을 한 번 실행한다.
- current 종결 상태는 반복 분석 대신 직접 편집 안내와 RHWP Studio 진입점을 제공한다.
- 문서 10개 상한 밖 원본은 `document_limit_exceeded`로 봉인해 조용한 누락 완료를 막는다.

검증 증거:

- `pnpm lab:roundtrip:test`
- `pnpm lab:application-precompute:test`
- `pnpm lab:application-materialization:test`
- `pnpm lab:promote:test`
- `pnpm test:apply-workspace`
- `pnpm verify:virtual-company-flow`: 5개 공고 평가 → 목표 공고 추천 → 필수조건 3건 충족 → HWP 원본 SHA 확인 → 저장 필드 5개 workspace 즉시 조회
- `pnpm --filter @cunote/web typecheck`
- `pnpm build:web`

유료 모델 호출·운영 materialization 쓰기·Cloud Run/Vercel 배포는 수행하지 않았다. 승격 차단은 아직 열지 않았고, 체크포인트 3에서 2건의 정상 공고와 1건의 부분/검토 공고를 observe-only로 측정한 뒤 별도 판단한다.

목표: 선계산 artifact를 승격 시 운영 `grant_document_fields`로 materialize해 사용자 접근 시 계산을 없앤다.

구현:

1. roundtrip artifact 검증기와 source SHA/version 멱등성 확인
2. `document_artifacts.kind=field_candidates`의 content-addressed 불변 JSON 저장
3. 승격 트랜잭션에서 지원 surface·field map materialization
4. `complete/partial/review_required/not_applicable/failed` 운영 상태 저장
5. 지원 바이너리가 있는데 상태가 `pending/missing`이면 관측 경고
6. 작업공간 트리거를 stale/missing 복구 전용으로 전환
7. 가상 기업 E2E에서 매칭 → 공고 상세 → 작업공간이 선계산 필드를 즉시 읽는지 검증

초기에는 승격 차단을 `observe_only`로 측정한다. 실제 차단 전 최소 2건의 정상 공고와 1건의 부분/검토 공고를 통과시킨다.

커밋 기준: materialization·idempotency·workspace 회귀 테스트와 clean exact-commit 검증을 통과한 한글 커밋 1개.

### 체크포인트 3 — 운영 API 어댑터와 관제·백로그

목표: 운영 딥 분석 worker가 활성화될 때도 같은 계약으로 실행하고, 현재 누락된 과거 바이너리만 bounded backfill한다.

구현:

1. production API transport adapter를 같은 coordinator 인터페이스에 연결
2. `deep-analysis/processor.ts`의 seal 검증 직후 Kordoc 전용 멱등 작업을 enqueue하고 22축 primary를 기다림 없이 시작
3. surface 단위 전용 job과 heartbeat를 두고 identity unique, lease·retry·heartbeat·동시성을 deep worker와 분리
4. Cloud Run worker에는 구독 transport가 절대 유입되지 않는 격리 테스트
5. ops에 공고별 두 분석의 시작·완료·원본 수·문서 수·필드 수·상태·버전·비용·오류 노출
6. `preview_ready`인데 field map이 없는 기존 HWP/HWPX를 bounded cohort로 산출
7. 신규 공고 우선, 과거 백로그는 별도 낮은 동시성으로 처리
8. 관측 데이터가 안정된 뒤 승격 fail-closed 여부를 별도 결정

운영 worker mode 변경, Scheduler 수정, 실제 배포는 이 체크포인트 구현과 검증 후 별도 승인으로만 수행한다.

#### 구현 결과 (2026-08-04)

- [x] 운영 Kordoc worker는 공용 `analyzeRoundtripDocument`에 `transport: "api"`를 명시해 같은 문서·필드 계약을 사용한다.
- [x] 봉인 검증 직후 전용 enqueue와 22축 primary를 병렬 착수하고, enqueue 오류가 22축 결과를 폐기하지 않도록 분리했다.
- [x] surface + 원본 SHA + 분석 버전 unique job, 독립 lease/retry/heartbeat, API usage·비용 원장을 추가했다.
- [x] `/notice-pipeline` 요약과 공고 상세에 22축/Kordoc 시작·완료·문서·필드·버전·비용·오류를 노출했다.
- [x] 과거 대상은 `application-precompute:backfill`의 기본 dry-run, 1회 최대 50 surface로 제한했다. 신규 딥분석 enqueue 우선순위 100, 과거 backfill -100으로 신규를 우선한다.
- [x] 운영 진입점에 구독 CLI import와 `ANALYSIS_LAB_TRANSPORT`가 없고 API transport가 고정되는 격리 테스트를 추가했다.
- [ ] migration `0067_familiar_anthem.sql` 적용, worker active 전환, Scheduler/Cloud Run 배포, 실제 20~50건 cohort 실행은 이 체크포인트에서 수행하지 않았다.
- [ ] 승격 fail-closed 여부는 observe-only cohort의 coverage·비용·오류 관측 후 결정한다.

#### 운영 준비 체크포인트 (2026-08-05)

- [x] `0067_familiar_anthem.sql`을 현재 연결된 운영 DB에 적용했다. 전용 job/heartbeat 테이블과 8개 인덱스를 확인했고 적용 직후 두 테이블은 모두 0건이었다.
- [x] Next 개발 서버만 `apps/web/.env.development.local`을 읽고 루트의 `pnpm lab:*` CLI는 읽지 않던 설정 분기를 제거했다. 딥분석 배치, 스모크, AI 검수, 블라인드 감사, 확인 질문 CLI가 동일 로컬 env를 우선 읽는다.
- [x] 독립 Kordoc smoke와 dev API route도 공용 analyzer에 lab binding을 명시 주입한다. `claude-cli` binding 누락 시 field planner는 API로 폴백하지 않고 중단하는 기존 가드를 유지한다.
- [x] 실제 batch dry-run에서 `transport=claude-cli`, Kordoc 형제 분석의 딥분석 모델 상속, API 토큰 미지출 로그를 확인했다.
- [x] 최초 backfill `--limit=20` 상세 검수에서 `status=open`이지만 실제 7월 마감인 stale 공고 20건이 드러났다. enqueue 전에 실제 `apply_end` 한국 날짜 cutoff를 추가하고 회귀 테스트로 고정했다.
- [x] 보정 후 dry-run cohort는 비마감 surface 20건 / 공고 16건 / 원본 약 1.78MB이며 protected 0, current 0이다. dry-run이므로 enqueue/job/model 호출은 모두 0건이다.
- [x] 20건을 단일 analysisVersion과 16개 grant bounded scope로 enqueue하고 동시성 1로 관측했다. 일일 상한 직전까지 14건 모두 성공(complete 8, partial 2, not_applicable 4), 실패 0, artifact 14, field 469개를 저장했다.
- [x] 실제 비용은 44 request / input 456,653 / output 97,258 token / `$1.885886`이었다. not_applicable 4건은 모델 호출과 비용이 모두 0이었다.
- [x] 기존 상한은 완료 비용만 비교해 다음 한 건만큼 초과할 수 있었다. cohort 최대 실측 `$0.293390`보다 여유 있는 기본 `$0.50` job reserve를 claim 전에 합산하도록 보강했다.
- [x] 비용 중단 invocation에서 claimed 0 / budgetStopped true, 남은 6건 pending·attempt 0을 확인했다.
- [x] `/notice-pipeline` 서버 detail 조회로 deep-analysis pending과 Kordoc job 2/2 완료, surface별 모델·토큰·비용·필드·상태가 노출되는 것을 확인했다.
- [x] 기존 pending 6건과 신규 동시 시작 공고 1건을 6개 grant bounded scope·동시성 1로 모두 종결했다. 기존 `$1.885886`에서 추가 비용은 `$0.876004`였고, 임시 invocation 상한 `$4` 안에서 최종 누적 `$2.761890`으로 끝났다. Scheduler·Cloud Run·기본 `$2` 정책은 변경하지 않았다.

#### 신규 공고 동시 시작 검증 (2026-08-05)

- [x] 비마감 visible 공고 `[한양대학교] 2026년 제23기 한양스타트업아카데미 교육생 모집`(`kstartup:178677`) 1건을 bounded claim으로 고정했다. 실행 전 입력은 7,656자·첨부 5건으로 봉인됐고 현재 v25 run과 Kordoc job은 모두 0건이었다.
- [x] exact commit `e87d77c0016d16a19abd51febd55435e23268d72`의 production deep worker를 최대 1건·동시성 1로 실행했다. enqueue 1 / claim 1 / success 1 / failure 0이며 22축 전부, 독립 감사 `concur`, exception 0건으로 `analysis_complete`를 통과했다.
- [x] 딥분석 run `da-20260805T062018039Z-213eef61-2f6f-41bc-bd6f-c039cca0c23d`의 실제 사용량은 input 62,973 / output 8,865 token, 총비용 `$0.446805`였다.
- [x] `input_sealed` receipt는 `06:20:23.218556Z`, 같은 run에 결속된 Kordoc job 생성은 `06:20:23.311275Z`였다. Kordoc enqueue는 primary 완료 receipt `06:22:09.139028Z`보다 약 106초 앞서므로 후처리 순차 실행이 아니라 같은 봉인 시점의 병렬 착수임을 확인했다.
- [x] `/notice-pipeline` 서버 detail은 딥분석 `succeeded/passed`와 비용, Kordoc `pending`과 HWP surface·원본 SHA·analysisVersion을 같은 공고에서 노출했다.
- [x] Kordoc active worker를 같은 grant 한 건으로 제한해 재실행했으며, 일일 비용 `$1.885886 / $2`와 job reserve `$0.50` 때문에 claim 0 / success 0 / failure 0 / `budgetStopped=true`로 종료했다. pending job의 attempt는 0으로 보존됐으며 상한을 높이거나 우회하지 않았다.
- [x] 신규 HWP는 `complete`, 후보 8개 중 필드 7개를 materialize했고 workspace 저장 경로가 216ms에 같은 7개를 읽었다. 상태는 `current=true`, 원본 SHA와 artifact가 일치했으며 추가 모델 호출은 없었다. ops 상세도 Sonnet 5/API, 요청 1회, `$0.022426`, 필드 7개와 완료 시각을 노출했다.
- [x] 나머지 6건은 `partial` 2건(필드 50+37), `review_required` 1건, `not_applicable` 3건으로 정상 종결됐다. `review_required/not_applicable`은 필드를 자동 반영하지 않았고 전체 7건에서 실패·retry·dead letter는 0건이었다.
- [x] release `deep-production-r1-20260805T072410Z-036af33b`를 준비하고 aggregate `GO`(blocking 4/4, source drift 0), shadow `PASS`(공고 1 × 회사 131, issue 0), dry-run `PASS`(baseline 1/1, source drift 0)를 통과한 뒤 현재 사용자 승인과 분리된 실행 actor로 canary·전체 승격했다.
- [x] release와 item은 각각 `active`·`applied`다. promotion snapshot 검증 issue 0, canary와 전체 serving 검증이 모두 PASS했고 `analysis_complete`, `publication_complete`, `serving_complete`, `analysis_fresh`가 전부 true이며 blocker가 없다. 랜딩의 `requireDeepAnalysisPromotion=true` active universe에서도 대상 공고와 새 criteria 3건을 읽었다.
- [x] 운영 도구 후속 개선: `lab:aggregate`와 `lab:shadow`가 웹 개발 환경과 같은 analysis-lab env 계약을 읽고, aggregate도 성공·실패 후 DB 연결을 닫는다. `pnpm lab:shadow-key:init`은 gitignored `apps/web/.env.development.local`에 전용 32-byte 랜덤 HMAC 키를 한 번만 생성·재사용하며 값은 출력하지 않고 파일 권한을 `0600`으로 고정한다.

#### 상시화 안전 게이트 — 코드 체크포인트 (2026-08-05)

- [x] claim마다 UUID lease token과 attempt 원장을 함께 생성한다. 모델 batch가 성공할 때마다 request·token·비용을 원장에 누적하고, 실패·만료 attempt는 최소 job reserve를 일일 비용에 남겨 이미 지출됐을 수 있는 비용이 사라지지 않게 했다.
- [x] 일일 비용과 동시 실행 capacity 확인, 비용 reserve, job lease, attempt 생성은 전역 advisory lock 안의 단일 SQL로 묶었다. 분석 버전이 바뀌어도 서로 다른 worker가 같은 일일 예산을 중복 예약하지 않는다.
- [x] lease는 처리 시작·처리 중·종결 직전에 갱신한다. complete/fail/materialization은 `job + attempt + worker_id + lease_token + leased status`를 검증해 소유권을 잃은 worker의 결과 덮어쓰기를 거부한다.
- [x] 만료 lease sweep은 재시도 가능한 job을 `retry_wait`로, 최종 attempt에서 만료된 job을 `dead_letter`로 종결한다. 아직 claim되지 않았지만 공고가 비노출·마감 상태로 바뀐 job은 `canceled`로 정리한다.
- [x] worker invocation 자체를 실행하는 회귀 테스트로 sweep→claim→renewal→process→complete 순서, 비용 중단, 재시도 실패, lease 탈취, 주기 갱신을 검증했다. migration은 현재 leased job이 있으면 중단하고 기존 attempt 비용을 보수적으로 이관한다.
- [x] C6 말소 경로를 닫았다. `extract:grant-document-fields --write`는 해당 공고의 `grant-document-field-extraction-v1` 행만 짧은 transaction으로 교체하며 Kordoc·사람 검수·reconcile 필드는 보존한다.
- [x] Kordoc enqueue 실패를 최신 딥분석 run의 append-only `application_precompute_enqueue_failed` 운영 예외로 기록한다. 22축 결과는 실패시키지 않고 성공·실패 primary receipt에도 outcome을 남기며 `/notice-pipeline` 요약과 공고 상세에서 현재 오류로 집계한다.
- [x] LLM `timeout/http/invalid response/request failed`는 Kordoc 구조 후보를 버리지 않고 `partial` 또는 `review_required`로 정상 종결한다. API key·transport 설정 실패는 계속 차단하며, 부분 성공 usage는 완료 시 0으로 덮지 않고 attempt 실제 비용과 보수 reserve를 유지한다.
- [x] `0068_glamorous_dagger.sql`을 운영 DB에 적용했다. 적용 전 succeeded 21·leased 0을 확인했고, 적용 후 attempt 21건·charged cost `$2.761890`, lease token 잔존 0건, field map 619건(Kordoc 568·reconcile 51)으로 기존 결과가 보존됨을 확인했다.
- [x] 기존 `cunote-deep-analysis` Cloud Run execution이 명시적 `APPLICATION_PRECOMPUTE_EXECUTE=1`일 때만 독립 Kordoc queue cycle을 추가 실행하도록 배선했다. 플래그가 없으면 heartbeat를 포함한 mutation 0건이고, 딥분석 worker mode와 Kordoc worker mode·claim scope·일일 비용 상한은 서로 독립이다.
- [x] Cloud Run의 딥분석 worker는 `observe_only`를 유지하고 Kordoc만 `active/all`, invocation당 1건·동시성 1·일일 `$2`로 활성화했다. 정확한 3개 Job image 배포와 수동 smoke·Scheduler 실행을 확인했다.

#### 상시화 운영 적용 증거 (2026-08-05)

- [x] `sw@noten.im` base account, `changupnote-com`, `asia-northeast3`를 다시 인증했고 tokeninfo에서 실제 API actor가 `cunote-codex-dev@changupnote-com.iam.gserviceaccount.com`임을 확인했다.
- [x] exact source commit `e00cee9a346ff88ae879f3739c8802949976a03e`를 원격 `main`에 push한 뒤 Cloud Build `0a9316bc-61a3-462b-825e-432c26bc06ab`로 빌드했다. 세 Job은 immutable digest `sha256:dd059e081c536a0e9197583883271ab885434af6ceda1f28d3b35e9047da63b0`와 같은 commit SHA를 사용한다.
- [x] Ready generation은 main `96/96`, input preparation `32/32`, serving monitor `25/25`다. 기존 runtime service account, timeout, retry 0, command/args, secret 참조와 Scheduler의 enabled·주기·KST 설정을 보존했다.
- [x] main observe-only smoke `cunote-deep-analysis-6n7l2`는 22축 enqueue·analysis·budget mutation 0건, Kordoc observe-only claim 0건으로 성공했다. input preparation `cunote-deep-analysis-input-preparation-qztl9`도 성공했다.
- [x] Kordoc active smoke `cunote-deep-analysis-lwdr5`와 5분 정시 Scheduler execution `cunote-deep-analysis-4cdc8`은 모두 성공했다. 두 실행은 deep worker `observe_only`, Kordoc `active/all`, `claimed=0`, `budgetStopped=true`, 오류 0을 기록했다.
- [x] 적용 후 DB read-only 검증은 job 21건 전부 succeeded, attempt 21건 전부 succeeded, charged cost `$2.761890` 불변이다. 최신 heartbeat는 API/Sonnet 5, 일일 cap `$2`, reserve `$0.5`, active/all과 budget stop을 동일하게 기록했다.
- [!] serving monitor 수동 execution `cunote-deep-analysis-serving-monitor-9s4zx`는 새 release `deep-production-r1-20260805T072410Z-036af33b`를 PASS했지만 2026-07-31의 일부 과거 active release에서 promotion snapshot 이후 criteria hash·trace가 바뀐 기존 drift를 찾아 전체 FAIL했다. Kordoc 활성화와 무관하며 이 기록을 삭제하거나 monitor를 우회하지 않았다.

검증 명령은 `pnpm lab:roundtrip:test`, `pnpm application-precompute:test`,
`pnpm verify:deep-analysis-contract`, web/admin typecheck·build다.

### 7.4 Kordoc 구독 자동 재판정 루프 (2026-08-09)

- 로컬 `claude-cli` 경로는 기존 문서당 180개 후보 절단을 제거하고 모든 후보를 20개 묶음·동시성 1로 처리한다. 운영 API 경로는 비용 경계를 위해 180개 상한을 유지한다.
- 최초 Opus 5 판정에서 응답이 빠졌거나 거절 확신이 0.75 미만인 후보만 최대 2회 다시 판정한다. 낮은 확신을 확정 거절로 바꾸지 않으며 두 번 뒤에도 모호하면 명시적 미해결로 종결한다.
- 산출물에는 최초·재판정을 합친 request/token/명목 비용과 처리·미처리 후보 수, 재판정 횟수·대상 수·잔여 미해결 수·실패 코드를 기록한다. 계약은 `kordoc-application-roundtrip-v6`이다.
- 미해결 후보가 남아도 Opus가 확정한 필드가 있으면 해당 필드만 `partial`로 materialize한다. 모호한 필드는 candidate artifact에 보존하고 빠른 작성에서 제외해 전체 양식을 버리지 않는다.
- 배치 진행, 런 상세, Kordoc 검토 화면은 AI 재판정 횟수와 잔여 미해결 수를 표시한다. 구독 실패 시 API 자동 폴백은 계속 금지한다.

검증 기준은 205개 후보 전수 처리, API 180개 상한 보존, 누락·저신뢰 후보 2회 이내 해소, 2회 뒤 모호한 후보의 비강제 종결, 안전 필드 `partial` materialization이다.

#### 기존 검토 필요 사례 피드백 검증 (2026-08-09)

- 과거 Opus 5 산출물 6개 공고의 봉인 원문과 `fieldCoverage.unresolvedCandidates`만 새 재판정기에 다시 넣었다. 불변 artifact와 DB는 덮어쓰지 않았고 운영 API 폴백도 사용하지 않았다.
- 총 446개 미해결 후보가 0개로 줄었다. Opus는 입력 276개와 비입력 170개로 나눴고 호출 실패는 없었다.
- 공고별 변화는 `6→0`, `4→0`, `34→0`, `55→0`, `128→0`, `219→0`이다. 4·34·128개 사례에서는 최초 결과 중 낮은 확신만 1차 자동 재판정해 모두 해소했다.
- 55개 사례는 미해결 후보는 0이 됐지만 별도 구조 좌표 경고 때문에 `partial`로 남았다. 확정된 55개 입력 필드는 새 정책에 따라 빠른 작성에 사용할 수 있고, 구조적으로 불안한 위치만 제외된다.
- 대상 후보만 재판정한 전체 실행은 33회 모델 호출, 약 39분 16초였다. 가장 큰 219개 사례는 11회 호출, 약 14분 29초였다. 따라서 이 작업은 사용자 진입 시 실행하지 않고 딥분석 배치에서 미리 끝내야 한다.
- 실검증 중 연결이 끊긴 단건 요청과 같은 owner의 새 요청이 겹칠 수 있음을 발견했다. 로컬 프로세스에 단일 실행 락을 추가해 두 번째 요청은 모델 호출 전에 `local_analysis_already_running`으로 차단하고, 첫 실행 종료 뒤에는 락이 해제되도록 회귀 테스트로 고정했다.
- 저장까지 포함한 v6 카나리는 장애인기업 마케팅 공고의 HWP 2개·후보 33개를 약 2분 9초에 처리했다. `claude-cli`/`claude-opus-5`, 처리 33/33, 잔여 미해결 0, 필드 5+2, 오류 0으로 `roundtrip-2026-08-08T200254.085Z-183b70` 불변 artifact가 생성됐다. 실행 중 같은 owner의 두 번째 dev API 요청도 실제로 409 차단됐다.

### 7.5 2026-08-04 읽기 전용 backlog 기준선

계획 수립 중 production DB를 read-only transaction으로 집계했으며 쓰기는 롤백했다.

- 비마감 visible `preview_ready` HWP/HWPX 중 field map이 없는 우선 대상: **513 surface / 311 공고 / 약 96MB**
- 전체 visible open 기준: 787 surface / 약 143MB
- `fields_ready`: 2 surface뿐이며, Kordoc 자동 map은 1건 5 fields
- 비마감 후보의 공고당 surface: p50 1, p95 4, 최대 11
- `document_artifacts.kind=field_candidates`: 현재 0건

따라서 첫 운영 backfill은 전체 513건을 즉시 처리하지 않는다. 체크포인트 3에서 20~50 surface observe-only cohort로 R2·DB·coverage·모델 usage를 먼저 측정한 뒤 동시성과 일일 한도를 결정한다.

## 8. 과구현 방지선

이번 트랙에서 하지 않는다.

- 22축 분류 체계나 매칭 점수 변경
- Kordoc 파서를 새로 작성하거나 다른 파서로 교체
- 지원서 작성 UI의 대규모 개편
- 모든 과거 공고를 한 번에 backfill
- 별도 범용 workflow engine 도입
- 동일 문서를 22축 프롬프트 안에 다시 바이너리로 첨부
- Kordoc 실패 때문에 유효한 딥 분석을 폐기
- 구독 실패 시 API 자동 폴백
- 사용자 페이지 진입을 분석 작업 큐 트리거로 유지

## 9. 완료 정의

다음이 모두 참일 때 이 목표를 완료로 본다.

1. 새 딥 분석 실행에서 22축과 지원 바이너리 분석의 시작 시각이 같은 공고 실행 안에 기록된다.
2. 구독 로컬 배치에서 두 분석 모두 높은 수준의 명시 모델과 같은 transport provenance를 가진다.
3. 원본 HWP/HWPX SHA와 Kordoc/모델 버전이 결과에 남는다.
4. 모든 지원 바이너리가 명시적 종결 상태를 갖는다.
5. 승격된 공고의 작업공간 진입은 모델 호출 없이 저장된 필드 맵을 읽는다.
6. 사용자 진입 복구 경로는 stale/missing 예외에만 동작한다.
7. ops에서 공고별 두 분석의 단계·비용·실패를 확인할 수 있다.
8. 운영 Cloud Run에는 claude-cli 구독 경로가 포함되지 않는다.

## 10. 즉시 실행 순서

1. 체크포인트 1 코드·테스트·커밋
2. 체크포인트 1 리뷰: 동시 시작, 모델 provenance, 실패 독립성, 과도한 CLI 동시성 여부 확인
3. 확인 후 체크포인트 2 착수
4. 체크포인트 2 E2E 통과 후에만 체크포인트 3 범위를 연다
