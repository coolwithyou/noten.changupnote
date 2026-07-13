# `/dev/service-data` 매칭 입력 필드 개선 계획

> 작성일: 2026-07-13
> 상태: 문제인식 문서와 교차 검토 완료 · 구현 대기
> 기준 진단: [매칭 입력 필드 검증 문제인식](../research/2026-07-13-service-data-매칭입력-필드-문제인식.md)
> 상위 실행 맥락: [사업자번호 우선 자동채움 실행 가이드](./2026-07-12-사업자번호-우선-자동채움-실행가이드.md)
> 신규 세션 실행: [Orca 구현 핸드오프](./HANDOFF-2026-07-13-service-data-매칭입력.md)

## 1. 목표

사업자등록번호와 현재 연결된 외부 소스, 최소 사용자 답변만으로 다음 end-to-end 흐름을 dev 페이지에서 증명한다.

```text
사업자번호 조회
  -> 외부 원시 응답
  -> canonical CompanyProfileFieldUpdate[]
  -> evidence 우선순위를 적용한 CompanyProfile
  -> 활성 공고 전체 shadow matching
  -> 지원 가능/확인 필요/지원 어려움
  -> 남은 unknown과 다음 최적 질문
```

첫 마일스톤의 완료 문장은 다음과 같다.

> 사업자번호 1개를 조회하면 현재 확보 가능한 정보로 typed `CompanyProfile`이 만들어지고, 실제 matcher에서 입력 전후 `unknown` 감소량과 판정 상태 변화를 확인할 수 있다.

이 문서는 기존 커넥터 구현 계획을 다시 세우지 않는다. **화면 표시와 실제 matcher 사이의 끊어진 경계**만 우선 연결한다.

## 2. 범위 고정

### 2.1 이번 구현에 포함

- 회사 프로필 필드 역할의 단일 명세
- 화면 필드 계획과 matcher 소비 필드의 parity 테스트
- 커넥터 결과와 Q&A의 typed update 변환
- 기존 evidence 우선순위를 사용한 최종 profile 병합
- 활성 공고 read-only shadow match
- profile 부족 unknown과 공고 추출 부족 unknown 분리
- 현재 필드 누락·오표현 보정
- 공고 가중 커버리지 계산 보정
- 사용자 실행 dev 서버에서의 마지막 브라우저 검증

### 2.2 이번 구현에서 제외

- 신규 외부 API·유료 provider 추가
- production dashboard UI 변경
- profile DB schema 변경
- 외부 API raw payload 영속화 확대
- generic connector/plugin framework 구축
- dev 페이지 전체 리팩터링
- AI가 hard eligibility를 직접 결정하는 기능
- 지원서 작성 기능

### 2.3 분류 체계의 임시 고정

구현을 시작하기 위해 다음을 고정한다.

- 기준선: 현재 운영 19축
- 활성 후보: `premises`, `export_performance`
- 자격 분모 제외: `other`
- 자격 분모 밖: 조회 전제, 파생 보조, ranking 목표, 운영 진단

예약축의 최종 활성화는 Phase 0B 검수 결과 전까지 구현 임계경로를 막지 않는다.

## 3. 전체 의존 순서

```text
Phase 0A 역할 동결
  -> Phase 1 필드 SSOT·parity
  -> Phase 2 typed update
  -> Phase 3 profile merge
  -> Phase 4 shadow match
  -> Phase 5 화면·지표 보정
  -> Phase 7 로컬/브라우저 검증

Phase 0B premises/export 표본 검수
  -> 승인된 축만 Phase 6에서 하나씩 활성화
```

Phase 0B는 Phase 1~5와 병렬로 결정할 수 있지만, `premises` 또는 `export_performance` 코드는 검수 결정 전 작성하지 않는다.

## 4. Phase 0 — 분류 역할 동결과 예약축 판정

### Phase 0A. 즉시 고정할 역할

다음 분류를 문서·코드 주석·테스트에서 동일하게 사용한다.

