# `/dev/service-data` 매칭 입력 필드 구현 핸드오프

> 작성일: 2026-07-13
> 대상: 신규 Codex 메인 세션과 그 세션이 감독하는 Orca worker
> 상태: `main` 통합 전 보존본 · 실행 시 매칭 마스터 문서를 우선하고 Gate 1부터 순차 실행
> 기록 시점 branch: `codex/first-mission-gates-20260713`
> 기록 시점 HEAD: `ce1950fb4eaa8e083c8e65597141eddb9a123e52`

## 1. 핸드오프 목적

이 문서는 신규 세션이 [문제인식 문서](../research/2026-07-13-service-data-매칭입력-필드-문제인식.md)와 [개선 계획](./2026-07-13-service-data-매칭입력-필드-개선계획.md)을 실제 코드로 옮길 때 사용하는 **실행 계약**이다.

핵심 목표는 하나다.

> 현재 연결된 사업자 데이터와 최소 Q&A를 typed `CompanyProfile`로 만들고, 실제 matcher에 넣어 어떤 공고의 `unknown`이 줄었는지 dev 페이지에서 증명한다.

신규 세션은 전체 계획을 한 번에 구현하지 않는다. 한 Gate마다 다음 순서를 지킨다.

```text
사전 감사
  -> Orca 구현 task/dispatch
  -> worker_done
  -> 별도 읽기 전용 리뷰 task/dispatch
  -> 필요한 경우 좁은 fix task
  -> 재리뷰
  -> Gate 영수증
  -> 중지 및 사용자 보고
```

사용자가 명시적으로 다음 Gate 진행을 요청하기 전에는 다음 구현을 시작하지 않는다.

## 2. 문서 우선순위

신규 세션은 다음 순서로 읽는다.

1. [매칭 트랙 마스터 실행 문서](./2026-07-13-matching-master-execution.md): 우선순위·범위·완료 판정의 단일 기준
2. 이 핸드오프: service-data 하위 트랙의 실행 방식, 작업 경계, Orca 규칙
3. [매칭 입력 필드 문제인식](../research/2026-07-13-service-data-매칭입력-필드-문제인식.md): 무엇이 문제인지
4. [매칭 입력 필드 개선 계획](./2026-07-13-service-data-매칭입력-필드-개선계획.md): Phase별 구현 내용과 완료 조건
5. [사업자번호 우선 자동채움 실행 가이드](./2026-07-12-사업자번호-우선-자동채움-실행가이드.md): 기존 소스·측정·외부 게이트
6. [공고 매칭 1차 미션 복구 계획](./2026-07-13-first-mission-recovery-plan.md): matcher 안전 불변식과 제품 4상태

충돌 시 마스터 문서의 현재 결함 대장과 실행 순서를 먼저 따른다. 그 다음 현재 코드, 문제인식 문서의 확인 사실, 개선 계획의 교차 리뷰 결과를 우선한다. 모호하면 구현하지 말고 decision gate로 올린다.

## 3. 현재 상태 스냅샷

이 값은 신규 세션이 다시 확인해야 하며, 현재 상태라고 가정하면 안 된다.

- branch: `codex/first-mission-gates-20260713`
- pre-handoff HEAD: `ce1950fb4eaa8e083c8e65597141eddb9a123e52`
- `ba3a290`: 다른 세션이 생성한 현재 구현 진행분 checkpoint. 매칭·자동채움 관련 기존 dirty 구현과 문제인식·개선계획 문서를 포함
- `70272aa`, `ce1950f`: 매칭 마스터 실행 문서와 체크포인트 이후 결함 대장 보정
- 작업 트리: 기록 시점에는 제품 코드 dirty 없음. 이 핸드오프 파일과 세 문서의 핸드오프 링크만 미커밋
- 이 트랙의 문제인식·개선계획 문서: `ba3a290`에 추적됨
- 이 핸드오프 문서: 기록 시점에는 미추적 파일
- `page.tsx`, `ServiceDataMonitor.tsx`, `devServiceDataMonitor.ts`: 기록 시점 targeted status에서는 별도 변경 없음
- contracts/core/serviceData 관련 의존 파일: 다른 매칭 작업과 섞인 변경 다수 존재
- 이 문서 작성 세션에서 제품 코드는 수정하지 않음
- 개발 서버를 시작하지 않음
- Orca runtime은 기록 시점 `ready`였으나 task 목록은 runtime-global 과거 작업을 다수 포함

