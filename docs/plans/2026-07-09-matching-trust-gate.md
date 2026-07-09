# 매칭 신뢰 게이트 상세 구현 설계

작성일: 2026-07-09

## 1. 문제 정의

현재 `/matches?biz=...` 결과에서 실제 업종·자격이 맞지 않는 공고가 `지원 가능한 사업` 목록에 높은 적합도처럼 노출된다.

대표 사례:

- 기업: `(주)바톤`
- 기업 정보: 디자인·소프트웨어 제작 회사, 원전·로봇 관련 업종/업태 없음
- 노출 공고: 원전 생태계 고도화, 로봇 실증사업 등
- 화면 증상: `조건 1 · 충족 1`, `적합도 72%`, 상세 조건에는 원전 분야 매출/인증/기술 실적 확인 필요가 있음

핵심 원인은 세 가지다.

1. 공고의 실제 핵심 자격 조건이 `grant_criteria`로 구조화되지 않고 `text_only` 또는 누락 상태로 남는다.
2. `conditional` 상태도 숫자 적합도와 함께 상단 추천처럼 노출된다.
3. `industry`, `certification`, `other/exclusion` 같은 하드 게이트 축의 미확인이 일반 unknown과 동일하게 처리된다.

## 2. 목표

이번 개선의 목표는 "더 많은 공고를 맞추는 것"이 아니라 "틀린 공고를 맞는 것처럼 보이지 않게 하는 것"이다.

### 사용자 경험 목표

- `지원 가능한 사업`에는 필수 조건이 실제로 충족된 `eligible` 공고만 노출한다.
- 원문 확인이 필요한 공고는 `확인이 필요한 사업`으로 분리한다.
- 핵심 업종·인증·특수자격 미확인 공고에는 숫자 적합도를 표시하지 않는다.
- "조건 1 · 충족 1"처럼 구조화 coverage가 낮은 공고가 높은 추천처럼 보이지 않게 한다.
- 공고 상세/조건 펼침에서는 왜 확인이 필요한지 `source_span` 중심으로 설명한다.

### 시스템 목표

- 기존 14개 `grant_criteria` 축은 유지한다.
- DB 마이그레이션 없이 1차 구현한다.
- `MatchResult`와 `MatchCard` 계약에 신뢰 게이트 메타를 추가한다.
- 매칭 계산, 정렬, 티저/대시보드 UI, 검증 스크립트가 같은 기준을 쓰게 한다.
- 이후 원전·로봇·반도체 등 특수산업 정규화 룰을 추가해도 같은 게이트 위에서 동작하게 한다.

## 3. 비목표

- LLM 기반 공고 재추출 전체 도입은 이번 범위가 아니다.
- 산업 taxonomy 전체 재설계는 이번 범위가 아니다.
- `eligibility` enum에 새 값 추가는 1차 범위가 아니다. `eligible | conditional | ineligible`은 유지한다.
- 기존 `match_state` 테이블 컬럼 추가는 1차 범위가 아니다.

## 4. 현재 코드 기준 진단

### 매칭 엔진

파일: `packages/core/src/matching/match.ts`

- `criteria.length === 0`이면 이미 `conditional`, `fit_score: 0`, `criteria_extracted: false`로 강등한다.
- 하지만 조건이 1건 이상이면 `criteria_extracted: true`가 된다.
- `text_only` criterion은 `unknown` trace로 평가된다.
- `scoreFit()`은 `conditional`에도 `60 + passRatio * 35` 점수를 준다.
- 따라서 필수 조건 1건 통과 + 핵심 조건 미확인 조합이 숫자 점수로 보일 수 있다.

### 카드 변환·정렬

파일: `packages/core/src/use-cases/match-card.ts`

- `bucketForMatch()`는 `conditional`을 `conditional` bucket으로 분리한다.
- `sortMatchedGrants()`는 `eligible` 다음에 `conditional`을 정렬한다.
- `criteria_extracted === false`만 하단으로 내린다.
- `text_only` 핵심 조건이 있어도 구조화된 조건이 하나라도 있으면 하단 강등되지 않는다.

### 티저

파일: `packages/core/src/use-cases/build-teaser.ts`

