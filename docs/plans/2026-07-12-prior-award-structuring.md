# prior_award 구조화 (C2 후속) 구현계획

> 🟡 상태: 구현 진행 중(2026-07-12). P0~P4, 기본-off K-Startup splitter 배선, P5 자동 품질 게이트, P6 read-only dry-run·레거시 검수 배선, P7 golden은 완료했다. 운영 L1 flag는 독립 사람 검수 0/10으로 계속 off이며, 실제 HTTP·브라우저 e2e, 검수 승인, DB 백필·match_state 재계산은 남아 있다. 현재 프로필 113개의 구조화 prior_award 커버리지는 0개이므로, 파서만 활성화해서는 실제 추천 등급이 바뀌지 않는다.
> 출발점: `docs/plans/HANDOFF-2026-07-12-p6-prior-award-design.md` 트랙 2. 상위 설계: `docs/plans/2026-07-11-matching-dimension-expansion.md` §6-C2(범위 제외 근거).
> 근거 연구: `docs/research/2026-07-11-공고매칭-14차원-확장-검토.md`(27종 표 #8/#10/#13/#20), `docs/research/2026-07-11-차원확장-백필-층화측정.md`.
> 실측: 운영 Supabase(`changupnote`) 2026-07-12 읽기 전용 조회. 결과는 §7에 인용.

> 구현 메모 (2026-07-12): `PriorAwardCriterionValue`와 `PriorAwardProfileValue`, canonical 9개 사업 사전과 질문 커버 완전성 검증, self/program/program_type·상태·기간·known-program 게이트 evaluator를 추가했다. legacy 문자열은 canonical 비교하되 partial 목록의 no-hit는 unknown으로 유지한다. prior_award 계약 변경으로 v4를 거쳐, 현재 `RULESET_VERSION`은 검수 전 hard fail을 unknown으로 보존하는 v5다. 구조화 프로필은 self flag·records·known program/type을 merge 저장하고 Drizzle 양방향 codec과 OpenAPI에 반영했다. question planner는 같은 dimension을 self/program context별로 분리하고 한 program씩 순차 질문하며, dashboard 질문과 설정 편집기는 self 범위·중복입주·사업별 상태·연도·known 범위를 구조화 값으로 저장한다. P3 splitter는 #8/#10/#13/#20과 기간 조건을 파싱하고 K-Startup normalizer까지 명시 flag로 배선됐지만 기본값은 false다. P4에서는 L3 계약 허용과 L2 LLM emit을 한 변경으로 열어 신규 scope/value 검증과 source_span 정책을 적용했다. 전체 매칭 단위 테스트, 루트 typecheck, OpenAPI 27 paths, diff check가 통과했고 L1 기본 미생성 회귀도 유지됐다. 실행 중 dev 서버가 없어 시각 검수와 실제 HTTP 저장 verifier는 미실행이다.

## 0. 목표·범위·비범위

**목표**: 27종 배제 조건 표의 #8(동일과제 참여 중)·#10(중복입주)·#13(프로그램 수료 이력)·#20(타부처 중복지원)을 `other`/`text_only` 잔존에서 끌어내, 수혜·참여 이력 기반으로 **거짓 통과(false pass) 없이** 자동 판정 가능하게 만든다. 현재는 3중 방어층(§1)으로 이 4종의 구조화를 의도적으로 차단해 둔 상태다. 이 계획은 (a) 계약에 자기참조(self-scope) 표현과 수혜 이력 프로필 구조를 신설하고, (b) 상태·기간을 구분하는 전용 evaluator를 도입하고, (c) 방어층을 **단계적으로** 해제하는 순서를 확정한다.

**범위**:
- `prior_award` CriterionValue의 신설 union 타입(self-scope, named-program, program-completion 3형) 정의. self-scope는 다시 `self_kind`(현재형 유사·동일과제·본사업 과거입상·당해연도 타부처)로 **범위를 분화**한다(B2 — 단일 boolean 환원이 실측 범위를 붕괴시키는 문제 해소).
- `CompanyProfile.prior_awards`를 자유 문자열 배열 → 구조화 이력 목록(+ known 게이트)으로 확장. 하위호환 유지.
- 결격 3축에서 검증된 `known_flags`/플래그 단위 게이트(C1)를 수혜 이력에 재사용해 "미질의 이력 false pass"를 차단. **scope="program"(특정 사업명)에도 `known_programs` 커버 게이트를 신설**해 상세 이력이 비어도(records empty) exclusion이 pass로 새는 false pass(B1 — C1 재발)를 차단한다.
- `prior_award` 전용 evaluator 신설(현행 `evaluateListCriterion` 문자열 exact-match 대체). 참여 중 / 수혜 완료 / 수료의 상태 구분과 기간 조건("최근 3년") 표현.
- 사업명 canonical 정규화 전략(연차·기수 변형 흡수).
- 온보딩 저부담 문항(자유 입력 부담 완화).
- 방어층 3층의 단계적 해제 시점을 Phase에 명시.
- #10(중복입주)·#20(타부처 중복지원)의 표현 가능성 판정 및 값 구조 확정.

**비범위**:
- 수혜 이력의 외부 API 소싱(정부24·범부처 통합관리시스템 연계 등) — 자가신고 수집까지만. 소싱은 별도 트랙(`docs/research/2026-07-10-company-data-matching-accuracy.md`).
- P6 audience 상류 게이트 — 독립 트랙(`docs/plans/2026-07-12-audience-gate.md`).
- grants 테이블과의 실시간 조인/FK 저장(수혜 이력을 grant_id 참조로 저장) — §7.3 실측 근거로 **기각**하고 canonical 문자열 사전 안을 채택(D3). FK 안은 대안으로만 기록.
- 절차·재량 조건(#6 서류 허위, #21 표절, #27 "기타 부적합") — 본질상 `other` 잔존이 정답. 이 계획이 건드리지 않는다.

## 1. 현행 3중 방어층 (해제 순서 설계의 대상)

| 층 | 위치 | 현재 동작 |
|---|---|---|
| L1 분해기 제외 | `packages/core/src/disqualification/extract.ts:114-115`(`PRIOR_AWARD_PATTERN`), `:336`, `:476`(`!isPriorAward` 가드) | 중복수혜·수료·참여류 문장을 구조화하지 않고 `residualSpans`(text_only 잔존)로 돌린다. `prior_award` 축을 절대 emit하지 않는다. |
| L2 정규화기 강등 | `packages/core/src/bizinfo/llm-criteria.ts:158-164`(`shouldDowngradeToOther`), `:191`, `:196-220` | LLM이 `prior_award && kind==="exclusion"`을 반환하면 `other`/`text_only`로 강등(span·note 보존). 시스템 프롬프트 `:75-78`도 "prior_award로 만들지 말고 other text_only로" 명시. |
| L3 계약 backstop | `packages/core/src/bizinfo/criteria-contract.ts:287-296`(`detectStructuringViolations`) | `prior_award + exclusion` criterion을 계약 검증 실패로 차단. 방어층 우회 시 발행 자체를 막는다. |

방어층 테스트: `packages/core/src/disqualification/extract.test.ts:82-116`(C2 케이스: #8/#10/#13/#20 문장이 `residualSpans`에 남고 `consumedSpans`에 없음, `prior_award` 미생성), `packages/core/src/bizinfo/llm-criteria-normalize.test.ts:30-55`(C2 강등 4 check).

**해제하지 않으면 안 되는 이유(C2 리뷰)**: 현행 `evaluateListCriterion`(match.ts:409-448)은 `required.some((v) => companyValues.includes(v))` 문자열 exact-match다. 공고 "초기창업패키지"와 회사 "2024 초기창업패키지(예비)"가 다르면 매칭 실패 → 결격인데 pass. 그래서 계약·evaluator·프로필·문항이 전부 준비되기 전에 방어층을 풀면 false pass를 양산한다.

## 2. 설계 결정 (D-번호)

| # | 결정 | 근거 | 대안 기각 이유 |
|---|---|---|---|
| D1 | **`prior_award` CriterionValue를 판별 유니온(discriminated union)으로 신설**: `scope` 필드로 `self`(자기·동시참여) / `program`(특정 사업명) / `program_type`(프로그램 유형 수료) 3형 구분(§3.1) | 실측 §7.2: 자기참조/동시참여형이 특정사업명 지시형의 ~7배(168:24). "동일 사업" 다수는 매칭 대상 공고 자신을 가리켜 현행 계약으로 표현 불가(C2 지적) | 단일 `programs: string[]` 유지 안 → 자기참조를 표현 못 하고 exact-match 회귀. 부적합 |
| D2 | **`{scope:"self"}` 자기참조 표현 신설, `self_kind`로 범위 분화(B2)**. 단일 `has_concurrent_public_support` boolean은 실측된 서로 다른 범위(과거 본사업 입상 §7.1, 당해연도 타부처 §7.2, 동일과제 동시참여)를 못 가르므로, self value에 `self_kind: "current_similar"｜"same_project"｜"same_business_prior"｜"same_year_other_support"` 범위 축을 둔다. evaluator는 `self_kind`별 프로필 플래그(§3.2)로 판정. 매칭 대상 공고의 정체성(grant_id·사업명)과 자동 대조하지 **않는다** | 실측 §7.1/§7.2: "정부·지자체 등 유사 사업 중복참여자", "당해연도 타 부처 유사 정부보조금 중복", "과거 본 사업 입상여부", "동일과제 참여"가 각기 다른 범위로 혼재. 단일 boolean은 이 범위들을 하나로 뭉개 오판정 | ①grant_id 자기대조 안 → "동일 사업"의 범위가 공고마다 다르고(당해연도/유사/동일과제) 회사 이력을 grant로 정규화할 수 없어 판정 불가(§7.3). ②단일 boolean 안 → 실측 범위 붕괴(B2) — `self_kind`로 분화 필수 |
| D3 | **사업명 정규화는 canonical 문자열 사전 안 채택**. 수혜 이력을 grants FK로 저장하지 **않는다** | 실측 §7.3: "초기창업패키지"가 229개 grant title에 연차·대학·세부트랙·하위행사(설명회·IR·강좌)로 극심하게 분산. FK 조인은 어느 grant를 가리키는지 확정 불가 | grant FK 저장 안 → 사용자가 "초기창업패키지 수혜"라고만 알지 어느 연도 어느 대학 공고인지 특정 못 함. FK 무의미. §7.3 |
| D4 | **known 게이트를 이력 축에 그대로 재사용**(C1과 동일 문제 구조). `prior_award` known은 "수혜 이력 문항에 응답했는가"의 dimension-confidence 게이트 + **program·program_type 양쪽 커버 게이트**(B1 확장). `scope="program"`(특정 사업명)도 `program_type`과 동일하게, 요구 program 중 미질의(`known_programs` 미포함)가 있으면 unknown — records가 비어도(사용자가 self 문항만 답하고 상세 이력 미입력) exclusion을 pass로 흘리지 않는다 | 결격 축 C1 해법(match.ts:566, `isKnownListField`) + 플래그 단위 커버 게이트(match.ts:570~579 `unqueried = critFlags − known_flags`)가 검증된 패턴. program에 커버 게이트가 없으면 상세 이력 미입력 시 exclusion이 false pass(B1, C1 재발) | ①dimension-confidence만으로 pass 확정 안 → 사용자가 "NEST 수료 안 함"을 명시적으로 안 물었는데 pass 확정하는 false pass. ②program 커버 게이트 없이 records empty를 "미해당"으로 해석 안 → 특정 program 미질의 false pass(B1). 결격 축 C1과 동형 |
| D5 | **상태(state) 3분류 + 극성 매트릭스**: `participating`(동시 수행 금지 → exclusion), `completed`(재지원 금지 → exclusion), `graduated`(우대/배제 양방향 — kind로 극성). §4 매트릭스 | #8은 "참여 중" 금지, #13 사관학교/NEST는 "수료 이력" 금지 또는 우대 두 방향 모두 실측(§7.2, `우대`·`제외` 혼재) | 단일 상태 안 → "참여 중이면 금지지만 수료했으면 우대"인 사업을 못 가름 |
| D6 | **#10(중복입주)은 별도 `scope:"self"` + `self_kind:"same_year_other_support"`(범위) + `channel:"incubation_tenancy"` 하위 태그로 표현**. #20(타부처 중복지원)은 `scope:"self"`(`self_kind:"same_year_other_support"`)로 흡수. **온보딩 기본 2문항에서 incubation_tenancy는 제외**(B6) — 활성 잔존 0건(§7.4)이므로 실제 `channel:"incubation_tenancy"` criterion이 걸린 grant에서만 lazy question으로 노출 | 실측 §7.4: #10은 "보육센터/BI 물리적 중복입주"로 수혜와 층위가 다름(동시 점유). 활성 잔존 0건이라 전 사용자 기본 게이트에 넣으면 과잉(B6). #20은 "당해연도 유사 정부보조금 중복"으로 self-scope 전형 | ①#10을 일반 수혜로 흡수 안 → "입주"는 재정지원과 별개 조건(입주 없이 수혜만 받는 회사가 다수). 별도 채널 태그 필요. ②전 사용자 기본 문항 안 → 활성 0건에 회상 부담 부과는 과잉(B6), lazy로 이관 |
| D7 | **방어층은 Phase 경계에서만 해제하되 L3+L2는 원자 배포(B4)**. L3(계약 허용)과 L2(정규화기 강등 제거·emit)는 evaluator·프로필이 준비된 뒤 **같은 Phase(P4)에서 동시** 해제 — LLM 정규화가 emit 직후 계약을 assert(`llm-criteria.ts:134`)하므로 둘을 분리 배포하면 간극에서 런타임 실패. L1 분해기는 골든 검증 후 마지막(P5) 해제(§5 실행순서) | 계획 §6-C2: "계약·evaluator·프로필·문항이 전부 준비되기 전에 3중 방어층을 풀면 안 됨" + B4: L3/L2 배포 간극이 assert 실패 유발 | ①일괄 해제 안 → 어느 층이라도 먼저 풀리면 방어 안 되는 criterion이 발행·판정되어 false pass. ②L3/L2 분리 배포 안 → assert 즉시 실행이라 간극에서 정규화 런타임 실패(B4) |
| D8 | **기간 조건("최근 3년")은 값에 내장**하되 evaluator는 이력의 연도로 판정. 연도 미상 이력은 unknown(assumed-pass 금지) | 실측 §7.5: 중복수혜 계열 중 ~8%(45/537)가 "최근 N년" 기간 명시. 소수지만 오판정 시 결격 오인 비용 큼 | 기간 무시 안 → "최근 3년 내 수혜만 배제"인데 5년 전 수혜를 배제로 오판 |
| D9 | **자가신고 confidence 0.6** 유지, 매칭 메시지에 "자가신고 기준" 고지 | 결격 축 전례(`SELF_DECLARED_CONFIDENCE`, update-profile-field.ts:21). prior_award는 소싱 불가라 자가신고가 유일 | 소싱 confidence 0.8 적용 안 — 소싱 경로 없음 |

## 3. 계약 상세

### 3.1 신규 CriterionValue — `prior_award` 판별 유니온 (`packages/contracts/src/index.ts`)

현행 `ListCriterionValue.programs`(`index.ts:182`)는 라벨 배열뿐이라 self-scope·상태·기간을 표현하지 못한다. 전용 값 인터페이스를 신설하고 `CriterionValue` union(`index.ts:224-234`)에 **반드시 추가**한다(Minor-8 전례 — union 누락 시 타입 통과하는 오염 값).

```ts
/** prior_award 수혜/참여 이력 조건 — 공고 측. scope 로 판별. */
export type PriorAwardScope = "self" | "program" | "program_type";

/**
 * self-scope 범위 축(B2, D2). 단일 boolean 환원이 붕괴시킨 실측 범위를 분화.
 *   current_similar          : 현재 동일·유사 정부지원을 수행·수혜 중(현재형, §7.1 "중복참여자"). #8 동시참여 다수.
 *   same_project             : 동일 과제로 다른 지원에 참여 중(과제 동일성, §7.2 "협약기간 중복 불가").
 *   same_business_prior      : 본 사업(동일 공모)에 과거 선정/입상 이력(§7.1 "과거 본 사업 입상여부").
 *   same_year_other_support  : 당해연도 타 부처/유사 정부보조금 중복(§7.2, §7.4 #20/#10).
 */
export type PriorAwardSelfKind =
  | "current_similar"
  | "same_project"
  | "same_business_prior"
  | "same_year_other_support";

/** 수혜 상태 — 극성 매트릭스(§4)의 축. */
export type PriorAwardState = "participating" | "completed" | "graduated";

export interface PriorAwardCriterionValue {
  /**
   * self         : 매칭 대상 공고 자신 또는 "동일·유사 정부지원 동시/기수혜" (자기참조, D2).
   *                grant_id 자동 대조 아님 — 회사의 self_kind별 플래그(§3.2)로 판정.
   * program      : 특정 사업명 지시(canonical 정규화된 program key). 예: 초기창업패키지.
   * program_type : 프로그램 유형 수료 이력(사관학교/NEST 계열, D5).
   */
  scope: PriorAwardScope;
  /** scope=self 일 때 어떤 범위인지(B2). 없으면 current_similar 기본(가장 흔한 현재형). */
  self_kind?: PriorAwardSelfKind;
  /** scope=self 일 때 어떤 공적 지원 채널인지. 기본 general(모든 정부·지자체 지원). */
  channel?: "general" | "incubation_tenancy"; // incubation_tenancy = #10 중복입주(D6)
  /** scope=program|program_type 일 때 canonical program key 목록(§3.3 사전). */
  programs?: string[];
  /** 어떤 상태를 문제 삼는가(D5). 비면 상태 무관(모든 상태 대상). */
  states?: PriorAwardState[];
  /** 기간 조건(D8). 예: {value:3, unit:"year"} = "최근 3년 내". 없으면 기간 무관. */
  within?: { value: number; unit: "year" | "month" } | null;
  /** 원문 표기(진단·표시용). */
  labels?: string[];
}
```

- `kind`으로 극성 표현: `exclusion`(배제) / `preferred`(우대) / `required`(전제 이력 필수, 드묾 — 실측 §7.6에 `통상닥터 참여기업이어야 함` 사례).
- `operator`: `self`는 `exists`(해당 여부), `program`/`program_type`은 `in`(교집합).
- **하위호환**: 기존 `programs: string[]`만 있는 v1 criterion을 evaluator가 `{scope:"program", programs, states:undefined}`로 폴백 해석(§4). 재발행 없이 회귀 방지.

### 3.2 CompanyProfile 확장 (`packages/contracts/src/index.ts:356`)

현행 `prior_awards?: string[]`(`index.ts:356`)를 유지하되(하위호환 표시용), 구조화 이력과 known 게이트를 신설한다.

```ts
export interface PriorAwardRecord {
  /** canonical program key(§3.3) 또는 자유 표기. self 채널엔 불필요. */
  program?: string;
  /** 주관기관(선택, 자동완성·중복판정 보조). */
  agency?: string;
  /** 수혜/참여 연도(YYYY). null=미상 → 기간 조건 판정 시 unknown(D8). */
  year?: number | null;
  /** 상태(D5). */
  state: PriorAwardState;
}

export interface PriorAwardProfileValue {
  /** 구조화 수혜/참여 이력. */
  records: PriorAwardRecord[];
  /**
   * self-scope 판정용 플래그 맵(B2, D2). self_kind별로 분리 저장 — 단일 boolean이 아니다.
   * 값 undefined/미포함 = 해당 self_kind 미질의(→ unknown 게이트). true/false = 질의됨.
   * records 로부터 일부 파생 가능하나, 사용자가 저부담 응답만 한 경우를 위해 self_kind별 별도 저장.
   *   current_similar         : 현재 동일·유사 공적 지원 수행·수혜 중인가.
   *   same_project            : 동일 과제로 다른 지원에 동시 참여 중인가.
   *   same_business_prior     : 본 사업(동일 공모)에 과거 선정/입상 이력이 있는가.
   *   same_year_other_support : 당해연도 타 부처/유사 정부보조금을 중복 수혜 중인가.
   */
  self_flags?: Partial<Record<PriorAwardSelfKind, boolean>>;
  /** #10(중복입주) 전용 플래그(D6). 현재 다른 BI/보육센터 입주 중인가. lazy 질의(B6). */
  has_incubation_tenancy?: boolean;
  /**
   * 질의·확인이 이뤄진 program 커버(C1/D4/B1). scope="program" 요구 program 중 "물어본 것".
   * program 커버 게이트: 요구 program − known_programs ≠ ∅ → unknown(records empty false pass 차단).
   */
  known_programs: string[];
  /**
   * 질의·확인이 이뤄진 program_type 커버(C1/D4). 사전 program_type 중 "물어본 것".
   * self 게이트는 self_flags[kind]의 존재(!== undefined)로, incubation 게이트는 has_incubation_tenancy의 존재로 known 판정.
   */
  known_program_types: string[];
}

// CompanyProfile 내부:
prior_awards?: string[];                 // 하위호환(표시) — 유지
prior_award_history?: PriorAwardProfileValue; // 신규 구조화 이력
```

- dimension known 게이트(`confidence.prior_award`)는 유지(match.ts:451 `isKnownListField`). 그 위에 **program 커버 게이트(`known_programs`, B1)와 program_type 커버 게이트(`known_program_types`)를 둘 다** 얹는다(C1 재사용, `evaluateDisqualification`의 `unqueried = critFlags − known_flags` 패턴 미러).
- `prior_awards`(문자열)와 `prior_award_history`(구조)를 동시 보유 시 evaluator는 history 우선. 마이그레이션 시 기존 문자열은 `records[].program`(state 미상 → `completed` 기본)으로 승격 가능(선택, P3).

### 3.3 canonical program 사전 (신규 `packages/core/src/prior-award/canonical.ts`)

결격 canonical(`disqualification/canonical.ts`) 구조를 미러링한다. 연차·기수 변형을 canonical key로 흡수(D3).

```ts
export interface CanonicalProgram {
  key: string;              // 안정 식별자. 예: "chogi_startup_package"
  label: string;            // 표준 한국어명. "초기창업패키지"
  /** program_type 계열 여부(D5 graduated 양방향 대상). */
  isProgramType?: boolean;  // 사관학교·NEST 계열
  /** title/자유표기 → key 매칭용 정규식 시드(연차·대학·트랙 접사 흡수). */
  aliases: RegExp[];
}
```

- 초기 세트(실측 §7.3 상위 토큰): 초기창업패키지·예비창업패키지·창업도약패키지·창업사관학교(program_type)·Start-up NEST(program_type)·메이커스페이스·로컬크리에이터·소셜벤처·TIPS. `aliases`는 `/(?:20\d{2}\s*년?\s*)?(?:[가-힣]+대학교\s*)?초기창업패키지/` 식으로 접사 흡수.
- **계약 규칙(C1 미러, B1)**: 사전에 program·program_type을 추가하면 반드시 온보딩 문항 커버 매핑에 추가. 커버 완전성(모든 program·program_type이 1개 이상 문항에 커버되어 `known_programs`/`known_program_types`에 기록될 수 있음)을 단위테스트로 강제. program 커버가 빠지면 records empty false pass(B1) 재발.
- **정규화 함수** `normalizeProgramLabel(text): string | null` — 자유 표기를 canonical key로. 매칭 실패 시 null(→ 자유 표기 그대로 보존, self-scope 판정엔 무영향).

### 3.4 계약 복제 지점 전수 (M2 전례 — openapi.ts 하드코딩 누락 주의)

| 지점 | 위치 | 작업 |
|---|---|---|
| CriterionValue union | `packages/contracts/src/index.ts:224-234` | `PriorAwardCriterionValue` 등재(Minor-8) |
| CompanyProfile | `packages/contracts/src/index.ts:356` | `prior_award_history` 필드 추가(기존 `prior_awards` 유지) |
| openapi CompanyProfile 스키마 | `packages/contracts/src/openapi.ts:1352`(`prior_awards: arrayOf(...)`) | `prior_award_history` object 스키마 추가(`records`·`self_flags`·`has_incubation_tenancy`·`known_programs`·`known_program_types`)(M2 — 하드코딩 누락 시 API 계약 불일치) |
| openapi criterion value 스키마 | `packages/contracts/src/openapi.ts` value 관련 블록 | prior_award value 형상 반영(`scope`·`self_kind`·`channel`·`programs`·`states`·`within`). 현재 `value:{type:"object"}` 느슨하면 문서화만 |
| JSON Schema | `packages/contracts/schemas/grant-criteria.schema.json` | prior_award value 형상(있으면) 갱신. 없으면 신설 불필요 확인 |
| pgEnum | 변경 없음 — `prior_award` dimension은 이미 존재(schema.ts:58 enum, `prior_award` 포함). **DB 마이그레이션 불필요**(값 구조는 jsonb) | 확인만 |

**주의**: prior_award는 dimension enum·pgEnum에 이미 있으므로 결격 축과 달리 **enum 마이그레이션이 없다**. 변경은 전부 jsonb value 형상 + 프로필 직렬화 + evaluator 로직.

## 4. evaluator 시맨틱 (`prior_award` 전용 evaluator)

현행 `evaluateListCriterion`(match.ts:409-448) 호출(match.ts:160)을 신규 `evaluatePriorAward`로 교체한다. 판정 매트릭스는 (scope × state × known)의 곱.

### 4.1 판정 알고리즘

```
evaluatePriorAward(criterion, company):
  value = adaptV1(criterion.value)   # v1 하위호환 어댑터(§4.4) — program/awards/note/text_only 각 형식 흡수
  profile = company.prior_award_history
  # known 게이트(D4) — dimension confidence
  if profile 미존재 or confidence.prior_award 없음:            → unknown ("수혜 이력 확인 필요")

  scope = value.scope
  # ── scope=self (D2, B2, #8/#20) ──
  if scope=="self":
    channel = value.channel ?? "general"
    if channel=="incubation_tenancy":                         # #10(D6)
      flag = profile.has_incubation_tenancy
    else:
      selfKind = value.self_kind ?? "current_similar"         # B2 범위 축
      flag = profile.self_flags?.[selfKind]                   # self_kind별 플래그
    if flag === undefined:                                     → unknown (해당 self_kind/채널 문항 미질의, C1)
    hit = (flag === true)
    # 기간(within)은 self 현재형(current_similar/same_project/same_year_other_support)엔 무의미 — 무시.
    #   same_business_prior 은 records의 본사업 이력 연도로 within 판정할 수 있으나, self_kind 플래그 우선.

  # ── scope=program (특정 사업명) ──
  else if scope=="program":
    reqPrograms = canonical(value.programs)
    # program 커버 게이트(C1/B1): 요구 program 중 미질의가 있으면 unknown.
    #   records empty 를 "미해당(pass)"으로 해석하지 않는다 — false pass 차단.
    unqueried = reqPrograms − profile.known_programs
    if unqueried ≠ ∅:                                          → unknown (해당 program 이력 미질의)
    matched = profile.records where program ∈ reqPrograms
                                   AND (value.states 비었거나 record.state ∈ value.states)
                                   AND withinPeriod(record.year, value.within)   # D8
    if within 있고 matched 후보 중 year=null 존재 and 확정 hit 없음: → unknown (연도 확인 필요)
    hit = matched ≠ ∅

  # ── scope=program_type (#13, 유형 수료) ──
  else:  # program_type
    reqPrograms = canonical(value.programs)
    # program_type 커버 게이트(C1): 요구 유형 중 미질의가 있으면 unknown
    unqueried = reqPrograms − profile.known_program_types
    if unqueried ≠ ∅:                                          → unknown
    matched = profile.records where program ∈ reqPrograms
                                   AND (value.states 비었거나 record.state ∈ value.states)
                                   AND withinPeriod(record.year, value.within)   # D8
    if within 있고 matched 후보 중 year=null 존재 and 확정 hit 없음: → unknown (연도 확인 필요)
    hit = matched ≠ ∅

  # ── 극성(D5) ──
  # kind=exclusion → hit 이면 fail, 아니면 pass
  # kind=required  → hit 이면 pass, 아니면 fail
  # kind=preferred → hit 이면 pass(가점), 아니면 pass(감점 없음, 우대 미충족)
  return polarity(kind, hit)
```

### 4.2 판정 매트릭스 (상태 × 조건종류 × known)

| criterion | 회사 이력 | known? | 결과 | 근거 |
|---|---|---|---|---|
| `self/general current_similar, exclusion` | `self_flags.current_similar=true` | known | **fail** | 현재 유사 지원 수행 중 배제(#8) |
| `self/general current_similar, exclusion` | `self_flags.current_similar=false` | known | **pass** | 현재 유사 지원 없음 |
| `self/general current_similar, exclusion` | 미질의(`self_flags.current_similar=undefined`) | unknown | **unknown** | C1 게이트 — false pass 차단 |
| `self/general same_year_other_support, exclusion` | `self_flags.same_year_other_support=true` | known | **fail** | 당해연도 타부처 중복(#20) |
| `self/general same_business_prior, exclusion` | `self_flags.same_business_prior=undefined` | unknown | **unknown** | 다른 self_kind 응답이 이 범위를 커버하지 않음(B2) — 범위별 독립 게이트 |
| `self/incubation_tenancy, exclusion` | `has_incubation_tenancy=true` | known | **fail** | 중복입주 해당(#10) |
| `self/incubation_tenancy, exclusion` | `has_incubation_tenancy=undefined` | unknown | **unknown** | C1(lazy 질의, B6) |
| `program_type=[사관학교], exclusion, participating` | records에 사관학교 `participating` | known | **fail** | 참여 중 배제(#13) |
| `program_type=[사관학교], exclusion, completed` | records에 사관학교 `completed` | known | **fail** | 수료 이력 배제(#13) |
| `program_type=[사관학교], preferred, graduated` | records에 사관학교 `graduated` | known | **pass(가점)** | 수료 우대(양방향, D5) |
| `program_type=[사관학교], exclusion` | 사관학교 미질의(`known_program_types` 미포함) | unknown | **unknown** | program_type 커버 게이트(C1) |
| `program=[초기창업패키지], exclusion` | records empty, `known_programs`에 초기창업패키지 **미포함** | unknown | **unknown** | **program 커버 게이트(B1)** — records empty를 미해당으로 오해석하지 않음 |
| `program=[초기창업패키지], exclusion` | records empty, `known_programs`에 초기창업패키지 **포함** | known | **pass** | 질의 후 해당 이력 없음 확정 |
| `program=[초기창업패키지], exclusion, within 3y` | records 초기창업패키지 year=2020(5년 전), known_programs 포함 | known | **pass** | 기간 밖(D8) |
| `program=[초기창업패키지], exclusion, within 3y` | 초기창업패키지 year=null, known_programs 포함 | known | **unknown** | 연도 미상 → assumed-pass 금지(D8) |
| `program=[초기창업패키지], required` | 해당 이력 없음, known_programs 포함 | known | **fail** | 전제 이력 필수 미충족(§7.6) |

- **assumed-pass 금지**(D4/D8): 미질의·연도미상은 pass가 아니라 unknown. `nextQuestion`으로 유도.
- exclusion 극성은 결격 3축과 동일하게 message에 잔존 근거 명시("동일 사업 동시 수혜 해당", "청년창업사관학교 수료 이력").

### 4.3 review gate 통합

- `prior_award`는 `CORE_GATE_DIMENSIONS`에 **넣지 않는다**(match.ts:36-42). 결격 3축과 동형: unknown은 `needs_profile_input` 티어로 "1분 수혜 이력 확인" CTA.
- **reason code는 기존 `profile_missing` 재사용으로 확정(B7)**. `prior_award`는 `DISQUALIFICATION_AXES`에 없으므로 match.ts:986-999의 분기가 자동으로 `reviewReason("profile_missing", entry, ...)`를 부여한다. dimension(`prior_award`)과 message로 수혜 이력 CTA를 구분하면 되고, 신규 reason enum 값 신설은 **불요** — enum(`enums.ts:34-41`)·openapi(`openapi.ts:930-937`) 복제 비용만 발생하고 이득이 없다. 별도 analytics 세분이 실측상 필요해지면 그때 M2 복제 체크리스트(§3.4)와 함께 신설한다(현 시점 보류).
- `hasHighRiskSignal`(match.ts:1035-1054): prior_award는 exclusion이면 이미 M1 완화로 제외됨(`criterion.kind==="exclusion"` 분기). required/preferred prior_award는 raw_text에 도메인 단어 복제 금지(span 정책 준수)로 오강등 방지.

### 4.4 v1 하위호환 어댑터 `adaptV1(value)` (B3 — 실측 형식 전수 포괄)

§7.6의 38건 snapshot 실측 키는 `note` 33, `program` 단수 2, `awards` 2, `labels` 3, `period` 1, `support_type` 1, `years` 1이다. 최초 계획의 `{programs}` 배열 가정과 달리 운영에는 단수 `program`이 존재한다. v1 값을 신규 `PriorAwardCriterionValue`로 변환하는 **별도 함수**로 명시하고 형식별 매핑을 강제한다.

| v1 값 형식 | 실측 근거 | 신규 값 변환 규칙 |
|---|---|---|
| `{ program: string }` | required/exists 2건(통상닥터, IP디딤돌프로그램) | `{ scope:"program", programs:[canonical(program)], labels:[program] }`. 비canonical은 idempotent `free:` key로 보존 |
| `{ programs: string[] }` | 과거/외부 입력 하위호환(현재 38건에는 0) | `{ scope:"program", programs: canonical(programs), labels: programs }` |
| `{ awards: string[] }` | 수상/선정 이력 지시 | `{ scope:"program", programs: canonical(awards), labels: awards }`(program과 동일 경로) |
| `labels: string[]` 만 존재 | 라벨만 있고 key 미매핑 | canonical 매핑 시도 → 성공분 `programs`, 실패분 `labels` 유지. 전부 실패면 `scope:"self", self_kind:"current_similar"`(자유표기 self 추정)로 폴백 후 unknown 유도 |
| `{ note }` / `text_only`(값 없음) | text_only 계열(§7.1, §7.6 `text_only` 15+8+2건) | 구조화 불가 → `{ scope:"self", self_kind:"current_similar" }`로 보수 해석(self known 게이트가 미질의 시 unknown 부여 — false pass 없음). note는 labels로 보존해 진단·CTA에 표시 |
| `exists`/`not_in` operator | required/exists·exclusion/not_in(§7.6) | operator는 §3.1 규약(`self`=exists, `program`=in)으로 정규화. `not_in`은 극성 유지하되 신규 evaluator 시맨틱으로 재판정 |

- 어댑터는 **재발행 없이 판정 시점에만** 적용(§3.1 하위호환 원칙). 실제 값 스키마 교체는 P6 백필에서 수행.
- P1 완료 기준에 실측 key histogram과 38건 adapted 결과를 고정하는 legacy regression을 추가한다.

## 5. Phase 계획 (방어층 해제 시점 명시)

실행순서: **P0 → P1 → P2 → (P3 ∥ P4) → P5 → P6 → P7**. 방어층 해제는 **L3+L2(P4 동시)·L1(P5)** 경계에서만(P6은 백필). L3(계약 허용)과 L2(강등 제거)를 **같은 Phase/배포 단위**로 묶는다(B4) — LLM 정규화기가 계약을 즉시 assert(`llm-criteria.ts:134` `assertGrantCriteriaContract`)하므로, L2가 prior_award+exclusion을 emit하는데 L3가 아직 이를 계약 위반으로 차단하는 배포 간극이 생기면 정규화가 런타임 실패한다. 따라서 L3 허용과 L2 emit은 원자적으로 같이 배포한다.

### P0 — 계약·canonical 사전 (선행)

| 파일 | 작업 |
|---|---|
| `packages/contracts/src/index.ts` | `PriorAwardScope`/`PriorAwardState`/`PriorAwardCriterionValue`/`PriorAwardRecord`/`PriorAwardProfileValue` 신설. `CriterionValue` union(:224)에 등재. `CompanyProfile`(:356)에 `prior_award_history` 추가 |
| `packages/contracts/src/openapi.ts` | `:1352` 인접에 `prior_award_history` object 스키마. criterion value 문서화(§3.4) |
| `packages/contracts/schemas/grant-criteria.schema.json` | prior_award value 형상(있으면) 갱신 |
| `packages/core/src/prior-award/canonical.ts`(신규) | §3.3 사전 + `normalizeProgramLabel` + 문항→program_type 커버 매핑 + 라벨 |
| `packages/core/src/prior-award/canonical.test.ts`(신규) | program_type 커버 완전성(C1 미러) |
| 빌드 | `pnpm -F @cunote/contracts -F @cunote/core build`(core dist 미빌드 시 dev 미반영 — 메모리) |

**완료 기준**: 워크스페이스 typecheck 통과. union 등재 확인. 커버 완전성 테스트. **방어층 미해제(전 층 유지).**

### P1 — evaluator (`packages/core/src/matching/match.ts`)

- `evaluatePriorAward` 신설(§4). `evaluateCriterion` switch의 `prior_award` 케이스(match.ts:159-160)를 교체. **`adaptV1` v1 하위호환 어댑터(§4.4) 포함** — `{program}`·`{programs}`·`{awards}`·`labels`·`{note}`/`text_only` 형식 전수 흡수.
- `labelFor`·`nextQuestion` prompts(match.ts:1143 기존 "동일하거나 유사한 정부지원사업 선정 이력이 있나요?")를 self_kind·채널 구분 문항으로 개정(§6).
- `RULESET_VERSION` 범프(`ruleset-kstartup-spine-v5`) — prior_award v4 후 검수 전 hard fail→unknown 안전 경계를 추가한 현재 매칭 스냅샷 재계산 트리거(§P7).

**완료 기준**: evaluator 테스트 매트릭스(§4.2 전 행) + **38건 실측 value-key/adapted golden 회귀**(B3) + 기존 golden 회귀 100%. **방어층 미해제** — 이 시점 DB엔 아직 prior_award 구조화 criterion이 없으므로 evaluator는 v1 어댑터만 실행(무해).

### P2 — 프로필 파이프라인 (M3 silent-drop 주의)

> 🟡 정적·runtime 구현 완료(2026-07-12): 점진 질문과 설정 화면 모두 v2 구조화 payload를 생성한다. 설정 편집기는 미확인/해당 없음/해당을 분리하고 records·self_flags·중복입주·known program/type을 replace 저장한다. 레거시 문자열은 편집 초안으로 보존하며 사용자가 저장할 때 canonical 구조로 확인된다. runtime repository의 resolve→save→resolve→재매칭과 unrelated field 저장 후 잔존을 검증했고, 편집기 SSR 42KB 마크업에서 self/중복입주/기존 이력/known program/안전 문구/저장 액션을 확인했다. HTTP verifier도 신 계약으로 갱신했지만 개발 서버 부재로 실제 HTTP와 브라우저 시각 검수는 미실행이다.

| 파일 | 작업 |
|---|---|
| `packages/core/src/company/update-profile-field.ts` | `prior_award` 케이스(:75-76)를 구조화 입력 정규화로 교체(문항 응답 → `PriorAwardProfileValue`: self_kind별 `self_flags`, `known_programs`/`known_program_types` 커버 기록, `records`). 자유 문자열 입력은 하위호환 승격 |
| `apps/web/src/lib/server/repositories/drizzle.ts` | **`toCompanyProfile`(:744) 역직렬화 + `companyProfileRows`(:910-912) 직렬화 양방향에 `prior_award_history` 추가**(M3 — 결격 축 :919-929 블록 전례. 누락 시 silent drop). `profileConfidence`(:959) fallback 0.8이 자가신고 0.6을 덮지 않게 문항 API가 confidence 명시 전달 |
| `packages/core/src/use-cases/build-dashboard.ts` | `inputTypeForDimension`(:96)에 prior_award 저부담 타입, `criterionOptionsForDimension`(:143, 현행 `prior_award:["programs"]` :154) 매핑 확장 |
| `apps/web/src/features/dashboard/ProgressiveQuestionCard.tsx` | prior_award 구조화 입력 렌더(§6) |
| `apps/web/src/features/dashboard/CompanySettingsPanel.tsx` | 수혜 이력 수정 섹션(현행 텍스트 `prior_awards` :559-566 → 구조화 이력 편집. 결격 `DisqualificationEditor` :600-707 전례) |
| `apps/web/src/lib/server/onboarding/onboardingProgress.ts` | 수혜 이력 저부담 스텝(§6) |
| `apps/web/src/features/dev/ServiceDataMonitor.tsx` (+ `devServiceDataMonitor.ts`) | dev 소싱 커버리지 하네스의 prior_award Q&A(현행 자유 텍스트 1칸)를 신 계약 구조화 입력(self_kind별 `self_flags`·`records`·`known_programs` 커버)으로 갱신 — 소싱 검증 하네스가 신 계약을 따라가지 못하면 커버리지 확인이 무의미해짐 |

**완료 기준**: e2e — self_kind 문항 응답 → 저장 → 매칭 unknown 해소, "현재 유사 지원 수행 중" 응답 시 self/current_similar exclusion이 ineligible 전환, 특정 program 이력 응답 시 `known_programs` 커버로 program exclusion 판정 확정(B1), **다른 필드 저장 후 self_flags·known_programs·records 잔존**(M3), 설정 패널 정정 → 재판정. **방어층 미해제.**

### P3 — 파서 (분해기·LLM) 준비 — L1/L2 여전히 차단

> ✅ 준비 배선 완료(2026-07-12): 독립 splitter와 K-Startup normalizer 옵션 `priorAwardSplit`을 연결했다. 기본값 false에서는 prior_award 미생성+other residual이 유지되고, true에서는 동일 과제 span만 구조화하며 기존 세금 결격을 보존하고 placeholder 중복을 만들지 않는다. 이 과정에서 공용 문장 분할기의 ASCII 마침표 누락을 수정해 혼합 조건 span 오귀속도 차단했다. P5 전 운영 호출부는 아직 flag를 켜지 않는다.

- **prior-award splitter를 별도 모듈 + feature flag로 분리(B5)**: `packages/core/src/prior-award/extract.ts`(신규 독립 모듈 — `disqualification/extract.ts` 인라인 확장이 아니라 분리)에서 중복수혜·수료·참여류 문장을 `PriorAwardCriterionValue`로 구조화. self(+self_kind)/program/program_type 분류 + state 추론(참여 중/수료) + within("최근 N년") 파싱. 통합 경로(`extract.ts:335-337`, `:475-489`)에는 **feature flag(`PRIOR_AWARD_SPLIT`)로 게이팅**해 삽입 — flag off면 기존 residual 경로 그대로.
  - **flag off**(기본, P3~P4): 기존 C2 테스트(`extract.test.ts:82-119`, `extractAll` 결과의 prior_award 미생성 검사)가 그대로 통과. "별도 함수라 안전"이 아니라 **통합 경로에 flag 가드가 있으므로** 안전.
  - **flag on**(P5에서 활성): #8/#10/#13/#20(테스트 케이스 라인 82-119 대상) 구조화 테스트가 통과.
- `packages/core/src/bizinfo/llm-criteria.ts`: 시스템 프롬프트(:75-78)의 "prior_award로 만들지 마라" 지시를 새 값 형식 few-shot으로 **교체 준비**(주석/플래그로 비활성 유지).
- **방어층 미해제** — 분해기 신설 + flag 게이팅만, flag off라 배선 무효.

**완료 기준**: 분해기 단위테스트 — 실측 §7 표본(자기참조·특정사업명·수료·기간)이 올바른 scope/self_kind/state/within으로 구조화. **flag off 상태에서 기존 C2 통합 테스트(`extract.test.ts:82-119`)가 여전히 통과**(별도 함수 존재만으로가 아니라 통합 경로 flag 가드로 미생성 보장). flag on 구조화 테스트(#8/#10/#13/#20)는 별도 스위트로 통과.

### P4 — L3+L2 원자 해제 + LLM 배선 (B4 — 같은 배포 단위)

> ✅ 구현 완료(2026-07-12): L3의 blanket ban과 L2의 prior_award 강등을 동시에 제거했다. exclusion은 v2 `scope`가 필수이며 self_kind/channel, programs, states, within을 계약 검증한다. prior_award도 구조화 시 source_span을 요구하고 raw_text에는 span만 보존한다. v1 required/preferred 값은 하위호환으로 유지한다. 정상 emit→즉시 assert 통과, malformed 값 차단, span 누락 강등, 예약 축 차단을 `llm-criteria-normalize.test.ts` 17건으로 확인했다. L1 결정론 추출기는 계속 미생성 상태다.

> **B4 — 배포 원자성**: L3(계약 허용)와 L2(강등 제거·emit)는 **반드시 같은 Phase/배포에서 동시** 해제한다. LLM 정규화기가 emit 직후 계약을 assert(`llm-criteria.ts:134`)하므로, L2만 먼저 배포되면(L3 미해제) prior_award+exclusion emit이 계약 위반으로 런타임 실패한다. 따라서 아래 두 작업은 하나의 배포로 묶는다.

- `packages/core/src/bizinfo/criteria-contract.ts:287-296`(`detectStructuringViolations`): `prior_award + exclusion` 금지를 **완화** — 신규 값 스키마 검증으로 교체(scope/self_kind/state/programs 형식 검증). `validateDimensionValueSchema`에 prior_award 케이스 추가. **L3 해제.**
- `packages/core/src/bizinfo/llm-criteria.ts`: `shouldDowngradeToOther`(:158-164)의 `prior_award && exclusion` 강등 제거. 시스템 프롬프트를 새 형식으로 교체. tool schema는 prior_award 유지(예약축 제외는 그대로). **L2 해제.** ← L3와 원자 배포.
- 방어층 테스트 갱신: `llm-criteria-normalize.test.ts:30-55`의 C2 강등 기대를 "정상 구조화" 기대로 교체.

**완료 기준**: **L3+L2 동시 해제** 후 LLM이 prior_award 구조화 criterion을 발행 → 계약 즉시 통과(assert 실패 0). **L1(분해기)은 아직 유지**(deterministic splitter flag off). 신규 값 스키마 검증 테스트. 배포 원자성 회귀(L2 emit + L3 미해제 조합이 CI에서 재현되지 않음 확인).

### P5 — L1 분해기 해제 + splitter flag on

- `packages/core/src/prior-award/extract.ts`(P3 신설 splitter): `PRIOR_AWARD_SPLIT` flag를 **on**으로. `disqualification/extract.ts`의 `PRIOR_AWARD_PATTERN`(:114) residual 처리를 splitter 구조화 emit으로 교체. `!isPriorAward` 가드(:336, :476) 제거. **L1 해제.**
- `packages/core/src/kstartup/normalize.ts`: exclusion-text 블록에서 prior_award splitter 선실행. normalizer version 범프.
- 방어층 테스트 갱신: `extract.test.ts:82-119` C2 케이스를 **flag on 스위트에서** "구조화 성공" 기대로 교체(#8/#10/#13/#20 문장이 올바른 scope/self_kind/state로 구조화, `consumedSpans`로 이동).

**완료 기준**: 3층 전부 해제(L3+L2 P4, L1 P5). splitter flag on. 27종 표 #8/#10/#13/#20 문장이 구조화됨(오귀속 0). **방어층 완전 해제 완료 지점.**

### P6 — 백필·재계산

> 🟡 dry-run·검수 배선 완료(2026-07-12): `backfill:kstartup-renormalize -- --active-only --prior-award-split`이 DB write 없이 활성/unknown 409건을 재정규화해 criteria 1,297→1,307, prior_award 10건, 오류 0을 보고했다. split write는 `--prior-award-annotations`가 필수이며 현재 입력 해시·criterion 완전 일치가 10/10인 reviewed JSONL 없이는 preflight에서 중단된다. 활성 BizInfo legacy exclusion 4건은 `plan:prior-award-legacy-remediation`으로 2건 deterministic v2 후보, 2건 targeted human rewrite로 분류했고 write-ready는 0이다. 실제 write·normalizer version 범프·match_state 재계산은 미실행이다.

> 🟡 실제 프로필 등급 영향 read-only 측정(2026-07-12): 신규 prior_award 후보가 생기는 K-Startup 9개 공고와 DB의 회사/사용자 프로필 scope 113개를 전수 조합해 1,017쌍을 비교했다. 구조화 prior_award 프로필은 0/113, legacy 문자열만 있는 프로필은 1/113이었고, prior_award trace는 1,017/1,017 모두 unknown이었다. 그 결과 eligibility는 `ineligible→ineligible` 401, `conditional→conditional` 616으로 전이 0건, recommendation tier도 `not_recommended→not_recommended` 401, `needs_core_review→needs_core_review` 613, `needs_profile_input→needs_profile_input` 3으로 전이 0건이었다. 이는 신규 criterion이 거짓 pass·부당 ineligible을 만들지 않는다는 안전 근거인 동시에, **파서 활성화만으로는 현재 추천 품질이 개선되지 않고 구조화 설정·점진 질문 응답 수집이 반드시 함께 배포되어야 함**을 뜻한다.

- kstartup 전량 + bizinfo 재정규화(prior_award 구조화 반영). skipUnchanged 우회 강제 재발행(Minor-6 전례, `archiveBizInfoCore.ts`). bizinfo LLM 재추출 비용 산정(참고: 차원확장 전량 ≈$4.6).
- **v1 잔존 청산**(§7.1 재조회): 활성 prior_award exclusion 4건(그중 scope 없는 `not_in` 2건=현행 false-pass 위험)을 재발행 대상으로 확인.
- match_state 재계산(`ruleset-kstartup-spine-v5`).

**완료 기준**: prior_award 구조화 criterion 생성 수 보고. v1 잔존 exclusion 0. tier 분포 층화 측정(신규 prior_award criterion이 생긴 공고의 티어 변화 — M7 전례).

현재 dry-run/검수 명령과 산출물:

```bash
pnpm backfill:kstartup-renormalize -- --active-only --prior-award-split
pnpm plan:prior-award-legacy-remediation
pnpm export:prior-award-legacy-review-tasks -- --force
pnpm measure:prior-award-tier-impact
```

- K-Startup split write gate: 독립 검수 10/10 + 현재 입력 fixture 일치가 필수.
- BizInfo legacy review: `tmp/prior-award-legacy-review-workbench.html` (4건)
- BizInfo legacy tasks/annotations: `tmp/prior-award-legacy-review-tasks.jsonl`, `tmp/prior-award-legacy-draft-annotations.jsonl`
- legacy 2건은 현 스키마로 자동 축약 금지: 달성군 군비 지원 이력의 기관 범위, 안산시 BI 사업 질문형 polarity를 사람이 확정해야 한다.

### P7 — 골든·통합 검증

> 🟡 golden 구현 완료(2026-07-12): 시나리오 golden 11건은 contract/trace/eligibility 전건 통과(unknown 3/pass 4/fail 4). 별도 legacy regression은 운영 38건의 실제 value key histogram과 adapted 결과를 고정하고 빈 프로필 38/38이 unknown인지 확인한다. 이 과정에서 `program` 단수 누락과 비canonical `free:free:` 이중 prefix 버그를 수정했다. 실제 UI/HTTP e2e는 남아 있다.

- `packages/core/golden/matching/`에 prior_award 시나리오(self·program·program_type·미질의·연도미상·기간밖) 추가.
- 전체 회귀: typecheck·test·build, `verify:service-data`(미종료 현상 — 출력 완주 판정).
- 시각 검수: 수혜 이력 문항·CTA·설정 패널(dev 서버 사용자 기동).

**완료 기준**: 골든 전건 통과. §6 완료 기준 충족.

현재 golden 명령:

```bash
pnpm verify:prior-award-golden
pnpm verify:prior-award-legacy-regression
```

## 6. 온보딩 저부담 문항 설계

수혜 이력은 결격 체크리스트보다 부담이 크다(자유 입력·회상 필요). 저부담 원칙:

1. **1차 게이트는 self_kind 구분 문항(B2, B6)**. 단일 예/아니오 boolean이 아니라 self_kind별로 분화해 묻는다(단일 boolean은 실측 범위 붕괴 — §D2). 가장 흔한 현재형부터 저부담으로:
   - (a) "현재 다른 정부·지자체 지원사업을 수행 중이거나 이번 사업과 동일·유사한 지원을 받고 있나요?"(→ `self_flags.current_similar`, #8 해소).
   - (b) "올해(당해연도) 다른 부처·공공기관의 유사 정부보조금을 중복 수혜하고 있나요?"(→ `self_flags.same_year_other_support`, #20 해소).
   - (c) same_project·same_business_prior은 해당 self_kind criterion이 걸린 공고에서 lazy 명확화 문항으로("이번 공모에 과거 선정된 적이 있나요?" 등). (a)의 응답으로 자동 커버하지 **않는다** — 범위별 독립 게이트(B2).
   - **incubation_tenancy는 기본 2문항에서 제외(B6)**. 활성 잔존 0건(§7.4)이므로 실제 `channel:"incubation_tenancy"` criterion이 걸린 grant에서만 lazy question("현재 다른 창업보육센터·BI에 입주 중인가요?" → `has_incubation_tenancy`)으로 노출.
2. **program_type은 그룹 체크리스트**: "다음 프로그램을 수료·참여한 이력이 있나요?"(청년창업사관학교·Start-up NEST 등 사전 program_type 일괄, "해당 없음" 버튼). 결격 그룹 체크리스트(`DISQUALIFICATION_QUESTIONS`, canonical.ts:174) 전례. 응답은 `known_program_types`에 커버 기록.
3. **특정 program 상세 이력은 "해당 criterion이 걸린 공고에서는 선택이 아니라 전제"(B1 정정)**. §6 원안이 "상세 이력은 선택 입력"이라 서술했으나, 특정 `program` criterion(예: 초기창업패키지 재지원 금지)이 걸린 공고에서는 그 program에 대한 이력 응답이 **해당 criterion 해소의 전제**다 — 미응답이면 `known_programs` 커버 게이트가 걸려 판정이 unknown으로 남고 pass 확정되지 않는다(false pass 차단, B1). 따라서 그런 공고에서는 상세 이력 문항이 "선택"이 아니라 "이 공고 판정에 필요한 확인"으로 유도된다. 자동완성은 canonical 사전 label 목록 사용, 연도 미상 허용(→ 기간 조건은 unknown 유지). 특정 program criterion이 없는 일반 공고에서는 상세 이력이 여전히 선택 입력이다.
4. grant 검색 연동은 §7.3 근거로 **보류**(연차·기수 분산으로 자동완성 정확도 낮음). canonical label 자동완성으로 대체.

## 7. DB 실측 (운영 Supabase, 2026-07-12, 읽기 전용)

최초 설계 시점에는 `grant_criteria` 87,770행 / `grants` 31,388행, prior_award 37행이었다. 구현 중 `pnpm audit:prior-award-readiness`로 2026-07-12 22:54 KST에 재조회한 현재값은 prior_award 38행, 활성(open/upcoming) 30행이다. 아래 §7.1·§7.7은 재조회값을 우선한다.

### 7.1 prior_award + exclusion 활성 잔존 4건 (방어층 우회 진단)

재조회 결과 활성 legacy exclusion은 4건(`not_in` 2, `text_only` 2)이다. 이 중 `not_in` 2건은 v2 `scope`가 없어 현재 계약 검증에도 실패하며 **현행 false-pass 위험**으로 분류한다. 최초 조사에서 확인한 대표 문구는 다음과 같다.
- `text_only`: "정부 또는 지방자치단체 및 유관기관으로부터 동일 또는 유사한 내용의 지원을 받은 사실이 있거나…참여중인 경우" (self-scope 전형)
- `not_in`: "□ 2024ㅡ2025년 안산시 BI 입주기업 브랜드 강화사업 참여기업인가?" (특정사업 지시)
- `text_only`: "과거 본 사업(변화와 기회의 경기창업공모 등) 입상여부" (self-scope, 본 사업)

→ **P6 백필이 v1 잔존을 재발행해야 함**(신규 방어층은 신규 추출만 커버, v1 잔존은 미청산). 이것이 방어층의 사각지대.

### 7.2 자기참조형 vs 특정사업명 지시형 분포 (D1/D2 근거)

중복수혜 계열 528건 중: **자기참조/동시참여형(동일·본·당해·유사·타부처·중복입주) ≈ 168 vs 특정 사업명 지시형(사관학교·NEST·패키지·바우처 등 고유명) ≈ 24**. 약 7:1로 self-scope가 압도. → 단일 `programs[]`로는 다수를 표현 불가, self-scope 신설 필수.

표본(scope=self 전형): "정부, 지방자치단체 등 유사 사업 중복참여자", "당해연도(2026) 타 부처, 공공기관 등에서 실행하고 있는 유사 정부보조금 지원사업과 수혜가 중복되는 기업", "타 부처 창업지원관련 사업화자금 지원을 받고 있는 기업(협약기간 중복 불가)".
표본(scope=program_type): "他 NEST Space 중복 지원 불가", "청년창업사관학교·글로벌창업사관학교·딥테크창업사관학교 수료/참여".
표본(우대 방향, D5): "세종시 창업강좌 수료자 우대", "홍익대학교 창업성장지원단 출신 기업 우대".

### 7.3 grants 사업명 연차·기수 분산 (D3 canonical 사전 채택 근거)

canonical 토큰별 grant title ilike 매칭 수: 소셜벤처 248 / 초기창업패키지 229 / TIPS 166 / 예비창업패키지 110 / 창업사관학교 102 / 메이커스페이스 81 / 창업도약패키지 56 / 로컬크리에이터 46.

"초기창업패키지" title 실례: "2026년 초기창업패키지 Bridge to Vietnam", "성신여자대학교 초기창업패키지 …마케팅 프로그램", "2019년 국민대학교 초기창업패키지 …교육생 모집", "고려대학교 초기창업패키지 KU IR DAY", "2025년 초기창업패키지(딥테크) TIPS STAGE 데모데이", "2026년도 초기창업패키지(딥테크 특화형) 창업기업 모집공고". → 같은 사업이 연도·대학·세부트랙·하위행사로 극심 분산. **FK 조인은 어느 grant를 가리키는지 확정 불가 → canonical 문자열 사전 안 채택.**

### 7.4 #10·#20 표현 가능성 (D6 근거)

활성(open/upcoming) `other` 1,190행 중 중복수혜 계열 72건. 그중 **#10 중복입주 활성 0건**(전 코퍼스 54건은 전부 마감), **#20 타부처/유사사업 중복 활성 10건**. #10 표본은 전부 "보육센터/BI 물리적 중복입주"(예: "중앙정부·지자체·대학 창업보육센터 입주 중…복수 공간 동일기간 중복입주 불가") — 재정지원과 층위가 다른 **동시 점유** 조건. → #20은 `scope:"self"`로 흡수, #10은 `channel:"incubation_tenancy"` 별도 태그(D6).

### 7.5 기간 조건 빈도 (D8 근거)

중복수혜 계열 537건 중 "최근 N년/개월" 기간 명시 45건(≈8%). 소수지만 오판정 시 결격 오인 비용 큼 → `within` 표현 신설, 연도 미상은 unknown(assumed-pass 금지).

### 7.6 현행 prior_award 38건 구성 (하위호환 대상)

`required/text_only` 15, `preferred/text_only` 8, `preferred/exists` 3, `preferred/in` 3, `required/in` 2, `required/exists` 2, `exclusion/text_only` 2, `exclusion/not_in` 1, `preferred/not_in` 1. required/exists 사례("전북도 통상닥터 참여기업이어야 함") = 전제 이력 필수(§4.2 required 행). 운영 snapshot의 실제 키는 `note/program/awards/labels/period/support_type/years`이며 evaluator 폴백이 전부 흡수한다.

재조회 시점 38건 분포는 위와 동일하되 `exclusion/not_in`이 1→2로 증가했다. parser version은 v1 17건, v2 21건이다.

### 7.7 P5 활성화 readiness dry-run (2026-07-12 22:54 KST)

재현 명령: `pnpm audit:prior-award-readiness` (DB read-only, 외부 API/LLM/DB write 없음).

- 활성 K-Startup raw 310건에서 flag 기본 off는 prior_award 0건으로 L1 방어 유지.
- 메모리에서 flag on 시 9개 공고·10 criteria 생성(self 5, program 4, program_type 1), parse failure 0, 계약 위반 0.
- 표현 불가능한 금액·동시 과제 수 임계는 residual로 되돌리고, 불릿·한글 번호·prior 시작구문·절차 조건 경계로 재분할했다. 한 공고의 서로 다른 named-program/self 조건은 2개 criterion으로 분리한다.
- 자동 위험 규칙(`overbroad_span`, `mixed_unrelated_exclusion`) 검출은 0건이며 automated quality gate는 통과했다.
- 실제 10개 criterion × 3개 프로필 상태 false-pass 매트릭스도 30/30 통과: 미응답 `unknown`, 명시적 비해당 `pass`, 해당 이력 `fail`. 이 매트릭스 실패도 automated quality gate를 즉시 닫는다.
- 활성 `other/text_only` prior_award 신호 후보는 53건(BizInfo 44, K-Startup 9).
- 결론: 독립 사람 검수 필요 10건, 승인 0건이라 `autoActivationReady=false`, **P5 운영 flag는 no-go**. 10개 criterion 전건 독립 검수 전에는 기본값을 true로 바꾸지 않는다.

검수 산출물 생성:

```bash
pnpm export:prior-award-review-tasks -- --force
```

- review tasks: `tmp/prior-award-p5-review-tasks.jsonl` (9개 공고)
- draft annotations: `tmp/prior-award-p5-draft-annotations.jsonl`
- 독립 검수 HTML: `tmp/prior-award-p5-review-workbench.html`

Workbench에서 1차 annotator와 별도 human reviewer가 확정한 JSONL을 내보낸 뒤 다음으로 재검증한다.

```bash
pnpm audit:prior-award-readiness -- --annotations=<reviewed-annotations.jsonl>
```

parser가 독립 reviewer 메타데이터를 검증하고, 현재 deterministic 후보와 criterion ID·operator·value·source span이 정확히 같은 항목만 accepted로 센다. 10/10 전에는 `autoActivationReady`가 true가 되지 않는다.

### 7.8 실제 프로필 등급 영향 기준선 (2026-07-12, 읽기 전용)

재현 명령: `pnpm measure:prior-award-tier-impact` (DB read-only, 회사 식별자를 출력하지 않음).

- 대상: prior_award 신규 후보 영향 K-Startup 9개 공고 × 현재 프로필 scope 113개 = 1,017쌍.
- 프로필 커버리지: 구조화 prior_award 0/113, legacy-only 1/113, prior_award confidence known 1/113.
- 판정: prior trace known 0, unknown 1,017. eligibility 전이 0, recommendation tier 전이 0.
- 안전성 해석: 미응답을 pass로 간주하지 않아 거짓 통과와 신규 부당 탈락은 관측되지 않았다.
- 제품 해석: 운영 flag·백필보다 구조화 설정 폼·해당 공고의 lazy 질문·자동채움 응답 수집이 실질 개선의 필수 조건이다. 배포 후 동일 명령으로 `priorKnownPairCount > 0`과 `conditional→eligible|ineligible` 전이를 재측정한다.

## 8. 리스크와 완화

| 리스크 | 완화 |
|---|---|
| **미질의 이력 false pass**(C1 재발, B1) | known 게이트 재사용(D4) + **program·program_type 양쪽 커버 완전성 테스트**(B1 — scope="program"도 `known_programs` 게이트로 records empty false pass 차단) + §4.2 unknown 케이스 |
| **self-scope 범위 붕괴**(B2) — 단일 boolean이 서로 다른 범위(현재형·당해연도 타부처·본사업 과거·동일과제)를 뭉갬 | self value에 `self_kind` 축 분화 + 프로필 `self_flags` 범위별 플래그. 범위별 독립 known 게이트로 "한 범위 응답이 다른 범위를 커버하지 않음"(§4.2) |
| **self-scope 과대 배제** — "동일·유사 지원 수혜 중"을 넓게 잡으면 정상 기업 오배제 | self 판정은 사용자 자가신고 플래그(`self_flags[kind]`)에만 의존, grant 자동 대조 안 함(D2). 메시지에 "자가신고 기준" 고지 |
| **canonical 정규화 미스** — 신종 program 표기를 key에 못 매핑 | 매칭 실패 시 자유 표기 보존(self-scope 판정 무영향), program 지시형만 영향. 사전은 실측 상위 토큰부터 점증 |
| **방어층 조기 해제 → false pass / 배포 간극 런타임 실패**(B4) | D7 층별 단계 해제. **L3+L2는 원자 배포(P4)**, L1은 P5. 각 층 해제 Phase에 테스트 갱신 세트로 묶음. L2 emit이 L3 미해제 배포에서 assert 실패하지 않도록 원자성 회귀 |
| **v1 잔존 exclusion 미청산**(§7.1, scope 없는 not_in 2건 활성) | P6 백필이 v1 잔존을 재발행 대상에 포함. 완료 기준에 "v1 prior_award exclusion 0" 명시 |
| **연도 미상 → 과대 unknown** | 기간 조건 있는 공고에서만 unknown. 기간 무관 공고는 연도 없이도 판정 가능(D8) |
| M3 프로필 silent drop | drizzle.ts 양방향 매핑 명시(P2) + e2e 잔존 케이스. 결격 축 :919-929 전례 |
| openapi 하드코딩 누락(M2) | P0 `openapi.ts:1352` 인접 등재 |
| 저장된 매칭 스냅샷 혼재 | P6 재계산 + `ruleset-kstartup-spine-v5` 범프 |
| 하위호환 회귀 — 기존 37 prior_award 판정 변화 | evaluator v1 폴백(§4.1) + 골든 회귀 100% |

## 9. 완료 기준 (측정 가능)

1. **27종 표 #8/#10/#13/#20이 자동 판정 가능**: #8/#20은 `scope:"self"`(self_kind별) exclusion으로, #10은 `channel:"incubation_tenancy"`로, #13은 `program_type` state 매트릭스로 구조화. 각 유형 골든 케이스 pass/fail/unknown 판정 정확.
2. **false pass 0**: §4.2 매트릭스 전 행 통과 — 특히 미질의 self_kind(unknown)·**program 미질의(records empty, unknown, B1)**·연도미상(unknown)·기간밖(pass)·자기참조(self_flags 게이트) 케이스.
3. **방어층 단계 해제 완료(B4)**: **L3+L2 원자(P4)·L1(P5)** 순으로, 각 해제 시 대응 테스트(`criteria-contract`·`llm-criteria-normalize`·`extract`) 갱신 통과. L2 emit + L3 미해제 배포 간극 재현 0(assert 실패 0). 일괄 해제 흔적 0.
4. **자기참조 계약 표현(B2)**: `PriorAwardCriterionValue.scope="self"` + `self_kind`로 "동일 사업 기수혜/동시참여/당해연도 타부처/동일과제"를 범위 구분해 계약 레벨에서 표현. C2 리뷰 "현행 계약으로 표현 불가" + 범위 붕괴 해소.
5. e2e: self_kind 문항 응답 → eligible/ineligible 확정 전환 + 답변(self_flags·known_programs·records) 잔존(M3) + 설정 패널 정정.
6. 계약 복제 지점(§3.4) 일치: CriterionValue union·CompanyProfile·openapi·JSON Schema. reason code는 `profile_missing` 재사용(B7 — 신규 enum 0).
7. **program·program_type 양쪽 커버 완전성 테스트 통과**(B1 — 사전-문항 동기화, C1 미러). program 커버 게이트가 records empty를 false pass로 흘리지 않음.
8. 백필 후 v1 `bizinfo-llm-criteria-v1` prior_award exclusion 잔존 0(§7.1) + 활성 중복수혜 계열 `other` 잔존 감소 보고.
9. 기존 golden 회귀 100%: **38건 실측 value-key/adapted `adaptV1` 어댑터 무회귀**(B3, §4.4).

## 리뷰 반영 기록 (2026-07-12, codex gpt-5.5 xhigh fast mode 심층 리뷰)

리뷰 종합 판정: **재설계**. 발견 7건(Critical 2 · Major 3 · Minor 2)을 전건 반영해 self-scope 범위 붕괴·program 커버 게이트 부재·방어층 배포 원자성을 바로잡고 "조건부 승인" 수준으로 끌어올림. 반영 결과 §0 범위·§2 D2/D4/D6·§3.1/3.2 타입·§4.1 evaluator·§4.2 매트릭스·§4.3 reason·신설 §4.4 v1 어댑터·§5 Phase(P1/P3/P4/P5)·§6 온보딩·§8 리스크·§9 완료 기준이 초안과 다름.

| 발견 | 심각도 | 결정·반영 |
|---|---|---|
| B1 scope="program" program 단위 known 게이트 부재 → records empty 시 exclusion false pass(C1 재발) | Critical | `PriorAwardProfileValue.known_programs` 신설. §4.1 scope="program" 분기에 `요구 program − known_programs ≠ ∅ → unknown` 커버 게이트(`evaluateDisqualification` 패턴 미러). §4.2에 "program 미질의 records empty → unknown" 행. §6-3 "상세 이력 선택 입력"을 정정 — 특정 program criterion 공고에선 이력 응답이 criterion 해소의 전제. D4 근거를 program·program_type 양쪽 커버 게이트로 확장 |
| B2 self 단일 boolean 환원이 실측 범위(현재형·당해연도 타부처·본사업 과거·동일과제)를 붕괴 | Critical | `PriorAwardSelfKind`(`current_similar`｜`same_project`｜`same_business_prior`｜`same_year_other_support`) 축 신설. value에 `self_kind`, 프로필 단일 boolean → `self_flags: Partial<Record<PriorAwardSelfKind,boolean>>` 분리. §4.1 self 분기·§4.2 매트릭스(self_kind별 분화·범위별 독립 게이트)·§6-1 문항(단일 예/아니오 → self_kind 구분)·D2 근거 전면 개정 |
| B3 하위호환 폴백이 실측 형식(`{program}`·`{awards}`·`{note}`/`text_only`) 미포괄 | Major | 신설 §4.4 `adaptV1` + 38건 legacy snapshot. 실측 단수 `program`과 `free:` idempotence까지 회귀 고정. §9-9 개정 |
| B4 방어층 해제 Phase 번호 충돌(요약행 L3(P4)·L2(P5) vs 실제 P4가 L3+L2 동시) → LLM 정규화 즉시 assert(`llm-criteria.ts:134`)로 배포 간극 시 런타임 실패 | Major | 선택지 (i) 채택 — L3(계약 허용)+L2(강등 제거·emit)를 **P4 원자 배포**, L1은 P5로 확정. §5 요약행·P4 헤더(원자성 blockquote)·P5 헤더·§8 리스크·§9-3 완료 기준을 "L3+L2(P4)·L1(P5)"로 일관 정정. 배포 원자성 회귀(L2 emit+L3 미해제 재현 0) 추가 |
| B5 P3 "별도 함수라 C2 테스트 통과" 가정 취약(통합 경로 안전성 미보장) | Major | prior-award splitter를 **별도 모듈 `prior-award/extract.ts` + feature flag `PRIOR_AWARD_SPLIT`**로 설계 명시. flag off(P3~P4)=기존 C2 통합 테스트(`extract.test.ts:82-119`) 유지, flag on(P5)=#8/#10/#13/#20 구조화 스위트. P3·P5 작업목록·완료 기준에 flag 게이팅 반영 |
| B6 #10 incubation_tenancy 온보딩 과잉(활성 0건인데 전 사용자 기본 2문항 게이트) | Minor | §6-1 기본 2문항에서 incubation_tenancy 제외 → 실제 `channel:"incubation_tenancy"` criterion 공고에서만 lazy question. D6·§6·§4.2 매트릭스 갱신 |
| B7 unknown reason code 신설 불요 — `profile_missing` 재사용이 안전 | Minor | §4.3 열린 결정을 "prior_award unknown은 기존 `profile_missing` 재사용, dimension/message로 구분"으로 확정(`prior_award`가 `DISQUALIFICATION_AXES` 밖이라 match.ts:986-999가 자동 부여). 신규 enum/openapi 복제 없음. analytics 세분 필요 시 M2 체크리스트와 함께 후속 단서. §9-6 개정 |

리뷰가 확인한 유효 전제(변경 없음): D1 판별 유니온 신설, D3 canonical 문자열 사전(FK 기각, §7.3), D5 상태 3분류·극성 매트릭스, D7 층별 단계 해제 원칙, D8 within 기간·연도미상 unknown, D9 자가신고 confidence 0.6, M2/M3 복제·silent-drop 방지 지점.