### 이 상태가 의미하는 것

기록 시점 제품 코드 baseline은 `ba3a290`에, 마스터 문서 보정은 `ce1950f`에 고정됐지만 이 핸드오프 자체는 기록 시점 미커밋이다. 따라서 신규 세션은 먼저 실제 branch·HEAD·status를 다시 확인해야 한다.

이 핸드오프가 `main`으로 검증된 fast-forward 통합된 후에는 **로컬 `main`의 exact HEAD**를 새 baseline으로 삼는다. 통합 전에는 현재 트랙 branch의 exact HEAD를 사용한다.

신규 세션 시작 전에 이 핸드오프와 링크 변경까지 별도 commit으로 고정되어 있고 working tree가 clean이라면, 승인된 통합 branch의 exact HEAD를 base로 한 clean Orca child worktree를 선택할 수 있다. 통합 전은 현재 트랙 branch, 통합 후는 로컬 `main`이 승인된 기준이다. 과거 `1e6306f`나 `origin/main`처럼 통합된 변경이 빠지는 base를 사용하지 않는다.

새 worktree는 다음 조건을 모두 만족할 때만 사용한다.

1. 필요한 baseline과 이 핸드오프가 commit으로 고정되어 있다.
2. 현재 working tree에 가져가야 할 미커밋 제품 코드가 없다.
3. 새 worktree의 Git base가 통합 전에는 현재 트랙 branch, 통합 후에는 로컬 `main`의 exact HEAD와 일치한다.
4. Orca lineage를 현재 트랙의 child로 명시했다.

이 조건이 없으면 `orca worktree create`를 실행하지 않는다.

## 4. 절대 불변식

모든 worker spec과 review에 다음 규칙을 포함한다.

1. 첫 typed loop의 자격 기준선은 현재 운영 19축이다.
2. `other`는 자격 profile 입력과 coverage 분모에서 제외한다.
3. `premises`, `export_performance`는 별도 사람 표본 검수와 사용자 결정 전 활성화하지 않는다.
4. hard eligibility의 pass/fail은 결정론 matcher가 담당한다.
5. AI는 공고 추출·canonicalization·설명·ranking 보조에만 쓴다.
6. 값이 부족하거나 불명확하면 `unknown`을 유지한다. 테스트를 위해 pass로 바꾸지 않는다.
7. 새 API/provider/env key를 추가하지 않는다.
8. DB migration, production UI, production source promotion을 하지 않는다.
9. generic connector/plugin/schema framework를 만들지 않는다.
10. 현재 dev 페이지 전체 리팩터링을 하지 않는다.
11. 외부 provider live 호출, 유료 호출, DB write를 하지 않는다.
12. 개발 서버는 사용자가 직접 실행한다.
13. 관련 없는 dirty 변경을 되돌리거나 staging/commit하지 않는다.
14. 커밋은 사용자가 별도로 요청하고 범위를 승인한 경우만 한다.
15. 허용 파일 밖 수정이 필요하면 먼저 Orca `ask` 또는 `escalation`으로 보고한다.

## 5. Orca 운영 모델

### 5.1 역할

| 역할 | 책임 | 파일 수정 |
|---|---|---:|
| coordinator | preflight, task 생성, dispatch, 결과 종합, Gate 영수증 | 상태 문서만 최소 수정 가능 |
| implementer | 현재 Gate의 허용 파일만 구현·테스트 | 가능 |
| reviewer | diff·계약·테스트 증거의 독립 검토 | 금지 |
| fixer | coordinator가 수용한 review finding만 수정 | 가능 |