- 전체 매칭 결과를 정렬한 뒤 상위 `limit`건을 그대로 `matches`로 반환한다.
- `conditionalUpside`는 `conditional` 공고 금액 합산이다.
- 티저 UI는 받은 `matches`를 `지원 가능한 사업` 아래 렌더링한다.

### UI

파일: `apps/web/src/features/matches/MatchesExperience.tsx`

- 섹션 제목이 `지원 가능한 사업` 하나다.
- 카드에 `eligible`, `conditional`, `ineligible` badge를 함께 보여주지만 목록 의미는 모두 지원 가능처럼 읽힌다.
- `criteria = match.ruleTrace.filter((chip) => chip.result !== "text_only")`라서 원문 확인 조건은 조건 개수에서도 빠진다.
- `criteriaExtracted === false`일 때만 점수를 `—`로 숨긴다.

## 5. 핵심 설계: Match Trust Gate

`eligibility`는 법적/논리적 판정 상태로 유지하고, 별도 메타로 "추천해도 되는지"를 판단한다.

### 5-1. 새 개념

```ts
type MatchRecommendationTier =
  | "recommendable"      // 지원 가능 목록에 노출 가능
  | "needs_core_review"  // 핵심 조건 확인 필요
  | "needs_profile_input" // 사용자 정보 입력 필요
  | "not_recommended";   // 미해당 또는 추천 제외

interface MatchReviewGate {
  tier: MatchRecommendationTier;
  scoreDisplay: "numeric" | "hidden";
  reasons: Array<{
    code:
      | "core_dimension_unknown"
      | "criteria_under_extracted"
      | "profile_missing"
      | "hard_fail"
      | "unstructured_criteria";
    dimension: CriterionDimension;
    label: string;
    sourceSpan?: string;
  }>;
}
```

1차 구현에서는 DB 저장 없이 `MatchResult`와 `MatchCard`에 선택 필드로 추가한다.

```ts
interface MatchResult {
  ...
  review_gate?: MatchReviewGate;
}

interface MatchCard {
  ...
  recommendationTier?: MatchRecommendationTier;
  scoreDisplay?: "numeric" | "hidden";
  reviewReasons?: MatchReviewGate["reasons"];
}
```

OpenAPI/DTO는 선택 필드로 추가해 하위 호환을 유지한다.

### 5-2. 핵심 게이트 축

아래 축은 미확인 상태이면 추천 목록에 올리지 않는다.

```ts
const CORE_GATE_DIMENSIONS: CriterionDimension[] = [
  "industry",
  "certification",
  "business_status",
  "target_type",
  "other",
];
```

해석:

- `industry`: 원전, 로봇, 제조, 바이오, 지역 특화 산업 등
- `certification`: KEPIC, ASME, 여성기업, 벤처기업, 기업부설연구소 등
- `business_status`: 휴폐업/정상 사업자 조건
- `target_type`: 신청 주체 자체가 맞는지
- `other`: 제외대상, 특수 실적, 수행 이력, 분야 매출 등 현재 구조화되지 않은 핵심 조건

`founder_age`, `revenue`, `employees`는 기본적으로 `needs_profile_input`로 분류한다. 단, source span에 "원전 분야 매출", "최근 5년 해당 분야 실적" 같은 특수산업 문구가 있으면 `core_dimension_unknown`으로 승격한다.

### 5-3. 점수 표시 정책

| 상태 | 조건 | 점수 표시 | 목록 위치 |
|---|---|---|---|
| `recommendable` | `eligible`이고 핵심 게이트 unknown/text_only 없음 | 숫자 | 지원 가능한 사업 |
| `needs_core_review` | 핵심 축 unknown/text_only 존재 | 숨김 | 확인이 필요한 사업 |
| `needs_profile_input` | 기업 프로필 입력으로 확정 가능한 unknown 존재 | 숨김 또는 낮은 강조 | 확인이 필요한 사업 |
| `not_recommended` | 하드 fail 또는 ineligible | 숨김 | 미해당/준비 가능 |

`fit_score` 자체는 내부 계산값으로 남기되, UI는 `scoreDisplay`를 따른다.

## 6. 매칭 엔진 변경 설계

### 6-1. 파일

- `packages/core/src/matching/match.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/dto.ts`
- `packages/contracts/src/openapi.ts`

### 6-2. 알고리즘

