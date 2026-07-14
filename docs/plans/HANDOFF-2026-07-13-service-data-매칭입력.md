# service-data 매칭 입력 통합·제품 승격 실행계획

> 작성일: 2026-07-13
> 통합일: 2026-07-13
> 대상: 신규 Codex 메인 세션과 그 세션이 감독하는 Orca worker
> 상태: G1~G7 dev 증명 완료 (`fcc190c`, 2026-07-14) · 제품 승격 P0~P6 계획 초안 작성 완료 · 제품 코드 구현 전
> 단일 정본: 이 파일이 service-data 하위 트랙의 범위·순서·수용 조건·Orca 실행 방식을 모두 소유한다.
> 권장 모델: coordinator·implementer·fixer는 `gpt-5.6-sol` xhigh, reviewer·re-reviewer는 fresh `Claude Fable 5` max
> 통합 이력: 이전 `2026-07-13-service-data-매칭입력-필드-개선계획.md`의 실행 내용을 이 파일에 흡수했으며, 이전 파일은 다시 만들거나 별도 상태 원천으로 사용하지 않는다.
> 제품 승격 결정: 2026-07-14부터 다음 목표는 새 로직 추가가 아니라 **검증된 매칭·자동채움 로직을 모든 실제 사용자 진입점의 단일 경로로 만드는 것**이다. P0~P6가 끝날 때까지 별도 인터페이스 리디자인은 시작하지 않는다.

## 1. 문서 목적과 성공 기준

이 문서는 기존 “매칭 입력 필드 개선 계획”과 Orca 구현 핸드오프를 합친 **단일 실행 정본**이다. 신규 세션은 [문제인식 문서](../research/2026-07-13-service-data-매칭입력-필드-문제인식.md)의 확인 사실을 이 문서의 Gate 계약에 대조해 실제 코드로 옮긴다.

G1~G7의 dev 증명 목표는 다음과 같았고 `fcc190c`에서 완료됐다.

> 현재 연결된 사업자 데이터와 최소 Q&A를 typed `CompanyProfile`로 만들고, 실제 matcher에 넣어 어떤 공고의 `unknown`이 줄었는지 dev 페이지에서 증명한다.

이제 이 문서의 최종 목표는 다음으로 확장한다.

> 익명 `/matches`, 로그인 대시보드와 매칭 페이지, web/app API, 자동채움·답변 저장·재평가가 모두 하나의 제품용 profile resolution과 matcher 경로를 사용하게 한다. 이후 matcher·자동채움 로직을 한 곳에서 개선하면 별도 UI 재배선 없이 모든 사용자 화면과 결과에 즉시 반영되어야 한다.

dev 증명에 사용한 원래 성공 흐름은 다음과 같다.

```text
사업자번호 조회
  -> 현재 연결된 외부 소스의 원시 응답
  -> canonical CompanyProfileFieldUpdate[]
  -> evidence 우선순위를 적용한 CompanyProfile
  -> 활성·deduped 공고 read-only shadow matching
  -> engine 3상태와 사용자 노출 4상태
  -> 남은 unknown의 원인과 다음 최적 질문
```

제품 성공 흐름은 이 위에 다음 단일 경로를 고정한다.

```text
제품 접근 컨텍스트(anonymous / owned cache / owned refresh)
  -> 그 컨텍스트에 허용된 source acquisition
  -> canonical CompanyProfileFieldUpdate[]
  -> 동일한 evidence precedence와 final CompanyProfile resolver
  -> 동일한 deterministic matcher + question planner
  -> 안전한 19축 MatchingProfileView + 제품 4상태 + 다음 질문
  -> /matches · dashboard · web/app API가 같은 결과 소비
```

G1~G7의 1차 로컬 완료는 현재 커넥터와 Q&A가 typed profile을 만들고, 실제 matcher 입력 전후의 `unknown` 감소와 판정 변화를 재현 가능한 로컬 증거로 설명하는 상태였다. P0~P6 제품 완료는 그 결과가 실제 사용자 경로에서 같은 의미로 소비되고, `product_consumed=pending`이 하나도 남지 않는 상태다.

신규 세션은 전체 계획을 한 번에 구현하지 않는다. G/P Gate마다 다음 순서를 지킨다.

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

G1~G7에서 사용한 사용자 승인 단위 진행 규칙은 당시 영수증에 그대로 보존한다. P0~P6 구현을 시작할 때도 Gate마다 구현·독립 리뷰·회귀·checkpoint commit을 남기되, 사용자가 P0~P6 전체 실행을 명시적으로 승인하면 BLOCKER나 중단 조건이 없는 한 다음 Gate로 자율 진행할 수 있다.

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

아래 목록은 G1~G7 dev 증명 범위다. P0~P6 제품 승격 범위는 §17~§24가 추가로 소유한다.

- matcher 기준 필드 SSOT와 화면·matcher parity
- 현재 connector 결과와 Q&A의 typed update 변환
- 기존 evidence 우선순위를 사용한 final `CompanyProfile` 병합
- 활성·deduped 공고 read-only shadow match
- `profile_missing`과 `grant_unready` unknown 분리
- dev 필드 표시·커버리지·공고 가중치 보정
- 로컬 검증과 사용자 실행 서버의 별도 외부 Gate

### 4.2 제외 범위

아래 제외는 G1~G7에 적용된 역사적 경계다. §17 이후의 명시적 제품 승격 항목은 `production dashboard/UI·source promotion` 제외를 대체하지만, 신규 provider·generic framework·근거 없는 값 확정 금지는 계속 유지한다.

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
7. G1~G7에서는 새 API/provider/env key를 추가하지 않는다. P0~P6도 현재 연결·검증된 소스의 제품 배선만 허용하며, 새 provider는 마스터 문서 개정 없이는 추가하지 않는다.
8. G1~G7에서는 DB migration, production UI, production source promotion을 하지 않는다. P0~P6에서는 §17~§24에 적힌 제품 배선·기능 UI만 허용하고, schema migration은 19축 round-trip 결함이 기존 schema로 해소되지 않는다는 증거와 별도 Gate 없이는 하지 않는다.
9. generic connector/plugin/schema framework를 만들지 않는다.
10. 현재 dev 페이지 전체 리팩터링을 하지 않는다.
11. G1~G7 검증에서는 외부 provider live 호출, 유료 호출, DB write를 하지 않는다. P0~P5도 fixture/cache 중심으로 검증하고, P6에서만 승인된 표본·권한·사용자 실행 서버로 bounded live read와 owner-scoped write를 허용한다.
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

G5 dev proof의 사용자 노출 4상태는 “지원 가능성이 높음”, “정보 확인”, “원문 확인”, “지원 어려움”으로 검증했다. engine 상태와 제품 상태를 같은 enum이나 숫자로 합치지 않는다. 다만 production copy는 마스터 D9와 P4가 우선하므로 D9 해제 전에는 positive label을 중립 표현으로 바꾼다.

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
- [x] G2B current connector/Q&A typed conversion
- [x] G3 final CompanyProfile merge
- [x] G4 active-universe read-only shadow match
- [x] G5 dev UI/coverage/weighting correction
- [x] G7L local completion audit
- [x] G0B reserved-axis human review or explicit pending
- [x] G6 approved axis activation or explicit not approved
- [x] G7E browser/30-sample/live truth or explicit external pending

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
- 구현 기준점: G1 checkpoint `7ce3688c3fb3909ec77364cd484fe056072d4a9b`; G2A checkpoint `195f485374e1e0d92a1101e80267f20ac62cb769`
- 구현 파일: `apps/web/src/lib/server/devServiceDataProfile.ts`, `apps/web/src/lib/server/devServiceDataProfile.test.ts`, `apps/web/src/lib/server/devServiceDataMonitor.ts`, `apps/web/src/lib/server/devServiceDataMonitor.test.ts`
- 구현 검증: `devServiceDataProfile.test.ts`, `devServiceDataMonitor.test.ts`, core `update-profile-field.test.ts` 36건, core/web typecheck, tracked/untracked changed-file `git diff --check` 모두 통과
- 독립 리뷰: `task_ad432286c69b`, BLOCKER 0 / MAJOR 0 / MINOR 2; FSC 하위 진단행 completeness 표시와 certification 병합 시 드문 normalization failure 진단 유실 가능성은 matcher·coverage 수치·데이터 의미에 영향 없는 비핵심 가시성 finding으로 기록
- 수정·재리뷰: `task_6f1e92f53792`에서 원 MINOR 2건만 수정; `task_671611312339` 재리뷰에서 두 건 해소와 코드 BLOCKER 0 / MAJOR 0 / MINOR 0 확인. 재리뷰의 영수증 staleness MINOR 1건은 이 행 갱신으로 해소
- 외부 대기: G0B 예약축 표본 검수, G7E 사용자 실행 dev server 브라우저·개인15/법인15 실표본·live provider truth
- 다음 Gate: G2B completed

### G2B 영수증 — 2026-07-14

- Orca root/task/dispatch: root `task_011d0d6c6538`; implement `task_0faf9812f7e1` / `ctx_731d50047c55`; review `task_55bc70064867` / `ctx_68d137b87796`; fix `task_7707c62d16dd` / `ctx_e4662a2fc5e7`; re-review `task_462c6ae95554` / `ctx_bdc38eeff49a`; negative-ratio fix `task_d67e21e344d9` / `ctx_851bb135b0ef`; full re-review `task_1d89312329aa` / `ctx_d8c1600e89be`; final MINOR fix `task_ec74bcd52f92` / `ctx_e323b7feb06f`; final re-review `task_73027bace0b8` / `ctx_3d6d22eb39ae`
- 모델/terminal: implementer `gpt-5.6-sol` xhigh `term_8a710bbd-7e19-455d-bda5-4b581150a232`; first reviewer Fable 5 max `term_416b4172-48e1-48f1-9aaa-840b6d95bafe`; fixers `gpt-5.6-sol` xhigh `term_7bceaa99-0b3d-428d-b810-e3e8181c3cf6`, `term_d491e62b-dc45-4e03-85be-9ae69bc38447`, `term_6f9c4065-a39e-4efc-9b25-219372a2a20d`; re-reviewers Fable 5 max `term_2d43b9cd-25e6-4d12-9c55-e82387d36520`, `term_e4365f3e-39b5-4f8d-9191-b0f03d520d15`, `term_c0df75a2-40e4-4975-af40-63c3f4af1a29`
- 구현 파일: `apps/web/src/lib/server/devServiceDataProfile.ts`, `apps/web/src/lib/server/devServiceDataProfile.test.ts`, `apps/web/src/lib/server/devServiceDataMonitor.ts`, `apps/web/src/lib/server/devServiceDataMonitor.test.ts`, `apps/web/src/features/dev/ServiceDataMonitor.tsx`, `apps/web/src/app/api/dev/service-data/route.ts`
- 구현 검증: profile/monitor focused tests, core `update-profile-field.test.ts` 36건, core `match.test.ts` 24건, core/web typecheck, changed-file `git diff --check` 모두 통과
- 독립 리뷰: 최초 `task_55bc70064867` BLOCKER 1 / MAJOR 2 / MINOR 3; KIPRIS completeness, FSC+DART parent merge, production connector tests, preliminary union, dead builders, G3 baseProfile 경계를 모두 수용해 보정. `task_462c6ae95554`에서 원 finding 전부 해소, 새 MAJOR 1 / MINOR 1을 수용해 음수 부채비율 typed 생략·미사용 helper 제거
- 수정·재리뷰: `task_1d89312329aa` 전면 재리뷰 BLOCKER 0 / MAJOR 0 / MINOR 2; NICE 미분리 결격 신호를 unknown으로 보존하고 FSC/NICE 자본총계·자본금 결측 문구를 구분. `task_73027bace0b8` 최종 재리뷰 BLOCKER 0 / MAJOR 0 / MINOR 0, INFO 2는 의도적 unknown 보류 audit 노이즈와 비차단 지역 변수로 수용
- 판단 기록: 불명확한 NICE PB/OCCD06 양성 신호는 두 플래그를 동시에 확정하지 않고 diagnostic display만 보존한다. 0건과 분리된 exact 신호만 known/pass 또는 held/fail로 사용해 false eligible·false ineligible을 모두 피한다. `product_consumed`는 production promotion 전까지 pending으로 둔다.
- 외부 대기: G0B 예약축 표본 검수, G7E 브라우저·개인15/법인15 실표본·live provider truth
- 다음 Gate: G3 approved by user continuation request; not started at this receipt

