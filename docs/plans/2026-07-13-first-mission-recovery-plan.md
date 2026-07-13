# 공고 매칭 1차 미션 복구 계획

> 작성일: 2026-07-13  
> 상태: 핵심 구현·0045 적용·DB-backed demo E2E 완료 · 독립 reviewed/실사용자·브라우저 게이트 대기  
> 범위: 공고 조건 계약, 자동채움 프로필 저장 왕복, 정확도 회귀 검증  
> 비범위: 추가 공고 API, OCR/첨부 확장, 운영 match-state 대량 쓰기, 지원서 작성 기능

## 1. 목표

사업자등록번호와 최소 추가 답변으로 K-Startup·기업마당의 활성 공고 전체를 평가하되 다음을 보장한다.

1. 공고 조건 저장 형식과 평가 형식이 달라 생기는 오판정을 제거한다.
2. 자동채움 출처·기준일·축 완전성과 사용자의 `모름/범위` 상태가 DB 왕복 뒤에도 유지된다.
3. 구조화가 불충분한 조건은 자동 통과·탈락시키지 않고 `conditional`로 남긴다.
4. 사용자에게는 `지원 가능성이 높음 / 정보 확인 / 원문 확인 / 지원 어려움`의 네 상태만 제공한다.

AI는 원문 조건 추출·표준화·설명·순위화에 사용하고, 필수·제외 조건의 최종 판정은 결정론적 규칙 엔진이 수행한다.

## 2. 구현 전 기준선

- 활성 공고 1,898개: 기업마당 1,523개, K-Startup 375개
- 조건 6,368개, 구조화 hard criterion 4,595개
- evaluator 기대 형식과 다른 hard criterion 진단치 1,686개(36.69%)
- 명백한 자기일관성 실패 380건
- extraction readiness: partial 1,809 / structured-unreviewed 77 / unstructured 12 / reviewed 0
- 사업자번호 초기 즉시 판정률 39.09%, recommendable 0.61%
- `company_profiles` 503행·113개 회사의 DB source가 전부 `self_declared`
- 현재 DB에는 `profile_question_events` 마이그레이션이 적용되지 않음

이 수치는 운영 정확도 주장이 아니라 개선 전 회귀 기준선이다. 0045 적용 여부처럼 구현 후 바뀐 상태는 §8.4~8.5를 최신 진실 원천으로 본다.

## 3. 구현 불변식

### 3.1 공고 조건

- canonical value는 차원별 단일 키만 사용한다.
- legacy alias 변환은 의미가 보존되는 경우에만 한다.
- 숫자 임계의 방향, 시군구 조건, 자유서술 조건처럼 의미가 불명확하면 추측하지 않고 `unknown`으로 둔다.
- `kind=exclusion`과 `operator`의 극성은 evaluator마다 다르게 해석하지 않는다. 신규 추출은 operator가 제외 집합의 predicate를 표현하도록 고정한다.
- required/exclusion의 자동 pass/fail에는 구조화 값과 근거가 모두 있어야 한다.

### 3.2 회사 프로필

- 값과 evidence를 분리하되 같은 dimension DB row에서 함께 왕복시킨다.
- `sourceKind`, provider, `asOf`, `axisCompleteness`, confidence, supplemental을 보존한다.
- 질문 상태는 값이 없어도 저장할 수 있어야 하며, 이를 known confidence로 오인하지 않는다.
- 기존 DB row는 읽을 수 있어야 하고 신규 metadata가 없는 행을 파괴적으로 마이그레이션하지 않는다.

### 3.3 배포 안전

- ambiguous legacy criterion을 자동 보정해 `ineligible`을 늘리지 않는다.
- 이번 구현은 DB/R2/외부 provider write를 하지 않는다.
- 현재 dirty worktree의 관련 없는 파일을 수정하거나 정리하지 않는다.

## 4. 구현 단위

### A. criterion canonicalization

대상:

- `packages/core/src/criteria/canonicalize.ts`
- `packages/core/src/matching/match.ts`
- `packages/core/src/bizinfo/llm-criteria.ts`
- `packages/core/src/bizinfo/criteria-contract.ts`

작업:

1. region code를 문자열로 통일한다.
2. `labels/types/industries` 등의 legacy alias를 `sizes/targets/traits/tags`로 변환한다.
3. 업력의 year 값을 month로, 연령의 단일·min/max 값을 ranges로 변환한다.
4. 매출·직원 수의 의미 보존 가능한 threshold alias를 canonical min/max로 변환한다.
5. 지역 코드가 없고 `nationwide=true`도 아니면 전국 대상으로 자동 통과시키지 않는다.
6. canonicalizer를 신규 LLM 경계와 evaluator 경계에서 공유한다.
7. 차원·operator별 필수 canonical key를 계약 검증에 추가한다.