`matchGrantCriteria()` 마지막 단계에서 `review_gate`를 계산한다.

```ts
const reviewGate = buildReviewGate({
  eligibility,
  traceEntries: ruleTrace,
  criteria,
  criteriaExtracted: true,
});
```

게이트 판정 순서:

1. `criteria.length === 0`
   - tier: `needs_core_review`
   - scoreDisplay: `hidden`
   - reason: `unstructured_criteria`
2. 하드 fail 존재
   - tier: `not_recommended`
   - scoreDisplay: `hidden`
   - reason: `hard_fail`
3. `text_only` 또는 `unknown`이 핵심 축에 존재
   - tier: `needs_core_review`
   - scoreDisplay: `hidden`
   - reason: `core_dimension_unknown`
4. required 조건 수가 너무 적고 공고 제목/원문에 특수산업 신호가 있음
   - tier: `needs_core_review`
   - scoreDisplay: `hidden`
   - reason: `criteria_under_extracted`
5. 일반 profile missing unknown만 존재
   - tier: `needs_profile_input`
   - scoreDisplay: `hidden`
6. 나머지 eligible
   - tier: `recommendable`
   - scoreDisplay: `numeric`

### 6-3. 특수산업/고위험 source span 힌트

1차는 보수적인 키워드 사전으로 충분하다.

```ts
const HIGH_RISK_DOMAIN_PATTERN =
  /원전|원자력|핵심부품|로봇|실증|반도체|바이오|의료기기|방산|우주|항공|해양|수소|이차전지|배터리|소부장|KEPIC|ASME|인증|확인서|최근\s*\d+\s*년|매출|실적|납품|수행/;
```

사용 위치:

- `source_span`
- `source_span`이 없을 때의 trace message
- 필요 시 criterion value note

이 키워드는 추천 승격용이 아니라 강등용이다. 따라서 오탐의 피해는 "확인 필요로 내려감"이고, 잘못된 지원 가능 노출보다 안전하다.

### 6-4. scoreFit 조정

1차 선택지는 두 가지다.

권장안:

- `fit_score` 계산은 유지한다.
- 다만 `review_gate.scoreDisplay === "hidden"`이면 UI와 카드 정렬에서 숫자를 사용하지 않는다.
- 기존 `match_state.fit_score`와 과거 비교가 깨지지 않는다.

대안:

- `needs_core_review`는 `fit_score`를 0 또는 40 이하로 clamp한다.
- 장점: 저장된 점수도 직관적이다.
- 단점: 과거 데이터와 점수 의미가 바뀌고, `conditionalUpside` 등 후속 계산 영향이 커진다.

1차 구현은 권장안으로 간다.

## 7. 카드 변환·정렬 변경 설계

### 7-1. 파일

- `packages/core/src/use-cases/match-card.ts`
- `packages/core/src/use-cases/select-match-cards.ts`
- `packages/core/src/use-cases/build-teaser.ts`
- `packages/core/src/use-cases/build-dashboard.ts`
- `packages/core/src/matching/live-company-match.ts`

### 7-2. toMatchCard

`MatchResult.review_gate`를 `MatchCard`로 전달한다.

```ts
recommendationTier: entry.match.review_gate?.tier ?? fallbackTier(entry.match),
scoreDisplay: entry.match.review_gate?.scoreDisplay ?? "numeric",
reviewReasons: entry.match.review_gate?.reasons ?? [],
```

### 7-3. 정렬

`compareMatch()` 정렬 우선순위를 바꾼다.

```ts
const tierRank = {
  recommendable: 0,
  needs_profile_input: 1,
  needs_core_review: 2,
  not_recommended: 3,
};
```

기존 `eligibility` rank보다 `recommendationTier`를 먼저 본다.

효과:

- `eligible + recommendable`만 최상단
- `conditional + needs_core_review`는 하단 확인필요
- `ineligible + soon`은 roadmap에서는 유지하되 추천 목록에서는 밀림

### 7-4. buildTeaser

티저 응답의 `matches`는 당장 UI 호환을 위해 유지하되, 선택 기준을 바꾼다.

권장 1차:

```ts
const cards = sorted.map(toMatchCard);
const recommendable = cards.filter((card) => card.recommendationTier === "recommendable");
const reviewNeeded = cards.filter((card) => card.recommendationTier !== "recommendable");

matches: [...recommendable, ...reviewNeeded].slice(0, limit)
```