### G3 영수증 — 2026-07-14

- Orca root/task/dispatch: root `task_011d0d6c6538`; implement `task_ba241987e7c0` / `ctx_ed32537b7bd3`; review `task_a2071db69deb` / `ctx_cb727335e32e`; fix `task_5a7dce3d2ad5` / `ctx_4282e594b0f5`; re-review `task_db4510e93526` / `ctx_8e7443256de1`
- 모델/terminal: implementer `gpt-5.6-sol` xhigh `term_6e00bb96-15a0-4e0f-9be2-352ade6c342f`; reviewer Fable 5 max `term_ca68153b-2a0f-44cd-b81e-b909e1e834e5`; fixer `gpt-5.6-sol` xhigh `term_5ec2ccec-e09d-4531-8cc0-4c08b186dbce`; re-reviewer Fable 5 max `term_47e0c43f-45c0-4970-b9bc-8d22280c09db`
- 구현 파일: `apps/web/src/lib/server/devServiceDataProfile.ts`, `apps/web/src/lib/server/devServiceDataProfile.test.ts`, `apps/web/src/lib/server/devServiceDataMonitor.ts`, `apps/web/src/lib/server/devServiceDataMonitor.test.ts`, `apps/web/src/app/api/dev/service-data/route.ts`
- 구현 검증: profile/monitor focused tests, core `evidence-priority.test.ts` 10건, `update-profile-field.test.ts` 36건, `match.test.ts` 24건, core/web typecheck, `verify:company-enrichment` 9 checks, `verify:service-data` 6 checks, changed-file `git diff --check` 모두 통과. verify 명령은 Popbill/DB env 부재 시 정해진 sample fallback으로 `ok:true`, DB write와 live provider 호출 없음
- 독립 리뷰: `task_a2071db69deb` BLOCKER 0 / MAJOR 0 / MINOR 3; `other_conditions` overlay, retained confidence, raw payload redaction 범위를 모두 수용
- 수정·재리뷰: `task_5a7dce3d2ad5`에서 profile 구현·테스트 두 파일만 보정. `task_db4510e93526` 최종 재리뷰 BLOCKER 0 / MAJOR 0 / MINOR 0 / NOTE 3; production scalar/list/compound/evidence parity, connector→Q&A order, byte-equal replay, partial absence, supplemental 보존, 상태 분리와 민감정보 비노출을 재확인
- 판단 기록: G3 final merge API를 위한 `route.ts`는 최소 dev response 경계로 승인한다. raw payload 전체를 숨기지 않고 비민감 provider 진단은 보존하되 CODEF `birthDate8`/`loginIdentity`/phone/mobile/대표자/`resCeoNm`/token 계열은 casing·separator 변형까지 재귀 제거한다. 같은 base·ordered updates·명시 `qna.asOf`는 같은 preview/decision을 만들며, `product_consumed`는 production promotion 전까지 항상 pending이다.
- 외부 대기: G7E 브라우저에서 실제 profileMerge·redaction 가시성, 개인15/법인15 실표본·live provider truth
- 다음 Gate: G4 approved by user continuation request; not started at this receipt

### G4 영수증 — 2026-07-14

- Orca root/task/dispatch: root `task_011d0d6c6538`; implement `task_730748aedc53` / `ctx_25c9782aad7a`; first review `task_11203483fb49` / `ctx_892ec8c76177`; findings fix `task_8f15b0b31126` / `ctx_8f49aebc21e3`; structured-unreviewed fix `task_ef057859353b` / `ctx_6f1d4c554af5`; first re-review `task_2d64ff0954a9` / `ctx_00d4dd23876f`; safety fix `task_97db73a6a727` / `ctx_26767a269638`; final review `task_50bf18c0d2de` / `ctx_69984b79d2c3`
- 모델/terminal: implementer `gpt-5.6-sol` xhigh `term_a405dcca-112f-4d46-a4fb-e95b3d8da40d`; first reviewer Fable 5 max `term_5067f1a0-0dfb-4efc-89e4-30172a9fcaad`; fixers `gpt-5.6-sol` xhigh `term_e89f0349-e1f2-4875-97b0-622401fef5ac`, `term_fe630304-498a-428b-b7ab-380a645181b5`, `term_368382a1-66e8-4f8c-9fe2-6c64d02e5d48`; re-reviewers Fable 5 max `term_882a766f-4106-41f2-adc3-e8dbc30af555`, `term_e049e5f2-c924-4bc4-9d51-0c40cb79f0ff`
- 구현 파일: `apps/web/src/app/api/dev/service-data/route.ts`, `apps/web/src/lib/server/devServiceDataMonitor.ts`, `apps/web/src/lib/server/devServiceDataMonitor.test.ts`, `packages/core/src/matching/question-planner.ts`, `packages/core/src/matching/question-planner.test.ts`
- 구현 검증: monitor/profile focused tests, core question planner 10건, match 24건, canonicalize/question-visibility/range-question-flow tests, core/web typecheck, `verify:service-data` 6 checks `ok:true`, changed-file `git diff --check` 모두 통과. verify 명령은 provider/DB env 부재 시 정해진 sample fallback을 사용했으며 DB write와 live provider 호출 없음
- 독립 리뷰: 최초 `task_11203483fb49` BLOCKER 0 / MAJOR 1 / MINOR 3. 원 findings 수정 뒤 첫 re-review가 PASS를 보고했으나 coordinator가 active-universe 경계, 혼합 criterion, malformed reviewed criterion, structured-unreviewed hard fail, high-risk review reason을 각각 재현해 PASS를 기각하고 추가 안전 보정을 지시
- 수정·재리뷰: `task_97db73a6a727`에서 default repository adapter를 `drizzle`로 fail-closed 제한하고, criterion resolvability를 core planner와 공유하며, 같은 dimension의 clean/text-only 병존·malformed reviewed·non-reviewed hard fail·review reason 회귀 테스트를 추가. `task_50bf18c0d2de` 최종 전면 재리뷰 BLOCKER 0 / MAJOR 0 / MINOR 0 / NOTE 3
- 판단 기록: runtime/sample repository는 전체 universe 증거로 사용하지 않고 503 unavailable로 닫는다. 공고 준비도와 profile 질문 가능성을 분리해 같은 dimension이 `profile_missing`과 `grant_unready` 양쪽에 있을 수 있게 한다. 비검수 hard fail은 `지원 어려움`으로 승격하지 않고 `원문 확인`에 둔다. 기존 Drizzle 조회의 `requestedLimit + 500` headroom, legacy alias의 보수적 grant-unready, process 중 env mutation 차이는 기존 비차단 NOTE로 기록하고 이 Gate에서 일반화하지 않는다. `product_consumed`는 production promotion 전까지 pending이다.
- 외부 대기: G7E 브라우저에서 full-universe unavailable/available 응답, before/after 4상태·unknown 감소, redaction을 확인. 실사업자 30표본과 live provider truth는 사용 가능한 승인 표본·credential 범위에서만 검증
- 다음 Gate: G5 approved by user continuation request; not started at this receipt

### G5 영수증 — 2026-07-14

- Orca root/task/dispatch: root `task_011d0d6c6538`; implement `task_a9927d9d63fb` / `ctx_4353b6e120da`; first successful review `task_ff00b7014683` / `ctx_a229dcfedd6c`; findings fix `task_ed30ff641478` / `ctx_61e401293435`; final re-review `task_07a32f741497` / `ctx_ae236fc0c5b9`
- 모델/terminal: implementer `gpt-5.6-sol` xhigh `term_2b552aba-dc0b-4345-9ecd-39c45a6e8c50`; first successful reviewer Fable 5 max `term_a35c7f38-b7dc-4abd-bc5c-1f2867a22fa1`; fixer `gpt-5.6-sol` xhigh `term_d173a228-7a79-4ff1-a4b8-22a18c66be3d`; final reviewer Fable 5 max `term_8b0c279a-4183-4058-a9f7-b60a492ace65`. `task_0d4f6ca2d63f` / `term_e3a1a24f-4948-4a94-b130-7c055f61fb7c`는 잘못된 model alias와 interactive transport로 리뷰 시작 전에 종료되어 판정 증거로 사용하지 않음
- 구현 파일: `apps/web/src/app/api/dev/service-data/route.ts`, `apps/web/src/features/dev/ServiceDataMonitor.tsx`, `apps/web/src/lib/server/devServiceDataMonitor.test.ts`, `apps/web/src/lib/server/devServiceDataMonitor.ts`
- 구현 검증: monitor/profile focused tests, `profile-field-spec.test.ts`, `coverage.test.ts`, `canonicalize.test.ts`, `match.test.ts` 24 checks, `question-planner.test.ts`, core/web typecheck, `verify:service-data` 6 checks `ok:true`, 4개 changed-file `git diff --check` 모두 통과. verify 명령은 provider/DB env 부재 시 기존 sample fallback을 사용했고 DB write·live provider 호출 없음
- 독립 리뷰: `task_ff00b7014683` BLOCKER 0 / MAJOR 3 / MINOR 0. 느린 A사 Q&A 응답의 B사 결과 덮어쓰기, Q&A 뒤 coverage 유래 label·`ip.right_statuses` 값 회귀, 부모행만 남겨 하위 진단이 사라지는 세 finding을 모두 수용
- 수정·재리뷰: `task_ed30ff641478`에서 result-generation guard와 동시 실행 차단, 기존 display evidence와 새 typed section의 좁은 client reconciliation, 부모 19축 집계와 parent+child 상세행 분리를 구현. `task_07a32f741497` 최종 전면 재리뷰 PASS, BLOCKER 0 / MAJOR 0 / MINOR 0 / NOTE 4. 별도 read-only post-fix 감사도 같은 세 보정과 focused test/typecheck를 0 / 0 / 0으로 확인
- 판단 기록: UI는 identity prerequisite, eligibility 19축, reserved, supporting/derivation, ranking goals, final typed profile, shadow/unknown의 7개 역할 섹션을 유지한다. `sourcing_coverage`, `canonical_match_ready_coverage`, `grant_extraction_readiness`, `end_to_end_decidability`는 합치지 않는다. 전체 active deduped universe를 한 번 로드·평가하며 500건 cap·균등가중 fallback 없이 reviewed/pending과 제외 축을 분리한다. Q&A는 lookup과 정확히 같은 `asOf`만 쓰고 실제 dimension별 unknown 감소가 있을 때만 완료 표시한다. coverage 전용 표시값은 현재 확인된 `ip.right_statuses`만 known 보존하며 그 밖의 새 미정 값은 추론하지 않고 unknown으로 닫는다. Fable NOTE의 항상 참인 방어 guard, 파일 상단의 과거 `22축` 주석, 기존 Drizzle `requestedLimit + 500` headroom은 동작·계약에 영향 없는 비차단 항목으로 기록하고 일반화하지 않는다. `product_consumed`는 production promotion 전까지 pending이다.
- 외부 대기: G7E에서 bounded child dev server의 접근·오류·unavailable·Q&A normalize·desktop/mobile을 확인한다. 승인된 개인15/법인15, live provider credential/consent, full DB universe가 없으므로 live success·정상 빈값·cache truth·30표본 정확도는 증거가 생길 때까지 external pending으로 남긴다.
- 다음 Gate: G0B/G6 decision 기록과 G7L은 사용자 continuation 요청으로 승인됨; 이 checkpoint에는 포함하지 않음

### G0B/G6 영수증 — 2026-07-14

