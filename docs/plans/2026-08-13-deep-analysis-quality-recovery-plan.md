# 딥분석 품질 회복 구현 계획 (2026-08-13)

> 상태 정정(2026-08-14): 정적 구현·125015 canary·v17 pilot5는 GO였지만, 비중복 확대 10건에서 publishable 7·held 3·repair 6/10이 재현돼 누적 6/15(40%)로 `<20%` 게이트에 실패했다. repair 후 신규 issue는 0이나 Kordoc 미해결 게이트도 실패해 추가 대량 실행을 중단한다. 당시 구독 명목 비용 guard 초과는 역사적 중단 사실로만 보존하며, 현재 USD는 fan-out 관측 telemetry이고 실행·품질 게이트가 아니다.
> 선행 근거: `docs/research/2026-08-13-딥분석-처리속도-트랙-리뷰-정리.md`
> 안전 경계: 사용자 승인으로 exact canary, 불변 pilot5, 비중복 확대 10건을 로컬 구독 CLI로 실행했다. 확대 게이트 실패 뒤 추가 배치를 중단했다. 범용 `lab:agent --execute`, 2차 교정, 운영 worker 활성화, 배포·승격은 실행하지 않았다. 당시 worker는 `observe_only`였지만 2026-08-14 live 재확인은 gcloud 재인증 대기로 Gate R 미충족이다.
> 현행 계약 정정: 이 문서의 초기 sentinel/error 소비자 설계는 P0에서 대체됐다. 신규 held는 `primaryValidationOutcome=held`, `error=null` terminal이며 중앙 `classifyLabRunOutcome`/`isPublishableLabRun`만 성공 권한을 판정한다. 아래 과거 설계와 현행 계약이 충돌하면 `docs/research/2026-08-14-구독-딥분석-반복실패-구조진단-및-개선-설계.md`가 우선한다.

## 1. 목표와 성공 정의

목표는 repair 횟수를 억지로 낮추는 것이 아니라, **의미 오류만 교정하고 실제 입력 부족·근거 충돌은 정직하게 보류**하는 것이다.

성공은 다음 다섯 조건을 동시에 만족해야 한다.

1. 첫 패스 validator 이슈의 정확한 총량·경로·해당 criterion/axis를 로컬 런에서 재현할 수 있다.
2. `ambiguous`·`input_missing`만 남은 결과는 LLM repair를 반복하지 않고 `held`로 종결한다.
3. `held` 결과는 자동 검수·성공 런 재사용·승격 대상에 들어가지 않는다.
4. 실제 계약 오류는 계속 repair하며, 승격 파서는 기존 S7~S9 strict 계약(`validation.valid === true`)을 유지한다.
5. 최대 repair 뒤 실패한 런도 첫 패스부터 마지막 패스까지의 진단을 잃지 않는다.

CP2의 `<20% repair`는 구현 성공 조건이 아니다. 새 계약에서는 최소한 다음을 별도로 측정해야 한다.

- first-pass publishable 비율
- first-pass held 비율(`ambiguous` / `input_missing`)
- 실제 모델 repair 비율
- repair 후 신규 issue 발생률
- 최종 strict-publishable 비율

## 2. 실측에서 확정된 문제

### 2-1. 진단 손실

`validated-primary.ts`는 패스당 issue code를 앞 20개까지만 저장한다. 175783은 20개 상한에 닿았으므로 CP2 문서의 `unresolved_axis 29건`은 정확한 총량이 아니라 **최소 29건**이다. code만 남고 path·message·문제 axis/criterion이 사라져 첫 패스 정적 재현도 불완전하다.

### 2-2. 계약 충돌

- extractor는 실제 근거 충돌을 `ambiguous`, 실제 첨부 누락을 `input_missing`으로 내라고 지시한다.
- validator는 두 상태를 모두 `unresolved_axis`로 만들고 `valid=false`로 둔다.
- quality graph는 이미 `ambiguous=partial`, `input_missing=held`를 표현한다.
- lab과 운영 processor는 `valid=false`만 보고 최대 2회 전체 결과 repair를 실행한다.