UI에서 섹션 분리를 하기 위해 `TeaserResult`에 선택 필드를 추가한다.

```ts
interface TeaserResult {
  ...
  recommendableMatches?: MatchCard[];
  reviewNeededMatches?: MatchCard[];
}
```

하위 호환을 위해 기존 `matches`는 `recommendable + reviewNeeded` 조합으로 유지한다.

### 7-5. selectMatchCards

API 필터에 `review`를 추가할지 결정해야 한다.

1차 최소안:

- 기존 `status=conditional`은 유지
- UI 내부에서 `recommendationTier`로 필터링

2차 확장안:

- `MATCH_STATUS_FILTERS`에 `recommendable`, `review_needed` 추가
- OpenAPI와 query parser 동시 갱신

1차 구현은 최소안으로 가고, 대시보드/Opportunity Map 개선 시 2차 확장한다.

## 8. UI 변경 설계

### 8-1. `/matches` 티저

파일: `apps/web/src/features/matches/MatchesExperience.tsx`

현재:

- `ProgramsSection` 하나
- 제목: `지원 가능한 사업`
- 조건부/미해당 badge를 같은 섹션에 표시

변경:

- `EligibleProgramsSection`
- `ReviewNeededProgramsSection`
- `NotRecommendedDisclosure` 또는 숨김

구조:

```tsx
const recommendable = teaser.recommendableMatches ?? teaser.matches.filter(isRecommendable);
const reviewNeeded = teaser.reviewNeededMatches ?? teaser.matches.filter(isReviewNeeded);

<ProgramsSection title="지원 가능한 사업" matches={recommendable} />
<ProgramsSection title="확인이 필요한 사업" matches={reviewNeeded} tone="review" />
```

문구:

- 지원 가능한 사업 empty: `현재 정보로 바로 지원 가능하다고 확인된 사업은 아직 없어요.`
- 확인이 필요한 사업 설명: `업종, 인증, 수행실적처럼 원문 확인이 필요한 조건이 있어요.`
- 카드 CTA: `조건 확인하고 준비하기`

점수:

- `match.scoreDisplay === "hidden"`이면 `적합도` 대신 `확인 필요`
- progress bar 숨김
- `reviewReasons[0].label`을 점수 영역 아래 작은 문구로 표시

조건 개수:

현재 `text_only`를 제외한다. 변경 후에는 제외하지 않는다.

```ts
const visibleCriteria = match.ruleTrace;
const passCount = visibleCriteria.filter((chip) => chip.result === "pass").length;
const reviewCount = visibleCriteria.filter((chip) =>
  chip.result === "unknown" || chip.result === "text_only"
).length;
```

표기:

- `조건 3 · 충족 1 · 확인 2`
- `text_only` 행은 `원문 확인` 배지로 표시

### 8-2. Opportunity Map

파일: `apps/web/src/features/opportunity-map/OpportunityMap.tsx`

1차:

- `now` bucket 설명을 `필수 조건과 핵심 자격이 충족된 공고`로 변경
- `conditional` bucket에 `recommendationTier !== recommendable` 공고가 모이도록 카드 표시 문구 보정

2차:

- `bucketForMatch()`에서 `needs_core_review`는 항상 `conditional`로 둔다.
- `needs_profile_input`은 `conditional`, time unlock은 `soon`.

### 8-3. Home/Landing teaser

파일: `apps/web/src/features/home/HomeExperience.tsx`

1차:

- 상단 carousel에는 `recommendationTier === "recommendable"` 우선 노출
- 없으면 `확인 필요` 카드로 표현하고 숫자 점수 숨김

## 9. 정규화 보강 설계

### 9-1. 파일

- `packages/core/src/kstartup/normalize.ts`
- `packages/core/src/industry/ksic.ts`
- `packages/core/src/industry/ksic.test.ts`
- `packages/core/src/certification/certs.ts`
- `packages/core/src/certification/certs.test.ts`

### 9-2. 특수산업 룰 추가

현재 `INDUSTRY_RULES`는 KSIC 업종 중심이다.

추가할 별도 사전:

```ts
const SPECIAL_DOMAIN_RULES = [
  { pattern: /원전|원자력|SMR|핵심부품|KEPIC|ASME/, label: "원전·원자력", dimension: "industry" },
  { pattern: /로봇|서비스로봇|실증로봇/, label: "로봇", dimension: "industry" },
  { pattern: /반도체|팹리스|소부장/, label: "반도체·소부장", dimension: "industry" },
  { pattern: /바이오|의료기기|헬스케어/, label: "바이오·의료", dimension: "industry" },
];
```

다만 이 룰은 바로 `operator: "in"`으로 구조화하지 않는다.

1차 동작:

- 특수산업 키워드가 있으면 `industry-text` 또는 `other` required `text_only`를 확실히 생성한다.
- `review_gate`가 이를 보고 `needs_core_review`로 강등한다.

2차 동작:

- 충분히 검수한 뒤 특수산업 taxonomy와 회사 프로필의 세부 분야 입력을 붙여 `operator: "in"`으로 승격한다.

### 9-3. 원전/인증 문구

다음 문구는 certification 또는 other core gate로 남긴다.

- `KEPIC`
- `ASME`
- `원자력 인증`
- `국내외 원자력 인증보유`
- `최근 5년 이내 원전 분야 매출`
- `기술개발 참여실적`
- `심사를 통해 적격여부 판단`

정규화 원칙:

- 인증명이 명확하면 `certification text_only` 또는 `certification in` 후보
- 실적/매출/참여 이력은 `other text_only required`
- 애매하면 무조건 `text_only`, 추천 승격 금지

## 10. 테스트 설계

### 10-1. 매칭 단위 테스트

파일: `packages/core/src/matching/match.test.ts`

추가 케이스:

1. `industry text_only required`가 있으면 `review_gate.tier === "needs_core_review"`
2. `certification text_only required`가 있으면 점수 표시 hidden
3. `region pass + industry text_only` 조합은 `conditional`, `scoreDisplay hidden`
4. `region pass + biz_age pass` 조합은 `recommendable`, numeric
5. `industry fail required`는 `not_recommended`

### 10-2. 카드/티저 테스트

파일: `packages/core/scripts/verify-service-usecases.ts`

추가 검증:

- `buildTeaser()`가 `recommendableMatches`와 `reviewNeededMatches`를 분리한다.
- 기존 `matches`는 recommendable 우선 정렬을 유지한다.
- `selectMatchCards(sort="fit")`가 hidden score 공고를 숫자 점수만으로 상단에 올리지 않는다.

### 10-3. 상태 갱신 테스트

파일: `packages/core/scripts/verify-match-state-refresh.ts`

추가 검증:

- `match.match.review_gate`가 plan output에 존재한다.
- DB 저장은 기존 컬럼만 사용하되 `rule_trace`에는 source span이 유지된다.

### 10-4. 정규화 테스트

파일:

- `packages/core/src/industry/ksic.test.ts`
- `packages/core/src/certification/certs.test.ts`

추가 fixture 문구:

- `최근 5년 이내 원전 분야 매출 또는 기술개발 참여실적 보유`
- `국내외 원자력 인증보유(KEPIC, ASME 등)`
- `원자력 분야 기술 이용 또는 희망 기업`
- `로봇 실증사업 지원 과제`

기대:

- 명확한 필수 실적/인증은 `text_only required` 이상으로 잡힌다.
- 우대/희망/관심 문맥은 하드 fail 구조화하지 않는다.
- 어떤 경우에도 곧바로 `recommendable`로 올라가지 않는다.

## 11. 구현 순서

### Step 1. 계약 추가

- `packages/contracts/src/index.ts`
  - `MATCH_RECOMMENDATION_TIERS`
  - `MatchRecommendationTier`
  - `MatchReviewGate`
  - `MatchResult.review_gate?`
- `packages/contracts/src/dto.ts`
  - `MatchCard.recommendationTier?`
  - `MatchCard.scoreDisplay?`
  - `MatchCard.reviewReasons?`
  - `TeaserResult.recommendableMatches?`
  - `TeaserResult.reviewNeededMatches?`
- `packages/contracts/src/openapi.ts`
  - 선택 필드 문서화

### Step 2. 매칭 엔진 게이트