완료 조건:

- 제주 숫자/문자 코드가 동일하게 평가된다.
- size/target_type/founder_trait legacy alias가 평가 가능하다.
- 빈 region criterion이 전국 pass가 되지 않는다.
- 의미가 불분명한 값은 fail이 아니라 unknown이다.

### B. 자동채움 DB 왕복

대상:

- `apps/web/src/lib/server/repositories/drizzle.ts`
- repository codec 회귀 테스트

작업:

1. dimension value JSON에 evidence와 question state metadata를 함께 저장한다.
2. evidence provider에 맞는 legacy `source` 컬럼 값을 선택하되, 전체 provenance는 JSON metadata를 진실 원천으로 사용한다.
3. 값 없는 `unknown/range` 질문 상태용 metadata-only row를 지원한다.
4. metadata-only row가 confidence나 빈 목록을 생성하지 않도록 한다.
5. 기존 row는 source/asOf를 이용해 보수적인 legacy evidence로 읽는다.

완료 조건:

- `encode → DB row shape → decode` 후 profile evidence와 question state가 동일하다.
- Popbill/NTS/CODEF/self-declared 구분이 유지된다.
- 값 없는 unknown 상태가 매칭 known 근거가 되지 않는다.

### C. 검증

1. canonicalization 단위 테스트
2. 기존 match/LLM normalization 테스트
3. profile persistence codec 왕복 테스트
4. contracts/core/web typecheck
5. 활성 1,898개 read-only 재진단

성공 판단:

- 기존 명백한 자기일관성 실패 380건이 제거되거나 안전한 unknown으로 강등된다.
- false/unsafe ineligible 회귀가 없다.
- DB write 없이 결과가 재현된다.

## 5. 계획 자체 리뷰

### 반례 1: alias를 고치면 오히려 잘못 탈락시킬 수 있다

맞다. 따라서 문자열·단위 변환처럼 의미가 보존되는 alias만 자동 변환한다. source span을 자연어 규칙으로 재해석해야 하는 숫자 exclusion, 시군구·시설·수출 조건은 이번 구현에서 구조화하지 않는다.

### 반례 2: 19축으로 모든 공고를 표현할 수 없다

이번 구현은 축을 늘리지 않는다. 공통 19축을 안정화하고 나머지는 `other/text_only`로 보존한다. `locality`, `premises`, `export_performance` 활성화는 실제 표본과 프로필 공급원을 확보한 뒤 별도 결정한다.

### 반례 3: evidence를 JSON에 넣는 것은 임시방편이다

현재 `company_profiles`가 dimension별 JSON value를 이미 사용하고 있어 가장 작은 호환 변경이다. 별도 fact/evidence 테이블은 운영 규모와 query 요구가 확인된 뒤 설계한다. 이번 목표는 정보 손실을 즉시 막는 것이다.

### 반례 4: dirty main에서 검증 결과를 믿을 수 없다

관련 파일만 패치하고 파일별 diff와 targeted test를 기록한다. 전체 main의 완료를 주장하지 않는다. 구현 완료 후 이 범위만 별도 branch/commit으로 분리할 수 있어야 한다.

### 반례 5: reviewed 공고가 0개인데 목표 달성이라고 할 수 없다

없다. 이번 구현은 엔진 신뢰 기반 복구다. 제품의 `지원 가능성이 높음` 배포 게이트는 별도의 독립 reviewed 공고·pair 평가셋이 생길 때까지 닫아 둔다.

## 6. 중단 조건

다음 중 하나라도 발생하면 기능을 더 붙이지 않고 원인을 먼저 해결한다.

- canonicalization 후 ineligible이 근거 없이 증가
- profile DB 왕복 뒤 evidence/question state 손실
- partial/unstructured 공고가 recommendable로 승격
- 테스트를 통과시키기 위해 unknown을 pass로 변경해야 하는 상황
- 새 API·OCR·지원서 작성 코드가 필요해지는 상황

## 7. 구현 순서

1. canonicalizer와 반례 테스트
2. evaluator·LLM 경계 연결
3. profile persistence metadata codec과 왕복 테스트
4. 타입·회귀 테스트
5. 활성 공고 read-only 재진단 및 이 문서에 결과 기록

## 8. 구현 결과

> 2026-07-13 로컬 구현 완료. 운영 정확도 배포 게이트는 계속 닫혀 있다.

### 8.1 완료

