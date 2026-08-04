# 딥 분석 시점 Kordoc 바이너리 선분석 통합 계획

> 작성일: 2026-08-04  
> 상태: 구현 대기 — 체크포인트 1부터 순차 적용  
> 범위: 딥 분석과 HWP/HWPX 빠른 작성 분석의 실행 시점·결과 결속·서빙 준비 보장  
> 비범위: 공고 수집 정책 변경, 22축 매칭 규칙 변경, 사용자 지원서 작성 UI 재설계, Cloud Run 활성화·배포

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

`pending` 또는 결과 부재인 공고를 조용히 사용자에게 서빙하지 않는다. 다만 체크포인트 2의 승격 게이트 전까지는 이 규칙을 관측만 하고 기존 서빙을 차단하지 않는다.

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

```text
grantId
+ sourceSha256
+ APPLICATION_ROUNDTRIP_VERSION
+ Kordoc engineVersion
+ field planner prompt/version
+ requestedModel
+ transport class(api | claude-cli)
```

체크포인트 1은 불변 산출물과 결속을 먼저 만들고, 체크포인트 2에서 이 키로 기존 산출물 재사용과 DB materialization 멱등성을 구현한다.

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

목표: 선계산 artifact를 승격 시 운영 `grant_document_fields`로 materialize해 사용자 접근 시 계산을 없앤다.

구현:

1. roundtrip artifact 검증기와 source SHA/version 멱등성 확인
2. 승격 트랜잭션에서 지원 surface·field map materialization
3. `complete/partial/review_required/not_applicable/failed` 운영 상태 저장
4. 지원 바이너리가 있는데 상태가 `pending/missing`이면 관측 경고
5. 작업공간 트리거를 stale/missing 복구 전용으로 전환
6. 가상 기업 E2E에서 매칭 → 공고 상세 → 작업공간이 선계산 필드를 즉시 읽는지 검증

초기에는 승격 차단을 `observe_only`로 측정한다. 실제 차단 전 최소 2건의 정상 공고와 1건의 부분/검토 공고를 통과시킨다.

커밋 기준: materialization·idempotency·workspace 회귀 테스트와 clean exact-commit 검증을 통과한 한글 커밋 1개.

### 체크포인트 3 — 운영 API 어댑터와 관제·백로그

목표: 운영 딥 분석 worker가 활성화될 때도 같은 계약으로 실행하고, 현재 누락된 과거 바이너리만 bounded backfill한다.

구현:

1. production API transport adapter를 같은 coordinator 인터페이스에 연결
2. `deep-analysis/processor.ts`의 seal 검증 직후 Kordoc 전용 멱등 작업을 enqueue하고 22축 primary를 기다림 없이 시작
3. Kordoc 전용 worker의 lease·retry·heartbeat·동시성을 deep worker와 분리
4. Cloud Run worker에는 구독 transport가 절대 유입되지 않는 격리 테스트
5. ops에 공고별 두 분석의 시작·완료·원본 수·문서 수·필드 수·상태·버전·비용·오류 노출
6. `preview_ready`인데 field map이 없는 기존 HWP/HWPX를 bounded cohort로 산출
7. 신규 공고 우선, 과거 백로그는 별도 낮은 동시성으로 처리
8. 관측 데이터가 안정된 뒤 승격 fail-closed 여부를 별도 결정

운영 worker mode 변경, Scheduler 수정, 실제 배포는 이 체크포인트 구현과 검증 후 별도 승인으로만 수행한다.

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
