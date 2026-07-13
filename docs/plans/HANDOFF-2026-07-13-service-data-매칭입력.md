# `/dev/service-data` 매칭 입력 필드 통합 실행계획

> 작성일: 2026-07-13
> 통합일: 2026-07-13
> 대상: 신규 Codex 메인 세션과 그 세션이 감독하는 Orca worker
> 상태: 문제인식·개선계획·Orca 실행계약 통합 완료 · G1부터 한 Gate씩 실행
> 단일 정본: 이 파일이 service-data 하위 트랙의 범위·순서·수용 조건·Orca 실행 방식을 모두 소유한다.
> 권장 모델: coordinator·implementer·fixer는 `gpt-5.6-sol` xhigh, reviewer·re-reviewer는 fresh `Claude Fable 5` max
> 통합 이력: 이전 `2026-07-13-service-data-매칭입력-필드-개선계획.md`의 실행 내용을 이 파일에 흡수했으며, 이전 파일은 다시 만들거나 별도 상태 원천으로 사용하지 않는다.

## 1. 문서 목적과 성공 기준

이 문서는 기존 “매칭 입력 필드 개선 계획”과 Orca 구현 핸드오프를 합친 **단일 실행 정본**이다. 신규 세션은 [문제인식 문서](../research/2026-07-13-service-data-매칭입력-필드-문제인식.md)의 확인 사실을 이 문서의 Gate 계약에 대조해 실제 코드로 옮긴다.

핵심 목표는 하나다.

> 현재 연결된 사업자 데이터와 최소 Q&A를 typed `CompanyProfile`로 만들고, 실제 matcher에 넣어 어떤 공고의 `unknown`이 줄었는지 dev 페이지에서 증명한다.

성공 흐름은 다음으로 고정한다.

```text
사업자번호 조회
  -> 현재 연결된 외부 소스의 원시 응답
  -> canonical CompanyProfileFieldUpdate[]
  -> evidence 우선순위를 적용한 CompanyProfile
  -> 활성·deduped 공고 read-only shadow matching
  -> engine 3상태와 사용자 노출 4상태
  -> 남은 unknown의 원인과 다음 최적 질문
```

1차 로컬 완료는 현재 커넥터와 Q&A가 typed profile을 만들고, 실제 matcher 입력 전후의 `unknown` 감소와 판정 변화를 재현 가능한 로컬 증거로 설명할 수 있는 상태다. 실사업자·브라우저·live provider truth는 별도 외부 Gate다.

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

## 2. 문서 우선순위와 충돌 규칙

신규 세션은 다음 순서로 읽는다.

1. [매칭 트랙 마스터 실행 문서](./2026-07-13-matching-master-execution.md): 우선순위·범위·완료 판정의 단일 기준
2. 이 통합 실행계획: service-data 하위 트랙의 범위, Phase/Gate 사양, 완료 조건, Orca 규칙
3. [매칭 입력 필드 문제인식](../research/2026-07-13-service-data-매칭입력-필드-문제인식.md): 무엇이 문제인지
4. [사업자번호 우선 자동채움 실행 가이드](./2026-07-12-사업자번호-우선-자동채움-실행가이드.md): 기존 소스·측정·외부 Gate
5. [공고 매칭 1차 미션 복구 계획](./2026-07-13-first-mission-recovery-plan.md): matcher 안전 불변식과 제품 4상태

충돌 시 마스터 문서의 현재 결함 대장과 실행 순서를 먼저 따른다. 그 다음 현재 코드, 문제인식 문서의 확인 사실, 이 문서의 Gate 계약을 우선한다. 모호하면 구현하지 말고 decision gate로 올린다.

## 3. 기준선과 현재 상태 확인

이 문서에 적힌 branch·HEAD를 실행 기준으로 고정하지 않는다. 신규 세션은 항상 실제 branch·HEAD·status·diff와 Orca task/terminal 상태를 다시 읽고 기준선을 결정한다.

이 통합 실행계획이 로컬 `main`에 포함된 후에는 **로컬 `main`의 exact HEAD**를 새 baseline으로 삼는다. 통합 전에는 승인된 현재 트랙 branch의 exact HEAD를 사용한다.

신규 세션 시작 전에 이 문서와 필수 baseline이 commit으로 고정되어 있고 working tree가 clean이라면, 승인된 통합 branch의 exact HEAD를 base로 한 clean Orca child worktree를 선택할 수 있다. 통합 전은 현재 트랙 branch, 통합 후는 로컬 `main`이 승인된 기준이다. 과거 HEAD나 `origin/main`처럼 통합된 변경이 빠지는 base를 사용하지 않는다.

새 worktree는 다음 조건을 모두 만족할 때만 사용한다.

1. 필요한 baseline과 이 통합 실행계획이 commit으로 고정되어 있다.
2. 현재 working tree에 가져가야 할 미커밋 제품 코드가 없다.
3. 새 worktree의 Git base가 통합 전에는 현재 트랙 branch, 통합 후에는 로컬 `main`의 exact HEAD와 일치한다.
4. Orca lineage를 현재 트랙의 child로 명시했다.

이 조건이 없으면 `orca worktree create`를 실행하지 않는다.