구현자와 reviewer를 같은 dispatch로 합치지 않는다. reviewer는 fresh terminal에서 읽기 전용으로 수행한다.

### 5.2 동시성

- 같은 worktree의 writer는 항상 1명이다.
- implementer가 `worker_done`을 보낸 뒤 reviewer를 dispatch한다.
- reviewer가 끝난 뒤에만 fixer를 dispatch한다.
- Phase 0B 표본 검수도 코드 writer와 병렬 실행하지 않는 것을 기본값으로 한다.
- `orca orchestration run`의 자동 fan-out을 쓰지 않고 수동 루프를 사용한다.

### 5.3 Orca provenance

사용자가 Orca orchestration을 명시했으므로 일반 subagent나 chat-only spawn으로 대체하면 안 된다.

반드시 실제로 다음 상태를 만든다.

- `orca orchestration task-create`
- `orca orchestration dispatch --inject`
- `orca orchestration dispatch-show`
- worker의 `worker_done`

task spec에는 고유 prefix `CUNOTE-SD-G<gate>-...`를 사용한다. runtime-global 과거 task와 섞여도 식별 가능해야 한다. 기존 task를 지우려고 `orca orchestration reset`을 실행하지 않는다.

## 6. 신규 세션 preflight

코드 수정과 task 생성 전에 실행한다.

```bash
pwd
git branch --show-current
git rev-parse HEAD
git status --short
git diff --stat
git diff -- packages/core/src/autofill/coverage.ts packages/core/src/index.ts packages/contracts/src/index.ts packages/core/src/matching/match.ts apps/web/src/lib/server/devServiceDataMonitor.ts apps/web/src/features/dev/ServiceDataMonitor.tsx
test -f docs/research/2026-07-13-service-data-매칭입력-필드-문제인식.md
test -f docs/plans/2026-07-13-service-data-매칭입력-필드-개선계획.md
test -f docs/plans/HANDOFF-2026-07-13-service-data-매칭입력.md
orca status --json
orca orchestration task-list --json
orca terminal list --worktree active --json
```

### preflight 중단 조건

다음이면 구현 task를 만들지 않는다.

- 세 정본 문서 중 하나가 없음
- 현재 worktree가 이 문서가 기대하는 코드를 포함하지 않음
- Orca runtime 또는 orchestration 기능이 사용 불가
- 다른 active terminal이 현재 Gate의 허용 파일을 수정 중
- 대상 파일 diff의 소유권을 구분할 수 없음
- clean worktree를 만들기 위해 미커밋 변경을 임의로 버려야 함

Orca가 불가하면 일반 agent 도구로 대체하지 말고 정확한 blocker를 사용자에게 보고한다.

preflight가 끝나면 구현 위치를 하나로 고정한다.

- 핸드오프 미커밋 또는 필요한 dirty 변경 존재: `<implementation-worktree-selector>=active`
- 핸드오프까지 commit·working tree clean·현재 exact HEAD 기반 child 생성 완료: `<implementation-worktree-selector>=id:<child-worktree-id>`

한 Gate 도중 selector를 바꾸지 않는다.

clean child 조건을 충족한 경우에만 다음 형태로 만든다. `--no-parent`를 쓰지 않는다. 이 구현은 현재 트랙에 종속된 child work다.

```bash
orca worktree create --name cunote-service-data-typed-loop --base-branch <approved-integration-branch> --json
git -C <child-worktree-path> rev-parse HEAD
```

child의 시작 HEAD가 preflight에서 기록한 parent HEAD와 다르면 dispatch하지 않는다.

## 7. 기본 Orca 수동 루프

### 7.1 root task

첫 세션에서 한 번만 만든다.

```bash
orca orchestration task-create --spec "CUNOTE-SD-ROOT: docs/plans/HANDOFF-2026-07-13-service-data-매칭입력.md를 실행 계약으로 사용해 /dev/service-data typed CompanyProfile -> shadow matcher 경계를 Gate별로 구현·리뷰한다. 한 번에 한 Gate만 진행하고 사용자 승인 없이 다음 Gate로 넘어가지 않는다." --json
```