즉, **표현 계약은 보류 상태를 허용하지만 실행 계약은 그것을 모델 오류로 취급**한다.

### 2-3. 전체 재생성의 비국소 회귀

120145는 첫 패스 `semantic_misattribution` 1건을 고치는 첫 repair가 `axis_criterion_mismatch` 13건을 새로 만들었다. 현재 repair 지시는 실패 부분이 아니라 전체 22축 tool 결과를 다시 생성한다.

### 2-4. 품질 게이트 범위

이 계획은 딥분석 criteria·22축 계약만 다룬다. Kordoc 필드 드리프트는 별도 field-level canary 없이는 개선됐다고 판정하지 않는다.

## 3. 불변식과 비목표

### 반드시 지킬 불변식

- `DeepAnalysisValidationResult.valid`는 계속 **자동 승격 가능한 strict 결과**만 true다.
- `ambiguous`·`input_missing`을 `inspected_no_condition`으로 강제 변환하지 않는다.
- held 결과는 audit·promotion·subscription second-pass 입력이 아니다. 신규 lab run은 `error=null` terminal로 보존하되 중앙 outcome classifier가 모든 성공 소비자에서 fail-closed한다. 비-null sentinel은 legacy 읽기 호환에만 남는다.
- 모델 repair는 raw pass, usage, cost를 계속 누적한다.
- API 경로와 CLI 경로는 같은 validator→route→repair 정책을 사용한다.
- 기존 런 파일은 optional 필드 부재 상태로 계속 읽힌다.

### 비목표(과구현 방지)

- DB enum·테이블·migration 추가 없음: 운영 held는 기존 run/job `blocked`를 사용한다.
- 새 queue, daemon, launchd, 재시도 스케줄러 없음.
- generic workflow engine·issue class hierarchy 도입 없음.
- semantic criterion을 임의로 다른 축으로 자동 재매핑하지 않음.
- Kordoc matcher·candidate concurrency·UI 디자인 변경 없음.
- live canary·LLM 검수·감사·배포·승격 없음.

## 4. 설계 — 작은 인터페이스, 깊은 판정

### 4-1. 공유 seam

`validator.ts`에 순수 함수 하나를 둔다.

```ts
decideDeepAnalysisValidationRoute({ result, validation })
  -> { route: "accept" | "repair" | "hold", repairIssues, holdIssues }
```

판정 규칙은 다음과 같다.

1. `validation.valid === true` → `accept`.
2. `unresolved_axis`가 아닌 issue가 하나라도 있으면 → `repair`.
3. 남은 issue가 모두 `unresolved_axis`이고 해당 axis status가 `ambiguous` 또는 `input_missing`이면 → `hold`.
4. path가 축으로 해석되지 않거나 상태가 맞지 않는 `unresolved_axis`는 안전하게 → `repair`.
5. repairable issue와 hold issue가 섞이면 먼저 → `repair`; repair 뒤 hold만 남으면 → `hold`.

`valid`의 의미나 승격 artifact schema를 바꾸지 않고 실행 선택만 이 함수 뒤에 숨긴다. lab과 운영 processor는 이 seam만 호출한다.

### 4-2. lab 결과 계약

`LabRun`에 하위 호환 optional 필드를 추가한다.

```ts
primaryValidationOutcome?: "publishable" | "held";
```

- 구 런(undefined)은 `error === null`이면 종전 publishable로 해석한다.
- 신규 held 런은 분석 결과와 axis 상태를 보존하고 `primaryValidationOutcome="held"`, `error=null`로 기록한다. legacy sentinel도 중앙 classifier에서 held로 읽는다.
- `primaryValidationOutcome`은 quality graph가 held를 일반 분석 오류가 아닌 `partial/held`로 표시하기 위한 명시적 provenance다.
- batch 성공 수·latest terminal/publishable index·AI review·audit·confirmation·promotion은 `classifyLabRunOutcome` 또는 `isPublishableLabRun`으로 held를 제외한다. `error === null` 단독 판정은 성공 권한으로 쓰지 않는다.
- quality graph는 기존 axis 상태를 사용해 `partial/held`를 표시한다.

