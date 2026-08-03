# 구독 배치 운영 대시보드 — 로컬 딥분석 실행·관리 툴

> 🟢 진행 상황 (2026-08-03): v1 구현·검증·커밋 완료(7bd12a2). 4트랙 병렬(러너 추출 A / 집계·계약 B / UI C / 잡·라우트 D) — 신규 테스트 3종+기존 스위트 통과, tsc 0, dry-run 바이트 동일, dev 서버 실측(깔때기 실데이터·배치 라우트 400/409). 실 배치 웹 E2E 통과(POST 202→finished, plan skippedOk 30·targets 0, transport claude-cli·opus-5 확정 기록). 잔여: v2 후보(검수·감사·집계 실행 트리거, SVG 유량 캔버스).

## 1. 목표 / 비목표

**목표**: 로컬 dev 웹(/dev/analysis-lab)에 "배치 운영" 탭을 추가해, 구독(claude CLI) 딥분석 배치를 **명시적으로 실행·관찰·관리**한다.

- 깔때기 현황: 아카이빙 총계 → 모집중 → 코호트 편입 → 딥분석 완료 → 검수/감사 → 승격(파이프라인 연결)
- transport(구독/API) 명시 선택 + 현재 모드·모델 표시 + 런별 transport 분포
- 배치 실행/중단/재개 + 구조화 진행 스트림(로그 파싱 아님) + 가드 상태(비용 상한·윈도 소진·기간 스킵)

**비목표**: 운영(admin/배포) 노출 금지 — 런 파일(spike-out)·claude CLI·Keychain이 로컬 전용이므로 dev 라우트(production 404) 밖으로 내보내지 않는다(약관 경계 §8-5 준수). ai-review/감사/집계/승격의 **실행 트리거**는 v1 범위 밖(카운트와 명령 안내만) — 스코프 확인 후 v2.

## 2. 정찰 확정 사실 (2026-08-03, 에이전트 3종)

- 현 lab UI: 탭 2개(criteria/roundtrip), 단건 분석·검수·감사 시트 완비. **배치 실행·진행 모니터링·transport 표시/선택·집계 트리거 전무**(전부 CLI). shadcn base-nova·토큰 일관.
- ops(admin) 재사용 패턴: 지표 카드(3xl tabular-nums)·액션 카드 tone 시스템·SVG 유량 캔버스(`features/pipeline/PipelineCanvas.tsx` — v2 후보)·단일 CTE 다종 집계.
- 깔때기 데이터 소스(핵심 주의점 포함):
  - ① `grants` WHERE `servingState='visible'` (`grantServingVisiblePredicate()` 단일 원천). ARCHIVE_HIDDEN은 공개 API 킬스위치일 뿐 상태 아님 — 대시보드는 DB 직접 조회.
  - ② `withinApplyPeriod`(cohort.ts:339, KST) — 모집중/기간미상(`listPeriodUnknownGrants`)/마감·시작전 3분할. 제품 쪽 `activeGrantWhere`와 정의가 다름(혼용 금지).
  - ③ `readCohortFileV2()` entries (+label/seed/strata).
  - ④ `partitionCohortEntries`(batch-plan.ts, 순수·테스트 있음) — skippedOk/구버전만/heldError/pending 4버킷 그대로 사용. 현행 기준 `ANALYSIS_LAB_PROMPT_VERSION`.
  - ⑤ `selectReviewedRuns()`(사람 검수) + `loadAuditedConfirmedReviews()`(감사 확정, provenance로 AI자동확정/사람판정 분리) — **3분할 표시 필수(무은폐 원칙)**, `excludePilotStratum` 켜지 말 것(게이트 전용).
  - ⑥ `analysis_lab_promotion_items` WHERE `status='applied' AND rolledBackAt IS NULL`, `COUNT(DISTINCT grantId)`(재승격 중복 방지). 릴리스 상태가 아니라 item 상태로 셀 것(partial_failed 함정).
- 런 파일 판별은 이중 방어 유지(부속 파일 오인 사고 전례 e4556df): 사이드카 접미 제외 + `startedAt` 존재 확인.
- ④⑤는 파일시스템 전수 스캔 — 요청마다 돌리지 말고 루트 1회 스캔 캐시 + 수동 새로고침.
- `batch.ts`는 모듈 최상단 env 로드 + 하단 `main().then(exit)` — **import 금지**. 워커 풀·비용 상한·윈도 소진 감지·기간 가드는 모듈 로컬(export 없음).
- `LabRunSummary`에 grantId·transport 없음(`toRunSummary`가 떨어뜨림) — transport 분포 표시엔 스캐너 확장 필요.
- `resolveLabTransport()`·`CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER` export 확인 — 현재 모드 표시·소진 감지에 그대로 사용.

## 3. 설계

### 3-1. 배치 러너 추출 (구조 변경의 핵심)

`batch.ts`의 코어(스캔→기간 가드→워커 풀→가드 중단→요약)를 `batch-runner.ts`로 추출해 export한다. CLI(batch.ts)는 argv 파싱 + 러너 호출 + 콘솔 출력의 얇은 래퍼로 유지(동작·로그 포맷 불변, 기존 테스트 통과가 합격선). 러너 계약:

```ts
runLabBatch(options: {
  limit; concurrency; maxCostUsd; retryErrors; reanalyzeOutdated;
  transport?: "api" | "claude-cli";   // env보다 우선하는 명시 오버라이드
  model?: string;
  onEvent: (e: LabBatchEvent) => void; // started|target-started|target-ok|target-error|guard-stop|finished
  signal?: AbortSignal;                // 중단 버튼
}): Promise<LabBatchSummary>
```

- transport/model 오버라이드는 `runLabAnalysis`에 옵션 파라미터 추가로 전달(기존 env 경로는 기본값 유지, provenance 규칙 — try 밖 해석·성공/실패 모두 기록 — 불변).
- 웹 잡 상태: Next 프로세스 내 모듈 싱글턴(동시 1배치) + `spike-out/analysis-lab/batch-job.json` 스냅샷(dev 서버 재시작 후 "이전 잡" 표시·고아 감지용). 이벤트는 링 버퍼(최근 200건)로 GET 폴링에 서빙.
- dev 서버 재시작 시 진행 중 배치는 죽는다 — CLI Ctrl-C와 동일 의미론(완료 런은 저장돼 있고 재실행=재개). UI에 명시.

### 3-2. 라우트 (dev 전용 404 가드, 기존 관행)

| 라우트 | 역할 |
|---|---|
| `GET /api/dev/analysis-lab/ops/summary` | 깔때기 6단계 + transport 분포 + 현재 모드(resolveLabTransport/모델/env 출처) + 코호트 메타. `?refresh=1`로 파일 스캔 캐시 무효화 |
| `POST /api/dev/analysis-lab/ops/batch` | 배치 시작(옵션: limit/concurrency/maxCostUsd/transport/model/retryErrors/reanalyzeOutdated). 실행 중이면 409 |
| `GET /api/dev/analysis-lab/ops/batch` | 잡 스냅샷(진행 i/N·누적 명목 비용·이벤트 링·가드 상태) — 2~5s 폴링 |
| `DELETE /api/dev/analysis-lab/ops/batch` | AbortSignal 중단(진행분은 완료 저장) |

### 3-3. UI — AnalysisLabWorkspace 3번째 탭 "배치 운영"

1. **모드 카드**: 현재 transport(구독/API)·모델·env 출처(.env.development.local 여부)·claude CLI 버전. 구독 선택 시 "실지출 $0 · 명목 비용은 게이트 잣대" 문구, 윈도 소진 상태 배지.
2. **깔때기 보드**: 6단계 가로 스텝 + 건수(tabular-nums), ②는 모집중/기간미상/마감 3분할 칩, ⑤는 사람 검수/감사 확정/AI 자동확정 3분할(무은폐), ⑥은 DISTINCT 공고 수. ops 지표 카드 패턴 이식.
3. **실행 콘솔**: transport ToggleGroup + limit/concurrency/maxCostUsd 입력 + retry-errors/reanalyze-outdated Toggle + dry-run(=summary의 pending 목록 미리보기) + 시작/중단 버튼.
4. **진행 스트림**: (i/N) 이벤트 리스트 + Progress + 누적 명목 비용 + 가드 중단 사유 표시. 종료 요약 카드.
5. 검수/감사/집계/승격은 카운트 + 다음 명령 복사 버튼(기존 UsageGuide 관행) — v1은 실행 트리거 없음.

### 3-4. 계약 추가 (contract.ts — 전부 옵셔널·하위 호환)

- `LabRunSummary.transport?: "api" | "claude-cli"` (toRunSummary에서 통과)
- `LabOpsSummary`·`LabBatchJobSnapshot`·`LabBatchEvent` 신규 타입

## 4. 구현 순서 (파일 겹침 없는 병렬 분할)

| # | 담당 | 내용 |
|---|---|---|
| A | 서버1 | batch-runner.ts 추출 + batch.ts 래퍼화 + runLabAnalysis transport 오버라이드 + 유닛(기존 batch-plan 테스트 무수정 통과 + 러너 이벤트/중단 테스트) |
| B | 서버2 | ops summary 집계 모듈(깔때기 6단계 + 캐시) + summary 라우트 + toRunSummary transport 추가 |
| C | UI | 배치 운영 탭(모드 카드·깔때기 보드·실행 콘솔·진행 스트림) — shadcn 스킬 로드 필수, 기존 토큰 관행 |
| D | 배선 | batch 라우트 3종(잡 싱글턴) — A 완료 후 |

검증: `pnpm lab:transport:test`·batch-plan/roundtrip 기존 테스트 무수정 통과, tsc 0, CLI `lab:batch --dry-run` 출력 불변, dev 서버에서 E2E(소량 배치 1회 — 구독), 격리 rg 2종(운영 무영향) 유지.

## 5. 리스크

- batch.ts 리팩터링이 CLI 동작을 흔들 위험 → 로그 포맷·exit code 불변을 합격선으로, dry-run 출력 diff로 검증.
- Next dev 프로세스 내 장시간 잡 — HMR/재시작에 취약(수용: dev 도구, 재실행=재개 설계가 흡수). 서버 코드 편집 중 배치 실행은 피하라고 UI에 명시.
- CLI와 웹 배치 동시 실행 — batch-job.json 락으로 웹끼리는 차단, CLI와는 관례로만(문서화). 런 스토어는 append-only라 파손은 없음.
- 파일 스캔 캐시 신선도 — 수동 새로고침 버튼 + 배치 이벤트 시 자동 무효화.