반환된 root task ID를 Gate 영수증에 기록한다. root task를 worker에게 dispatch하지 않는다.

### 7.2 구현 task

```bash
orca orchestration task-create --parent <root-task-id> --spec "<현재 Gate implementer spec>" --json
orca terminal create --worktree <implementation-worktree-selector> --title cunote-sd-g<gate>-impl --command "codex" --json
orca terminal wait --terminal <implementer-handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <implement-task-id> --to <implementer-handle> --inject --json
orca orchestration dispatch-show --task <implement-task-id> --json
orca orchestration check --wait --types worker_done,escalation,decision_gate --timeout-ms 900000 --json
```

15분 timeout은 실패가 아니다. task 상태와 terminal activity를 확인한 뒤 rolling wait를 계속한다.

### 7.3 리뷰 task

```bash
orca orchestration task-create --parent <root-task-id> --deps '["<implement-task-id>"]' --spec "<현재 Gate read-only review spec>" --json
orca terminal create --worktree <implementation-worktree-selector> --title cunote-sd-g<gate>-review --command "codex" --json
orca terminal wait --terminal <reviewer-handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <review-task-id> --to <reviewer-handle> --inject --json
orca orchestration dispatch-show --task <review-task-id> --json
orca orchestration check --wait --types worker_done,escalation,decision_gate --timeout-ms 900000 --json
```

reviewer spec에 `파일 수정·apply_patch·format write·git add/commit 금지`를 명시한다.

### 7.4 수정과 재리뷰

- BLOCKER/MAJOR finding이 있으면 coordinator가 finding을 검증한다.
- 수용한 finding만 별도 fix task로 만든다.
- fixer는 원래 허용 파일과 수용 finding 범위만 수정한다.
- 같은 Gate에서 fix/review가 두 번 반복돼도 BLOCKER가 남으면 다음 Gate로 가지 않고 사용자에게 escalation한다.
- 리뷰 결과만으로 coordinator가 제품 코드를 직접 고치지 않는다.

## 8. Gate DAG

```text
G0 preflight
  -> G1 Phase 0A + Phase 1 field SSOT/parity
  -> G2A typed update 대표 3종 vertical slice
  -> G2B 현재 값 생성 connector/Q&A typed 전환 완료
  -> G3 evidence precedence 기반 final CompanyProfile
  -> G4 read-only shadow matching + 4상태
  -> G5 UI/지표 보정
  -> G7L local completion audit

G1 이후 별도 트랙:
  G0B premises/export 표본 검수
    -> 사용자 decision gate
    -> 승인된 경우에만 G6 축별 활성화

G5 이후 외부 트랙:
  G7E 사용자 실행 서버 브라우저 + 30개 실표본
```

G0B와 G7E는 첫 typed loop를 막지 않는 external/manual gate다. G6는 자동 진행 금지다.

## 9. Gate별 실행 계약

### G1 — Phase 0A + Phase 1 field SSOT/parity

신규 세션의 첫 작업은 이것뿐이다.

허용 파일:

- 신규 `packages/core/src/autofill/profile-field-spec.ts`
- 신규 `packages/core/src/autofill/profile-field-spec.test.ts`
- `packages/core/src/autofill/coverage.ts`
- `packages/core/src/index.ts`
- `apps/web/src/lib/server/devServiceDataMonitor.ts`
- 필요할 때만 해당 dev monitor test

구현자 필수 결과:

- 최소 field spec: key, parent dimension, role, profile/update path, readiness kind, denominator 여부
- 19개 운영 부모축 정확히 1행
- `other` eligibility/denominator 제외
- premises/export reserved role과 denominator 제외
- matcher 소비 nested field 누락 방지 목록
- provider/env/UI 문구는 core spec에 넣지 않음
- 기존 화면 동작을 바꾸는 UI 작업 없음

G1 필수 검증:

```bash
./node_modules/.bin/tsx packages/core/src/autofill/profile-field-spec.test.ts
./node_modules/.bin/tsx packages/core/src/autofill/coverage.test.ts
./node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/devServiceDataMonitor.test.ts
pnpm --filter @cunote/core typecheck
pnpm --filter @cunote/web typecheck
git diff --check -- packages/core/src/autofill/profile-field-spec.ts packages/core/src/autofill/profile-field-spec.test.ts packages/core/src/autofill/coverage.ts packages/core/src/index.ts apps/web/src/lib/server/devServiceDataMonitor.ts
```

실제 test 파일명이나 기존 명령이 다르면 먼저 확인하고 가장 가까운 focused test를 사용한다. 존재하지 않는 명령을 통과했다고 쓰지 않는다.

G1 reviewer 질문:

1. 새 spec이 matcher 계약을 반영하는가, 또 하나의 수동 목록만 늘렸는가?
2. 19축, 2개 reserved, `other`의 역할이 정확한가?
3. supporting/identity/ranking field가 eligibility denominator를 올리지 않는가?
4. prior award, IP, financial health, insured workforce, list completeness 누락이 없는가?
5. provider 구현이 core spec으로 새지 않았는가?
6. generic schema engine이나 불필요한 리팩터링이 생기지 않았는가?

G1 implementer task spec:

```text
CUNOTE-SD-G1-IMPLEMENT: 현재 active worktree에서 HANDOFF-2026-07-13-service-data-매칭입력.md의 G1만 구현한다. 편집 전 문제인식 문서, 개선계획, 현재 git status와 대상 파일 diff를 읽고 기존 사용자 변경을 보존한다.

허용 범위는 신규 packages/core/src/autofill/profile-field-spec.ts와 그 test, packages/core/src/autofill/coverage.ts, packages/core/src/index.ts, apps/web/src/lib/server/devServiceDataMonitor.ts, 필요한 기존 devServiceDataMonitor test뿐이다. 허용 파일 밖 변경이 필요하면 수정하지 말고 coordinator에게 ask/escalation한다.

최소 field spec은 field key, parent dimension, eligibility/reserved/supporting/identity/ranking role, CompanyProfile 또는 update path, scalar/list/compound readiness, denominator 포함 여부만 가진다. provider/env/UI 문구를 core로 옮기거나 generic schema framework를 만들지 않는다. 운영 19축 부모 행은 정확히 하나씩 존재하고, other는 eligibility/denominator에서 제외하며, premises/export_performance는 reserved/denominator 제외로 유지한다. matcher가 소비하는 prior_award, IP, industry_codes/list completeness, financial_health, insured_workforce nested field가 누락되지 않게 parity test로 고정한다. UI, connector 동작, DB, production 경로는 바꾸지 않는다.

G1 필수 focused tests, core/web typecheck, changed-file git diff --check를 실행한다. 기존 baseline failure가 있으면 새 변경 회귀와 분리해 정확한 명령·오류를 보고한다. 완료 시 worker_done을 한 번 보내며 수정 파일, 테스트 결과, 남은 blocker와 scope 판단을 포함한다. 다음 Gate는 시작하지 않는다.
```

G1 reviewer task spec:

```text
CUNOTE-SD-G1-REVIEW: 방금 완료된 G1 diff를 HANDOFF §4 불변식, §9 G1 acceptance, 문제인식 P1/P5/P9에 대조해 읽기 전용으로 검토한다. 파일 수정, apply_patch, formatter write, git add/commit을 하지 않는다.

반드시 대상 diff와 새 field spec/parity test를 읽고 가능한 focused tests를 실행한다. 새 spec이 matcher 계약을 반영하는 최소 SSOT인지, 수동 목록만 하나 더 늘렸는지, 19축/2 reserved/other 역할과 denominator가 맞는지, supporting/identity/ranking이 eligibility를 올리지 않는지, nested matcher field와 list completeness가 빠지지 않았는지, provider 구현이나 generic framework가 core로 새지 않았는지 확인한다.

findings를 BLOCKER/MAJOR/MINOR 순으로 파일:라인, 영향, 근거, 최소 수정과 함께 먼저 보고한다. findings가 없으면 no blocker/major findings, 실행한 명령, 남은 외부 gate를 명시한다. worker_done을 한 번 보내고 다음 Gate를 제안·구현하지 않는다.
```