최대 repair 뒤에도 실패한 경우에는 `ValidatedLabPrimaryError`가 마지막 extraction·repair count·전체 pass diagnostics를 함께 운반한다. `analyze.ts`는 이를 error LabRun으로 불변 저장해 125015 같은 실패 사례도 첫 패스 진단을 잃지 않는다. 일반 transport/model 예외는 종전처럼 extraction 없는 error run으로 남긴다.

### 4-3. 진단 계약

`primaryPasses`의 기존 필드를 유지하고 optional 진단 필드를 추가한다.

```ts
{
  kind,
  durationMs,
  issueCodes,        // 기존 앞 20개, 하위 호환
  issueCount?,       // 전체 개수
  issues?: Array<{
    code, path, message,
    axis?: { dimension, status, comment },
    criterion?: { dimension, kind, operator, value, sourceSpan, note }
  }>
}
```

issue detail은 최대 64개만 저장하고 `issuesTruncated`를 함께 둔다. 22축 unresolved와 현재 contract issue 규모는 전부 담되 비정상 폭주가 런 파일을 무제한 키우지 않게 한다. raw response 전체 sidecar는 이번 단계에서 만들지 않는다. path와 문제 객체 스냅샷으로 재현이 불가능한 사례가 확인될 때만 후속으로 검토한다.

### 4-4. 국소 결정 교정

새 semantic 재매핑기를 만들지 않는다. 현재 validator가 이미 유효하다고 확인한 **같은 dimension의** criterion이 있는데 axis가 `inspected_no_condition`으로 모순되는 경우에 한해 axis를 `condition_found`로 동기화한다.

- 안전 방향: 같은 dimension의 validated criterion ≥1 + axis status가 정확히 `inspected_no_condition` → `condition_found`.
- `ambiguous`·`input_missing`은 criterion 존재 여부와 무관하게 절대 동기화하지 않는다. 실제 근거 충돌과 입력 누락을 보존한다.
- 금지 방향: `condition_found` + criterion 0 → 자동으로 `inspected_no_condition` 처리하지 않는다. 실제 criterion 누락일 수 있으므로 모델 repair 대상이다.
- normalized axis와 `rawToolInput.axis_assessments`를 대칭 갱신한다.
- 이 결정 교정은 evidence/matching-scope 결정 교정 뒤, LLM repair 전에 실행한다. 적용 직후 validator를 처음부터 다시 실행하고, 새 validation으로 accept/repair/hold route를 다시 계산한다.
- 다른 semantic·logical issue가 남으면 route는 계속 repair이므로 axis 동기화만으로 publishable이 되지 않는다.

120145처럼 첫 LLM repair가 criterion은 고쳤지만 axis를 어긋나게 만든 경우 다음 루프는 추가 LLM 없이 수 ms 결정 교정으로 끝나야 한다.

### 4-5. 프롬프트 v15 / 운영 v21

route와 테스트가 먼저 구현된 뒤 프롬프트를 갱신한다.

- 실제 근거 충돌의 `ambiguous`, 실제 입력 누락의 `input_missing`은 정직한 hold 상태임을 명시한다.
- validator를 통과하려고 두 상태를 근거 없이 `inspected_no_condition`으로 바꾸지 말라고 명시한다.
- canonical 구조화 불안만 있는 경우의 `text_only + condition_found` 규칙은 유지한다.
- Bizinfo structured target 충돌, K-Startup 양쪽 실제 자격 문장 충돌, 누락 첨부가 필요한 직무/업종 구분 규칙은 hold 계약과 일치시키고 삭제하지 않는다.
- `ANALYSIS_LAB_PROMPT_VERSION`: `lab-deep-v14` → `lab-deep-v15`.
- `DEEP_ANALYSIS_PROMPT_VERSION`: `deep-analysis-v20` → `deep-analysis-v21`.
- validator strict 의미는 그대로이므로 validator version은 올리지 않는다. 결정 교정이 바뀌므로 repair version만 v5로 올린다.