## 4. 범위·분류·안전 불변식

### 4.1 포함 범위

- matcher 기준 필드 SSOT와 화면·matcher parity
- 현재 connector 결과와 Q&A의 typed update 변환
- 기존 evidence 우선순위를 사용한 final `CompanyProfile` 병합
- 활성·deduped 공고 read-only shadow match
- `profile_missing`과 `grant_unready` unknown 분리
- dev 필드 표시·커버리지·공고 가중치 보정
- 로컬 검증과 사용자 실행 서버의 별도 외부 Gate

### 4.2 제외 범위

- 신규 외부 API·유료 provider·env key
- production dashboard/UI·source promotion
- profile DB schema·migration·raw payload 영속화 확대
- generic connector/plugin/schema framework
- dev 페이지 전체 리팩터링
- AI의 hard eligibility 직접 판정
- 지원서 작성 기능

### 4.3 필드 역할 분류

| 역할 | 포함 | eligibility/coverage 분모 |
|---|---|---:|
| `eligibility` | 운영 19축 | 포함 |
| `reserved_eligibility` | `premises`, `export_performance` | 승인 전 제외 |
| `grant_unstructured` | `other` | 제외 |
| `identity_prerequisite` | 사업자번호, 상호, 법인번호, 인증 상태, match method | 제외 |
| `supporting` | 자산총계, 자본총계, 자본금, 기준연도 등 | 제외 |
| `ranking` | support/interest goals | 제외 |
| `diagnostic` | raw 상태, 오류, cache, latency, cost | 제외 |

### 4.4 안전 불변식

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

### 5.2 모델 라우팅

| 역할 | 모델·effort | 세션 규칙 |
|---|---|---|
| coordinator | `gpt-5.6-sol` xhigh | preflight, task/dispatch 감독, Gate 영수증만 담당 |
| implementer | `gpt-5.6-sol` xhigh | Gate마다 fresh Codex terminal |
| reviewer | `Claude Fable 5` max | implementer `worker_done` 후 fresh Claude terminal, 읽기 전용 |
| fixer | `gpt-5.6-sol` xhigh | 수용된 finding만 fresh Codex terminal에서 수정 |
| re-reviewer | `Claude Fable 5` max | fix `worker_done` 후 새 Claude terminal에서 처음부터 재검토 |

로컬에서 검증된 Claude CLI 표기는 `claude --model fable --effort max`다. `ultracode`는 현재 CLI의 검증된 model/effort 옵션이 아니므로 task 명령에 쓰지 않는다. `claude ultrareview`는 별도 cloud multi-agent review이며 Orca `task/dispatch/worker_done` provenance와 이 문서의 fresh reviewer 계약을 대체하지 못하므로 사용하지 않는다.

Fable entitlement 또는 usage credit이 reviewer 시작 시 거부되면 해당 Gate를 review pending으로 중지하고 사용자에게 정확한 오류를 보고한다. 같은 Codex implementer에게 self-review를 맡기거나 다른 Claude 모델로 조용히 fallback하지 않는다. 사용자가 대체 reviewer를 명시적으로 승인한 경우에만 새 review task를 만든다.

### 5.3 동시성

- 같은 worktree의 writer는 항상 1명이다.
- implementer가 `worker_done`을 보낸 뒤 reviewer를 dispatch한다.
- reviewer가 끝난 뒤에만 fixer를 dispatch한다.
- Phase 0B 표본 검수도 코드 writer와 병렬 실행하지 않는 것을 기본값으로 한다.
- `orca orchestration run`의 자동 fan-out을 쓰지 않고 수동 루프를 사용한다.