| 역할 | 포함 | 자격 커버리지 분모 |
|---|---|---:|
| `eligibility` | 운영 19축 | 포함 |
| `reserved_eligibility` | premises, export_performance | 승인 전 제외 |
| `grant_unstructured` | other | 제외 |
| `identity_prerequisite` | 사업자번호, 상호, 법인번호, 인증 상태, match method | 제외 |
| `supporting` | 자산총계, 자본총계, 자본금, 기준연도 등 | 제외 |
| `ranking` | support/interest goals | 제외 |
| `diagnostic` | raw 상태, 오류, cache, latency, cost | 제외 |

완료 조건:

- 코드에서 `other`가 자동채움 자격 분모에 들어가지 않는다.
- 예약축이 matcher에서 계속 `unknown`을 반환한다.
- supporting 필드가 자격 축 수를 늘리지 않는다.

### Phase 0B. `premises`·`export_performance` 표본 검수

목표는 축을 늘리는 것이 아니라, 이미 예약된 두 축을 실제로 활성화할 가치가 있는지 확인하는 것이다.

절차:

1. 2026-07-13 후보 query를 재현해 축별 최소 30개 공고를 추출한다.
2. 각 후보를 사람이 다음 중 하나로 분류한다.
   - hard eligibility
   - preferred/ranking
   - 지원 내용·혜택 설명
   - 신청 후 수행 요건
   - 다른 기존 축의 오분류
   - 구조화 불가 long-tail
3. hard eligibility에 대해서만 필요한 회사 값, operator, 단위, 기간, 근거 span을 적는다.
4. 한 축 안에서 안정된 공통 계약으로 표현 가능한지 판단한다.
5. 축별로 `activate`, `remain_reserved`, `reject` 중 하나를 기록한다.

판정 원칙:

- 반복 빈도만으로 활성화하지 않는다.
- 회사 측 값을 현실적으로 입력·조회할 수 있어야 한다.
- 한 축이 서로 다른 의미를 억지로 묶으면 활성화하지 않는다.
- false ineligible을 만들 수 있는 모호한 조건은 `text_only`로 유지한다.

산출물:

- 문제인식 문서의 후보 수치 아래에 검수 결과와 대표 반례 추가
- 승인 시 해당 축의 profile/criterion 계약 초안

완료 조건:

- 두 축 각각에 결정과 근거 예시·반례가 있다.
- 독립된 사람 검수 전에는 `activate`로 기록하지 않는다.

## 5. Phase 1 — matcher 기준 필드 SSOT와 parity

### 목적

화면의 `FIELD_COVERAGE_PLAN`이 matcher 변경을 수동 추적하지 않게 한다.

### 구현

1. `packages/core/src/autofill/profile-field-spec.ts`에 최소 필드 명세를 만든다.
2. 명세에는 다음만 둔다.
   - field key와 parent dimension
   - 역할: eligibility/reserved/supporting/identity/ranking
   - `CompanyProfile` 경로 또는 update field
   - scalar/list/compound readiness 종류
   - 자격 분모 포함 여부
3. provider 이름, env key, UI 문구는 dev 서버의 소스 계획에 남긴다. core 명세에 외부 provider 구현을 넣지 않는다.
4. `FIELD_COVERAGE_PLAN`은 core 필드 key를 참조하고, dev 전용 소스 메타만 덧붙이도록 바꾼다.
5. 운영 19축의 부모 행은 `OPERATIONAL_AUTOFILL_DIMENSIONS`에서 파생한다.

추가할 명시 필드:

- `industry_codes`
- list completeness: industry, founder_trait, certification, prior_award, ip, target_type
- `financial_health.interest_coverage_ratio`
- `financial_health.capital_krw`
- `financial_health.fiscal_year`
- `insured_workforce.months_since_last_layoff`
- 구조화 `prior_award_history`
- IP 권리 종류·상태
- target type의 법적 형태와 신청 주체 태그
- identity prerequisite와 ranking field

주요 파일:

- 신규 `packages/core/src/autofill/profile-field-spec.ts`
- 신규 단위 테스트
- `packages/core/src/autofill/coverage.ts`
- `packages/core/src/index.ts`
- `apps/web/src/lib/server/devServiceDataMonitor.ts`

게이트:

- 19개 운영 dimension마다 부모 eligibility row가 정확히 1개다.
- `other`는 eligibility row와 분모에 없다.
- 예약축은 별도 role이고 분모에 없다.
- matcher가 읽는 복합 하위 필드가 명세에서 누락되지 않는다.
- supporting/identity/ranking 행은 부모 축 complete를 만들지 않는다.

중단 조건:

- 명세를 만들기 위해 matcher 전체를 generic schema engine으로 바꿔야 한다면 중단한다.
- 목표는 작은 상수와 parity helper이지 새 프레임워크가 아니다.

## 6. Phase 2 — 커넥터와 Q&A를 typed update로 변환

### 목적

표시 문자열과 matcher 입력을 분리한다.

### 구현

1. `ConnectorResult`에 표시용 `value`를 유지하면서 선택적 `profileUpdates: CompanyProfileFieldUpdate[]`를 추가한다.
2. 값이 있는 성공 결과는 가능한 경우 최소 한 개 typed update를 함께 반환한다.
3. 모든 update는 `updateCompanyProfileField()`를 통과해야만 `normalized` 상태가 된다.
4. 변환 실패는 API 실패가 아니라 `normalization_failed`로 표시한다.
5. `sourceKind`, provider, `asOf`, confidence, axis completeness를 update에 그대로 넣는다.
6. 클라이언트는 직렬화 가능한 dev answer DTO만 서버에 보낸다.
7. 서버의 `buildDevQnaProfileUpdates()`가 answer DTO를 typed update로 바꾼다.
8. 기존 production `QuestionDefinition`과 `updateCompanyProfileField()`를 재사용하고 문항 의미를 복제하지 않는다.

`page.tsx`가 현재 Q&A schema를 서버에서 만들어 전달하는 이유는 클라이언트 번들에 `@cunote/core`를 끌어들이지 않기 위해서다. 이 경계를 유지한다. 클라이언트에서 matcher normalizer를 직접 import하지 않는다.

필수 Q&A 보정:

- `prior_award`: 자유 텍스트를 구조화 이력·known 범위 입력으로 교체
- `ip`: 보유 건수 대신 권리 종류·상태와 known 범위 입력
- 재무: 이자보상배율, 자본금, 결산연도 입력/표시 추가
- 감원: 이미 있는 경과 개월 입력을 명시 typed update에 연결
- industry/trait/cert/IP/target/prior award: positive-only와 complete 목록을 구분
- 예비창업: 사업자번호 조회 기본값이 아닌 별도 시나리오

권장 분리 파일:

- 신규 `apps/web/src/lib/server/devServiceDataProfile.ts`
- 신규 `apps/web/src/lib/server/devServiceDataProfile.test.ts`
- `apps/web/src/lib/server/devServiceDataMonitor.ts`
- `apps/web/src/features/dev/ServiceDataMonitor.tsx`

게이트:

- 숫자 단위가 원 단위·명·개월로 canonical 변환된다.
- prior award와 IP가 matcher가 실제 읽는 구조를 만든다.
- 빈 결과와 normalization 실패가 구분된다.
- user answer가 권위 원천을 묵시적으로 덮어쓰지 않는다.
- raw 표시값은 유지되므로 커넥터 디버깅 능력이 후퇴하지 않는다.

## 7. Phase 3 — 최종 `CompanyProfile` 병합

### 목적

현재 소스가 만든 update를 한 개의 실제 matcher 입력으로 합친다.

### 구현

1. 조회 파이프라인의 기존 base profile을 시작점으로 사용한다.
2. 소스별 typed update를 `updateCompanyProfileField()`로 적용한다.
3. 충돌은 기존 `resolveEvidencePrecedence()` 정책을 재사용한다.
4. primary에서 밀린 evidence는 supplemental로 보존한다.
5. list merge는 positive hit와 exhaustive list를 구분한다.
6. 최종 profile과 field별 merge decision을 dev 응답에 포함한다.
7. 이 단계에서는 DB에 저장하지 않는다.