## 5. TDD 수직 슬라이스와 커밋 순서

### Commit 1 — 진단 손실 제거

RED:

- 22개 ambiguous axis fixture에서 `issueCodes`는 20개여도 `issueCount=22`, issue detail 22개와 각 axis path/status가 남는 테스트.
- criterion semantic issue에서 문제 criterion snapshot이 남는 테스트.

GREEN:

- bounded diagnostic collector 구현.
- `LabRun.primaryPasses` optional 계약 확장.

검증:

- `validated-primary.test.ts`
- web typecheck
- `git diff --check`

커밋 제목: `딥분석 첫 패스 진단 손실을 막다`

### Commit 2 — accept/repair/hold 판정과 lab 적용

RED:

- valid → accept.
- unresolved-only(input_missing/ambiguous) → hold, 모델 1회.
- mixed unresolved + normalization/semantic issue → repair.
- 잘못된 unresolved path → repair(fail closed).
- held 런은 latest successful/AI review/batch ok에서 제외.
- legacy held sentinel과 신규 explicit held가 confirmation·audit·promotion을 포함한 중앙 outcome 소비처 전부에서 제외되는지 전수 확인.
- 최대 repair 실패가 pass diagnostics와 마지막 extraction을 error LabRun에 보존.

GREEN:

- 공유 순수 route 함수.
- `runValidatedLabPrimary`가 route=repair일 때만 repair.
- `primaryValidationOutcome` 저장 및 run-store/batch/review 필터 배선.

검증:

- `validator.test.ts`
- `validated-primary.test.ts`
- `batch-runner.test.ts`
- 관련 run-store/quality 테스트
- `verify:deep-analysis-contract`
- web typecheck

커밋 제목: `딥분석 보류 상태와 교정 오류를 분리하다`

### Commit 3 — 운영 processor 동일 정책과 국소 결정 교정

RED:

- 유효 criterion이 있는데 axis만 어긋난 fixture는 LLM 호출 없이 axis/raw axis를 동기화하고 valid가 된다.
- axis가 `ambiguous` 또는 `input_missing`이면 같은 축 criterion이 있어도 결정 교정하지 않는다.
- `condition_found`인데 criterion이 없는 fixture는 결정 교정하지 않는다.
- worker failure classifier가 `primary_validation_held`를 input-blocked로 분류한다.

GREEN:

- axis 동기화 결정 교정 구현·repair v5.
- processor repair loop가 공유 route를 사용.
- route=hold이면 raw/normalized artifact와 validation receipt를 남긴 뒤 run/job을 기존 blocked 경로로 종결한다.
- 운영 `blocked`는 `failDeepAnalysisJob(... failureClass="input_blocked")`의 terminal 상태라 자동 retry되지 않는지 회귀 테스트로 고정한다.

검증:

- `repair.test.ts`
- `workerPolicy.test.ts`
- `verify:deep-analysis-contract`
- `test:deep-analysis-runtime-control`
- web typecheck

커밋 제목: `딥분석 교정을 국소화하고 운영 보류를 종결하다`

### Commit 4 — 프롬프트 계약 정합과 회귀 fixture

RED:

- 프롬프트가 실제 충돌·입력 누락을 hold로 보존하고 무근거 종결을 금지한다는 계약 테스트.
- 기존 canonical/text_only 규칙이 사라지지 않았다는 회귀 테스트.

GREEN:

- v15/v21 문구와 버전 갱신.
- input_missing은 fake transport로 1회 hold를 고정하고, structured target 충돌과 직무/업종 구분은 기존 prompt contract fixture가 유지되는지 검증한다. 실제 모델 응답 품질을 흉내 내는 테스트는 만들지 않고, route·보존 계약만 검증한다.

검증:

- `analyzer.test.ts`
- `validated-primary.test.ts`
- `verify:deep-analysis-contract`
- `lab:quality:test`
- web typecheck

커밋 제목: `딥분석 보류 의미를 프롬프트 계약에 맞추다`

### Commit 5 — 문서 정본·최종 리뷰

- CP2 issue 29건을 `관측 최소 29건`으로 정정.
- 새 지표와 live canary 승인 게이트를 HANDOFF/처리속도 계획에 반영.
- 구현 diff 전체를 적대적으로 리뷰해 missing/overengineering/security/backward-compatibility를 재점검.
- 리뷰 지적은 코드 수정 후 관련 커밋에 포함하거나 별도 한국어 후속 커밋으로 남긴다.

커밋 제목: `딥분석 품질 회복 계약과 검증 절차를 기록하다`

## 5-1. 구현 결과 (2026-08-13)

| 순서 | 커밋 | 구현·검증 결과 |
|---:|---|---|
| 0 | `1de06b5` | 상세 계획과 CP2 실패 근거를 정본화하고 Claude 적대적 계획 리뷰의 P0/P1을 반영 |
| 1 | `ef3a984` | issue code 20개 호환 상한과 별개로 정확한 `issueCount`, 최대 64개 path/message/axis/criterion 진단을 보존 |
| 2 | `af65bf2` | 공유 `accept/repair/hold` 판정, lab held sentinel, 실패 extraction·전 패스 진단 보존, mixed issue에서 hold를 repair prompt에서 제외 |
| 3 | `9e33f6a` | 운영 processor가 같은 route를 사용하고 held를 `blocked`로 종결. validated criterion + `inspected_no_condition` 한 방향만 raw/normalized 축을 대칭 교정 |
| 4 | `3c16cf3` | 프롬프트 `lab-deep-v15`/`deep-analysis-v21`. 실제 충돌·입력 누락은 hold, canonical 표현 불안만 `text_only + condition_found`로 정렬 |
| 4-r | `29f0491` | 최종 리뷰 후 held 오류가 attempt 여유·소진과 무관하게 terminal `blocked`가 되는 상태 매핑을 순수 회귀 테스트로 고정 |
| 5 | `947d932` | 기존 정본을 보존하는 불변 층화 코호트 동결과 `--cohort-snapshot` 소비 경로. label 경로 조작·덮어쓰기 차단 |
| 6 | `240f533` | v15 pilot repair 원문 재검토 뒤 현재 제재 오탐, 주관기관 신청주체, 면책 과축약, 역할 한정 평가를 최소 규칙으로 개선 |
| 7 | `1b1dc47` | package dist를 재빌드한 뒤 `lab-deep-v17`/`deep-analysis-v23` 런타임 계약 고정 |
| 8 | `9281d38` | 모든 `lab:batch` 실행 전에 package runtime freshness를 강제하고 CLI 잡에 불변 코호트 라벨 기록 |
| 9 | `f337380`·`3b28530` | 중앙 outcome 소비자를 먼저 교체한 뒤 신규 held를 `error=null` terminal로 전환하고 batch/agent/readiness를 분리 |

기존 CP2 런은 `issueCodes` 앞 20개만 저장했으므로 과거의 `unresolved_axis 29건`은 재계산 가능한 정확값이 아니라 **관측 최소 29건**이다. 새 런부터 exact count와 bounded detail이 남는다. 125015 단건은 v13 repair 2회 실패를 v15 first-pass held·repair 0으로 바꿨고, v17 불변 pilot5는 publishable 4·held 1·repair 0·신규 issue 0으로 종결했다. 평균 wall은 같은 표본 v15 687.5초에서 v17 427.8초로 줄었다. 당시 0/5의 단측 95% 상한은 45.1%여서 모집단 `<20%` 주장을 보류했고, 이후 확대 결과는 §9의 6/15 NO-GO로 반영했다.