- `packages/core/src/matching/match.ts`
  - `SCORING_VERSION` 또는 `RULESET_VERSION` 업데이트
  - `buildReviewGate()` 추가
  - `CORE_GATE_DIMENSIONS`, `HIGH_RISK_DOMAIN_PATTERN` 추가
  - `criteria.length === 0` 결과에도 `review_gate` 추가
  - 테스트 추가

버전 제안:

- `RULESET_VERSION = "ruleset-kstartup-spine-v2"`
- `SCORING_VERSION = "scoring-fit-v2-trust-gate"`

### Step 3. 카드 변환과 정렬

- `packages/core/src/use-cases/match-card.ts`
  - `toMatchCard()`에 게이트 메타 전달
  - `compareMatch()`에 tier rank 반영
  - `estimateMatchConfidence()`는 유지하되 text_only도 unknown처럼 낮게 반영할지 검토
- `packages/core/src/use-cases/build-teaser.ts`
  - recommendable/reviewNeeded 분리
- `packages/core/src/use-cases/select-match-cards.ts`
  - hidden score 공고 fit sort 하향 처리

### Step 4. `/matches` UI 분리

- `apps/web/src/features/matches/MatchesExperience.tsx`
  - `ProgramsSection`을 title/tone props 기반으로 일반화
  - `지원 가능한 사업`에는 recommendable만 렌더
  - `확인이 필요한 사업` 섹션 추가
  - score hidden 표시
  - `text_only` 조건도 조건 수와 상세 행에 포함

### Step 5. 특수산업 placeholder 보강

- `packages/core/src/kstartup/normalize.ts`
  - special domain text gate 추가
  - 원전/로봇/인증/실적 문구는 최소 `text_only required`가 되게 보장
- 테스트 추가

### Step 6. 저장 상태 재계산

- 로직 반영 후 기존 명령으로 match_state 재계산

```bash
pnpm match:states:refresh -- --write
```

실행 전후 확인:

- `(주)바톤` 원전/로봇 공고가 `지원 가능한 사업`에서 빠지는지
- 해당 공고가 `확인이 필요한 사업`에 있고 점수가 숨겨지는지
- `조건 1 · 충족 1` 대신 `조건 N · 충족 1 · 확인 M`으로 보이는지

## 12. 검증 명령

1차 구현 후 최소 검증:

```bash
pnpm exec tsx packages/core/src/matching/match.test.ts
pnpm exec tsx packages/core/src/industry/ksic.test.ts
pnpm exec tsx packages/core/src/certification/certs.test.ts
pnpm exec tsx packages/core/scripts/verify-service-usecases.ts
pnpm exec tsx packages/core/scripts/verify-match-state-refresh.ts
pnpm --filter @cunote/web typecheck
git diff --check
```

브라우저 검증은 기존 개발 서버가 있을 때만 수행한다. 이 repo 규칙상 Codex는 명시 요청 없이 `pnpm dev:web`을 시작하지 않는다.

## 13. 수용 기준

### 기능 기준

- `(주)바톤` 같은 디자인·SW 기업에 원전/로봇 특수 공고가 `지원 가능한 사업`으로 노출되지 않는다.
- 핵심 조건 미확인 공고는 `확인이 필요한 사업`으로 분리된다.
- 핵심 조건 미확인 공고에는 `72%` 같은 숫자 적합도가 보이지 않는다.
- 조건 요약에 `text_only` 원문 확인 조건이 포함된다.
- 기존 eligible 공고는 여전히 숫자 적합도와 함께 상단 노출된다.

### 회귀 방지 기준

- 조건 0건 공고는 계속 `criteriaExtracted: false`, 점수 `—` 유지.
- 업력 unlock 공고의 `soon` bucket 동작은 유지.
- `preferred` fail은 하드 탈락을 만들지 않는다.
- `buildApplySheet()`의 원문 확인 조건은 계속 문서 준비 checklist에 들어간다.

## 14. 다음 단계

이 설계가 승인되면 구현은 두 커밋으로 나누는 것을 권장한다.

1. 매칭 신뢰 게이트 + 카드/티저/UI 분리
2. 원전/로봇/인증 특수산업 placeholder 보강 + 테스트 fixture

이렇게 나누면 UI 정책 변경과 정규화 룰 변경을 별도로 검증할 수 있다.