필드 상태는 다음 네 단계로 노출한다.

| 단계 | 의미 |
|---|---|
| `sourced` | 원시 응답에 값이 있음 |
| `normalized` | typed update 검증 통과 |
| `match_ready` | 해당 criterion을 판정할 evidence·completeness가 충분 |
| `product_consumed` | production 저장·매칭 경로에서 실제 소비됨 |

dev shadow 단계에서는 앞의 세 단계까지만 필수다. `product_consumed`는 마지막 외부 게이트까지 pending일 수 있다.

게이트:

- 같은 입력을 같은 순서로 병합하면 같은 profile이 나온다.
- 원천 우선순위와 completeness 우선순위가 production 경로와 같다.
- partial list가 빈 목록의 부재를 확정하지 않는다.
- profile preview가 `CompanyProfile` 타입과 update normalizer를 통과한다.

## 8. Phase 4 — 활성 공고 shadow matching

### 목적

페이지의 커버리지를 실제 판정 변화로 검증한다.

### 구현

1. 활성·deduped 공고 전체를 read-only로 불러온다.
2. 최종 profile을 `matchNormalizedGrant()`에 넣는다.
3. 엔진 진단용으로 다음 수를 반환한다.
   - eligible
   - conditional
   - ineligible
4. 사용자 노출 계약과 같은 다음 네 상태도 별도로 집계한다.
   - 지원 가능성이 높음
   - 정보 확인
   - 원문 확인
   - 지원 어려움
5. `eligible`이어도 공고 extraction/review gate가 닫혀 있으면 “지원 가능성이 높음”으로 올리지 않는다.
6. unknown을 다음 두 범주로 분리한다.
   - `profile_missing`: 회사 값 또는 completeness 부족
   - `grant_unready`: text_only, needs_review, canonicalization 부족, source evidence 부족
7. 최소 두 snapshot을 비교한다.
   - 사업자번호 기본 profile
   - 현재 외부 소스 + 사용자 답변을 모두 병합한 profile
8. before/after에서 바뀐 공고 수와 dimension별 unknown 감소량을 표시한다.
9. 기존 question planner를 이용해 다음 가장 가치 있는 질문을 표시한다.

첫 마일스톤에는 모든 provider를 한 번씩 제거한 기여도 분석을 넣지 않는다. 기본 profile과 최종 profile의 차이만 먼저 증명한다. 개별 provider 기여도는 성능과 필요성이 확인된 뒤 추가한다.

주요 파일:

- `apps/web/src/lib/server/devServiceDataMonitor.ts`
- `apps/web/src/lib/server/devServiceDataProfile.ts`
- `apps/web/src/app/api/dev/service-data/route.ts`
- `apps/web/src/features/dev/ServiceDataMonitor.tsx`

게이트:

- shadow match는 DB write를 하지 않는다.
- 공고 반환 제한과 평가 universe를 구분한다.
- 같은 profile과 공고 revision에서 결과가 재현된다.
- text-only 공고 조건이 profile 질문으로 잘못 분류되지 않는다.
- unreviewed/partial 공고가 “지원 가능성이 높음”으로 잘못 승격되지 않는다.
- 질문 응답 후 unknown 감소가 없으면 해당 문항을 “채움 완료”로 표시하지 않는다.

## 9. Phase 5 — 필드 화면과 지표 보정

### 9.1 화면 정보 구조

기존 UI를 전면 재설계하지 않고 섹션만 명확히 나눈다.

1. 조회 전제·식별 정보
2. 자격 판정 19축
3. 예약축 상태
4. 파생·설명 보조 필드
5. 추천 정렬용 관심 목표
6. 최종 typed profile
7. shadow match 결과와 unknown 원인

### 9.2 커버리지 지표

다음 네 값을 구분한다.