G1 합격 후에도 G2A를 자동 시작하지 않는다.

### G2A — typed update 대표 3종 vertical slice

목표는 모든 connector 전환이 아니라 경계의 타당성 증명이다.

대표 shape:

- scalar: employees 또는 revenue
- list: certification 또는 IP
- compound: financial_health 또는 insured_workforce

허용 기본 파일:

- 신규 `apps/web/src/lib/server/devServiceDataProfile.ts`
- 신규 `apps/web/src/lib/server/devServiceDataProfile.test.ts`
- `apps/web/src/lib/server/devServiceDataMonitor.ts`
- 필요한 최소 dev API response type

필수 조건:

- 표시용 `value` 유지
- `CompanyProfileFieldUpdate[]` 동시 생성
- `updateCompanyProfileField()` 검증 통과
- `normalization_failed`와 API failed 구분
- sourceKind/provider/asOf/confidence/completeness 보존
- DB write·client core import 없음

리뷰는 세 shape가 실제 matcher 소비 값으로 변환되는지와 기존 raw 진단이 유지되는지를 본다.

### G2B — 현재 connector/Q&A typed 전환 완료

G2A 패턴을 현재 값 생성 connector와 Q&A에만 확장한다.

필수 보정:

- prior award 구조화 이력과 known 범위
- IP 종류·상태와 completeness
- interest coverage, capital, fiscal year
- 감원 경과 개월 typed 연결
- industry codes와 6개 list completeness
- target type 법적 형태/신청 주체 태그 구분
- Q&A answer DTO는 클라이언트, typed 변환은 서버 소유

새 Q&A 프레임워크나 전체 문항 UI 재작성은 금지한다.

### G3 — final `CompanyProfile` 병합

필수 조건:

- 기존 base profile에서 시작
- 기존 `updateCompanyProfileField()`와 `resolveEvidencePrecedence()` 재사용
- primary에서 밀린 evidence supplemental 보존
- partial list 부재를 complete로 오인하지 않음
- 최종 profile preview와 merge decision 제공
- dev memory only, persistence 없음
- CODEF 생년월일·휴대폰·대표자명·token 원문 비노출

reviewer는 production `serviceData.ts`와 merge semantics가 갈라지지 않는지 확인한다.

### G4 — read-only shadow matching

필수 조건:

- 활성·deduped 공고 전체 평가
- DB write 없음
- engine eligible/conditional/ineligible 집계
- 사용자 노출 4상태 별도 집계
- unreviewed/partial 공고를 “지원 가능성이 높음”으로 승격 금지
- unknown을 `profile_missing`과 `grant_unready`로 분리
- business-number base 대 final profile before/after 비교
- dimension별 unknown 감소와 다음 질문
- provider별 ablation 전수 분석은 후순위

### G5 — UI와 지표 보정

기존 dev 화면 안에서만 다음 섹션을 구분한다.

1. identity prerequisite
2. eligibility 19축
3. reserved 축
4. supporting/derivation
5. ranking goals
6. final typed profile
7. shadow match와 unknown 원인

공고 가중치는 전체 활성·deduped, canonical, hard required/exclusion, non-text-only, profile-resolvable, 공고별 dimension 1회로 계산한다. production dashboard 디자인 작업은 금지한다.

### G7L — 로컬 완료 감사

개선 계획 §11의 targeted test와 core/web typecheck를 실행한다. baseline noise와 changed-file regression을 분리한다.

완료 주장은 다음으로 제한한다.

> typed profile과 read-only shadow matching 하네스가 로컬에서 검증됨. 실사업자·브라우저·provider truth gate는 대기 중.

### G0B/G6 — 예약축 decision gate

G0B는 축별 최소 30개 후보의 사람 검수다. 결과는 `activate/remain_reserved/reject` 중 하나다.

