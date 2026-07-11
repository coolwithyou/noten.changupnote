# 공고매칭 차원 확장 (14→22) 구현계획

> 🟢 상태: P0~P7 구현 완료 + Codex(gpt-5.5 xhigh) 심층 리뷰 발견 5건 패치 완료 (2026-07-11, 커밋 483a9ec~0390d57)
> 잔여: bizinfo LLM 재추출(≈$4.6, 사용자 보류) → match_state 1,484행 재계산 → after 재측정, 비활성 kstartup 전량 재정규화(백그라운드), 시각 검수(사용자 동반). 측정: `docs/research/2026-07-11-차원확장-백필-층화측정.md`
> 근거 연구: `docs/research/2026-07-11-공고매칭-14차원-확장-검토.md`
> 리뷰 결과와 결정 사항은 §6 참조. Critical 2건 반영으로 범위·완료 기준이 초안과 다름.

## 0. 목표와 범위

**목표**: 실제 공고의 최빈 필수 게이트인 결격(배제) 조건이 `other` text_only로 새서 영구 `unknown`이 되는 구조를 해소한다. 신규 차원 8개(판정 활성 6 + enum 예약 2)와 기존 차원 확장으로, DB 백업 기준 배제 조건 27종 중 **16종을 자동 판정 가능**하게 만든다 (신설축 12 + industry 배제업종 3 + 기존 business_status 1).