- `sourcing_coverage`
- `canonical_match_ready_coverage`
- `grant_extraction_readiness`
- `end_to_end_decidability`

기존 `authoritative_axis_coverage`, `total_answered_coverage`는 소싱 지표로 유지할 수 있다. 이름이나 설명만으로 actual match-ready와 혼동하지 않게 한다.

### 9.3 공고 가중치 수정

가중치 분모를 다음으로 고친다.

- 전체 활성·deduped 공고
- canonical contract 통과
- hard required/exclusion
- non-text-only
- profile-resolvable
- 공고별 같은 dimension 중복 제거
- reviewed와 pending 별도 집계

게이트:

- 샘플 500건 제한이 없다.
- preferred criterion이 자격 가중치에 들어가지 않는다.
- 한 공고의 같은 dimension이 여러 criterion이어도 1회만 센다.
- `other`는 회사 프로필 커버리지 부족으로 세지 않는다.

## 10. Phase 6 — 승인된 예약축만 활성화

Phase 0B에서 `activate`된 축만 하나씩 진행한다. 두 축을 묶어 한 번에 열지 않는다.

축 하나의 원자적 구현 범위:

1. `CompanyProfile` 필드 계약
2. `CompanyProfileFieldUpdate` 정규화
3. criterion value canonical contract
4. deterministic evaluator
5. 추출·canonicalization 경계
6. question definition
7. dev field spec과 readiness
8. matcher·parser·question 회귀 테스트
9. 표본 공고 shadow match

승인 전 상태:

- enum 자리는 유지
- matcher는 unknown
- question planner는 질문하지 않음
- 자격 커버리지 분모에서 제외

중단 조건:

- 하나의 축으로 표현할 수 없는 의미가 섞임
- 회사 값을 신뢰성 있게 입력할 방법이 없음
- evaluator가 원문 추론 없이 결정론적으로 동작하지 않음
- false ineligible을 막을 안전한 unknown 경계가 없음

## 11. Phase 7 — 검증과 외부 게이트

### 11.1 로컬 필수 검증

변경 범위에 따라 다음을 실행한다.

```bash
./node_modules/.bin/tsx packages/core/src/autofill/profile-field-spec.test.ts
./node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/devServiceDataProfile.test.ts
./node_modules/.bin/tsx packages/core/src/criteria/canonicalize.test.ts
./node_modules/.bin/tsx packages/core/src/matching/match.test.ts
./node_modules/.bin/tsx packages/core/src/matching/question-planner.test.ts
./node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/devServiceDataMonitor.test.ts
pnpm --filter @cunote/core typecheck
pnpm --filter @cunote/web typecheck
pnpm verify:service-data
```

아직 존재하지 않는 신규 테스트 명령은 해당 Phase에서 만든 뒤 실행한다. 전체 `pnpm test`의 기존 unrelated 실패와 이번 범위 테스트를 구분해 기록한다.

### 11.2 브라우저 게이트

개발 서버는 사용자가 실행한다. 실행 중인 web 서버가 있을 때만 다음을 확인한다.

- 기준 경로: `/dev/service-data`
- 사업자번호 조회 성공·빈값·실패·cache 상태
- typed profile preview
- prior award/IP/재무/감원 Q&A
- before/after match summary
- mobile/desktop 기본 overflow와 오류 상태

### 11.3 실표본 외부 게이트

최소 개인 15개·법인 15개, 총 30개 사용 권한 있는 표본으로 다음을 측정한다.

- source별 응답률과 정상 빈값
- typed normalization 성공률
- authoritative vs self-declared 충돌률
- 사업자번호 기본 profile의 match-ready 축 수
- 질문 수와 질문 1개당 unknown 감소량
- verified-only 정확도와 unverified 분리

이 표본이 없으면 “하네스 완료, 실측 대기”까지만 주장한다.

### 11.4 개인정보·로그 게이트