- Orca/provenance: root `task_011d0d6c6538`; 구현 dispatch 없이 coordinator가 G0B read-only audit을 수행하고 `/root/g0b_reserved_review` 및 `/root/g0b_reserved_review/g0b_report_sanity`가 분류·합계·반례를 독립 재검산했다. 이 collaboration 검증을 사후 Orca dispatch로 표현하지 않는다.
- 검수 증거: main checkout의 기존 env loader는 값·host·token을 출력하지 않고 child worktree의 Drizzle `listActiveGrants` SELECT 경로에만 사용했다. migration·transaction write·insert/update/delete·provider·server 실행 없음. snapshot/current 모두 active confirmed-dedup universe 1,802건, export 70 grants / 85 criteria, premises 125 / 168이며 limit 미도달. 전체 사람 검수 mapping은 export 51개, premises 54개 고유 공고이고 축별 최소 30개를 충족했다.
- 사람 분류: export 51개 = hard 13 / existing-axis·오분류 15 / long-tail 16 / benefit 5 / performance 2 / ranking 0. premises 54개 = hard 10 / existing-axis·오분류 21 / long-tail 12 / benefit 5 / performance 5 / ranking 1. 로컬 audit report `/tmp/G0B-reserved-axis-audit-2026-07-14.md` SHA-256 `8a0a87a3d25747c9f726ec16eebf56f2518f8d1ac6eecc3e171c8a9f6149a586`; 민감정보 없는 보조 산출물은 mode 600으로 유지했다.
- 독립 검산: BLOCKER 0 / MAJOR 0 / MINOR 0. 51/54 고유 ID, current/snapshot 후보 포함, 분류 합계, revenue 오분류 9건, `/i`의 `BI`가 `AI·Bio`에 매치되는 query false positive를 재현했다. 현재 row 기반 snapshot은 immutable history 복원이 아니라는 한계도 유지했다.
- 판단 기록 — `export_performance`: `remain_reserved`. 실제 hard eligibility는 있으나 현재/예정, direct/indirect/total, 국가·기간·통화·납품관계가 섞여 하나의 안전 계약이 아니다. 수출액 9건이 총매출 `revenue`로 오분류되어 있고, 특히 USD 20M을 KRW 20B로 저장한 사례는 총매출 matcher에서 false pass/fail을 만들 수 있다. 향후에는 9건을 먼저 재라벨하고 verified actual direct/total records, 기간, 원통화, completeness가 확보된 좁은 계약만 재검토한다.
- 판단 기록 — `premises`: `remain_reserved`. 현재 특정 시설 입주, 공장 등록·가동, 기존 `region`, 입주 우대, 선정 후 이전 의무, 신규 입주 혜택이 한 축에 섞여 있다. 향후 `current_named_tenancy`와 `registered_operating_factory`를 분리 검토하고, 단순 소재는 `region`, performance/ranking/benefit은 hard eligibility 밖에 둔다. 후보 regex의 `BI`는 독립 토큰 문맥으로 경계화해야 한다.
- G6 결정: 두 축 모두 decision criteria를 통과하지 못했으므로 activation은 **explicit not approved**이며 G6를 시작하지 않았다. enum 예약 자리, matcher `unknown`, question planner 비노출, eligibility/coverage 분모 제외를 그대로 유지한다. `activate` 결과가 아니므로 사용자 activation gate도 생성하지 않았다.
- 변경·검증: 이 Gate의 production/code 변경 없음. handoff 체크리스트와 본 영수증만 갱신하며 `git diff --check`로 문서 checkpoint를 검증한다.
- 외부 대기: 향후 실제 계약 후보를 다시 만들 때만 승인 표본·verified provider/input completeness로 재검수한다. 현재 로컬 완료와 G7E를 막지 않는다.
- 다음 Gate: G7L local completion audit approved; G6 code not started

### G7L 영수증 — 2026-07-14

- 실행 주체/provenance: root `task_011d0d6c6538`; coordinator가 G1~G5 및 G0B/G6 checkpoint가 모두 clean인 `9dc0b7e`에서 계획의 로컬 완료 명령을 직접 재실행했다. G5 최종 Fable review `task_07a32f741497` / `ctx_ae236fc0c5b9`의 동일 회귀 묶음 PASS와 별개인 새 실행이다.
- focused tests: `profile-field-spec.test.ts`, `coverage.test.ts`, `devServiceDataProfile.test.ts`, `canonicalize.test.ts`, `devServiceDataMonitor.test.ts` 모두 all assertions passed. `match.test.ts` 24 checks passed. `question-planner.test.ts` `ok:true`, 10 checks passed.
- 정적 검증: `pnpm --filter @cunote/core typecheck`, `pnpm --filter @cunote/web typecheck` 모두 exit 0. exact base `f9491d7d2a68b6910cac3c2a7d366ed6bc6ac983`부터 `HEAD`까지 `git diff --check` exit 0. 테스트 뒤 worktree clean을 확인했다.
- 통합 검증: `pnpm verify:service-data` exit 0, `ok:true`, 6 checks 통과. Popbill·DB env가 없어 명령 자체의 명시적 K-Startup/BizInfo sample fallback을 사용했으며 DB write·live provider 호출·승격은 없었다.
- baseline/회귀 분리: 실행 실패나 pre-existing baseline noise 없음. changed-file regression 0건. sample fallback 메시지는 실패가 아니라 live credential/DB 부재를 표시하는 의도된 외부 경계다.
- 로컬 완료 주장: typed `CompanyProfile`, 19축 SSOT, connector/Q&A typed updates, evidence precedence merge, read-only full-universe shadow matcher, 7개 역할 섹션과 4개 분리 지표가 exact-base child worktree에서 검증됐다. 이 결과를 실사업자·브라우저·provider truth 완료로 확대하지 않는다.
- 외부 대기: G7E bounded browser/API evidence, 승인된 개인15/법인15 표본, live provider credential/consent, full DB universe truth.
- 다음 Gate: G7E external evidence approved; production promotion과 G6 activation은 범위 밖

### G7E 영수증 — 2026-07-14

- 실행 경계: 기존 main checkout 서버 `127.0.0.1:4010` PID 55990를 건드리지 않고, 사전 빌드 `pnpm build:packages` 통과 후 env 파일·DB/provider runtime key가 없는 child worktree에서 `pnpm --filter @cunote/web exec next dev --hostname 127.0.0.1 --port 4012`만 bounded 실행했다. WAF·Cloudflare·cache delete·force refresh·DB write·provider credential·실사업자번호는 사용하지 않았다.
- 접근/초기 화면: `GET /dev/service-data` HTTP 200, redirect 없음, HTML에서 `사업자 데이터 모니터`, `19축 + reserved + supporting`, `조회 provider`, `typed update 변환 확인` 확인. dev-only page/API가 인증 redirect 없이 child 서버에서 접근됐다.
- 입력/inspect: 3자리 사업자번호는 `invalid_biz_no` HTTP 400, 잘못된 provider는 `invalid_provider` 400. 합성 `0000000000`의 Popbill inspect는 200, `hasCache:false`, 빈 rows, 표시값 `000-**-00***`를 반환했다.
- Q&A/profile API: `normalize_qna` revenue 입력은 200, self-declared typed update 1개와 failure 0개. `merge_profile`은 200, `revenue_krw=2000000000`, evidence `asOf=2026-07-14T00:00:00.000Z`, `product_consumed=pending`. `qnaAsOf != asOf` withShadow 요청은 `invalid_profile_merge` 400으로 거절됐다.
- 7-section/unavailable truth: 동일 `asOf` withShadow 합성 요청은 200이며 top-level role section key가 정확히 7개, eligibility 부모행 19개, metric key 4개였다. `sourcing_coverage`만 available, canonical match-ready / grant extraction / end-to-end / weights / shadow는 모두 `shadow_match_universe_unavailable`로 명시되고 대체 수치가 없었다. 직접 `shadow_match` 요청도 같은 이유로 HTTP 503 fail-closed였다.
- 안전 payload: withShadow 합성 응답에 raw 10자리 입력 문자열과 birth/phone/mobile/token/source_span/raw_text/raw_payload/criteria key가 없음을 재귀 assertion으로 확인했다. 일반 lookup DTO는 기존 계약대로 top-level raw `bizNo`를 보존하므로 실제 번호를 사용하지 않았고 network body·snapshot·문서에 남기지 않았다. lookup 표시·section은 마스킹을 유지했다.
- controlled failure: 합성 lookup은 HTTP 200 + `popbill_lookup_failed`(내부 status 503), 7개 section을 반환했다. 서버 로그에는 필수 Popbill key 부재만 기록됐고 credential이 없어 외부 provider 호출은 시작되지 않았다.
- 브라우저 상태: 이 세션에서 앱 내 브라우저 자동화 surface가 노출되지 않아 실제 click/toast, 1440×900, 390×844 overflow screenshot은 실행 증거를 만들 수 없었다. HTTP/SSR/API 증거와 코드·focused test를 시각 증거로 바꿔 쓰지 않고 explicit external pending으로 남긴다.
- 실표본/live truth: repo의 개인15/법인15는 실제 사업자번호 없는 synthetic `CompanyProfile`이고 사용 승인된 30개 번호도 없다. child에는 DB/provider env와 CODEF consent가 없다. 따라서 live provider 성공·정상 빈값·cache truth·실제 Q&A unknown 감소·CODEF redaction·source별 응답률·normalization 정확도·충돌률은 미실행이며 external pending이다.
- 종료 검증: child 서버를 `Ctrl-C`로 종료하고 4012 listener 없음 확인. 기존 4010 listener는 그대로 유지. 테스트 전후 worktree clean.
- 완료 해석: G7E 체크는 **bounded external evidence + 명시적 external pending 기록**으로 닫는다. 브라우저 시각·30표본·live provider/DB truth가 완료됐다는 뜻이 아니다.
- 다음 Gate: 계획된 구현 Gate 없음. final cleanup과 root/task 상태 정리만 남음

### P1 영수증 — 2026-07-14

- 실행 기준: clean product-integration HEAD `8d98ef8ffae82ae2ada57cd63f400ea6bff2abc2`에서 P1만 수행했다. P2 resolver, route wiring, UI, provider 호출, schema migration은 시작하지 않았다.
- 모델 라우팅 변경(2026-07-14): 사용자의 최신 지시로 남은 모든 구현과 독립 리뷰는 각각 fresh `gpt-5.6-sol` ultra 세션을 사용한다. Fable은 더 이상 필요하지 않으며, 이 기록이 이 날짜 이전의 §5.2/Fable 필수 라우팅 문구보다 우선한다.
- assembly 결정: `buildDevFinalCompanyProfile()`의 merge/evidence 결정을 `assembleCompanyProfile(baseProfile, typed updates, explicit asOf)` 중립 core 경계로 옮기고 dev wrapper와 production enrichment merge가 함께 사용한다. production old/new scalar·list·compound fixture는 동순위 충돌 보정 외 deep-equal이다. core 결과에는 `product_consumed`나 I/O 상태가 없다.
- observation 결정: dimension, normalized source kind/provider, shared/user scope, asOf, canonical value, stable observation id/version을 canonical identity로 고정했다. 기존 semantic precedence가 먼저이며, 완전 동률 같은 값은 dedupe하고 다른 값은 `conflict_unknown`으로 닫아 두 관측을 canonical supplemental로 보존한다. fixed-seed update/DB-row permutation 회귀가 decisions와 profile 직렬화까지 동일함을 확인한다.
- persistence/rollback: 기존 `company_profiles.value` JSON meta와 `user_id`만 사용해 user answer를 `portable_user_answer`, provider/cache row를 `versioned_provider_observation`으로 표현한다. generic provider 때문에 legacy enum transport가 `self_declared`여도 embedded source kind/provider가 authoritative/public-registry로 유지되며 decoder는 이를 self-declared로 재해석하지 않는다. schema 변경 없이 scope, resolver version, canonical value, observation identity를 보존했고 N-1 adapter 및 typed answer write → legacy rollback profile/source/match parity가 통과했다.
- loss/contract 보정: `industry_codes`, `business_status.active` unknown, `investment.last_round=null`, structured `prior_award_history`, nullable compound 값, evidence/question state를 encode/decode/normalize에서 보존한다. TypeScript/OpenAPI/generated contract에 운영 19축 compound schema와 observation identity를 맞추고 모든 `PROFILE_FIELD_SPEC` CompanyProfile matcher path를 deep-equal로 고정했다.
- P0 step-6 tripwire: 한 sorted JSON fixture와 한 focused assertion만 추가해 현재 product entrypoint 23개와 direct matcher/legacy-merge call site 15그룹을 고정했다. AST/scanner framework는 만들지 않았고 새 우회 경로 정리는 P3로 남긴다.
- 검증: assembly/evidence/update/profile-spec/match, dev wrapper, production merge parity, full persistence/N-1/rollback, tripwire focused tests 모두 exit 0. contracts/core/web typecheck도 exit 0. OpenAPI export/verify와 `pnpm verify:service-data`의 pnpm `tsx` wrapper는 sandbox의 `listen EPERM`으로 시작되지 않았고, 각각 동일 소스·tsconfig의 `node --import tsx` fallback으로 generated export + 27 paths와 `ok:true` + 6 checks를 통과했다. `git diff --check`도 통과했다.
- 의도한 동작 차이: unknown/same-provider 완전 동률의 서로 다른 값만 input-first winner 대신 unknown conflict가 되고, 위 round-trip 손실과 provider 오표기만 교정한다. 그 밖의 production response/merge fixture는 유지한다.
- 남은 범위: 중앙 legacy adapter와 direct matcher call은 P3 배선을 위해 의도적으로 남아 있다. P2 source/privacy resolver, P3 route/background wiring, P4 UI/answer loop, P5/P6 shadow·live·canary는 미착수다.