`activate` 결정이 있어도 G6를 자동 시작하지 않는다. coordinator는 다음과 같은 Orca gate를 만들고 사용자 해석을 기록한다.

```bash
orca orchestration gate-create --task <root-task-id> --question "검수 결과를 근거로 premises 또는 export_performance 축 활성화를 시작할까요? 승인할 축을 지정해 주세요." --options '["pause","premises","export_performance","both-sequentially"]' --json
```

한 번에 한 축만 profile, update normalizer, criterion contract, evaluator, extraction boundary, question, tests를 원자적으로 구현한다.

### G7E — 외부 증거

- 사용자 실행 web dev server
- `/dev/service-data` 브라우저 검증
- 사용 권한 있는 개인 15·법인 15
- live provider credential과 consent
- verified-only accuracy와 unverified 분리

서버나 표본이 없으면 external pending으로 종료한다. 로컬 완료를 외부 정확도 완료로 표현하지 않는다.

## 10. 리뷰 규약

reviewer는 요약보다 findings를 먼저 쓴다.

| 심각도 | 기준 |
|---|---|
| BLOCKER | false pass/ineligible 위험, scope 위반, data loss, authoritative evidence 덮어쓰기, DB/live write, Gate 핵심 미구현 |
| MAJOR | typed shape·completeness·4상태·unknown bucket 오류, 필수 테스트 누락 |
| MINOR | 명명·설명·비핵심 유지보수 문제 |

finding 형식:

```text
[SEVERITY] 파일:라인 — 관찰 사실
영향: 어떤 acceptance/invariant가 깨지는가
근거: 코드 경로 또는 재현 명령
최소 수정: 범위를 넓히지 않는 해결안
```

reviewer는 다음을 하지 않는다.

- 파일 수정
- 새 기능 제안으로 Gate 확대
- “깔끔하게”를 이유로 대규모 분할 제안
- 새 provider·DB·production UI 제안
- 테스트를 실행하지 않고 통과 주장

finding이 없으면 `no blocker/major findings`와 실행한 검증, 남은 external gate를 명시한다.

## 11. Gate 영수증

coordinator는 Gate가 끝날 때 이 문서 하단 또는 개선 계획 체크리스트에 다음 형식으로 한 블록만 추가한다.

```markdown
### G<N> 영수증 — YYYY-MM-DD

- Orca root/task/dispatch: `<ids>`
- 구현 파일: `<paths>`
- 구현 검증: `<commands and results>`
- 독립 리뷰: `<task id>`, BLOCKER/MAJOR `<count>`
- 수정·재리뷰: `<task id or none>`
- 외부 대기: `<items>`
- 다음 Gate: `<not started / approved>`
```

장문의 진행 서사를 기존 실행가이드에 누적하지 않는다. 상태를 바꿀 때는 체크리스트와 구체적인 task/test 증거만 갱신한다.

## 12. 전체 중단 조건

다음 중 하나면 현재 Gate를 중지한다.

- 새 API가 필요하다는 이유로 provider 구현을 시작하려 함
- field spec이 generic schema framework로 커짐
- dev proof 전에 production `serviceData.ts` 승격이나 persistence를 요구함
- `other`를 줄이기 위해 새 top-level dimension을 추가함
- premises/export를 검수 없이 활성화함
- AI가 hard eligibility를 직접 판정하게 함
- unknown을 pass로 바꿔 테스트를 맞춤
- 허용 파일 밖의 dirty 변경과 충돌
- reviewer BLOCKER가 두 fix cycle 후에도 남음
- Orca dispatch provenance 또는 worker_done을 확인할 수 없음

## 13. 신규 세션 필수 트리거 문장

아래 전체 블록을 신규 세션의 첫 요청으로 그대로 사용한다.