- 사업자번호는 화면·로그에서 기존 마스킹 정책을 유지한다.
- CODEF 인증에 사용한 생년월일·휴대폰번호·대표자명 원문을 profile preview나 JSON 진단에 넣지 않는다.
- matcher에 필요한 대표자 연령·특성처럼 최소 파생값만 남긴다.
- 외부 raw payload와 인증 token을 브라우저 응답·테스트 snapshot·문서에 저장하지 않는다.
- profile preview 복사 기능을 만들더라도 민감 원문은 포함하지 않는다.

## 12. 테스트 시나리오

최소 회귀 시나리오는 다음과 같다.

1. 개인사업자, 법인번호 없음: 법인 전용 API는 failed가 아니라 prerequisite
2. 법인, DART bridge 성공: 법인번호와 재무 source 연결
3. KIPRIS exact positive: IP 종류 typed update와 partial/complete 의미 확인
4. KIPRIS miss: IP 없음으로 단정하지 않음
5. certification present-only: positive merge, 부재는 unknown
6. prior award program 미질의: 부재 pass 금지
7. 부분자본잠식: equity > 0이지만 equity < capital이면 partial
8. 감원 있음·시점 없음: unknown
9. 감원 후 경과 개월 충분/부족: pass/fail
10. derived 업력·규모: display는 가능하지만 evidence 보완 전 matcher unknown
11. `other/text_only`: profile 질문 후보에서 제외
12. 사용자 응답이 권위 원천과 충돌: primary 유지·supplemental 기록
13. unreviewed 공고의 engine eligible: 제품 상태는 원문 확인으로 유지
14. CODEF 인증 profile preview: 생년월일·휴대폰·token 비노출

## 13. 권장 변경 단위

현재 작업 트리가 매우 크므로 커밋 여부와 무관하게 diff 경계를 다음처럼 유지한다.

1. `autofill: define matcher-consumed field spec and parity`
2. `service-data: emit typed profile updates`
3. `service-data: merge profile evidence and preview final profile`
4. `service-data: add read-only shadow match deltas`
5. `service-data: correct field UI and weighted readiness`
6. 승인된 경우에만 `matching: activate premises` 또는 `matching: activate export performance`

각 단위는 테스트와 문서 체크리스트를 함께 갱신하고, 현재 작업 트리의 다른 변경을 포함하지 않는다.

## 14. 완료 체크리스트

- [ ] 19개 운영 축과 화면 부모 행 parity
- [ ] `other` 자격 분모 제외
- [ ] 예약축 별도 role 유지
- [ ] matcher 소비 하위 필드 누락 0
- [ ] connector success의 typed update 생성
- [ ] Q&A typed update 생성
- [ ] final CompanyProfile preview
- [ ] evidence precedence·supplemental 보존
- [ ] list completeness 보존
- [ ] prior award 구조화 입력
- [ ] IP 종류·상태 입력
- [ ] 부분자본잠식 파생
- [ ] 감원 경과 개월 typed 연결
- [ ] active universe shadow match
- [ ] profile missing vs grant unready unknown 분리
- [ ] before/after unknown 감소량
- [ ] 다음 질문 표시
- [ ] corrected grant weighting
- [ ] targeted tests와 core/web typecheck
- [ ] 사용자 실행 서버의 브라우저 검증
- [ ] 30개 실표본 측정 또는 명시적 external pending

## 15. 과설계 방지 중단 규칙

다음 상황에서는 기능 추가를 멈추고 첫 마일스톤부터 확인한다.

- 새 API 없이는 진행할 수 있다고 판단하기 시작함
- typed profile보다 connector 추상화 설계가 커짐
- dev 페이지 정리를 위해 production UI를 건드림
- `other`를 줄이기 위해 새 dimension을 연속 추가함
- 모든 목록의 완전한 사전을 먼저 만들려 함
- 모든 provider별 기여도를 첫 버전에 계산하려 함
- shadow match 전에 persistence migration을 설계함
- eligibility와 relevance/ranking을 같은 점수로 합침
- 테스트를 통과시키기 위해 unknown을 pass로 바꿈

## 16. 계획 완료 후 다음 행동