**비범위**:
- 결격 정보의 외부 API 소싱(체납 조회 등) — 자가신고 수집까지만. 소싱은 `docs/research/2026-07-10-company-data-matching-accuracy.md` 트랙.
- **prior_award 구조화(중복수혜·참여 중 과제·프로그램 수료 판정, 27종 표의 #8/#10/#13/#20)** — 리뷰 C2로 이번 범위에서 명시 제외, 후속 트랙(§6-C2). 이번 계획에서 해당 조건들은 other text_only 잔존을 유지하며, **분해기가 이를 prior_award로 구조화하는 것을 금지**한다(현행 문자열 exact-match evaluator로는 false pass를 양산하기 때문).

## 1. 설계 결정

| # | 결정 | 근거 |
|---|---|---|
| D1 | **enum은 8개를 한 번에 추가**: `tax_compliance`, `credit_status`, `sanction`, `financial_health`, `insured_workforce`, `investment` (판정 활성) + `premises`, `export_performance` (예약 — enum·타입 자리만) | PG enum은 값 제거 불가·마이그레이션 반복 비용 → 이름 확정 후 일괄 추가 |
| D2 | **DB enum 순서**: `other` 앞 삽입(`ADD VALUE ... BEFORE 'other'`)을 1안으로 하되, drizzle-kit이 이를 생성하지 못하면 **수동 편집이 기본 경로**(저장소 전례: 0004만 수동 BEFORE, 0026/0030은 말미 추가). enum 순서에 기능 의존은 없음이 확인됨 — 최악 시 말미 추가 + 3중 계약을 말미 순서로 통일하는 fallback 허용 | 리뷰 Minor-1 |
| D3 | **신규 축은 `CORE_GATE_DIMENSIONS`에 넣지 않는다** → unknown 시 `needs_profile_input` 티어(단, scoreDisplay는 이 티어도 hidden — 차이는 "원문 검수 필요"가 아니라 "문항 응답으로 해소 가능"이라는 점). 신규 reason code `disqualification_unconfirmed`로 결격 3축 unknown을 "결격 빠른 확인" CTA로 묶는다. **주의: `hasHighRiskSignal`이 raw_text에 반응하므로 P4의 span 정책(M1)과 세트로만 성립** | 결격 축은 문항으로 즉시 해소 가능. 리뷰 M1 반영 |
| D4 | **무응답 시 unknown 유지 (assumed-pass 금지)** + **플래그 단위 known**: dimension confidence만으로 pass를 확정하지 않고, criterion이 요구한 플래그가 전부 질의된(known_flags) 경우에만 pass/fail 확정 | 거짓확신 방지. 리뷰 C1 — 문항이 안 물은 플래그(예: 보증제한)를 pass로 확정하는 false pass 차단 |
| D5 | **결격 3축은 공고·프로필 모두 대칭 구조** `{ flags, exceptions }`(프로필은 + `known_flags`) + canonical 사전에 **예외→플래그 커버 매핑** 포함. 판정은 플래그 단위 차감(§2.4) | 리뷰 M5 — 예외가 교집합 일부만 면제하는 경우의 결함 제거 |
| D6 | **파서는 2단**: ① rule-based 결격 분해기(deterministic, kstartup·bizinfo 공용) ② LLM 프롬프트 갱신. 분해기가 소비한 문장은 other placeholder에서 제외(consumed-span). **신규 결격 criteria의 `source_span`은 해당 문장만, `raw_text`에 전체 원문 복제 금지**(M1 — HIGH_RISK_DOMAIN_PATTERN 오탐 방지). **예약 2축은 LLM tool schema enum에서 filter 제외**(M4) | 배제 조항 문구는 고도로 정형화 — LLM 없이 대부분 처리 가능 |
| D7 | **버전 범프 + 백필**: `RULESET_VERSION` → `ruleset-kstartup-spine-v3`, 양 normalizer version 범프, kstartup 전량 재정규화 + bizinfo LLM 재추출. 재추출은 **raw_hash 불변으로 skipUnchanged에 걸리므로 강제 재발행 플래그 필요**(Minor-6) | 재파싱 없이는 확장 효과 없음. 교체 시맨틱은 publisher의 grant별 delete-insert로 확인됨(`normalizedGrantPublisher.ts:92-97`) |
| D8 | **audience 상류 게이트**(기업/개인/혼합/미상)는 grants 레벨 분류로 별도 Phase(P6, 분리 가능) | 개인 대상 공고는 매칭 진입 자체를 차단 |

## 2. 계약 상세 설계

### 2.1 신규 값 인터페이스 (`packages/contracts/src/index.ts`)

`CriterionValue` union에도 반드시 추가한다(Minor-8).

```ts
/** 결격 축 공용 (tax_compliance / credit_status / sanction) — 공고 측 */
export interface DisqualificationCriterionValue {
  flags: string[];        // canonical 결격 플래그 (§2.3)
  labels?: string[];      // 원문 표기
  exceptions?: string[];  // 공고가 허용한 예외 canonical
}

export interface FinancialHealthCriterionValue {
  /** 부채비율 배제 임계. inclusive 여부를 값에 내장해 off-by-boundary 제거 (Minor-2) */
  debt_ratio_pct_threshold?: { value: number; inclusive: boolean } | null; // "1,000% 이상 제외" → {value:1000, inclusive:true}
  impairment_excluded?: ("partial" | "full")[];
  min_interest_coverage?: number | null;
  labels?: string[];
}

export interface InsuredWorkforceCriterionValue {
  employment_insurance_required?: boolean;
  min_insured?: number | null;
  max_insured?: number | null;
  no_layoff_within_months?: number | null;
  labels?: string[];
}

export interface InvestmentCriterionValue {
  min_total_krw?: number | null;
  rounds?: string[];
  tips_operator_required?: boolean;
  labels?: string[];
}
```

### 2.2 CompanyProfile 확장

결격 3축은 대칭 구조 + 플래그 단위 지식(C1/M5). tax의 유예 boolean도 exceptions canonical로 통일.

```ts
/** 결격 3축 공용 프로필 값 */
export interface DisqualificationProfileValue {
  flags: string[];        // 보유 결격 (canonical)
  known_flags: string[];  // 질의·확인이 이뤄진 플래그 — 문항→플래그 커버 매핑(§2.3)으로 기록
  exceptions: string[];   // 보유 예외 (canonical, 예: payment_deferral_approved)
}

tax_compliance?: DisqualificationProfileValue;
credit_status?: DisqualificationProfileValue;
sanction?: DisqualificationProfileValue;
financial_health?: {
  debt_ratio_pct?: number | null;
  impairment?: "none" | "partial" | "full" | null;  // 자본총계·자본금 입력 시 파생 계산 가능(P3)
  total_assets_krw?: number | null;   // size(중기법) 판정 정밀화에도 사용
  equity_krw?: number | null;
  capital_krw?: number | null;
  fiscal_year?: string;
};
insured_workforce?: {
  employment_insurance_active?: boolean;
  insured_count?: number | null;
  months_since_last_layoff?: number | null;  // null=미상. 감원 없음은 별도 boolean no_layoff 로 구분 (Minor-4)
  no_layoff?: boolean;
};
investment?: {
  total_raised_krw?: number | null;
  last_round?: string | null;
  tips_backed?: boolean;
};
// premises / export_performance: 예약 — 타입 placeholder 주석만
```

dimension 단위 known 게이트(`confidence?.[dimension]`)는 유지하되, 결격 3축은 그 위에 `known_flags` 게이트가 추가로 적용된다(§2.4).

### 2.3 canonical 사전 (신규 `packages/core/src/disqualification/canonical.ts`)

- `tax_compliance` flags: `national_tax_delinquent`, `local_tax_delinquent`, `customs_delinquent`, `social_insurance_delinquent`
- `credit_status` flags: `credit_delinquency`(연체), `loan_default`(채무불이행), `bond_default`(부도), `rehabilitation_in_progress`(회생·개인회생), `bankruptcy_filed`(파산), `court_receivership`(법정관리), `financial_misconduct`(금융질서문란), `asset_seizure`(압류), `guarantee_restricted`(보증금지·제한)
- `sanction` flags: `participation_restricted`, `subsidy_fraud`, `subsidy_law_violation`, `obligation_breach`, `wage_arrears_listed`, `serious_accident_listed`, `agreement_breach`
- **예외→플래그 커버 매핑** (M5): `payment_deferral_approved` → tax 4종 / `repayment_plan_in_good_standing` → `rehabilitation_in_progress`, `court_receivership` / `statute_expired` → `asset_seizure`
- **문항→플래그 커버 매핑** (C1): 온보딩 각 문항이 어떤 플래그를 known 처리하는지 정의. **계약 규칙: 사전에 플래그를 추가하면 반드시 문항 커버 매핑도 추가** — 매핑 완전성(모든 flag가 1개 이상 문항에 커버)을 단위테스트로 강제
- 공통 배제업종 canonical set(industry `not_in`용): 유흥주점업·무도유흥주점업·기타 주점업·사행시설 관리운영업·블록체인 암호화자산 매매중개업·부동산업·도박/사치/향락 계열 — KSIC 코드 매핑 포함

### 2.4 판정 시맨틱 (결격 공용 evaluator)

```
evaluateDisqualification(criterion, profile):
  profile 미존재 or confidence[dim] 없음            → unknown
  criterion.flags − profile.known_flags ≠ ∅         → unknown  ← 플래그 단위 known 게이트 (C1)
  hit = criterion.flags ∩ profile.flags
  waived = { f ∈ hit | ∃e ∈ (profile.exceptions ∩ criterion.exceptions):
                        e가 사전 매핑상 f를 커버 }     ← 플래그 단위 예외 차감 (M5)
  hit − waived ≠ ∅                                   → fail (메시지에 잔존 플래그·예외 근거 명시)
  else                                               → pass
```

- criterion은 대체로 `kind=exclusion, operator=in`.
- `financial_health`: 전용 evaluator. **기존 `evaluateNumericCriterion`은 exclusion 극성 반전이 없어 재사용 불가**(Minor-2) — 임계값 inclusive/exclusive와 exclusion 극성을 계약 수준으로 규정. **dimension known이어도 criterion이 참조하는 하위 필드가 null이면 unknown**(Minor-3, 예: 부채비율만 입력했는데 자본잠식 조건).
- `insured_workforce`/`investment`: boolean+numeric 복합, 동일한 부분-입력 unknown 규칙 적용.

## 3. Phase 계획

### P0 — 계약·canonical 사전 (선행, 다른 모든 Phase의 의존)

| 파일 | 작업 |
|---|---|
| `packages/contracts/src/index.ts` | `CRITERION_DIMENSIONS`에 8개 삽입(`business_status` 뒤, `other` 앞). §2.1 인터페이스 + `CriterionValue` union 등재, §2.2 CompanyProfile 필드, `MATCH_REVIEW_REASON_CODES`에 `disqualification_unconfirmed` |
| **`packages/contracts/src/openapi.ts`** | **dimension enum 하드코딩 4곳(933-951, 970-987 등) + reason code enum 1곳(925-931) 갱신** (M2). 가능하면 `[...CRITERION_DIMENSIONS]` 참조로 리팩터링해 복제 자체 제거 |
| `packages/contracts/schemas/grant-criteria.schema.json` | dimension enum 동일 순서 갱신 |
| `packages/core/src/disqualification/canonical.ts` (신규) | §2.3 사전 + 예외→플래그, 문항→플래그 커버 매핑 + 한국어 라벨 |
| 전수 grep | `Record<CriterionDimension`(컴파일 강제 지점: match.ts labelFor/prompts, build-action-queue:196, build-dashboard:173, grantArchiveSearch:196, grounding:201) + 문자열 하드코딩 `rg -n '"business_status"|"prior_award"|"target_type"|"founder_trait"' packages apps --type ts` (Minor-7) |
| 빌드 | `pnpm -F @cunote/contracts -F @cunote/core build` (core dist 미빌드 시 dev 미반영 — 메모리) |

**검증**: 워크스페이스 typecheck 통과. 계약 복제 지점(contracts 배열·JSON Schema·openapi.ts ×5·pgEnum) 순서/구성 diff 0. 문항→플래그 커버 완전성 테스트.

### P1 — DB 마이그레이션

1. `apps/web/src/lib/server/db/schema.ts:50-65` `criterionDimensionEnum`에 8개 추가(순서 동일)
2. `pnpm db:generate` → **생성 SQL 검수 필수 + 수동 편집 기본 예상**(D2): (a) `BEFORE 'other'` 미생성 시 수동 보정(전례 0004), (b) 기존 객체 재생성 섞이면 SQL에서 제거·스냅샷만 유지(0018~0024 교훈), (c) 마이그레이션 내 신규 enum 값 사용 문장 금지(PG 동일 트랜잭션 제약)
3. `pnpm db:migrate`

**검증**: `select enum_range(null::criterion_dimension)` 순서. 기존 행 무손상.

### P2 — 매칭 엔진 (`packages/core/src/matching/match.ts`)

- `evaluateCriterion` switch 6 케이스: 결격 3축 → 공용 `evaluateDisqualification`(§2.4), financial/insured/investment 전용 evaluator
- `labelFor`·`nextQuestion` prompts/priority에 8축 추가(예약 포함 — Record 강제). 결격 축 우선순위 상위
- `buildReviewGate`: 결격 3축 unknown → reason code `disqualification_unconfirmed`(티어는 needs_profile_input 유지)
- **`hasHighRiskSignal` 완화 검토**(M1): `kind === "exclusion"` criteria 또는 신규 결격 축을 검사 대상에서 제외하는 옵션 — P4 span 정책과 함께 골든으로 효과 확인 후 결정
- `RULESET_VERSION` → `ruleset-kstartup-spine-v3`. `CORE_GATE_DIMENSIONS` 불변

**검증**: evaluator 테스트 매트릭스 — 축별 × {pass, fail, unknown(미입력), **미질의 플래그 → unknown(C1)**, **부분 예외(교집합 2개 중 1개만 면제) → fail(M5)**, **하위 필드 부분입력 → unknown(Minor-3)**, 경계값 inclusive/exclusive(Minor-2)}. 기존 golden 회귀 100%.

### P3 — 프로필 파이프라인 + 온보딩 UI

| 파일 | 작업 |
|---|---|
| `packages/core/src/company/update-profile-field.ts` | 신규 6축 케이스(예약 2축은 명시 에러 유지). 문항 응답 → `{flags, known_flags, exceptions}` 변환은 문항→플래그 매핑 경유 |
| **`apps/web/src/lib/server/repositories/drizzle.ts`** | **`toCompanyProfile`(700-766) + `companyProfileRows`(782-848)에 신규 6축 직렬화/역직렬화** (M3 — 누락 시 silent drop, 다른 필드 저장 때 결격 답변 증발). `profileConfidence` fallback 0.8이 자가신고 0.6 의도를 덮지 않게 문항 API가 confidence 명시 전달 |
| profile field API (web/app 라우트) | 신규 축 입력 검증 |
| **`packages/core/src/use-cases/build-dashboard.ts`** | **`inputTypeForDimension`(95-113)에 신규 축 입력 타입(결격=checklist/boolean, 재무=number 그룹), `criterionOptionsForDimension`(135-148) 매핑** (M6 — 현재는 text 폴백이라 400/오염 저장) |
| `.../ProgressiveQuestionCard.tsx` | 신규 입력 타입 렌더 (M6) |
| **`.../CompanySettingsPanel.tsx`** | **결격 답변 수정 섹션** (M6 — 결격은 오답 비용이 가장 큰 축, 정정 수단 필수) |
| `packages/core/src/use-cases/match-card.ts` | `disqualification_unconfirmed` reason 전달 확인(33-56) → "1분 결격 확인" CTA |
| 온보딩 (`onboardingProgress.ts` + UI) | **결격 빠른 확인 스텝**: 사전 전체 플래그를 커버하는 그룹 체크리스트("해당사항 없음" 일괄 버튼) 형태로 저부담 유지(C1 — 개별 문항 3~4개로는 플래그 커버 불충분). ~~중복수혜 문항~~ **제외**(C2 — prior_award 트랙으로 이관). **financial_health는 자본잠식 여부만 예/아니오 저부담 문항으로 분리, 결산 수치는 선택 입력**(M7) |

UI 작업은 `.claude/skills/shadcn` 스킬 로드 후. 자가신고 confidence 0.6, 매칭 메시지에 "자가신고 기준" 노출.

**검증**: e2e — 문항 응답 → 저장 → 매칭 unknown 해소, 결격 "예" 응답 시 ineligible 전환, **다른 필드 저장 후 결격 답변 잔존**(M3), 설정 패널에서 정정 → 재판정.

### P4 — 파서·추출기

- `packages/core/src/disqualification/extract.ts` (신규): 문장 단위 regex 분해기. 백업 27종 문구 시드로 패턴 사전(체납/채무불이행/부도/회생·파산/압류/참여제한/부정수급/자본잠식/부채비율/보증제한/배제업종). **중복수혜·프로그램 수료류(#8/#10/#13/#20)는 구조화 금지 — text_only 유지**(C2). 출력: 구조화 criteria + consumed spans. **span 정책: `source_span`은 해당 문장만, `raw_text` 전체 원문 복제 금지**(M1)
- `packages/core/src/kstartup/normalize.ts:673-685` exclusion-text 블록: 분해기 선실행, 잔여 배제 문장만 other text_only(안전망). normalizer version 범프
- `packages/core/src/bizinfo/llm-criteria.ts`: 시스템 프롬프트 65행 지침 교체(신규 차원 + 값 형식 few-shot + **중복수혜류는 other 유지 지시**), **tool schema에서 예약 2축 filter 제외**(M4), max_tokens 여유 확인
- `apps/web/src/lib/server/ingestion/archiveBizInfoCore.ts:327-351` fallback에 분해기 적용
- `criteria-contract.ts`: 신규 값 스키마 검증 + (dimension, span) 중복 검출

**검증**: 백업 27종 대상 recall ≥ 16/27(범위 조정 후 기준), 오귀속 0 + **홀드아웃 검증: 백업 외 최신 수집 공고 N건으로 out-of-sample 측정**(Minor-5).

### P5 — 백필·재계산

- kstartup 전량 재정규화 → bizinfo LLM 재추출(공고 수 × haiku 단가 산정 후 실행 승인). **skipUnchanged 우회 강제 재발행 플래그 필요**(Minor-6, archiveBizInfoCore.ts:377-408)
- 교체는 publisher delete-insert로 보장 — 백필이 대상 grant를 빠짐없이 재발행하는지만 검증
- 매칭 재계산 + **tier 분포 층화 측정**(M7): "신규 criteria가 생긴 공고"를 (a) 기존 placeholder 있던 공고 vs (b) 기존에 criteria 없던(오늘 recommendable일 수 있는) 공고로 나눠 before/after 비교 — (b)의 하락 폭이 판단 대상

**검증**: needs_core_review 비율 감소. (b)군 recommendable 하락은 financial_health 저부담 문항(P3) 효과와 함께 평가 — 과도 시 완화 옵션(결격 unknown의 티어 영향 조정)을 데이터 보고 결정.

### P6 — audience 상류 게이트 (독립, 분리 실행 가능)

- grants `audience` 컬럼(enum: `company | individual | mixed | unknown`) 마이그레이션
- 분류기: 룰(재직자/심사역/임직원/포상/교육 키워드) + LLM 보조, unknown 현행 유지
- 매칭 파이프라인에서 `individual` 제외(또는 별도 섹션)

### P7 — 골든·통합 검증

- `packages/core/golden/matching/` kstartup-sample-v2: 백업 27종 기반 결격 시나리오 + 예외 조항 + 미질의 플래그 케이스
- 전체 회귀: typecheck·test·build, `verify:service-data`(미종료 현상 — 출력 완주 판정)
- 시각 검수: matches 결격 CTA·판정 메시지·설정 패널 (dev 서버는 사용자 기동)

**실행 순서**: P0 → P1 → (P2 ∥ P3 ∥ P4) → P5 → P7. P6 독립. **P0~P4 배포와 P5 사이 기간, 신규 ingestion은 P4 완료 전까지 구 프롬프트를 유지하므로 안전**(M4). 구현은 Phase별 Opus 서브에이전트 위임, 메인(Fable) 검수.

## 4. 리스크와 완화

| 리스크 | 완화 |
|---|---|
| PG enum 값 제거 불가 | D1 일괄 확정. 명명은 리뷰 반영 완료(§6 Minor-4) |
| **미질의 플래그 false pass** (C1) | known_flags 게이트 + 문항 커버 완전성 테스트 + P2 매트릭스 케이스 |
| **prior_award 문자열 매칭 false pass** (C2) | 이번 범위 제외 + 분해기 구조화 금지 + 후속 트랙 |
| 결격 criteria 대량 생성 → 미응답자 티어 하락 | D3 + 온보딩 표준 편입 + P5 층화 측정(M7) + financial 저부담 문항 분리 |
| raw_text의 도메인 단어 → needs_core_review 오강등 (M1) | P4 span 정책 + P2 hasHighRiskSignal 완화 검토 |
| 프로필 저장 silent drop (M3) | drizzle.ts 양방향 매핑 명시 + e2e 잔존 케이스 |
| 예약 축 LLM emit → 해소 불가 unknown (M4) | tool schema filter + 프롬프트 금지 명시 |
| 파서 이중 카운트 | consumed-span + criteria-contract (dimension, span) 중복 검출 |
| 자가신고 허위 가능성 | "자가신고 기준" 명시, confidence 0.6, 최종 책임 고지(제품 정책) |
| 저장된 매칭 스냅샷과 신 enum 혼재 | P5 재계산 범위에 포함, 매칭 결과 저장 경로 P5에서 확인 |

## 5. 완료 기준

1. 백업 27개 배제 조건 중 **16개 이상 자동 구조화**(신설축 12 + industry 3 + business_status 1) + 홀드아웃 out-of-sample 측정 보고. prior_award 4종은 후속 트랙 착수 조건으로 이관
2. 기존 golden 회귀 100% + 신규 evaluator 테스트 매트릭스(C1·M5·Minor-2·3 케이스 포함) 통과
3. 백필 후 needs_core_review 비율 감소 + **층화 기준**: 기존 criteria 없던 공고군의 recommendable 하락 폭 보고·평가(M7)
4. e2e: 결격 문항 응답 → eligible/ineligible 확정 전환 + 답변 잔존 + 설정 패널 정정
5. 계약 복제 지점 전체(contracts 배열·JSON Schema·openapi.ts ×5·pgEnum) 일치
6. 문항→플래그 커버 완전성 테스트 통과 (사전-문항 동기화 계약)

## 6. 리뷰 반영 기록 (2026-07-11, Fable 설계 리뷰)

리뷰 종합 판단: **조건부 승인** — Critical 2건 수정 없이 착수 불가. 아래와 같이 전건 반영.

| 발견 | 심각도 | 결정·반영 |
|---|---|---|
| C1 미질의 플래그 false pass (dimension 단위 known만으로 pass 확정) | Critical | `known_flags` 플래그 단위 게이트 신설(§2.2/2.4) + 온보딩을 사전 전체 커버 체크리스트로(P3) + 커버 완전성 테스트(완료 기준 6) |
| C2 prior_award 4종 — 작업 부재 + exact-match evaluator로 판정 불가 + "동일사업" 자기참조 표현 불가 | Critical | **범위 제외 결정**: 완료 기준 20→16/27 조정, 분해기의 prior_award 구조화 금지(P4), 중복수혜 온보딩 문항 이관. 후속 트랙(수혜 이력 구조화 + grant 자기참조 매칭) 별도 계획 |
| M1 hasHighRiskSignal이 결격 raw_text에 반응 → needs_core_review 오강등, D3 서술 오류 | Major | P4 span 정책(raw_text 전문 복제 금지) + P2 완화 검토 + D3 문구 정정(needs_profile_input도 hidden) |
| M2 openapi.ts 하드코딩 enum 4+1곳 누락 | Major | P0 등재 + spread 리팩터링 + 완료 기준 5 재정의 |
| M3 drizzle.ts 프로필 저장·로드 매핑 누락 → silent drop | Major | P3 등재 + e2e 잔존 케이스 + confidence fallback 주의 |
| M4 예약 2축 LLM tool schema 자동 노출 | Major | tool schema filter(P4/D6) + 배포 간극 안전성 명기(실행 순서) |
| M5 예외의 회사측 표현 부재 + 부분 예외 전체 pass 결함 | Major | 프로필 대칭 구조 + 플래그 단위 예외 차감(§2.4) + 예외→플래그 커버 매핑(§2.3) |
| M6 build-dashboard text 폴백·질문 카드·설정 패널 미등재 | Major | P3 파일 목록 등재(inputType/options, ProgressiveQuestionCard, CompanySettingsPanel, match-card) |
| M7 "기존 criteria 없던 공고"의 recommendable 하락 미측정 | Major | P5 층화 측정 + financial_health 저부담 문항 분리(P3) + 완료 기준 3 재서술 |
| Minor 1~8 (BEFORE 수동 편집 전제, 경계·극성 규약, 부분입력 unknown, 명명(`months_since_last_layoff`·`credit_delinquency`·회생/파산 분리), 홀드아웃, skipUnchanged, grep 확대, CriterionValue union) | Minor | 전건 해당 절에 반영(D2, §2.1~2.4, P4, D7, P0) |

리뷰가 확인한 유효 전제(변경 없음): 차원 신설 없이는 해소 불가(other∈CORE_GATE), D3 기본 흐름, 무응답 unknown, consumed-span, publisher delete-insert 교체, Record 강제/비강제 지점 구분.