- [x] 공고 criterion 공용 canonicalizer 추가
- [x] BizInfo·K-Startup LLM 게시 경계와 match evaluator 경계에 canonicalizer 연결
- [x] region 숫자/문자 코드 통일
- [x] size/target_type/founder_trait/industry legacy alias 통일
- [x] biz_age years→months, founder_age min/max→ranges 변환
- [x] revenue/employees threshold alias 변환
- [x] `exclusion + not_in` 이중 극성을 `exclusion + in`으로 정규화
- [x] 숫자 exclusion evaluator 극성 통일
- [x] 방향이 불명확한 legacy 숫자 exclusion은 unknown 유지
- [x] 지역 코드 없는 label-only 조건을 전국 pass가 아닌 unknown 처리
- [x] 신규 추출 결과에 차원별 canonical contract 검증 추가
- [x] 회사 프로필 evidence/question state를 dimension value JSON에 함께 저장·복원
- [x] metadata-only 질문 상태 row가 confidence·값을 만들지 않도록 처리
- [x] legacy Popbill/NTS/CODEF/OCR/self-declared row의 보수적 evidence 복원
- [x] 전용 회귀 명령 `pnpm verify:first-mission-recovery` 추가

### 8.2 활성 공고 read-only 재진단

- 공고 1,898개 / criterion 6,368개 / hard structured criterion 4,595개
- 새 strict canonical contract를 통과하지 못한 hard criterion: 86개(1.87%)
- region/size/target_type/founder_trait 자기일관성 검사: 2,859건
- 자기일관성 실패: 0건
- 기존 진단에서 확인된 명백한 실패 380건은 canonical pass 또는 안전한 unknown으로 해소
- 합성 56,940 pair의 false/unsafe ineligible: 0건 유지

남은 86개는 대부분 임계값이 없는 biz_age·employees·revenue, 코드 없는 region, 구조가 불충분한 소수 list criterion이다. 자동 추론하지 않고 unknown/review 대상으로 남긴다.

### 8.3 통과한 검증

- `pnpm verify:first-mission-recovery`
- `pnpm test:matching-unit`
- contracts/core/web typecheck
- `pnpm verify:company-enrichment`
- `pnpm verify:runtime-repositories`
- `pnpm verify:teaser-first-mission-route:database`
- `pnpm verify:openapi`
- `pnpm verify:rls-policy`
- `pnpm verify:db-migrations`

DB route 검증은 활성 1,898개 전체 평가, 반환 8개 제한 분리, web/app universe 일치, 다음 질문 `biz_age`를 확인했다.

### 8.4 남은 운영 게이트

- [ ] 독립 사람이 검수한 공고 100건·회사 30건·pair 500건 확보(`reviewed=0` 해소). 엔진 예측 초안은 정답으로 승격하지 않는다.
- [x] 운영 공용 DB에 `0045_mushy_daimon_hellstrom` 적용 및 테이블·RLS 재검증
- [ ] 실제 NextAuth 사용자 회사에서 profile 저장→재조회→매칭 갱신 브라우저 E2E
  - DB-backed app token demo 회사 경로는 통과했다. 이는 영속화·전체 평가·scoped refresh 증거이지 실사용자 로그인 UX 증거는 아니다.
- [ ] 자동채움 브라우저 시각·connector E2E
  - 페이지 소유 앱은 web이므로 기준 URL은 `https://dev.changupnote.com/dev/service-data`다. 사용자가 제공한 `dev-ops` 호스트는 admin 4011로 향하며 해당 페이지가 없다.
- [ ] 이번 범위를 독립 commit으로 격리
  - 작업 branch `codex/first-mission-gates-20260713` 생성은 완료했다. 기존 변경이 mixed file에 함께 있어 전체 파일 단위 staging은 금지한다.

이 게이트 전에는 `eligible`을 “지원 가능 확정”으로 표현하지 않는다.

### 8.5 2026-07-13 운영 게이트 실행 증거

- 운영 DB migration journal 45→46, `profile_question_events` 존재, RLS/FORCE RLS 활성, 누락 테이블·RLS 0
- 고정 demo 사용자·회사에 앱 access token으로 접근 권한을 확인하고 `employees=12` 저장
- 저장 직후 profile 재조회에서 값 `12`, evidence provider `cunote_profile_question` 보존
- 동일 요청에서 활성 공고 1,802건 평가, 질문 대상 conditional 19건 중 14건 확정(eligible 4 / ineligible 10), 5건 conditional 유지
- `profile_question_events` 저장 성공, conditional resolution rate `0.7368`
- demo 회사의 match state 78건이 같은 실행 구간에 갱신됐고, fresh matches 조회 total 1,802건 확인
- legacy 9쌍 중 1쌍은 `ineligible→conditional`로 보수 강등됐다. verifier는 이 단일 safe drift만 허용하며 false/unsafe ineligible과 false eligible은 계속 0으로 고정한다.

위 demo 수치는 파이프라인 E2E 증거이며 운영 정확도 지표가 아니다. 운영 정확도 게이트는 독립 reviewed development 350쌍과 blind holdout 150쌍으로만 계산한다.