## 12. 전체 중단 조건

다음 중 하나면 현재 Gate를 중지한다.

- 현재 연결 완료 목표를 벗어나 새 API/provider·유료 계약 구현을 시작하려 함
- field spec이 generic schema framework로 커짐
- 익명 조회가 owner-scoped 저장 프로필·동의 기반 값·민감 evidence를 읽을 가능성이 있는데 visibility 경계 없이 승격하려 함
- 제품 진입점 하나라도 canonical resolver를 우회해 repository profile이나 별도 merge를 matcher에 직접 넣음
- 비교 기간이 끝났는데도 legacy와 신규 resolver를 장기 이중 운영하거나, 장애 시 legacy 의미로 조용히 fallback하려 함
- `other`를 줄이기 위해 새 top-level dimension을 추가함
- premises/export를 검수 없이 활성화함
- AI가 hard eligibility를 직접 판정하게 함
- unknown을 pass로 바꿔 테스트를 맞춤
- 기능 연결보다 시각 리디자인·generic form builder·새 상태관리 체계에 범위를 씀
- 기존 schema로 19축 round-trip이 가능한지 증명하기 전에 migration을 추가함
- 허용 파일 밖의 dirty 변경과 충돌
- reviewer BLOCKER가 두 fix cycle 후에도 남음
- Orca dispatch provenance 또는 worker_done을 확인할 수 없음

## 13. 제품 승격 신규 세션 필수 트리거 문장

아래 전체 블록을 신규 세션의 첫 요청으로 그대로 사용한다.

```text
P0 통합 전에는 /Users/ffgg/orca/workspaces/cunote/cunote-service-data-g1/docs/plans/HANDOFF-2026-07-13-service-data-매칭입력.md를, `PLAN_CHECKPOINT_SHA`가 product-integration branch에 merge된 뒤에는 그 product worktree의 동일 상대경로 문서를 이번 작업의 실행 정본으로 사용해줘. 로컬 main의 copy가 `PLAN_CHECKPOINT_SHA`를 포함하지 않으면 stale이므로 사용하지 마.

먼저 매칭 마스터 문서, 이 통합 실행계획, 문제인식 문서, 기존 자동채움 실행가이드, 현재 git branch/HEAD/status/diff를 읽고 P0 preflight를 수행해. G1~G7 완료 HEAD `fcc190c`와 작업 시작 시점 로컬 `main` exact HEAD의 계보를 모두 확인하고, 둘을 보존하는 clean product-integration child worktree를 만들어. 과거 HEAD, `origin/main`, 또는 미커밋 변경이 빠지는 base에서 시작하지 마. 관련 없는 main의 dirty/untracked 파일은 절대 가져오거나 수정하지 마.

반드시 Orca orchestration CLI의 실제 task/dispatch 상태를 사용해. `orca status --json`과 기존 task/terminal 상태를 확인한 뒤, `task-create -> fresh implementer terminal -> dispatch --inject -> worker_done -> fresh read-only reviewer task -> 필요한 좁은 fix -> 재리뷰` 순서를 지켜. 일반 subagent/spawn으로 대체하지 말고, runtime-global 기존 task를 reset하지 마. 같은 worktree의 writer는 한 명만 허용해.

모델 라우팅은 coordinator·implementer·fixer에 `gpt-5.6-sol` xhigh, reviewer·re-reviewer에 fresh `Claude Fable 5` max를 사용해. Claude terminal은 `claude --model fable --effort max`로 만들고 `claude ultrareview`나 기존 reviewer 세션 재사용으로 대체하지 마. Fable entitlement나 usage credit이 거부되면 다른 모델로 fallback하지 말고 review pending blocker로 보고해.

P0부터 §21의 P0~P6을 순서대로 구현하고, 각 Gate의 acceptance·독립 리뷰·회귀가 통과할 때마다 checkpoint commit과 Gate 영수증을 남겨. 목표는 새 로직 추가가 아니라 모든 실제 사용자 진입점을 하나의 제품용 profile resolution·matcher·question 경로에 100% 연결하는 것이야. 새 API/provider, 근거 없는 migration, generic framework, premises/export_performance 활성화, 인터페이스 시각 리디자인은 금지야. `other`는 eligibility 분모에서 제외하고 unknown·consent·owner visibility 안전 경계를 유지해.

P0~P5는 fixture/cache와 자동 회귀로 진행하고 개발 서버를 직접 시작하지 마. P6 브라우저·live 검증은 현재 사용자가 실행 중인 서버를 먼저 확인해 사용하고, 서버가 없으면 사용자 실행을 요청해. 승인된 표본·권한만 사용하고 비밀값이나 원시 민감 payload를 기록하지 마. BLOCKER/MAJOR가 남거나 §12 중단 조건을 만나지 않으면 다음 Gate까지 자율 진행하고, P6 완료 후에만 최종 보고해.
```

## 14. 제품 Gate 반복 트리거

한 Gate만 좁게 실행할 때는 다음 형식을 사용한다.

```text
HANDOFF-2026-07-13-service-data-매칭입력.md의 현재 영수증과 §21 Gate 계약을 다시 확인하고, Orca orchestration 수동 루프로 P<번호>만 구현·독립 리뷰·필요한 fix·재리뷰·checkpoint commit까지 진행해줘. 이전 Gate의 unknown·privacy·persistence 경계를 보존하고, 다음 Gate는 시작하지 마.
```

## 15. G1~G7 dev 완료 정의

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

## 16. 제품 승격 결정과 `100% 연결`의 정의

2026-07-14 사용자 결정으로 다음 순서를 고정한다.

1. 먼저 매칭·자동채움의 **제품 연결을 100%**로 만든다.
2. 그 다음 실제 제품 경로에서 측정하며 matcher·source·question logic을 개선한다.
3. 마지막에 시각·상호작용 인터페이스를 개선한다.

여기서 `100%`는 값의 완전성이 아니라 **경로와 계약의 완전성**이다.

| 경계 | 100% 완료 조건 |
|---|---|
| source consumption | 현재 승격 대상으로 승인된 connector/cache/Q&A가 canonical typed update를 만들고, 제품 resolver가 실제 소비한다. 미승인·미계약·미동의 source는 `disabled/not_authorized/unavailable`로 명시하며 `product_consumed=pending`으로 방치하지 않는다. |
| profile resolution | 모든 제품 matcher 진입점이 같은 evidence precedence, explicit `asOf`, final `CompanyProfile` resolver를 사용한다. repository profile·route-local merge·raw request profile을 matcher에 직접 넣는 우회 경로가 없다. |
| matcher | 익명 teaser, 로그인 dashboard/matches/detail, web/app API, answer/enrich 후 refresh, background recompute가 **동일 context + 동일 materialized observations + 동일 `asOf`**에서 같은 final profile과 deterministic matcher 의미를 사용한다. context가 다르면 privacy 때문에 profile이 의도적으로 다를 수 있다. |
| user interface | 운영 19축 모두가 사용자 화면에 `known/unknown/partial` 상태로 나타나며 값, 안전한 source label, `asOf`, completeness, 편집 또는 다음 행동을 가진다. |
| answer loop | 지원하는 모든 질문 형식이 하나의 server-side normalize → merge → evaluate 경로를 사용하고, 답변 응답 안에서 profile·매칭 수·카드·다음 질문이 함께 갱신된다. |
| persistence | owner path는 19축·evidence·question state를 의미 손실 없이 round-trip한다. 익명 답변은 request/session 범위에만 있고 owner/private 값을 읽거나 저장하지 않는다. |
| parity/CI | matcher 축·경로가 추가 또는 변경되면 contract, UI adapter, question, persistence, product E2E 중 하나라도 빠진 PR이 CI에서 실패한다. |
| live proof | 같은 회사·profile·`asOf`에 대해 web/app 및 주요 사용자 화면이 같은 판정을 보이고, 동의 철회·provider 장애·빈 결과에서도 누출이나 거짓 확정 없이 동작한다. |

다음은 `100% 연결`이 뜻하지 않는 것이다.

- 모든 회사가 19/19 값을 자동으로 채운다는 뜻이 아니다.
- 판정 정확도·recall·coverage가 100%라는 뜻이 아니다.
- 모든 유료·동의 기반 provider를 활성화하거나 모든 요청에서 live 호출한다는 뜻이 아니다.
- `unknown`을 임의 값으로 채우거나 `not_found`를 부재 증거로 일반화한다는 뜻이 아니다.
- `premises`, `export_performance`, `other`를 운영 eligibility 19축에 넣는다는 뜻이 아니다.
- 카드 배치·타이포그래피·애니메이션 등 인터페이스 리디자인을 완료한다는 뜻이 아니다.

## 17. 2026-07-14 제품 연결 감사 기준선

계획 작성 시점의 코드 감사 기준은 child `fcc190c`와 로컬 `main` `04d1d45`다. 두 branch는 공통 조상 이후 갈라져 있으므로 제품 구현을 현재 child에 바로 덧붙이지 않는다. P0에서 최신 로컬 `main`과 G1~G7 전체 이력을 모두 포함하는 clean integration branch를 먼저 만든다. 이 HEAD 값은 감사 영수증이지 미래 세션의 고정 base가 아니며, 시작 시 실제 graph를 다시 확인한다.