### 5.4 Orca provenance

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
command -v codex
codex --version
command -v claude
claude --version
claude auth status --json
test -f docs/plans/2026-07-13-matching-master-execution.md
test -f docs/research/2026-07-13-service-data-매칭입력-필드-문제인식.md
test -f docs/plans/HANDOFF-2026-07-13-service-data-매칭입력.md
test -f docs/plans/2026-07-12-사업자번호-우선-자동채움-실행가이드.md
orca status --json
orca orchestration task-list --json
orca terminal list --worktree active --json
```

### preflight 중단 조건

다음이면 구현 task를 만들지 않는다.

- 마스터·통합 실행계획·문제인식·기존 자동채움 가이드 중 하나가 없음
- 현재 worktree가 이 문서가 기대하는 코드를 포함하지 않음
- Orca runtime 또는 orchestration 기능이 사용 불가
- Codex 또는 Claude CLI가 없거나 Claude가 로그인되지 않음
- reviewer 시작 시 `fable` 모델 entitlement/usage credit이 거부됨
- 다른 active terminal이 현재 Gate의 허용 파일을 수정 중
- 대상 파일 diff의 소유권을 구분할 수 없음
- clean worktree를 만들기 위해 미커밋 변경을 임의로 버려야 함

Orca가 불가하면 일반 agent 도구로 대체하지 말고 정확한 blocker를 사용자에게 보고한다.

preflight가 끝나면 구현 위치를 하나로 고정한다.

- 통합 실행계획 미커밋 또는 필요한 dirty 변경 존재: `<implementation-worktree-selector>=active`
- 통합 실행계획까지 commit·working tree clean·현재 exact HEAD 기반 child 생성 완료: `<implementation-worktree-selector>=id:<child-worktree-id>`

한 Gate 도중 selector를 바꾸지 않는다.

clean child 조건을 충족한 경우에만 다음 형태로 만든다. `--no-parent`를 쓰지 않는다. 이 구현은 현재 트랙에 종속된 child work다.

```bash
orca worktree create --name cunote-service-data-typed-loop --parent-worktree active --base-branch <approved-integration-branch> --json
git -C <child-worktree-path> rev-parse HEAD
```

child의 시작 HEAD가 preflight에서 기록한 parent HEAD와 다르면 dispatch하지 않는다.

## 7. 기본 Orca 수동 루프

### 7.1 root task

Gate 영수증에 기록된 root task ID가 있고 현재 runtime의 `task-list`에서 확인되면 재사용한다. 없을 때만 첫 세션에서 한 번 만든다. 과거 runtime의 사라진 ID를 현재 task처럼 쓰거나 중복 root를 만들지 않는다.

```bash
orca orchestration task-create --spec "CUNOTE-SD-ROOT: docs/plans/HANDOFF-2026-07-13-service-data-매칭입력.md를 실행 계약으로 사용해 /dev/service-data typed CompanyProfile -> shadow matcher 경계를 Gate별로 구현·리뷰한다. 한 번에 한 Gate만 진행하고 사용자 승인 없이 다음 Gate로 넘어가지 않는다." --json
```

반환된 root task ID를 Gate 영수증에 기록한다. root task를 worker에게 dispatch하지 않는다.

### 7.2 구현 task

```bash
orca orchestration task-create --parent <root-task-id> --spec "<현재 Gate implementer spec>" --json
orca terminal create --worktree <implementation-worktree-selector> --title cunote-sd-g<gate>-impl --command 'codex --model gpt-5.6-sol -c model_reasoning_effort="xhigh"' --json
orca terminal wait --terminal <implementer-handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <implement-task-id> --to <implementer-handle> --inject --json
orca orchestration dispatch-show --task <implement-task-id> --json
orca orchestration check --wait --types worker_done,escalation,decision_gate --timeout-ms 900000 --json
```

15분 timeout은 실패가 아니다. task 상태와 terminal activity를 확인한 뒤 rolling wait를 계속한다.

### 7.3 리뷰 task

```bash
orca orchestration task-create --parent <root-task-id> --deps '["<implement-task-id>"]' --spec "<현재 Gate read-only review spec>" --json
orca terminal create --worktree <implementation-worktree-selector> --title cunote-sd-g<gate>-review --command 'claude --model fable --effort max' --json
orca terminal wait --terminal <reviewer-handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <review-task-id> --to <reviewer-handle> --inject --json
orca orchestration dispatch-show --task <review-task-id> --json
orca orchestration check --wait --types worker_done,escalation,decision_gate --timeout-ms 900000 --json
```

reviewer spec에 `파일 수정·apply_patch·format write·git add/commit 금지`를 명시한다.

### 7.4 수정과 재리뷰

- BLOCKER/MAJOR finding이 있으면 coordinator가 finding을 검증한다.
- 수용한 finding만 별도 fix task로 만든다.
- fixer는 fresh `gpt-5.6-sol` xhigh terminal에서 원래 허용 파일과 수용 finding 범위만 수정한다.
- fix `worker_done` 후 기존 reviewer 세션을 재사용하지 않고 fresh `Claude Fable 5` max terminal에 re-review task를 dispatch한다.
- 같은 Gate에서 fix/review가 두 번 반복돼도 BLOCKER가 남으면 다음 Gate로 가지 않고 사용자에게 escalation한다.
- 리뷰 결과만으로 coordinator가 제품 코드를 직접 고치지 않는다.

fix와 re-review terminal은 다음처럼 새로 만든다.

```bash
orca terminal create --worktree <implementation-worktree-selector> --title cunote-sd-g<gate>-fix --command 'codex --model gpt-5.6-sol -c model_reasoning_effort="xhigh"' --json
orca terminal wait --terminal <fixer-handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <fix-task-id> --to <fixer-handle> --inject --json