## 6. 계획 자체의 테스트 행렬

| 반례 | 기대 route/결과 | 자동 승격 | LLM repair |
|---|---|---:|---:|
| 22축·근거·canonical 모두 유효 | accept / publishable | 가능(후속 audit 필요) | 0 |
| 실제 누락 첨부로 input_missing만 존재 | hold | 불가 | 0 |
| 실제 구조화/본문 충돌로 ambiguous만 존재 | hold | 불가 | 0 |
| input_missing + raw normalization drop | repair → hold 또는 accept | 최종 strict 결과만 | 최대 2 |
| semantic_misattribution 1건 | repair | 최종 strict 결과만 | 필요 |
| 유효 criterion + stale axis | 결정 교정 후 accept | 가능(후속 audit 필요) | 0 |
| 유효 criterion + ambiguous/input_missing axis | hold 유지 | 불가 | 0 |
| condition_found + criterion 없음 | repair | 불가 | 필요 |
| issue path 파손 | repair/fail closed | 불가 | 필요 |
| held 구런 필드 없음 | 종전 동작 | 종전 계약 | 종전 계약 |
| held 신런 | `primaryValidationOutcome=held`, `error=null` terminal + quality graph held, 중앙 성공 소비처에서 제외 | 불가 | 0 |
| 최대 repair 실패 | error run에 마지막 extraction과 모든 pass 진단 보존 | 불가 | 최대 2 |

## 7. 정밀 리뷰 질문

1. `ambiguous`를 전부 hold로 두면 모델 헤징을 숨기는가? → 숨기지 않는다. held 비율을 별도 실패 지표로 보고 자동 승격을 차단한다.
2. held를 DB 새 status로 만들어야 하는가? → 아니다. 기존 `blocked`와 exception reason이면 운영 의미가 충분하다. worker의 input-blocked 경로가 terminal이고 자동 retry되지 않음을 테스트한다.
3. raw pass sidecar가 당장 필요한가? → issue path와 문제 객체 snapshot으로 먼저 검증한다. 부족함이 실증될 때만 추가한다.
4. semantic 자동 재매핑이 필요한가? → 현재는 과구현·오분류 위험이 더 크므로 하지 않는다.
5. 전체 재생성을 patch schema로 즉시 바꿔야 하는가? → 지금은 axis 안전 동기화만 추가한다. 남은 semantic repair 실측이 여전히 회귀하면 별도 버전된 patch 계약을 설계한다.
6. repair율이 낮아졌다고 품질 향상인가? → 아니다. publishable/held/repair/new-issue 지표와 독립 검수를 함께 본다.
7. 운영 worker를 함께 바꾸는 것이 과한가? → 동일 validator를 쓰면서 lab만 route를 바꾸면 다음 운영 활성화 때 계약이 다시 갈라진다. 순수 route 공유와 기존 blocked 재사용까지만 동기화한다.

## 8. 적대적 계획 리뷰 반영

Claude 읽기 전용 적대적 리뷰 판정은 **CONDITIONAL GO**였다. 구현 전 P0로 지적한 항목과 반영은 다음과 같다.