```text
/Users/ffgg/noten.works/cunote/docs/plans/HANDOFF-2026-07-13-service-data-매칭입력.md를 이번 작업의 실행 정본으로 사용해줘.

먼저 매칭 마스터 문서, 문제인식 문서와 개선계획, 기존 자동채움 실행가이드, 현재 git branch/HEAD/status/diff를 읽고 이 핸드오프의 preflight를 수행해. 현재 worktree의 미커밋 변경을 보존해. 통합 전이면 현재 트랙 branch의 exact HEAD, 이 핸드오프가 검증되어 로컬 `main`으로 통합된 후라면 로컬 `main`의 exact HEAD를 base로 사용해. 과거 HEAD, `origin/main`, 또는 미커밋 변경이 빠지는 base에서 시작하지 마.

반드시 Orca orchestration CLI의 실제 task/dispatch 상태를 사용해. `orca status --json`과 기존 task/terminal 상태를 확인한 뒤, `task-create -> fresh implementer terminal -> dispatch --inject -> worker_done -> fresh read-only reviewer task -> 필요한 좁은 fix -> 재리뷰` 순서를 지켜. 일반 subagent/spawn으로 대체하지 말고, runtime-global 기존 task를 reset하지 마. 같은 worktree의 writer는 한 명만 허용해.

이번 세션에서는 G1(Phase 0A + Phase 1 field SSOT/parity)만 구현하고 독립 리뷰까지 완료해. 허용 파일과 acceptance gate는 핸드오프 §9의 G1을 그대로 적용해. 새 API/provider, DB migration, production UI, production source promotion, generic framework, premises/export_performance 활성화, 전체 dev 페이지 리팩터링은 금지야. `other`는 eligibility 분모에서 제외하고 unknown 안전 경계를 유지해. 개발 서버와 live/유료 API는 실행하지 마.

구현과 리뷰 증거를 Gate 영수증 형식으로 보고하고, BLOCKER/MAJOR가 0이거나 재리뷰로 해소됐는지 명확히 밝혀. G1이 통과해도 G2A는 시작하지 말고 내 다음 지시를 기다려.
```

## 14. 다음 Gate 반복 트리거

G1 이후에는 다음 형식으로 한 Gate씩 요청한다.

```text
HANDOFF-2026-07-13-service-data-매칭입력.md의 현재 영수증과 개선계획을 다시 확인하고, Orca orchestration 수동 루프로 G<번호>만 구현·독립 리뷰·필요한 fix·재리뷰까지 진행해줘. 이전 Gate의 범위와 unknown 안전 경계를 보존하고, 다음 Gate는 시작하지 마.
```

## 15. 최종 완료 정의

이 트랙의 1차 로컬 완료는 다음 모두가 충족될 때다.

- 19축 field spec/parity
- 현재 connector/Q&A의 typed update
- evidence precedence 기반 final `CompanyProfile`
- read-only active universe shadow matching
- engine 3상태와 제품 4상태
- profile missing/grant unready 분리
- before/after unknown 감소량과 다음 질문
- corrected coverage/weighting
- targeted tests와 core/web typecheck
- 독립 reviewer의 BLOCKER/MAJOR 0

브라우저·실표본·live provider truth는 별도 외부 완료 조건이다. `premises`·`export_performance` 활성화는 이 로컬 완료 정의에 포함되지 않는다.

로컬 완료 영수증을 기록한 뒤 root task를 다음처럼 닫는다. result에는 외부 pending을 함께 남긴다.

```bash
orca orchestration task-update --id <root-task-id> --status completed --result '{"local":"complete","external":"pending"}' --json
```

## 16. 관련 문서

- [매칭 트랙 마스터 실행 문서](./2026-07-13-matching-master-execution.md)
- [매칭 입력 필드 문제인식](../research/2026-07-13-service-data-매칭입력-필드-문제인식.md)
- [매칭 입력 필드 개선 계획](./2026-07-13-service-data-매칭입력-필드-개선계획.md)
- [사업자번호 우선 자동채움 실행 가이드](./2026-07-12-사업자번호-우선-자동채움-실행가이드.md)
- [공고 매칭 1차 미션 복구 계획](./2026-07-13-first-mission-recovery-plan.md)