orca terminal create --worktree <implementation-worktree-selector> --title cunote-sd-g<gate>-rereview --command 'claude --model fable --effort max' --json
orca terminal wait --terminal <re-reviewer-handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <re-review-task-id> --to <re-reviewer-handle> --inject --json
```

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

각 implementer/reviewer/fixer task spec은 해당 Gate의 허용 파일, 필수 결과, 관련 회귀 시나리오, 실행할 검증, 다음 Gate 금지를 포함해 작성한다. 아래에 완성형 spec이 있는 G1은 그대로 사용하고, 이후 Gate는 이 절의 계약을 줄이거나 넓히지 않고 같은 형식으로 구체화한다.

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

필수 하위 필드·완전성 표현:

- `industry_codes`
- industry, founder trait, certification, prior award, IP, target type 목록의 positive-only/complete 구분
- `financial_health.interest_coverage_ratio`, `capital_krw`, `fiscal_year`
- `insured_workforce.months_since_last_layoff`
- 구조화 `prior_award_history`와 known 범위
- IP 권리 종류·상태
- target type의 법적 형태·신청 주체 태그
- identity prerequisite와 ranking field

`OPERATIONAL_AUTOFILL_DIMENSIONS`는 19개 부모 eligibility row의 기준이고, 하위 supporting field는 부모축을 임의로 complete로 올리지 않는다. `FIELD_COVERAGE_PLAN`은 core field key를 참조하고 dev전용 source 메타만 덧붙인다.

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
CUNOTE-SD-G1-IMPLEMENT: 배정받은 implementation worktree에서 HANDOFF-2026-07-13-service-data-매칭입력.md의 G1만 구현한다. 편집 전 매칭 마스터, 이 통합 실행계획, 문제인식 문서, 기존 자동채움 가이드, 현재 git status와 대상 파일 diff를 읽고 기존 사용자 변경을 보존한다.

허용 범위는 신규 packages/core/src/autofill/profile-field-spec.ts와 그 test, packages/core/src/autofill/coverage.ts, packages/core/src/index.ts, apps/web/src/lib/server/devServiceDataMonitor.ts, 필요한 기존 devServiceDataMonitor test뿐이다. 허용 파일 밖 변경이 필요하면 수정하지 말고 coordinator에게 ask/escalation한다.

최소 field spec은 field key, parent dimension, eligibility/reserved_eligibility/grant_unstructured/supporting/identity_prerequisite/ranking/diagnostic role, CompanyProfile 또는 update path, scalar/list/compound readiness, denominator 포함 여부만 가진다. provider/env/UI 문구를 core로 옮기거나 generic schema framework를 만들지 않는다. 운영 19축 부모 행은 정확히 하나씩 존재하고, other는 grant_unstructured이며 eligibility/denominator에서 제외하며, premises/export_performance는 reserved_eligibility/denominator 제외로 유지한다. matcher가 소비하는 prior_award, IP, industry_codes/list completeness, financial_health, insured_workforce nested field가 누락되지 않게 parity test로 고정한다. UI, connector 동작, DB, production 경로는 바꾸지 않는다.

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
- 필요할 때만 `apps/web/src/lib/server/devServiceDataMonitor.test.ts`
- 필요한 최소 dev API response type 또는 `apps/web/src/app/api/dev/service-data/route.ts`

필수 조건:

- 표시용 `value` 유지
- `ConnectorResult`에 선택적 `profileUpdates: CompanyProfileFieldUpdate[]` 추가
- 값이 있는 success는 가능한 경우 최소 하나의 typed update를 동시 생성
- `updateCompanyProfileField()` 검증 통과
- `normalization_failed`와 API failed 구분
- sourceKind/provider/asOf/confidence/completeness 보존
- DB write·client core import 없음

숫자는 원·명·개월 단위로 canonicalize한다. list shape는 positive hit와 exhaustive/complete 목록을 구분한다. compound shape는 matcher가 실제 읽는 nested 계약을 만들어야 한다. 변환 실패는 connector API 장애로 데이터 의미를 바꾸지 않는다.

리뷰는 세 shape가 실제 matcher 소비 값으로 변환되는지와 기존 raw 진단이 유지되는지를 본다.

### G2B — 현재 connector/Q&A typed 전환 완료

G2A 패턴을 현재 값 생성 connector와 Q&A에만 확장한다.

허용 기본 파일:

- `apps/web/src/lib/server/devServiceDataProfile.ts`
- `apps/web/src/lib/server/devServiceDataProfile.test.ts`
- `apps/web/src/lib/server/devServiceDataMonitor.ts`
- `apps/web/src/lib/server/devServiceDataMonitor.test.ts`
- `apps/web/src/features/dev/ServiceDataMonitor.tsx`
- 필요한 최소 dev answer DTO/API route

필수 보정:

- prior award 구조화 이력과 known 범위
- IP 종류·상태와 completeness
- interest coverage, capital, fiscal year
- 감원 경과 개월 typed 연결
- industry codes와 6개 list completeness
- target type 법적 형태/신청 주체 태그 구분
- Q&A answer DTO는 클라이언트, typed 변환은 서버 소유
- 부분자본잠식은 `equity > 0`만 보지 않고 `equity < capital`을 별도 판정
- 예비창업은 사업자번호 조회의 기본값이 아닌 별도 시나리오

서버 `buildDevQnaProfileUpdates()`는 기존 production `QuestionDefinition`과 `updateCompanyProfileField()`를 재사용한다. user answer가 authoritative source를 묵시적으로 덮어쓰지 않아야 한다. 새 Q&A 프레임워크나 전체 문항 UI 재작성은 금지한다.

G2B의 완료는 대표 3종이 아니라 **현재 값을 만드는 connector와 Q&A가 모두 typed update를 내는 상태**다. G2A는 경계를 검증하는 수직 slice이지 G2B 완료가 아니다.

### G3 — final `CompanyProfile` 병합

허용 기본 파일:

- `apps/web/src/lib/server/devServiceDataProfile.ts`
- `apps/web/src/lib/server/devServiceDataProfile.test.ts`
- `apps/web/src/lib/server/devServiceDataMonitor.ts`
- 필요한 최소 dev response type/test

필수 조건:

- 기존 base profile에서 시작
- 기존 `updateCompanyProfileField()`와 `resolveEvidencePrecedence()` 재사용
- primary에서 밀린 evidence supplemental 보존
- partial list 부재를 complete로 오인하지 않음
- 최종 profile preview와 merge decision 제공
- dev memory only, persistence 없음
- CODEF 생년월일·휴대폰·대표자명·token 원문 비노출

reviewer는 production `serviceData.ts`와 merge semantics가 갈라지지 않는지 확인한다.

같은 base profile과 같은 update 순서를 주면 같은 final profile과 merge decision이 나와야 한다. list merge는 positive hit와 exhaustive list를 구분하고, 밀린 evidence를 삭제하지 않는다.

dev 표시는 다음 상태를 분리한다.

| 상태 | 의미 |
|---|---|
| `sourced` | 원시 응답에 값이 있음 |
| `normalized` | typed update 검증 통과 |
| `match_ready` | criterion 판정에 필요한 evidence·completeness 충족 |
| `product_consumed` | production 저장·매칭 경로에서 실제 소비 |

G3 dev proof는 앞의 세 상태만 요구한다. `product_consumed`는 production promotion 승인 전까지 pending으로 남는다.

### G4 — read-only shadow matching

허용 기본 파일:

- `apps/web/src/lib/server/devServiceDataMonitor.ts`
- `apps/web/src/lib/server/devServiceDataMonitor.test.ts`
- `apps/web/src/lib/server/devServiceDataProfile.ts`
- `apps/web/src/app/api/dev/service-data/route.ts`
- 결과 표시에 필요한 최소 `apps/web/src/features/dev/ServiceDataMonitor.tsx` 변경

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

사용자 노출 4상태는 “지원 가능성이 높음”, “정보 확인”, “원문 확인”, “지원 어려움”으로 고정한다. engine 상태와 제품 상태를 같은 enum이나 숫자로 합치지 않는다.

평가 universe와 API 반환 limit를 구분하고, 같은 profile과 grant revision에서 결과가 재현되어야 한다. `text_only`나 extraction/review 미완료는 profile 질문 부족으로 집계하지 않는다. 질문 응답 후 unknown 감소가 없으면 해당 문항을 “채움 완료”로 표시하지 않는다.

### G5 — UI와 지표 보정

허용 기본 파일:

- `apps/web/src/lib/server/devServiceDataMonitor.ts`
- `apps/web/src/lib/server/devServiceDataMonitor.test.ts`
- `apps/web/src/features/dev/ServiceDataMonitor.tsx`
- 필요한 최소 dev page/route response type

기존 dev 화면 안에서만 다음 섹션을 구분한다.

1. identity prerequisite
2. eligibility 19축
3. reserved 축
4. supporting/derivation
5. ranking goals
6. final typed profile
7. shadow match와 unknown 원인

공고 가중치는 전체 활성·deduped, canonical, hard required/exclusion, non-text-only, profile-resolvable, 공고별 dimension 1회로 계산한다. production dashboard 디자인 작업은 금지한다.

커버리지는 다음 네 개를 합치지 않고 별도로 표시한다.

- `sourcing_coverage`
- `canonical_match_ready_coverage`
- `grant_extraction_readiness`
- `end_to_end_decidability`

`authoritative_axis_coverage`와 `total_answered_coverage`를 소싱 지표로 유지하더라도 actual match-ready로 읽히지 않게 이름과 설명을 보정한다. 가중치 분모는 샘플 500건으로 잘라서는 안 되며, preferred criterion과 `other`를 포함하지 않고, reviewed/pending을 분리한다.

### G7L — 로컬 완료 감사

변경 범위에 해당하는 다음 검증을 실행하고 baseline noise와 changed-file regression을 분리한다.

```bash
./node_modules/.bin/tsx packages/core/src/autofill/profile-field-spec.test.ts
./node_modules/.bin/tsx packages/core/src/autofill/coverage.test.ts
./node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/devServiceDataProfile.test.ts
./node_modules/.bin/tsx packages/core/src/criteria/canonicalize.test.ts
./node_modules/.bin/tsx packages/core/src/matching/match.test.ts
./node_modules/.bin/tsx packages/core/src/matching/question-planner.test.ts
./node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/devServiceDataMonitor.test.ts
pnpm --filter @cunote/core typecheck
pnpm --filter @cunote/web typecheck
pnpm verify:service-data
git diff --check -- <Gate별 변경 파일>
```

실제 파일명이 다르거나 해당 Gate에서 아직 생성하지 않은 테스트는 물리적 경로를 확인한 후 가장 가까운 focused test로 대체하고, 대체 사유를 영수증에 기록한다. 존재하지 않는 명령을 통과했다고 쓰지 않는다.

완료 주장은 다음으로 제한한다.

> typed profile과 read-only shadow matching 하네스가 로컬에서 검증됨. 실사업자·브라우저·provider truth gate는 대기 중.

### G0B/G6 — 예약축 decision gate

G0B는 축별 최소 30개 후보의 사람 검수다. 결과는 `activate/remain_reserved/reject` 중 하나다.

축별 검수는 다음 순서를 따른다.

1. 2026-07-13 후보 query를 재현해 최소 30개 공고를 추출한다.
2. 각 후보를 hard eligibility, preferred/ranking, 혜택 설명, 수행 요건, 기존 축 오분류, 구조화 불가 long-tail로 분류한다.
3. hard eligibility에 대해서만 필요한 회사 값, operator, 단위, 기간, 근거 span을 기록한다.
4. 하나의 안정된 profile/criterion 계약으로 표현 가능한지 판단한다.
5. 대표 예시와 반례를 남기고 축별 결정을 기록한다.

반복 빈도만으로 활성화하지 않는다. 회사 값을 현실적으로 입력·조회할 수 없거나, 서로 다른 의미가 한 축에 섞이거나, false ineligible을 막을 안전한 unknown 경계가 없으면 활성화하지 않는다.

`activate` 결정이 있어도 G6를 자동 시작하지 않는다. coordinator는 다음과 같은 Orca gate를 만들고 사용자 해석을 기록한다.

```bash
orca orchestration gate-create --task <root-task-id> --question "검수 결과를 근거로 premises 또는 export_performance 축 활성화를 시작할까요? 승인할 축을 지정해 주세요." --options '["pause","premises","export_performance","both-sequentially"]' --json
```

한 번에 한 축만 profile field contract, update normalizer, criterion canonical contract, deterministic evaluator, extraction/canonicalization boundary, question definition, dev field spec/readiness, matcher·parser·question regression test, 표본 shadow match를 원자적으로 구현한다. 승인 전에는 enum 자리만 유지하고 matcher는 unknown, question planner는 질문 안 함, eligibility 분모는 제외를 유지한다.

### G7E — 외부 증거

- 사용자 실행 web dev server
- `/dev/service-data` 브라우저 검증
- 사용 권한 있는 개인 15·법인 15
- live provider credential과 consent
- verified-only accuracy와 unverified 분리

브라우저에서 조회 성공·정상 빈값·실패·cache 상태, typed profile preview, prior award/IP/재무/감원 Q&A, before/after match summary, mobile/desktop 기본 overflow와 오류 상태를 확인한다. 개발 서버가 없으면 Codex가 시작하지 않고 사용자에게 실행을 요청한다.

30개 표본으로 source별 응답률·정상 빈값, typed normalization 성공률, authoritative/self-declared 충돌률, 기본 profile의 match-ready 축 수, 질문 수·질문당 unknown 감소를 측정한다. 사업자번호는 기존 마스킹을 유지하고, CODEF 인증 원문·token·외부 raw payload를 브라우저 응답·snapshot·문서에 남기지 않는다.

서버나 표본이 없으면 external pending으로 종료한다. 로컬 완료를 외부 정확도 완료로 표현하지 않는다.

### Gate 공통 회귀 시나리오

각 Gate는 자신이 건드린 행동에 해당하는 시나리오를 focused test로 고정한다.

1. 개인사업자에 법인번호가 없으면 법인 전용 API는 `failed`가 아니라 prerequisite다.
2. 법인의 DART bridge가 성공하면 법인번호와 재무 source가 typed update로 연결된다.
3. KIPRIS exact positive는 IP 종류 update와 partial/complete 의미를 유지한다.
4. KIPRIS miss는 IP 미보유로 단정하지 않는다.
5. certification present-only는 positive만 병합하고 부재는 unknown으로 남긴다.
6. prior award의 미질의 program 범위는 부재 pass로 바뀌지 않는다.
7. `equity > 0`이어도 `equity < capital`이면 부분자본잠식을 놓치지 않는다.
8. 감원 사실만 있고 시점이 없으면 unknown이다.
9. 감원 후 경과 개월이 있으면 기준에 따라 pass/fail이 결정론적으로 나온다.
10. 파생 업력·규모는 display 가능과 matcher evidence 충분성을 구분한다.
11. `other`/`text_only`는 profile 질문 후보에서 제외한다.
12. user answer가 authoritative source와 충돌하면 authoritative primary를 유지하고 user evidence는 supplemental로 남긴다.
13. unreviewed grant가 engine eligible이어도 제품 상태는 “원문 확인”으로 남긴다.
14. CODEF 인증 흐름은 생년월일·휴대폰번호·token을 profile preview나 snapshot에 노출하지 않는다.

### 문제-작업 추적성

| 문제인식 | 해결 Gate | 누락 시 실패 |
|---|---|---|
| P0 display-only 경계 | G2A·G2B·G3·G4 | API 응답이 실제 판정으로 이어졌는지 모름 |
| P1 필드 계약 드리프트 | G1 | matcher 변경 때 화면이 다시 낡음 |
| P2 부분자본잠식 | G1·G2B·G5 | `equity > 0`을 정상으로 오표시 |
| P3 target type 의미 축소 | G1·G2B·G5 | 법적 형태만으로 신청 주체 전체를 complete 처리 |
| P4 `other`/ranking 혼합 | G1·G5 | 공고 추출 문제를 사용자 입력 문제로 오인 |
| P5 부모축 complete 과장 | G1·G4 | 복합 criterion의 실제 unknown을 숨김 |
| P6 잘못된 공고 가중치 | G5 | 필드 ROI 우선순위 왜곡 |
| P7 커버리지 혼합 | G4·G5 | API coverage를 판정 가능률로 오인 |
| P8 조회 전제 비가시성 | G1·G5 | join key 부족을 데이터 부재로 오인 |
| P9 display-to-match 테스트 부재 | G1~G7L | 같은 드리프트 재발 |

### 권장 diff 경계

커밋 여부와 관계없이 다음 경계를 섞지 않는다.

1. G1: `autofill: define matcher-consumed field spec and parity`
2. G2A/G2B: `service-data: emit typed profile updates`
3. G3: `service-data: merge profile evidence and preview final profile`
4. G4: `service-data: add read-only shadow match deltas`
5. G5: `service-data: correct field UI and weighted readiness`
6. 승인된 경우만 G6: `matching: activate premises` 또는 `matching: activate export performance`

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

coordinator는 Gate가 끝날 때 **이 문서에만** 다음 형식으로 영수증 한 블록을 추가한다.

```markdown
### G<N> 영수증 — YYYY-MM-DD