| 경계 | 현재 확인 상태 | 제품 목표 |
|---|---|---|
| G3 final profile | `buildDevFinalCompanyProfile()`과 `product_consumed=pending`은 dev-memory-only다. production acquisition/merge/save는 G1~G7 전과 같다. | 순수 assembly만 중립 core로 승격하고 dev와 product가 같은 함수를 사용한다. dev monitor 전체나 raw trace를 product에서 import하지 않는다. |
| anonymous teaser | `/api/web/teaser`와 app teaser는 기존 teaser resolver를 사용하며 APICK·K-Startup·KIPRIS cache overlay를 적용한다. | anonymous 정책으로 허용된 typed updates만 canonical resolver에 넣는다. owner/private/consent source는 배제한다. |
| authenticated product | `loadServiceDashboard()` 계열은 주로 persisted profile을 직접 사용해 teaser와 이미 의미가 다르다. apply sheet, feedback, ruleset/background refresh에도 별도 direct matcher 경로가 있다. | dashboard·matches·detail·apply sheet·feedback·refresh가 모두 resolved final profile만 matcher에 전달한다. |
| create/enrich/answer | web company create는 teaser 결과를 쓰지만 app create는 raw request profile을 저장한다. web/app field route와 enrichment가 각각 별도 merge·save·refresh를 수행한다. | 하나의 command service가 resolve → persist → 동일 객체로 match/refresh 순서를 보장한다. |
| persisted precedence | shared/user/provider row 해석이 조회 순서에 의존할 수 있고, provider evidence가 `self_declared`로 오표기될 수 있다. | row 순서와 무관한 evidence precedence, 정확한 source kind, primary/supplemental 보존을 보장한다. |
| match state | profile은 user overlay를 지원하지만 `match_state`는 company 단위다. 일부 GET 경로는 읽는 중 state를 쓸 수 있다. | user-facing truth는 현재 resolved profile의 즉시 matcher 결과다. GET write를 끄고 user overlay 결과를 company 공용 state에 저장하지 않는다. |
| 19축 UI | matcher와 TypeScript profile은 운영 19축을 소비하지만 `CompanyEvidence.fields`와 `/matches` 상시 카드는 10축만 노출한다. | `OPERATIONAL_PROFILE_DIMENSIONS` 순서 그대로 19축을 노출하고 누락을 typecheck/CI가 막는다. |
| Q&A | `/matches`의 revenue/employees range와 structured `prior_award`가 dashboard와 다른 의미로 처리된다. insured layoff와 investment last round 입력도 빠져 있다. | web/app/teaser가 같은 answer normalizer와 question-state 계약을 사용한다. |
| round-trip | `industry_codes`, `business_status.active`의 unknown, `investment.last_round=null`, teaser의 `prior_award_history`에서 의미 손실이 확인됐다. | full-profile encode/decode/normalize 후 모든 matcher path가 deep-equal이다. |
| API contract | TypeScript profile과 OpenAPI profile shape가 확장 6축에서 다르다. | 두 계약이 운영 19축과 evidence/question state를 같은 의미로 표현한다. |
| privacy | bizNo-only anonymous resolution에 owner/consent-derived 값을 추가하면 다른 사용자의 정보가 섞일 위험이 있다. CODEF cache·shared row는 특히 별도 scope가 필요하다. | anonymous/owner/consent scope를 acquisition 전에 강제하고, safe allowlist DTO만 사용자에게 반환한다. |

이 감사에서 확인된 문제를 별도 리팩터링 목록으로 확장하지 않는다. P0~P6의 수용 조건을 통과시키는 최소 변경만 한다.

## 18. 목표 아키텍처

### 18.1 하나의 assembly, 컨텍스트별 acquisition

source를 가져오는 정책과 값을 병합·판정하는 로직을 분리한다.

```text
ProductProfileResolutionContext
  -> acquire allowed observations (I/O, context-specific)
  -> immutable ProductProfileMaterialization (request당 한 번)
  -> rollout dispatcher
       -> LegacyProductProfileAdapter (P6 안정화까지만)
       -> canonical CompanyProfileFieldUpdate[]
          -> assembleCompanyProfile(base, orderedUpdates, asOf) (pure)
  -> mode/cohort가 선택한 immutable ResolvedCompanyProfile
  -> buildProductMatchSnapshot(profile, grants, asOf) (pure/core use-case)
  -> MatchingProfileView + product 4-state + next question
  -> every web/app/user consumer
```

구현 책임은 다음 다섯 경계로 제한한다.

1. `assembleCompanyProfile`: G3의 typed merge/evidence decision을 dev 명칭에서 분리한 순수 core 함수다. provider 호출·DB·redaction·UI·`product_consumed`를 모른다.
2. `materializeProductProfileInputs`: server I/O facade다. 접근 컨텍스트에 허용된 base/observations를 request당 한 번만 수집한다.
3. `resolveProductCompanyProfile`: rollout dispatcher다. 같은 materialization을 단 하나의 `LegacyProductProfileAdapter`와 typed assembly에 전달하고 `legacy|shadow|rollout|typed` mode가 response authority를 고른다. P3/P4의 기본은 `legacy`, P5는 `shadow`, P6에서만 cohort typed를 시작하며 안정화 뒤 legacy adapter와 dispatcher 분기를 제거한다.
4. `buildProductMatchSnapshot`: selected final profile, active deduped grant universe, explicit `asOf`를 한 번 받아 matcher·4상태·question planner·safe view를 계산한다.
5. `applyCompanyProfileAnswer`: web/app이 공유하는 command다. answer normalize → mode가 선택한 final resolve → 허용 시 persist → 같은 객체로 impact/match refresh → 새 snapshot 반환을 한 transaction/receipt 경계로 묶는다. shadow typed candidate는 저장하거나 state에 쓰지 않는다.

production이 `devServiceDataMonitor.ts`, dev route, raw/canonical trace를 import하는 것은 금지한다. production-safe pure 함수만 neutral module로 옮기고 dev도 그 함수를 역으로 소비한다.

rollout 기간의 legacy 허용 지점은 중앙 `LegacyProductProfileAdapter` 하나뿐이다. route-local legacy merge, repository profile의 direct matcher 입력, 별도 provider 재호출은 금지한다. P6 안정화 후 이 adapter와 mode 분기를 삭제한다.

### 18.2 접근 컨텍스트

초기 구현은 다음 고정 표만 사용한다. generic policy/plugin engine을 만들지 않는다.

| 컨텍스트 | 읽기 허용 | live acquisition | 저장 | state 처리 |
|---|---|---|---|---|
| `anonymous_teaser` | 공개/basic source와 안전한 cache, 현재 request의 ephemeral answer | 기존 익명 기본조회 외에는 금지. 공공 connector는 cache-only | 금지 | 응답에서만 계산, 공용 state write 금지 |
| `owned_read` | owner profile, 공개 cache, 아직 유효한 owner-scoped consent observation | 금지 | 금지 | 응답의 resolved snapshot이 진실 원천 |
| `owned_refresh` | `owned_read` + 회사 접근권한·활성 consent가 허용한 source | provider별 allowlist·deadline·single-flight·budget 안에서만 | owner/company scope에 canonical evidence로 저장 | 저장한 동일 profile로 scoped refresh |
| `system_recompute` | 명시된 company scope와, schema가 구분할 수 있을 때만 명시된 user scope | 금지 | profile write 금지 | company profile 결과만 company state에 저장. user overlay는 공용 state에 저장 금지 |

source 정책의 최소 결정은 다음과 같다.

- 익명 `/matches`는 기존 공개/basic 경계를 유지한다. 공공 cache hit는 사용할 수 있지만 owner row, CODEF, hometax, insurance, 신용 관측은 사용하지 않는다.
- 로그인 enrichment는 company access를 먼저 확인하고 source별 consent를 확인한다. `basic_info`, `hometax`, `insurance`를 서로 대체 가능한 하나의 동의로 취급하지 않는다.
- CODEF 및 consent-derived observation은 bizNo 전역 cache/shared row로 제품 재사용하지 않는다. user/company/consent scope와 철회 가능성을 가진다.
- NICE의 현재 무계약 demo 경로는 production disabled다. 계약·동의·source semantics가 별도 승인되기 전에는 `disabled`가 완료 상태다.
- cache miss·read 실패가 유료/live 호출의 암묵적 트리거가 되면 안 된다. 제품 request에는 cache delete나 force refresh를 노출하지 않는다.
- exact/fuzzy, exhaustive/partial, positive/absence capability를 source policy에 고정한다. fuzzy hit나 partial list miss로 보유/부재를 확정하지 않는다.
- consent 철회 시 신규 acquisition을 즉시 막고 해당 observation을 resolved profile에서 제외한 뒤 영향받은 state를 재계산한다.

실패 계약은 source class별로 다르다.

| source class | 실패 계약 |
|---|---|
| request identity/access/consent prerequisite | fail-closed 4xx. matcher와 provider acquisition을 시작하지 않는다. |
| required base identity lookup | 안전한 persisted/cache base도 없으면 기존 route 계약의 명시적 unavailable/503으로 닫는다. sample이나 빈 profile로 대체하지 않는다. |
| optional enrichment overlay | 해당 source만 `failed/unavailable`, 관련 축은 기존 값 또는 unknown으로 유지하고 나머지 매칭은 계속한다. |
| explicit owner refresh | refresh receipt를 `partial/failed`로 반환하고 새 observation을 저장하지 않는다. 기존 snapshot을 함께 보여줄 수 있지만 refresh 성공으로 표시하지 않는다. |
| active grant universe | 명시적 unavailable/503. sample universe나 cap 결과로 제품 판정을 만들지 않는다. |

### 18.3 제품 안전 DTO

사용자 응답은 raw `CompanyProfile`, provider raw payload, dev trace를 그대로 노출하지 않고 `MatchingProfileView` allowlist를 사용한다.

```ts
type MatchingProfileViewRow = {
  dimension: OperationalAutofillDimension;
  status: "known" | "partial" | "unknown";
  displayValue: string | null;
  sourceKind: EvidenceSourceKind | null;
  sourceLabel: string | null;
  asOf: string | null;
  completeness: "complete" | "partial" | "not_covered" | null;
  editMode: "direct" | "question_only" | "read_only";
  action: { kind: "answer" | "connect" | "refresh" | "none"; label: string };
};
```

구체 이름은 구현 시 기존 contract convention에 맞춰 조정할 수 있지만 의미는 축소하지 않는다. provider token, 생년월일 원문, 전화번호, 대표자명, raw text/payload, 내부 rule trace는 이 DTO에 들어갈 수 없다.

### 18.4 match-state 원칙

- 사용자에게 반환하는 현재 판정은 항상 `resolved profile + matcher + explicit asOf`의 결과다. `match_state`는 파생 cache이지 진실 원천이 아니다.
- GET/read 경로는 기본적으로 state를 쓰지 않는다.
- company-scoped profile 결과만 company-scoped state에 저장한다.
- user overlay별 state가 꼭 필요하다는 실제 제품 요구가 증명되기 전에는 새 schema를 만들지 않고 응답에서 계산한다.
- 최초 제품 전환 뒤 legacy state 전체를 한 번 재계산하되, user overlay를 회사 공용 PK에 덮어쓰지 않는다.

## 19. 운영 19축의 기능 인터페이스 계약

모든 행은 값 유무와 무관하게 `/matches`와 로그인 profile/matching 화면에 나타난다. 복잡한 축을 위해 범용 form builder를 만들지 않는다. 작은 `Record<OperationalAutofillDimension, ProfilePresentationAdapter>`를 두고 각 축에 `direct | question_only | read_only`를 명시한다.

| 축 | 기본 편집/확인 방식 | P4 기능 완료 조건 |
|---|---|---|
| `region` | direct 지역 선택 | canonical 지역 코드와 표시 label이 분리되고 source/asOf를 표시한다. |
| `biz_age` | read-only 자동 계산 + 정정 경로 | 개업일과 공고 기준일로 계산하며 explicit `asOf`를 사용한다. |
| `industry` | direct KSIC/업종 다중 선택 | `industries`와 `industry_codes`가 함께 round-trip하며 substring 오확정을 만들지 않는다. |
| `size` | direct 단일 선택 | known/unknown을 구분하고 근거 없는 derived size를 complete로 세지 않는다. |
| `revenue` | range → 필요 시 precise | 첫 range 응답이 question state로 저장되고 임계값을 가로지를 때만 정확값을 묻는다. |
| `employees` | range → 필요 시 precise | revenue와 같은 range 계약을 쓰며 피보험자수와 의미를 섞지 않는다. |
| `founder_age` | 선택형 연·월 또는 승인된 auth-supplied 값 | 민감 원문 없이 matcher용 age/asOf만 노출한다. |
| `founder_trait` | 선택적 question-only 다중 확인 | API 확정과 self-declared를 구분하고 기본 `없음`을 두지 않는다. |
| `certification` | direct 검색 가능한 checklist | canonical certificate와 만료/기준일을 보존한다. fuzzy 후보는 확인 전 known이 아니다. |
| `prior_award` | question-only 구조화 이력 | yes/no만 저장하지 않고 scope/kind/channel/program/state/기간의 구조를 보존한다. |
| `ip` | source result + question-only 확인 | 종류·상태·기준일을 표시하고 exact miss를 `IP 없음`으로 일반화하지 않는다. |
| `target_type` | direct 단일/다중 선택 | business/pre-startup 등 canonical 값만 저장한다. |
| `business_status` | read-only source 상태 + 정정 경로 | `active: undefined`와 `false`를 보존하고 unknown을 휴폐업으로 바꾸지 않는다. |
| `tax_compliance` | question-only 플래그별 3상태 | 해당/없음 확인/모름을 분리하고 기본값을 두지 않는다. |
| `credit_status` | question-only 법적 상태별 3상태 | source별 known 범위 밖 플래그는 unknown으로 남긴다. |
| `sanction` | question-only 제재 유형별 3상태 | partial registry miss로 `제재 없음`을 확정하지 않는다. |
| `financial_health` | question-only number group | debt ratio, interest coverage, equity/capital, fiscal year를 criterion별 completeness와 함께 보존한다. |
| `insured_workforce` | question-only number/status group | 가입·피보험자수뿐 아니라 `no_layoff`, `months_since_last_layoff`를 입력·보존한다. |
| `investment` | question-only 구조화 group | amount, TIPS, `last_round`를 입력하며 `null`과 unknown을 구분해 round-trip한다. |