구현은 Phase 0A와 Phase 1부터 시작한다. Phase 1 parity가 통과하기 전에는 새 커넥터를 추가하지 않는다. 첫 구현 세션의 종료점은 다음 세 가지다.

1. field spec 존재
2. current matcher와 page의 parity test 통과
3. 현재 `ConnectorResult` 중 대표 3종이 typed update를 만들기 시작함

대표 3종은 서로 다른 shape를 고른다.

- scalar: employees 또는 revenue
- list: certification 또는 IP
- compound: financial_health 또는 insured_workforce

이 세 종류가 end-to-end로 통과한 뒤 나머지 커넥터를 같은 방식으로 옮긴다.

## 17. 문제인식 문서와의 교차 리뷰

### 17.1 문제-작업 추적성

| 문제 | 해결 Phase | 빠진 경우의 실패 |
|---|---|---|
| P0 display-only 경계 | 2, 3, 4 | API 응답이 실제 판정으로 이어졌는지 모름 |
| P1 필드 계약 드리프트 | 1 | matcher 변경 때 화면이 다시 낡음 |
| P2 부분자본잠식 | 1, 2, 5 | `equity > 0`을 정상으로 오표시 |
| P3 target type 의미 축소 | 1, 2, 5 | 법적 형태만으로 신청 주체 전체를 complete 처리 |
| P4 other/ranking 혼합 | 0A, 5 | 공고 추출 문제를 사용자 입력 문제로 오인 |
| P5 부모축 complete 과장 | 1, 4 | 복합 criterion의 실제 unknown을 숨김 |
| P6 잘못된 공고 가중치 | 5 | 필드 ROI 우선순위가 왜곡됨 |
| P7 세 커버리지 혼합 | 4, 5 | API coverage를 판정 가능률로 오인 |
| P8 조회 전제 비가시성 | 1, 5 | 조인키 부족을 데이터 부재로 오인 |
| P9 display-to-match 테스트 부재 | 1~7 | 같은 드리프트가 재발 |

### 17.2 과설계 보정

- 예약축 검수는 19축 typed loop의 선행 blocker에서 분리했다.
- 첫 shadow match는 provider별 제거 실험을 하지 않고 기본 profile 대 최종 profile만 비교한다.
- 새 API, DB migration, production UI, generic connector framework를 범위에서 제외했다.
- 5천 줄 dev 구현의 파일 분할은 typed profile 경계를 만드는 한 파일만 허용하고 전면 리팩터링하지 않는다.
- 19축을 한 번에 전환하지 않고 scalar/list/compound 대표 3종으로 경계를 먼저 검증한다.

### 17.3 부족한 부분 보정

- 클라이언트 core import를 피하기 위해 Q&A typed 변환을 서버 소유로 고정했다.
- engine 3상태와 사용자 노출 4상태를 분리하고 review gate를 유지했다.
- CODEF·대표자 정보가 profile preview에 노출되지 않도록 개인정보 게이트를 추가했다.
- Phase 2 전체 완료는 현재 값 생성 커넥터와 Q&A가 모두 typed update를 내는 시점으로 정의한다. 대표 3종은 첫 세션의 세로 절단 검증일 뿐 전체 완료가 아니다.

교차 리뷰 결과, 구현 순서는 유지한다. 첫 코드 작업은 Phase 0A·1이며, Phase 0B와 새 provider는 첫 마일스톤을 막지 않는다.

## 18. 관련 문서

- [신규 세션 Orca 구현 핸드오프](./HANDOFF-2026-07-13-service-data-매칭입력.md)
- [매칭 입력 필드 검증 문제인식](../research/2026-07-13-service-data-매칭입력-필드-문제인식.md)
- [매칭 시스템 현황 평가](../research/2026-07-13-매칭시스템-현황평가.md)
- [사업자번호 우선 자동채움 실행 가이드](./2026-07-12-사업자번호-우선-자동채움-실행가이드.md)
- [공고 매칭 1차 미션 복구 계획](./2026-07-13-first-mission-recovery-plan.md)