- Orca root/task/dispatch: `<ids>`
- 모델/terminal: `<gpt-5.6-sol xhigh implementer, Fable 5 max reviewer handles>`
- 구현 파일: `<paths>`
- 구현 검증: `<commands and results>`
- 독립 리뷰: `<task id>`, BLOCKER/MAJOR `<count>`
- 수정·재리뷰: `<task id or none>`
- 외부 대기: `<items>`
- 다음 Gate: `<not started / approved>`
```

장문의 진행 서사를 기존 실행가이드에 누적하지 않는다. 상태를 바꿀 때는 체크리스트와 구체적인 task/test 증거만 갱신한다.

Gate 상태는 다음 체크리스트에서 영수증과 함께 갱신한다.

- [x] G1 field SSOT/parity
- [x] G2A scalar/list/compound vertical slice
- [ ] G2B current connector/Q&A typed conversion
- [ ] G3 final CompanyProfile merge
- [ ] G4 active-universe read-only shadow match
- [ ] G5 dev UI/coverage/weighting correction
- [ ] G7L local completion audit
- [ ] G0B reserved-axis human review or explicit pending
- [ ] G6 approved axis activation or explicit not approved
- [ ] G7E browser/30-sample/live truth or explicit external pending

### G1 영수증 — 2026-07-13

- Orca root/task/dispatch: root `task_011d0d6c6538`; implement `task_78ee1ea7de60` / `ctx_a6afaf1ddc43`; review `task_e192f8fd95b4` / `ctx_dcf080955b04`; fix `task_193482528b87` / `ctx_a0219b56b431`; re-review `task_0ff91feca22e` / `ctx_2781f5bf4084`
- 모델/terminal: implementer `gpt-5.6-sol` xhigh `term_caaa4ea2-22de-42b3-950b-a09b9db136de`; reviewer Fable 5 max `term_92713065-d952-458f-8dda-9f2f6f8c7471`; fixer `gpt-5.6-sol` xhigh `term_b296fb9a-9f4b-44e5-9eab-a42c513aaafd`; re-reviewer Fable 5 max `term_0deb3134-5481-4c5e-ae0c-f36238f332f0`
- 구현 파일: `packages/core/src/autofill/profile-field-spec.ts`, `packages/core/src/autofill/profile-field-spec.test.ts`, `packages/core/src/autofill/coverage.ts`, `packages/core/src/index.ts`, `apps/web/src/lib/server/devServiceDataMonitor.ts`, `apps/web/src/lib/server/devServiceDataMonitor.test.ts`
- 구현 검증: `profile-field-spec.test.ts`, `coverage.test.ts`, `devServiceDataMonitor.test.ts`, core/web typecheck, changed-file `git diff --check` 모두 통과; contracts/core build prerequisite 후 dist 기반 typecheck 재확인
- 독립 리뷰: `task_e192f8fd95b4`, BLOCKER 0 / MAJOR 1; contracts runtime `CRITERION_DIMENSIONS`와 부모행 parity 미고정 finding 수용
- 수정·재리뷰: `task_193482528b87`에서 test 한 파일만 수정; `task_0ff91feca22e` 전면 재리뷰 BLOCKER 0 / MAJOR 0 / MINOR 2
- 외부 대기: G0B 예약축 표본 검수·사용자 decision gate, G7E 사용자 실행 dev server 브라우저·30개 실표본·live provider truth
- 다음 Gate: G2A not started; 사용자 승인 대기

### G2A 영수증 — 2026-07-14

- Orca root/task/dispatch: root `task_011d0d6c6538`; implement `task_7d2c4ae7e06f` / `ctx_f3b74f82bc69`; review `task_ad432286c69b` / `ctx_d6f646e48030`; fix `task_6f1e92f53792` / `ctx_36f895bdd572`; re-review `task_671611312339` / `ctx_e9bb039766f3`
- 모델/terminal: implementer `gpt-5.6-sol` xhigh `term_8975fffc-3f04-42f3-8c9a-55d005601568`; reviewer Fable 5 max `term_6caf7905-59e4-4778-acae-9819755f80b1`; fixer `gpt-5.6-sol` xhigh `term_00763bae-504c-49b8-9e97-01574d4cfdd2`; re-reviewer Fable 5 max `term_196c1e1a-3cda-40f3-b5b8-71834adb8f32`
- 구현 기준점: G1 checkpoint `7ce3688c3fb3909ec77364cd484fe056072d4a9b`; G2A는 같은 child worktree에서 미커밋 상태로 유지
- 구현 파일: `apps/web/src/lib/server/devServiceDataProfile.ts`, `apps/web/src/lib/server/devServiceDataProfile.test.ts`, `apps/web/src/lib/server/devServiceDataMonitor.ts`, `apps/web/src/lib/server/devServiceDataMonitor.test.ts`
- 구현 검증: `devServiceDataProfile.test.ts`, `devServiceDataMonitor.test.ts`, core `update-profile-field.test.ts` 36건, core/web typecheck, tracked/untracked changed-file `git diff --check` 모두 통과
- 독립 리뷰: `task_ad432286c69b`, BLOCKER 0 / MAJOR 0 / MINOR 2; FSC 하위 진단행 completeness 표시와 certification 병합 시 드문 normalization failure 진단 유실 가능성은 matcher·coverage 수치·데이터 의미에 영향 없는 비핵심 가시성 finding으로 기록
- 수정·재리뷰: `task_6f1e92f53792`에서 원 MINOR 2건만 수정; `task_671611312339` 재리뷰에서 두 건 해소와 코드 BLOCKER 0 / MAJOR 0 / MINOR 0 확인. 재리뷰의 영수증 staleness MINOR 1건은 이 행 갱신으로 해소
- 외부 대기: G0B 예약축 표본 검수, G7E 사용자 실행 dev server 브라우저·개인15/법인15 실표본·live provider truth
- 다음 Gate: G2B not started; 사용자 승인 대기

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

먼저 매칭 마스터 문서, 이 통합 실행계획, 문제인식 문서, 기존 자동채움 실행가이드, 현재 git branch/HEAD/status/diff를 읽고 preflight를 수행해. 현재 worktree의 미커밋 변경을 보존해. 통합 전이면 현재 트랙 branch의 exact HEAD, 이 문서가 검증되어 로컬 `main`으로 통합된 후라면 로컬 `main`의 exact HEAD를 base로 사용해. 과거 HEAD, `origin/main`, 또는 미커밋 변경이 빠지는 base에서 시작하지 마.

반드시 Orca orchestration CLI의 실제 task/dispatch 상태를 사용해. `orca status --json`과 기존 task/terminal 상태를 확인한 뒤, `task-create -> fresh implementer terminal -> dispatch --inject -> worker_done -> fresh read-only reviewer task -> 필요한 좁은 fix -> 재리뷰` 순서를 지켜. 일반 subagent/spawn으로 대체하지 말고, runtime-global 기존 task를 reset하지 마. 같은 worktree의 writer는 한 명만 허용해.

모델 라우팅은 coordinator·implementer·fixer에 `gpt-5.6-sol` xhigh, reviewer·re-reviewer에 fresh `Claude Fable 5` max를 사용해. Claude terminal은 `claude --model fable --effort max`로 만들고 `claude ultrareview`나 기존 reviewer 세션 재사용으로 대체하지 마. Fable entitlement나 usage credit이 거부되면 다른 모델로 fallback하지 말고 review pending blocker로 보고해.

이번 세션에서는 G1(Phase 0A + Phase 1 field SSOT/parity)만 구현하고 독립 리뷰까지 완료해. 허용 파일과 acceptance gate는 통합 실행계획 §9의 G1을 그대로 적용해. 새 API/provider, DB migration, production UI, production source promotion, generic framework, premises/export_performance 활성화, 전체 dev 페이지 리팩터링은 금지야. `other`는 eligibility 분모에서 제외하고 unknown 안전 경계를 유지해. 개발 서버와 live/유료 API는 실행하지 마.

구현과 리뷰 증거를 Gate 영수증 형식으로 보고하고, BLOCKER/MAJOR가 0이거나 재리뷰로 해소됐는지 명확히 밝혀. G1이 통과해도 G2A는 시작하지 말고 내 다음 지시를 기다려.
```

## 14. 다음 Gate 반복 트리거

G1 이후에는 다음 형식으로 한 Gate씩 요청한다.

```text
HANDOFF-2026-07-13-service-data-매칭입력.md의 현재 영수증, Gate 계약, 문제-작업 추적성을 다시 확인하고, Orca orchestration 수동 루프로 G<번호>만 구현·독립 리뷰·필요한 fix·재리뷰까지 진행해줘. 이전 Gate의 범위와 unknown 안전 경계를 보존하고, 다음 Gate는 시작하지 마.
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
- [사업자번호 우선 자동채움 실행 가이드](./2026-07-12-사업자번호-우선-자동채움-실행가이드.md)
- [공고 매칭 1차 미션 복구 계획](./2026-07-13-first-mission-recovery-plan.md)