각 adapter는 label과 display만 소유한다. matcher path, source precedence, question definition을 UI adapter 안에 복제하지 않는다. 새 운영 축이나 matcher path가 생기면 `satisfies Record<OperationalAutofillDimension, ...>`와 parity test가 누락을 즉시 실패시켜야 한다.

## 20. 제품 승격 Gate DAG

```text
P0 baseline/integration
  -> P1 pure assembly + contract/persistence parity
  -> P2 product resolver + source/privacy policy
  -> P3 all read/write/background entrypoints behind legacy-default dispatcher
  -> P4 functional 19-axis UI + shared answer loop
  -> P5 CI vertical completeness + bounded legacy-response shadow
  -> P6A preview/live truth
  -> P6B 10/50/100 production promotion
  -> P6C stabilization + legacy retirement
```

P0~P6은 순차 실행한다. P1 이전 route 배선, P2 이전 live source promotion, P3 이전 UI가 client-side profile을 정본으로 갖는 구현, P6A 통과 이전 typed product response 전환은 금지한다.

## 21. 제품 Gate별 실행 계약

### P0 — clean 통합 기준선과 계획 checkpoint

**목표:** G1~G7 결과와 최신 로컬 `main`을 빠짐없이 포함하고, 제품 코드 변경 전 기준선을 재현 가능하게 만든다.

작업:

1. 이 계획을 현재 service-data child의 docs-only checkpoint commit으로 고정하고 그 SHA를 `PLAN_CHECKPOINT_SHA` 영수증에 기록한다. 이 commit은 `fcc190c`의 descendant여야 한다.
2. 시작 시점 로컬 `main` exact HEAD를 `PRODUCT_BASE_SHA`로 기록하고, 그 exact HEAD에서 clean product-integration child worktree를 만든다.
3. 새 child에 `PLAN_CHECKPOINT_SHA` 전체 history를 merge한다. `fcc190c`까지만 merge하거나 docs를 copy/cherry-pick해 provenance를 분리하지 않는다.
4. 충돌은 이 정본과 마스터 상태만 좁게 조정하고 관련 없는 main dirty/untracked 파일을 포함하지 않는다.
5. merge 후 G7L focused tests, core/web typecheck, `pnpm verify:service-data`, `git diff --check`를 재실행한다.
6. 현재 제품 진입점 목록과 direct matcher/legacy merger 호출 목록을 기계적으로 캡처해 P3 tripwire fixture로 고정한다.

수용 조건:

- branch는 `PRODUCT_BASE_SHA`와 `PLAN_CHECKPOINT_SHA` 모두의 descendant이며, 따라서 `fcc190c`와 이 실행 정본을 함께 포함한다.
- worktree는 clean이고 제품 동작 변경이 없다.
- baseline 회귀가 green이며 기존 실패는 별도 영수증으로 분리된다.
- checkpoint 예시: `docs: define service-data product promotion gates`

### P1 — pure assembly, 계약, persistence parity

**목표:** dev에서 증명된 profile assembly를 production-safe 단일 권위로 만들고, 19축이 저장·계약 경계에서 의미를 잃지 않게 한다.

작업:

1. `buildDevFinalCompanyProfile()`의 순수 merge/evidence decision만 neutral core module로 추출한다. dev monitor와 기존 production merger가 같은 함수를 사용한다.
2. 입력을 `base profile + typed updates + explicit asOf`, 출력을 `final profile + merge decisions`로 고정한다. caller의 우연한 배열 순서는 의미가 될 수 없다.
3. update/evidence에 canonical identity를 정의한다: `dimension + normalized sourceKind/provider + scope + asOf + canonical value + stable observation id/version`. 먼저 기존 semantic precedence를 적용한다. 완전 동률에서 값이 같으면 dedupe하고, 값이 다르면 입력 첫 항목을 primary로 고르지 말고 `conflict/unknown`으로 닫아 둘 다 supplemental에 보존한다. serialization/display만 canonical key로 정렬한다.
4. supplemental evidence도 canonical key로 정렬하고, updates/DB rows의 모든 permutation에서 final profile·decisions·serialized DTO가 동일한 property test를 추가한다.
5. DB shared/user/provider rows를 deterministic typed updates로 변환한다.
6. provider observation을 `self_declared`로 오표기하지 않도록 existing source contract를 최소 additive하게 보정한다.
7. `industry_codes`, `business_status.active` unknown, `investment.last_round=null`, `prior_award_history`의 encode/decode/normalize 손실을 보정한다.
8. TypeScript와 OpenAPI `CompanyProfile`을 운영 19축·evidence·question state 기준으로 맞춘다.
9. persistence observation을 두 class로 고정한다. 사용자 Q&A/direct edit는 `portable_user_answer`로 저장해 N과 N-1 adapter가 같은 최신 값을 읽는다. provider/cache 관측은 `versioned_provider_observation`으로 저장해 resolverVersion, source ownership/scope, stable observation identity를 가진다.
10. P3~P5 shadow는 typed provider candidate를 저장하지 않는다. P6 canary의 provider write는 기존 observation을 파괴하지 않는 versioned 형태만 허용하며, 사용자 answer write는 resolver mode와 무관하게 portable 형식 하나만 저장한다.
11. full-profile round-trip, 모든 `PROFILE_FIELD_SPEC` matcher path deep-equal, N-1 legacy reconstruction, `typed answer write → legacy rollback` test를 추가한다.

수용 조건:

- 기존 G1~G7 fixtures의 final profile·evidence decision이 의도된 migration 차이를 제외하고 동일하다.
- 같은 base/updates/asOf는 호출 위치와 row order에 관계없이 같은 결과다.
- 동순위 충돌은 입력 순서로 승자를 만들지 않고 conflict/unknown이며, supplemental 순서까지 permutation-invariant다.
- production runtime은 `dev*` module을 import하지 않는다.
- pure result에 `product_consumed`나 provider I/O 상태가 없다. 이 값은 product caller 영수증으로 이동한다.
- full 19축 fixture가 persistence와 API normalize를 왕복해 matcher 의미를 보존한다.
- typed provider observation을 추가한 뒤에도 `LegacyProductProfileAdapter`가 N-1 profile을 재구성할 수 있고, typed rollback이 기존 observation 삭제를 요구하지 않는다.
- canary 중 새로 저장한 모든 `direct|question_only` 사용자 답변은 legacy rollback 뒤에도 동일 값·evidence source·profile·match를 만든다.
- P1에서는 product response mode를 바꾸지 않는다. 기존 production merger를 새 assembly에 위임하려면 old/new output parity가 먼저 증명되어야 한다.
- checkpoint 예시: `core: promote typed service-data profile assembly`

### P2 — 제품 resolver와 source/privacy policy

**목표:** 접근 컨텍스트에 맞는 observation만 수집하고, 모든 제품 caller가 사용할 단일 resolver를 만든다.

작업:

1. §18.2의 네 context를 받는 `resolveProductCompanyProfile` facade를 만든다.
2. 현재 Popbill/APICK/K-Startup/KIPRIS/DART/FSC/공공 registry/CODEF 등 실제 producer를 전수 목록화하고 `public`, `owner`, `consent`, `disabled` 중 하나로 고정한다. 추측한 source를 새로 연결하지 않는다.
3. anonymous 경로가 owner/user row나 consent-derived cache를 읽지 못하는 negative test를 먼저 작성한다. 익명 teaser의 empty-body 요청과 fallback 경로도 동일한 privacy negative case로 P2에서 닫고, owner/user/consent-derived observation으로 fallback하지 않음을 검증한다.
4. source별 exact/fuzzy, absence capability, TTL, asOf, timeout, call budget, §18.2 source class와 fail-open/fail-closed를 작은 고정 mapping으로 둔다.
5. live는 explicit refresh command에서만 허용하고 사업자/provider별 single-flight와 전체 deadline을 적용한다. cache miss가 live 호출을 암묵적으로 유발하지 않게 한다.
6. consent revoke가 observation 제외 → re-resolve → scoped recompute로 이어지게 한다.
7. safe `MatchingProfileView`와 redaction/allowlist test를 추가한다.
8. typed provider persistence는 기존 observation을 overwrite/delete하지 않고 resolver/source version과 owner/consent scope가 있는 새 observation으로 저장한다. legacy adapter는 N-1 provider rows와 resolver 공통 `portable_user_answer`를 함께 읽어야 한다.
9. consent/user scope와 version을 기존 schema로 안전하게 표현할 수 없는 source는 먼저 `disabled`로 닫는다. 좁은 additive migration이 꼭 필요하다는 증거가 나오면 현재 구현을 멈추고 정본과 P2 영수증에 schema·N-1 read·rollback 계약을 추가한 뒤, 별도 checkpoint와 독립 리뷰 BLOCKER/MAJOR 0을 통과해야 재개한다.

수용 조건:

- anonymous/other-user/owner/consent-revoked matrix에서 cross-scope 값 노출 0건이다.
- NICE demo는 명시적 `disabled`; 미승인 source는 `pending`이 아니라 완료 가능한 비활성 상태다.
- optional provider 실패·timeout·빈 결과는 전체 매칭을 500으로 만들거나 hard pass/fail을 만들지 않고, required base/grant-universe 실패는 sample fallback 없이 명시적 unavailable로 닫힌다.
- 같은 materialized observations를 재생하면 live 호출 없이 같은 final profile이 나온다.
- raw payload와 민감 식별자가 safe DTO·로그·snapshot에 없다.
- typed provider write 후 mode를 legacy로 되돌리면 N-1 provider profile·match가 복원되며, cache/row 삭제나 역마이그레이션이 필요 없다.
- canary에서 새로 받은 사용자 답변은 N-1 reader가 같은 최신 값·profile·match로 읽는다. 손실 없는 portable 표현이 불가능한 answer dimension은 P6B 전에 고쳐야 하며 disable로 완료 처리하지 않는다.
- checkpoint 예시: `web: add product profile resolver and source policy`

### P3 — 모든 제품 진입점을 중앙 dispatcher 뒤로 배선

**목표:** 아직 typed 응답으로 전환하지 않고, 모든 product read/write/background 경로가 같은 materialization·mode dispatcher를 지나게 한다. P3/P4의 기본 response authority는 `legacy`이고 typed 결과는 비교 전용이다.

전환 대상:

- web/app teaser와 `/matches`
- web/app company preview/create
- `loadServiceDashboard()`를 소비하는 dashboard, matches, roadmap, action queue, applications, reports, notifications
- `loadServiceApplySheet()`와 grant detail/document generation
- web/app enrich
- web/app profile field/answer
- initial match, ruleset/grant-scope/background refresh, feedback provenance