| 지적 | 판정 | 계획 반영 |
|---|---|---|
| held를 `error=null`로 두면 당시 error 기반 소비처에서 fail-open | 후속 P0에서 재설계 | 중앙 outcome classifier와 소비자 전수 교체 뒤 신규 held를 `error=null` terminal로 전환. sentinel은 legacy 호환만 유지 |
| criterion 존재만으로 ambiguous/input_missing axis를 condition_found로 바꾸면 의미 손실 | 수용 | 정확히 `inspected_no_condition`인 같은 축만 동기화. 두 hold 상태는 절대 변경 금지 |
| 결정 교정 뒤 validator 재실행 순서 누락 | 수용 | 결정 교정 → 전체 revalidate → route 재계산 순서 명시·통합 테스트 추가 |
| 운영 blocked가 자동 retry될 수 있음 | 확인 필요 | 현행 worker의 input-blocked→blocked terminal 경로를 테스트로 고정 |
| 전체 결과 재생성 회귀는 잔존 | 수용 | 이번 범위에서는 안전한 axis 모순만 결정 교정. semantic repair 신규 issue율을 live 게이트로 유지 |
| axis patch를 별도 revert 가능한 변경으로 분리 | 수용 | route/held 커밋과 운영 axis 결정 교정 커밋 분리 유지 |

과구현 지적은 없었다. DB 상태·queue·generic patch schema·semantic 자동 재매핑을 만들지 않는 현재 비목표를 유지한다.

### 구현 후 적대적 리뷰

구현 후 핵심 상태 전이(`validator → processor → worker policy`)를 다시 Claude 읽기 전용 리뷰에 제출했다. strict valid 유지, repair loop의 hold 조기 탈출, held run의 blocked 종결, `primary_validation_held → input_blocked` 비재시도 경로를 추적한 결과 **APPROVE, 미해결 P0/P1 0** 판정을 받았다. 더 큰 전체 diff Sonnet 리뷰 두 시도는 로컬 구독 CLI 경합으로 각각 5분간 출력이 없어 중단했으며, 코드나 저장소 상태는 변경하지 않았다.

### 최종 검증 증거

- `pnpm verify:deep-analysis-contract` — 전체 통과
- `pnpm lab:quality:test` — 전체 통과
- `pnpm test:deep-analysis-runtime-control` — 전체 통과
- `pnpm verify:promotion-protection` — 전체 통과
- `pnpm --filter @cunote/web typecheck` — 통과
- `pnpm --filter @cunote/web build` — production build 성공
- `git diff --check` — 통과

build에는 기존 `archiveKStartupCore.ts`의 동적 파일 패턴과 NFT 추적 범위 경고가 남았지만 컴파일·TypeScript·페이지 생성은 모두 성공했다. 이후 사용자 승인 범위에서 exact canary와 pilot5만 실행했고, 범용 에이전트·2차 교정·배포·승격은 실행하지 않았다.

## 9. 최종 실행 게이트

이 절의 초기 canary/pilot 조건은 이미 실행됐고 확대 10건에서 NO-GO로 반증됐다. 현행 재개 조건은
2026-08-14 구조 설계의 Gate R이며, 다음을 모두 충족하기 전에는 live 실행을 자동으로 이어가지 않는다.

1. [완료] P0~P3 상태·비용·lane·불변 experiment kernel과 관련 회귀/typecheck/build GREEN.
2. [완료] legacy live entrypoint, cohort mutation, runtime lease acquire/renew, promotion approve/write의 정적 admission 차단과 독립 재감사 치명 0·중요 0.
3. [완료·NO-GO 증거] v17 pilot5 0/5 `CONTINUE`, 누적 6/15 `NO_GO` shadow replay.
4. [미충족] 전용 gcloud configuration으로 Cloud Run worker `observe_only`와 bounded claim 상태를 현행 시점에 재확인한 영수증.
5. [미충족] exact plan·artifact·receipt를 실제 실행과 결속하고 실행 중 신규 target 편입을 금지하는 최소 live Adapter.
6. [미충족] grant/cohort/plan SHA·만료·중단 조건에 결속된 새 비중복 단건 canary의 사용자 승인.

전체 재생성 repair는 기존 표본에서 신규 issue 0이므로 patch schema 즉시 도입을 보류한다. 원문 분류가
반복 가능한 최소 seam을 입증할 때만 별도 버전으로 설계하며, 구독 nominal USD cap이나 예약 ledger를
다른 이름으로 재도입하지 않는다.