#### P3A — read 경로

1. teaser, dashboard/matches, apply sheet/detail read가 `materializeProductProfileInputs`와 중앙 dispatcher를 사용하게 한다.
2. base observations, active deduped grant universe, `asOf`를 request당 한 번만 만들고 legacy/typed candidate가 공유한다.
3. mode 기본값은 `legacy`; typed candidate는 response, persistence, state에 쓰지 않는다. 단, P2 privacy policy가 금지한 anonymous acquisition을 cutoff함으로써 익명 응답이 기존과 달라지는 것은 legacy mode의 일반 parity에도 불구하고 의도한 product response delta로 기록한다.
4. checkpoint: `web: route product reads through profile dispatcher`

#### P3B — command/write 경로

1. web/app create·enrich·answer를 공통 command service로 모은다. raw `body.profile` 직접 저장과 route-local merge를 금지한다.
2. user answer는 mode와 무관하게 `portable_user_answer` 하나로 저장하고 두 adapter가 같은 update를 소비한다. provider result는 mode가 허용한 observation만 저장한다. materialized final profile snapshot으로 기존 rows를 파괴적으로 덮어쓰지 않는다.
3. `legacy|shadow`에서는 typed provider candidate를 저장하지 않는다. P6 typed/rollout provider write는 P1/P2의 versioned non-destructive observation 계약을 만족할 때만 열린다.
4. 저장 성공 후 annotation/telemetry/일부 state refresh 실패는 기존 receipt/best-effort 계약을 유지한다.
5. checkpoint: `web: unify product profile commands behind dispatcher`

#### P3C — background/state/feedback 경로

1. initial match, ruleset/grant-scope refresh, feedback provenance도 중앙 dispatcher가 선택한 profile을 사용한다.
2. GET/read 중 state write를 끄고 user overlay 결과를 company `match_state`에 저장하지 않는다.
3. background job은 `system_recompute` context와 state scope를 명시한다. scope가 불명확하면 write하지 않는다.
4. checkpoint: `web: align background matching with resolved profiles`

rollout 기간의 `ProductConsumptionReceipt`는 중앙 dispatcher가 생성한다.

```ts
type ProductConsumptionReceipt = {
  resolverVersion: string;
  consumerId: ProductProfileConsumerId;
  context: ProductProfileResolutionContext;
  mode: "legacy" | "shadow" | "rollout" | "typed";
  authority: "legacy_product" | "typed_candidate" | "typed_product";
  asOf: string;
  sources: Array<{ source: string; dimension: string; status: "consumed" | "disabled" | "not_authorized" | "unavailable" }>;
  selectedProfileFingerprint: string;
  typedCandidateFingerprint?: string;
};
```

receipt에는 raw 식별자·profile 값이 없다. product consumer 목록은 작은 typed registry로 고정하고 route/integration test가 모든 consumer의 receipt 생성을 검증한다. P5 CI는 pending/누락을 실패시키고, production은 집계 metric만 저장하며, Gate별 durable 결과는 이 handoff의 영수증에 commit·명령·집계와 함께 기록한다.

P3 전체 수용 조건:

- 동일 context + 동일 materialized observations + 동일 asOf/grant universe의 web/app 결과가 같다. anonymous와 owner 결과가 다른 것은 privacy 정책에 따른 정상 차이다.
- web/app create round-trip이 같고 raw request profile이 final authority가 아니다.
- `legacy|shadow`에서 기존 사용자 응답·저장 의미가 유지되고 typed candidate write/state write가 0이다.
- background recompute/feedback도 dispatcher를 우회하지 않는다.
- company state에 user-specific overlay가 쓰이지 않는다.
- production route의 legacy 사용은 중앙 `LegacyProductProfileAdapter` 하나만 allowlist한다. core 평가도구·명시적 test 외 direct repository profile → matcher 호출은 tripwire가 실패시킨다.

### P4 — 기능적 19축 projection과 공통 answer loop

**목표:** 시각 리디자인 없이 현재 컴포넌트 구조에서 모든 matcher 입력의 상태와 해소 경로를 제공한다. public deployment 전까지 typed projection/answer는 rollout mode 뒤에서만 검증한다.

#### P4A — 19축 safe projection

1. `buildCompanyEvidenceFields`의 하드코딩 10축을 제거하고 19축 presentation adapter 순회로 교체한다.
2. `/matches`와 로그인 화면은 server `MatchingProfileView`를 소비하고 client가 raw profile을 별도 추론하지 않는다.
3. 모든 축에 known/partial/unknown, 안전한 source label, asOf, completeness, `direct/question_only/read_only`, 다음 행동을 표시한다.
4. identity/supporting/diagnostic은 19축 eligibility와 다른 section에 둔다.
5. checkpoint: `web: project all operational profile dimensions`

#### P4B — shared answer loop

1. `/matches`, dashboard, web/app이 같은 answer builder와 P3B command를 사용한다.
2. revenue/employees range, structured prior award, insured layoff/months, investment last round 회귀를 고친다.
3. 답변 성공 응답에 최신 profile view, 영향 공고 수, 4상태 카드/카운트, 다음 질문을 함께 반환하고 화면이 즉시 그 값을 사용한다.
4. anonymous answer는 ephemeral이고 로그인 answer만 owner scope로 저장한다.
5. checkpoint: `web: unify matching profile answer loop`

P4 전체 수용 조건:

- `CompanyEvidence.fields`의 operational key와 순서가 19축 SSOT와 정확히 같다. identity/supporting row는 별도 section이다.
- 19축 어느 것도 `other_conditions` fallback으로 저장되지 않는다.
- range/prior-award/compound 답변이 동일 context의 `/matches`와 dashboard에서 같은 profile 의미를 만든다.
- 답변 후 강제 reload 없이 결과와 다음 질문이 갱신된다. 로그인 경로는 reload 후에도 동일하다.
- D9가 닫힌 동안 4상태 내부 판정이 있더라도 사용자 문구는 `조건 확인 완료`, `추가 정보 필요`, `원문 확인 필요` 같은 중립 표현을 사용하고 `지원 가능성이 높음`을 노출하지 않는다.
- P5 전 기본 mode는 legacy이며 typed candidate가 response/persistence/state authority가 되지 않는다.

### P5 — vertical completeness CI와 bounded shadow

**목표:** 이후 matcher·source 개선이 UI 배선 누락 없이 제품에 도달하도록 CI를 만들고, 실제 전환 전 의미 차이를 짧게 관찰한다.

#### P5A — parity CI와 semantic replay

1. `verify:profile-product-parity`를 추가해 core spec, contract/OpenAPI, source mapping, persistence round-trip, 19축 adapter, Q&A, product route E2E를 묶고 root test/CI의 필수 job으로 연결한다.
2. full-profile fixture와 축별 sparse/unknown fixture로 source → update → merge → persist → resolve → match → safe view를 수직 검증한다.
3. 모든 `ProductProfileConsumerId`의 route/integration fixture가 legacy product와 typed candidate receipt를 만들고, source/route matrix에 누락·`pending`이 없음을 검증한다.
4. 승인 30표본 또는 동일 범위의 안전한 fixture materialization을 고정해 legacy/typed semantic replay를 수행한다. provider I/O 없이 동일 observations, grants, asOf를 사용한다.
5. known→unknown, primary precedence 하락, eligible↔ineligible, question 변화와 safe view 차이를 집계하고 모든 hard-state 차이에 판정을 기록한다.
6. checkpoint: `test: enforce product profile vertical parity`

#### P5B — live traffic shadow

1. 시작 전에 배포 환경, 조작 주체, current deployment/commit, rollback deployment/commit, telemetry dashboard, current mode/percentage, live source allowlist, cohort secret 존재 여부만 영수증에 기록한다. secret 값은 출력하지 않는다. 전체 계획 실행 권한이 없는 세션에서는 production mode를 바꾸지 않는다. shadow 관찰을 열기 전 preflight에서 이용 가능한 production traffic의 consumer별 최근 요청량과 예상 관찰 시간을 측정해 500 total과 high-volume group별 100 receipt 분모를 충족할 수 있는지 먼저 판정하고, 불가능하면 shadow를 시작하지 않고 `traffic_evidence_insufficient`로 남긴다.
2. 중앙 dispatcher를 `shadow`, stable HMAC cohort percentage를 10%로 두고 typed candidate만 추가 계산한다. 사용자 response/persistence/state authority는 legacy다.
3. materialization과 provider 호출은 한 번만 수행하며 legacy/typed가 공유한다.
4. 최대 24시간 안에 최소 **500 shadow-evaluated receipts**를 모은다. 각 receipt는 같은 request의 legacy comparator를 가지며, 전체 eligible traffic 수를 typed 표본 수로 세지 않는다.
5. high-volume consumer group인 anonymous teaser와 authenticated matching read는 각각 최소 100 shadow-evaluated receipts를 요구한다. 나머지 등록 consumer는 production traffic 또는 승인된 controlled smoke로 최소 1회 관측한다.
6. 24시간에 분모가 부족하면 replay로 latency/5xx/call-count 증거를 대체하지 않고 `traffic_evidence_insufficient`로 P6B를 막는다.
7. route 5xx, p95, provider call count, receipt 누락, hard-state diff를 집계한다. 임계 초과 시 percentage 0 → mode legacy → 신규 live source allowlist 비우기 순서로 즉시 rollback한다.
8. checkpoint: `web: shadow typed profiles on product traffic`

수용 조건:

- matcher 축/path를 임의로 하나 추가한 mutation test가 adapter/persistence/question/product parity 중 누락을 CI에서 잡는다.
- 설명되지 않은 known→unknown, authoritative primary 하락, hard eligible↔ineligible 차이 0건이다.
- shadow 때문에 live provider 호출 수가 늘지 않는다.
- 5xx 증가 0.2%p 미만, p95 추가 지연은 150ms 또는 10% 중 큰 값 이하를 목표로 하며 초과 시 P6B로 가지 않는다.
- traffic shadow는 시작 후 24시간에 반드시 종료하고 mode를 `legacy`로 되돌린다. semantic replay는 성능·안정성 증거로 세지 않는다.
- P5 전체에서 typed product receipt와 typed persistence/state write는 0이다.

### P6 — 외부 truth, production canary, legacy 종료

**목표:** preview/live truth가 맞다는 증거를 먼저 통과시킨 뒤 typed resolver를 10→50→100%로 승격하고 유일한 제품 경로로 만든다.

#### P6A — preview/live truth Gate

사전 조건:

- 사용자가 실행 중인 dev/preview 서버와 포트를 먼저 확인한다. Codex가 장기 실행 dev 서버를 시작하지 않는다.
- 실제 개인 15·법인 15 표본은 사용 승인, 기대값을 아는 필드, consent 범위를 먼저 기록한다. 승인 표본이 없으면 임의 사업자번호를 수집하지 않고 `external_samples_missing` blocker로 닫는다.
- live/유료/consent source는 해당 권한과 비용 상한이 있을 때만 호출한다. 검증할 권한이나 ground truth가 없는 source는 production `consumed`가 아니라 `disabled|not_authorized|unavailable`로 닫는다.

필수 시나리오:

- anonymous, owner, other user, consent granted/expired/revoked
- success, normal empty, cache hit, cache miss, timeout/provider failure
- web/app teaser, create, dashboard/matches/detail, answer, enrich, refresh, feedback
- 19축 known/partial/unknown UI와 source/asOf/completeness
- revenue/employees range, prior award, IP, financial, layoff, investment 질문
- answer 직후 매칭 변화와 reload round-trip
- desktop 1440×900, mobile 390×844 기능 smoke
- 응답·로그·screenshot의 bizNo 원문, 생년월일, 전화, token, raw payload 누출 검사

30표본 측정표에는 source별 `success/normal_empty/not_covered/skipped/failed`, cache hit, typed normalization 성공/실패, verified field 일치/불일치, authoritative/self-declared 충돌과 선택 근거, 기본 match-ready 축 수, 질문 수, 질문별 unknown 감소를 반드시 기록한다. 비어 있거나 검증하지 못한 분모는 `n/a`로 명시하고 성공률로 위장하지 않는다.

P6A blocking 수용 조건:

- non-empty verified response의 normalization 실패 0건, verified field 불일치 0건이다. 하나라도 있으면 해당 source를 고치거나 disabled로 닫기 전 P6B로 가지 않는다.
- authoritative primary의 silent downgrade, 설명 없는 conflict winner, partial-list miss의 부재 확정이 각각 0건이다.
- 질문 fixture와 실표본에서 답한 target dimension의 expected unknown 감소가 재현되고, 불완전 근거의 false hard eligible/ineligible이 0건이다.
- source별 응답/정상 빈값/실패가 정확히 분류되고 provider schema mismatch가 성공으로 집계되지 않는다.
- 두 번째 동일 조회의 신규 live provider 호출 0, 30/30 deterministic replay 동일이다.
- cross-tenant/anonymous consent-derived 노출과 민감 로그/응답/screenshot이 0건이다.
- 동일 context + 동일 materialized observations + 동일 asOf에서 web/app 및 주요 consumer의 profile·match·question 결과가 같다.
- D9가 닫힌 동안 neutral copy만 노출한다.
- checkpoint: `test: record verified service-data product truth`

P6A 증거는 P5B traffic 성능 증거를 대체하지 않으며, P5B와 P6A 모두 통과해야 P6B를 시작한다.

#### P6B — production 10→50→100% canary

전환 전에 배포 환경, 조작 주체, current deployment/commit, rollback deployment/commit, telemetry dashboard, live source allowlist, cohort secret의 존재 여부만 영수증에 기록한다. secret 값은 출력하지 않는다. 전체 P0~P6 실행 요청이 없는 별도 세션에서는 production traffic을 바꾸지 않는다.

허용 제어는 다음 세 가지뿐이다.

- `SERVICE_DATA_PROFILE_MODE=legacy|shadow|rollout|typed`와 동등한 중앙 mode
- `SERVICE_DATA_TYPED_COHORT_PERCENT=0|10|50|100`와 동등한 percentage
- 신규 live source allowlist

cohort는 `HMAC(secret, context + stable internal subject) % 100`으로 정하고 raw bizNo/user ID를 log에 남기지 않는다. 같은 subject는 단계 안에서 sticky하다. cohort 배정 분모는 dispatcher를 통과한 eligible product requests지만, Gate 표본 수는 실제 `typed_product` 또는 `typed_candidate` receipt만 별도로 센다. `rollout`에서 percentage 밖 요청은 legacy, 안쪽 요청만 typed product authority를 사용한다.

승격 순서:

1. percentage 0에서 N/N-1 read와 rollback dry-run을 확인한다.
2. 10%를 최소 2시간, 최소 500 `typed_product` receipts와 최소 500 concurrent `legacy_product` comparator receipts까지 관찰한다.
3. Gate 지표가 유지되면 50%를 같은 분모와 시간 조건으로 관찰한다.
4. 다시 유지되면 100%로 전환해 최소 2시간과 최소 500 `typed_product` receipts를 관찰하고 P5B/직전 단계 baseline과 비교한다.
5. 어느 단계든 지표를 넘으면 percentage 0 → mode legacy → 신규 live source allowlist 비우기 순서로 즉시 rollback한다.

각 단계 수용 조건:

- route 5xx 증가는 0.2%p 미만, p95 추가 지연은 150ms 또는 10% 중 큰 값 이하다.
- 10/50%에서는 typed cohort의 provider call count가 concurrent legacy cohort보다 증가하지 않고, 100%에서는 P5B와 직전 P6B 단계의 동일 source-policy baseline을 넘지 않는다.
- 설명되지 않은 known→unknown, primary downgrade, hard-state diff, question-loop diff, receipt 누락이 각각 0건이다.
- typed write는 resolver/source version이 있는 non-destructive observation만 만들고, canary 중 새 답변을 포함한 N-1 legacy reconstruction test를 계속 통과한다.
- cross-scope exposure, 민감 telemetry, D9 copy 위반이 0건이다.
- 10/50%에서는 anonymous teaser와 authenticated matching read가 typed/legacy 각각 최소 100 receipts이고, 모든 등록 consumer는 실제 traffic 또는 승인된 controlled smoke receipt가 최소 1개다.
- 표본/시간이 부족하면 다음 percentage로 가지 않고 external traffic blocker로 남긴다.
- checkpoint: `web: roll out typed service-data product profiles`

#### P6C — 100% 안정화와 legacy retirement

1. 100% typed에서 24시간과 최소 500 `typed_product` receipts를 관찰한다.
2. source/route별 `ProductConsumptionReceipt.authority=typed_product` 집계를 기록하고 `product_consumed=pending`이 없음을 CI와 production aggregate 양쪽에서 확인한다.
3. typed resolver로 company-scoped state를 한 번 재계산한다. user overlay는 company state에 쓰지 않는다.
4. shadow comparison, central legacy adapter, route-local legacy merge, hardcoded 10축 list, 중복 answer 구현, rollout percentage 분기를 제거한다.
5. additive observation/schema는 삭제하지 않고 N-1 배포가 읽을 수 있는 상태를 한 release 유지한다. emergency rollback은 이전 검증 deployment로 수행하며 코드에 두 번째 resolver를 되살리지 않는다.

P6 최종 수용 조건:

- 운영 19축의 source 상태가 `consumed | disabled | not_authorized | unavailable` 중 하나이며 `product_consumed=pending`이 없다.
- 모든 product consumer가 동일 context/observations/asOf에서 같은 typed profile·match·question 의미를 쓴다.
- root CI, P6A truth, P5B/P6B operational gates, browser 기능 smoke가 green이다.
- 독립 reviewer BLOCKER/MAJOR가 0이고 rollout/shadow/legacy code가 제거됐다.
- final checkpoints: `web: make typed service data the product match input`, `chore: retire legacy profile resolution`

## 22. 검증 매트릭스

| 층 | 필수 증거 |
|---|---|
| pure assembly | evidence precedence, supplemental 보존, update order contract, explicit asOf, G1~G7 fixture 회귀 |
| contract | 19축 TypeScript/OpenAPI parity, safe DTO allowlist, source kind/consent semantics, consumer registry와 `ProductConsumptionReceipt` |
| persistence | full/sparse profile round-trip, permutation independence와 conflict/unknown, user/shared scope, versioned non-destructive observation, N-1 reconstruction, revoke 후 재해석 |
| matcher | direct·normalized product path parity, unknown 보존, 4상태, next-question 영향 |
| commands | web/app create·enrich·answer의 동일 profile/save/refresh receipt |
| routes | teaser/dashboard/detail/background/feedback가 resolver를 우회하지 않는 정적·통합 test |
| privacy | anonymous/owner/other-user/consent matrix, raw/masked payload 검사, GET no-write |
| UI | 19축 key/order, known/partial/unknown, source/asOf/completeness, 네 문제 질문 회귀, immediate refresh |
| live truth | 30표본 source status, normalization/verified-field accuracy, conflict decision, match-ready 축, 질문별 unknown 감소, privacy/browser 증거 |
| operations | cache/live call count, deadline/single-flight, 24h shadow, sticky HMAC cohort, 5xx/p95, 10/50/100 rollout·rollback 영수증 |

최소 로컬 명령 묶음은 새 `pnpm verify:profile-product-parity` 외에 contracts/core/web typecheck, OpenAPI·route-policy·RLS·migration 검증, matching/Q&A/evidence-priority/company-enrichment/service-data/consent focused tests, root `pnpm test`, `git diff --check`를 포함한다. 실제 명령명은 repo에 이미 있는 script를 재사용하고 같은 검증을 중복 구현하지 않는다.

## 23. rollout·rollback·관측 원칙

rollout 동안만 다음 세 제어를 허용한다.

- `SERVICE_DATA_PROFILE_MODE=legacy|shadow|rollout|typed`와 동등한 단일 mode switch
- stable HMAC cohort에 쓰는 `SERVICE_DATA_TYPED_COHORT_PERCENT=0|10|50|100`와 동등한 percentage
- 신규 live source allowlist. 빈 값이면 신규 live acquisition을 모두 중단한다.

rollback 순서는 다음과 같다.

1. cohort percentage를 0으로 내려 신규 typed response/write를 막는다.
2. mode를 `legacy`로 되돌린다.
3. 신규 live source allowlist를 비운다.
4. `LegacyProductProfileAdapter`가 resolver/source version으로 N-1 observations만 읽어 기존 profile을 재구성한다. typed observation은 삭제하거나 거짓 legacy 값으로 projection하지 않는다.
5. consent/CODEF acquisition을 중단하고 N-1 profile로 영향받은 company-scoped state만 재계산한다. user overlay state는 쓰지 않는다.
6. cache 삭제, DB enum 역마이그레이션, observation 삭제를 rollback 수단으로 쓰지 않는다.
7. P6C에서 legacy code를 제거한 뒤에는 이전 검증 deployment/commit으로 rollback한다. additive observation/schema의 N-1 read compatibility 때문에 데이터 복구나 역마이그레이션 없이 동작해야 한다.

관측에는 context, provider, source status, cache hit, latency, cost bucket, known/unknown 변화, hard-state 변화만 남긴다. 회사 식별자는 HMAC 가명키를 사용하고 bizNo·개인식별정보·raw payload·provider token은 남기지 않는다.

optional enrichment source 하나가 실패하면 해당 observation만 제외하고 base profile + 나머지 updates로 계속한다. 이때 fallback은 `unknown`이지 legacy merge 의미가 아니다. request identity/access, required base identity, active grant universe 실패는 §18.2의 fail-closed 계약을 따른다.

## 24. 제품 완료 판정과 다음 단계

P0~P6 최종 완료는 다음 모두가 참일 때만 선언한다.

- G1~G7 typed assembly가 production-safe single authority다.
- 모든 제품 matcher 진입점이 같은 dispatcher/resolver 계약, context에 맞는 observation set, request당 하나의 grant universe와 explicit asOf를 사용한다.
- 모든 제품 write가 같은 command service와 persistence 의미를 사용한다.
- 운영 19축이 실제 사용자 페이지에 상태·근거·해소 행동과 함께 노출된다.
- 모든 질문 형식이 동일 context의 web/app consumer에서 같은 profile 의미를 만들고, anonymous/authenticated의 차이는 명시된 privacy·persistence 정책과 정확히 일치한다.
- owner/anonymous/consent/revoke와 match-state scope가 안전하다.
- persistence·TypeScript·OpenAPI·UI·matcher parity를 CI가 강제한다.
- live product 증거와 10/50/100 rollout이 통과했다.
- source/route별 `product_consumed=pending`이 0이다.
- legacy resolver·hardcoded 10축·중복 answer 경로·장기 shadow가 제거됐다.
- D9가 별도 증거로 해제되기 전까지 사용자 문구가 중립 표현을 유지한다.
- 독립 리뷰 BLOCKER/MAJOR가 0이고 worktree가 clean하다.

이 완료 뒤 matcher/source/question logic 개선은 반드시 이 제품 경로와 `verify:profile-product-parity`를 통해 수행한다. 따라서 logic commit이 실제 `/matches`·dashboard·web/app API의 결과 변화와 같은 PR/commit의 증거로 남는다. 다음 성능 단계에서는 승인 30표본 baseline으로 축별 자동충전율, 질문 해소율, hard-state 정확도를 개선한다. 시각·상호작용 인터페이스 리디자인은 그 다음 별도 단계로 시작한다.

## 25. 관련 문서

- [매칭 트랙 마스터 실행 문서](./2026-07-13-matching-master-execution.md)
- [매칭 입력 필드 문제인식](../research/2026-07-13-service-data-매칭입력-필드-문제인식.md)
- [사업자번호 우선 자동채움 실행 가이드](./2026-07-12-사업자번호-우선-자동채움-실행가이드.md)
- [공고 매칭 1차 미션 복구 계획](./2026-07-13-first-mission-recovery-plan.md)
