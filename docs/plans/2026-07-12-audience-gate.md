# P6 audience 상류 게이트 — 구현계획 설계

> 🟠 상태: 리뷰 반영 완료(조건부 승인 → 반영). 심층 리뷰(codex gpt-5.5 xhigh fast mode) 발견 5건(Major 4·Minor 1) 전건 반영 완료(§리뷰 반영 기록). 사용자 승인 후 별도 세션에서 구현.
> 출처 핸드오프: `docs/plans/HANDOFF-2026-07-12-p6-prior-award-design.md` 트랙 1
> 단일 원천(기반 트랙): `docs/plans/2026-07-11-matching-dimension-expansion.md` (§1 D8·P6 골격, §6 M2 enum 복제 전례)
> 근거 연구: `docs/research/2026-07-11-공고매칭-14차원-확장-검토.md` §3.3(개인 대상 공고는 상류 게이트), `docs/research/2026-07-11-차원확장-백필-층화측정.md`(백필 실측 방법론)

---

## 0. 목표 · 범위 · 비범위

**문제**: 개인 대상 공고(재직자 교육, 심사역 양성, 포상·공모전, 청소년·대학생 대상 등)가 기업 매칭 우주에 섞여 있다. 이들은 "차원(dimension)이 없어서" 새는 것이 아니라 **공고의 대상 자체가 기업이 아니다** — 차원 신설(결격 축 트랙)로는 풀 수 없고, 매칭 진입 전 상류에서 걸러야 한다(근거 연구 §3.3, §7-2). 현재는 이 공고들이 결격/자격 criteria로 걸러지길 기대하는 구조라 `needs_core_review`/`not_recommended`로 새며 노이즈를 만들고, "만 N세" 류 개인 연령 조건이 미구조화 잔여로 남는다(DB 실측 §5: grant_criteria에 "만 N세" 텍스트 8,227행).

**목표**: grants 레벨에 `audience` 분류(`company | individual | mixed | unknown`)를 두어, `individual` 공고를 기업 매칭 우주에서 제외한다. 분류는 **①structured 신호(kstartup `aply_trgt` 코드값) → ②룰(고정밀 individual 키워드) → ③LLM 보조(애매 케이스만)**의 3단으로 하되, **오분류 비용 비대칭**(기업 공고를 individual로 오분류 = 매칭 기회 상실이 훨씬 비쌈)을 분류 임계에 명시적으로 반영한다.

**범위**:
- grants `audience` PG enum 컬럼 + 마이그레이션
- 분류기(structured/rule/LLM 3단) + canonical 신호 사전
- 백필(kstartup 29,429 + bizinfo 1,959 전량) + LLM 보조 비용 산정
- 매칭 통합(`listActiveGrants` 필터 권고안) + match_state 정합
- ingestion 배선(신규 수집 시 자동 분류)
- 계약(enum 복제 지점 전수) + 최소 UI 노출(별도 섹션은 후속)

**비범위**:
- **prior_award 구조화** — 별도 트랙(`docs/plans/2026-07-12-prior-award-structuring.md`, 핸드오프 트랙 2). audience와 독립.
- 결격 축 신설(tax/credit/sanction 등) — 완료된 기반 트랙(§0 22차원).
- `individual` 공고를 별도 제품 섹션("개인 대상 공고 보기")으로 노출하는 완결 UI — 이번엔 매칭 우주 제외까지만. 별도 섹션은 후속 결정(D8).
- 이 문서는 구현 금지 전제가 아니다. **이 문서 자체가 후속 구현 세션의 지침**이다.

---

## 1. 설계 결정 (D-번호)

| # | 결정 | 근거 | 기각 대안 |
|---|---|---|---|
| **D1** | `audience`는 **grants 테이블의 PG enum 컬럼**(`company \| individual \| mixed \| unknown`). criterion dimension으로 만들지 않는다 | 개인 대상은 "조건"이 아니라 "공고의 성격"이다. dimension으로 넣으면 매칭 파이프라인 안에서만 판정되어 우주 제외(상류 차단)를 못 한다. grants 컬럼이라 criteria 재발행과 독립 — 결격 트랙 재정규화 없이 단독 백필 가능(핸드오프 3) | dimension 신설: 상류 차단 불가, CORE_GATE 오염 |
| **D2** | **enum 4값 확정, `unknown` 기본값**. `mixed`(기업+개인 혼합)를 처음부터 포함 | PG enum은 값 제거 불가·추가 마이그레이션 반복 비용(기반 트랙 D1 교훈). mixed를 나중에 추가하면 재마이그레이션 | 3값(company/individual/unknown)으로 시작: mixed 케이스가 실존(§6), 후에 enum 추가 비용 |
| **D3** | **컬럼 저장 방식은 pgEnum**(`f_authoring_mode`의 text+타입union 전례와 다름). 다만 계약 계층은 `AUTHORING_MODES` 상수+`AuthoringMode` 타입union 전례를 그대로 따른다 | 핸드오프 원안(P6)이 "grants `audience` 컬럼(enum)"으로 못박음. DB 무결성(enum 제약)이 audience 4값에 유의미. 계약은 단일 원천 상수(§3.1) | text 컬럼(authoring_mode 방식): DB 레벨 오염값 방지 이점 포기 |
| **D4** | **분류 임계는 비대칭**: individual 확정은 **보수적**, 애매하면 `unknown`(=기업 우주 유지). false individual(기업→individual 오분류)의 비용이 false company(individual→company 오분류)보다 크다 | 오분류 비용 비대칭(핸드오프 트랙 1-1). false individual = 유효 공고가 사용자에게서 영원히 사라짐(silent loss). false company = 노이즈 1건(현행 baseline과 동일, 회귀 아님). unknown은 현행 유지라 안전 | 대칭 임계: false individual 양산 → 유효 공고 손실 |
| **D5** | **분류 신호 우선순위: ①structured(kstartup `aply_trgt`) → ②rule(고정밀 individual 키워드) → ③LLM(①②가 unknown/충돌인 것만)**. structured가 명확한 company 토큰을 포함하면 company로 조기 확정(LLM 미호출) | kstartup `aply_trgt`는 닫힌 어휘 categorical(§5). 대다수를 무료·deterministic으로 처리 → LLM 비용·오분류 최소화. bizinfo는 structured company-type(`trgetNm`)이 100% 기업이라 대부분 company 조기 확정 | 전량 LLM: 비용 과다·비결정성. 전량 rule: recall 부족 |
| **D6** | **분류 입력 소스는 "제목 + kstartup `aply_trgt`/`aply_trgt_ctnt` + bizinfo `trgetNm`/`bsnsSumryCn`"**. 제목 단독 금지 | 제목 단독은 recall 낮음(§5: 재직자 title 40 vs raw payload 1,071). 신청대상 원문이 핵심 신호. 원문은 `grant_raw.payload` JSONB에 있음(schema.ts:566) | 제목만: recall 부족. 첨부 본문 전체: 토큰 폭증·신호 대비 노이즈 |
| **D7** | **매칭 통합은 `listActiveGrants`(drizzle.ts:72-82) 필터에서 `audience <> 'individual'` 제외**를 권고. 매칭 파이프라인(match.ts) 내 제외·UI 별도 섹션은 기각 | `matchGrantCriteria(criteria, company)`는 grant 객체를 받지 않음(match.ts:54 — criteria+company만). audience를 파이프라인에 넣으려면 시그니처 변경+전 caller(6곳) 수정 필요. `listActiveGrants`는 매칭 우주의 단일 관문(match_state refresh·dashboard·teaser 전부 이 함수를 경유). 여기서 제외하면 하류 전체가 자동 정합 | 파이프라인 내 early return: 시그니처 변경 침습적, individual이 이미 매칭 계산에 진입한 뒤라 낭비. UI만 숨김: 서버 매칭·match_state는 여전히 오염 |
| **D8** | **`mixed`는 매칭 우주에 포함**(company와 동일 취급). `unknown`도 포함(현행 유지) | mixed는 기업도 대상이므로 매칭 시켜야 함(오분류 시 false individual 방지 = D4 일관). unknown 제외 시 미분류 전량이 사라져 대재앙 | mixed 제외: 유효 기업 공고 손실 |
| **D9** | **백필은 grants 컬럼 단독 업데이트**. criteria 재발행·재정규화 불필요. 별도 `backfill-audience` 스크립트(kstartup renormalize 스크립트 전례) | audience는 criteria와 무관한 grants 컬럼(D1). 결격 트랙 재정규화와 완전 독립. dry-run/`--write`/`--active-only`/`--batch` 플래그 관례(renormalize-kstartup-from-raw.ts) | 재정규화 파이프라인에 끼워넣기: 결격 트랙과 결합·재발행 비용 |
| **D10** | **match_state 재계산은 audience 자체로는 불필요. 단, individual의 stale match_state를 "1회 정리"가 아니라 _전 경로 불변식_으로 보장한다(A4)**. (a) stale을 읽는 진입점 `listDueMatchTransitions`(drizzle.ts:397~) 쿼리에 grants join + `audience <> 'individual'` 필터를 넣고, **동시에** (b) audience가 individual로 바뀌는 **모든 경로**(백필·ingestion 재분류)에서 해당 grant의 match_state 행 DELETE를 실행 | match_state 값(eligibility/score)은 criteria로 산정되므로 audience가 값을 바꾸지 않음(재계산 무의미). 그러나 `listActiveGrants`가 individual을 빼도 `listDueMatchTransitions`는 **`schema.matchState`만 select하고 grants join이 전무**(drizzle.ts:407-420 — 따라서 audience 필터 불가)라, `transitionPlan.ts`(:27)가 이 경로로 stale individual 행을 계속 읽는다. 게다가 publisher는 grant upsert 뒤 기존 stale state를 지우지 않아 **1회 정리로는 불변식이 아니다**(재분류·재수집 때마다 재발). (a) 읽기 차단 + (b) 쓰기 시 삭제의 이중화로만 "stale individual 0"이 불변식이 됨 | 전량 match_state 재계산: 낭비(값 불변). **1회 정리만**: 재분류·재수집 경로에서 stale 재발(불변식 아님). 방치: stale individual 노출 |
| **D11** | **분류기는 신규 ingestion에도 배선**(kstartup normalize·bizinfo publish 경로). 백필과 동일 분류 함수 재사용 | 백필만 하면 신규 수집 공고가 unknown으로 유입 → 즉시 다시 individual 오염. ingestion 시점 자동 분류가 정상 상태 | 백필만: 신규 공고 미분류 누수 |
| **D12** | **ingestion 인라인은 deterministic(structured+rule)만, LLM 보조는 야간/백필 배치**로 unknown 잔여만 갱신. individual 확정은 골든 통과 전까지 human-review 또는 unknown 유지 | kstartup normalize는 동기 순수 함수, bizinfo는 순차 LLM 루프 — LLM을 인라인에 넣으면 수집 지연·실패면 증가(A2). deterministic 분류는 대다수를 무료·즉시 처리(§5.2 92.3% company 조기 확정)하므로 인라인에 적합. LLM은 비동기 배치로 분리해 수집 경로의 지연·실패를 격리. individual write는 golden-before-write(D-순서·A3)에 종속 | 전량 인라인 LLM: 수집 지연·실패면 확대. 인라인에서 individual 즉시 확정: 골든 검증 전 write 위반(A3) |

---

## 2. 오분류 비용 비대칭 · 분류 임계 정책 (D4 상세)

이 트랙의 핵심 안전 설계. 두 방향의 오분류 비용이 다르다:

| 오분류 | 결과 | 비용 |
|---|---|---|
| **false individual** (실제 기업 공고 → `individual`) | `listActiveGrants`에서 제외 → 사용자에게 **영원히 안 보임**(silent loss). 매칭 기회 상실 | **높음** — 제품 핵심 가치(공고 발견) 직접 훼손, 사용자가 손실을 인지조차 못 함 |
| **false company** (실제 개인 공고 → `company`/`mixed`/`unknown`) | 매칭 우주에 잔존 → `not_recommended`/`needs_core_review`로 표시 | **낮음** — 현행 baseline과 동일한 노이즈 1건. 게이트 미적용 상태로 회귀할 뿐, 새 손해 아님 |

**임계 정책(precision-over-recall for individual)**:

1. **rule 단계는 high-precision individual 신호만 채택**. individual 확정 규칙은 "개인만"을 강하게 시사하는 패턴에 한정한다(예: 제목 `청소년비즈쿨`+`aply_trgt`=`청소년` 동시 충족). 애매하면 rule은 `unknown`을 반환하고 LLM으로 넘긴다. **company 방향 규칙은 관대해도 됨**(structured company 토큰 존재 시 company 조기 확정 — false company는 저비용).
2. **structured company 토큰 우선**: `aply_trgt`에 `일반기업|1인 창조기업|연구기관|대학`이 하나라도 있으면 **company로 조기 확정, LLM 미호출**(§5 근거: 27,161/29,429 kstartup 행이 company 토큰 보유). bizinfo `trgetNm`은 100% company-type이라(§5) 기본 company.
3. **LLM 판단에도 individual 확정은 보수적 임계**: LLM `confidence < 0.85`의 individual 판정은 `individual`이 아니라 **`unknown`으로 강등**(=우주 유지, 안전). company·mixed 판정은 confidence 임계 완화. **초기값 0.85는 "LLM individual _후보_ 임계"로만 사용**하고, 실제 individual **확정** 임계는 P6a 골든 실측(individual precision ≥ 0.95 달성) 후 확정한다(A3 — golden-before-write). 즉 golden 통과 전에는 이 임계로 individual을 write에 확정 진입시키지 않는다.
4. **`mixed`는 항상 우주 포함**(D8). "기업도 대상이면 매칭"이 원칙 — mixed로 판정된 순간 이미 false individual 위험은 제거됨.
5. **불변 규칙**: 어떤 단계도 근거 신호 없이 individual을 확정하지 않는다. individual은 "적극적 individual 신호 + company 신호 부재"의 교집합에서만 나온다.

**골든 셋 구성**(P6a):
- **individual golden**(20~30건): DB 실측 §5의 individual-only `aply_trgt` 표본(일반인/청소년 no-company-token) + "만 N세" criteria 잔여 공고 + 재직자/심사역 title 표본. 사람 검수로 확정(AI 라벨 검수 없이 golden 승격 금지 — CLAUDE.md Gate 1 규칙 준용).
- **company golden**(30~40건): company 토큰 보유 + 키워드 함정 케이스(§5에서 실측된 "반려동물 창업 공모전 참가자"=창업벤처, "청년 뉴리더 양성사업 참여기업"=중소기업 등 — 공모전/양성/청년 키워드가 있으나 기업 대상). **false individual 오탐 방지의 핵심 시험대**.
- **mixed golden**(10건): "예비창업자 및 창업기업", "개인·법인 모두" 류.
- **측정 지표**: individual **precision 우선**(목표 ≥ 0.95 — false individual 최소화), recall은 부차(목표 ≥ 0.7). company recall ≥ 0.98(유효 공고 손실 방지).

---

## 3. 계약 · 스키마 상세

### 3.1 계약 enum 정의 (단일 원천)

기반 트랙 M2 교훈(openapi.ts enum 복제 4+1곳)은 이미 리팩터로 해소됨 — `enums.ts`가 leaf 단일 원천이고 openapi.ts는 spread로 참조(openapi.ts:1-6). **audience도 같은 단일-원천 패턴을 따르되, GrantSource/GrantStatus처럼 grant 객체에 붙는 필드는 openapi.ts에 하드코딩 enum이 남는 유형**임에 주의(§3.3).

신규(권고): `packages/contracts/src/enums.ts`에 상수 추가
```ts
export const GRANT_AUDIENCES = ["company", "individual", "mixed", "unknown"] as const;
```
`packages/contracts/src/index.ts`
```ts
export { GRANT_AUDIENCES } from "./enums.js";        // re-export
export type GrantAudience = (typeof GRANT_AUDIENCES)[number];
export const GRANT_AUDIENCE_LABELS: Record<GrantAudience, string> = {
  company: "기업 대상",
  individual: "개인 대상",
  mixed: "기업·개인 혼합",
  unknown: "미분류",
};
```
`Grant` 인터페이스(index.ts:252-286)에 필드 추가:
```ts
audience?: GrantAudience;   // f_authoring_mode 전례와 동일 위치·관례(옵셔널, 기본 unknown)
```

### 3.2 DB 스키마

`apps/web/src/lib/server/db/schema.ts`:
- pgEnum 선언(grantSourceEnum:48 인근):
  ```ts
  export const grantAudienceEnum = pgEnum("grant_audience", ["company", "individual", "mixed", "unknown"]);
  ```
- grants 테이블(schema.ts:575-619)에 컬럼:
  ```ts
  audience: grantAudienceEnum("audience").notNull().default("unknown"),
  ```
- 인덱스(부분 필터 성능 — `listActiveGrants`가 `audience <> 'individual'`를 매번 평가):
  ```ts
  audienceIdx: index("grants_audience_idx").on(table.audience),
  ```

### 3.3 계약 복제 지점 전수 목록 (M2 전례 — audience 신설 시 손댈 곳)

audience는 **grant 객체에 실리는 필드**라 openapi.ts에서 GrantDetail·MatchCard 스키마에 하드코딩 enum이 필요하다(GrantSource/GrantStatus와 동형). 아래를 전수 갱신:

| # | 지점 | file:line | 작업 |
|---|---|---|---|
| 1 | 단일 원천 상수 | `packages/contracts/src/enums.ts` (신규 추가, CRITERION_DIMENSIONS:9 인근) | `GRANT_AUDIENCES` 배열 |
| 2 | re-export + 타입 + 라벨 | `packages/contracts/src/index.ts:82-90`(GrantSource/GrantStatus 인근) | export·`GrantAudience`·라벨. `Grant`(252-286)에 필드 |
| 3 | openapi `GrantDetail.audience` | `packages/contracts/src/openapi.ts:1073-1090`(source:1078·status:1084 인근) | `audience: { type:"string", enum:[...GRANT_AUDIENCES] }` — spread 참조로 하드코딩 회피 |
| 4 | openapi `MatchCard.audience` (노출 시) | `packages/contracts/src/openapi.ts:874-920`(source:897·status:901 인근) | UI가 카드에서 audience를 쓰면 추가. 안 쓰면 생략 |
| 5 | JSON Schema | `packages/contracts/schemas/grant-criteria.schema.json` | **복제 대상 아님(A5 확정)**: export된 JSON Schema는 `grant-criteria.schema.json`(GrantCriterion 전용)뿐이고 **grant 객체 스키마는 존재하지 않는다**. audience는 grant 객체 필드라 이 스키마와 무관 → 갱신 불필요. grant 객체 계약의 복제 대상은 openapi `GrantDetail`(#3)뿐 |
| 6 | pgEnum | `apps/web/src/lib/server/db/schema.ts:48` 인근 | §3.2 |
| 7 | drizzle→Grant 직렬화 | `apps/web/src/lib/server/repositories/drizzle.ts:620-654` `toGrant` | `audience: row.audience as GrantAudience` 매핑 추가(누락 시 silent drop — M3 유형 회귀) |
| 8 | **publisher 저장 매핑**(신규 수집→grants write) | `apps/web/src/lib/server/ingestion/normalizedGrantPublisher.ts:211~`(`grantInsertValues`)·`:219~`(`grantUpdateValues`) | **명시 화이트리스트 write** — `audience: grant.audience ?? "unknown"`를 insert·update 양쪽에 추가(A1). 누락 시 분류값이 저장되지 않고 `unknown` 유입(§P4·완료 기준) |

**검증**: 워크스페이스 typecheck. `rg -n '"company", "individual"' packages apps --type ts`로 하드코딩 잔재 0(spread 참조 강제). `Record<GrantAudience,` 컴파일 강제 지점(라벨) 완전성.

---

## 4. Phase 계획

> 실행 순서(A3 — golden-before-write): P0 → P1 → P2 → **P6a(골든 selection·측정: individual precision 실측)** → (P3 백필 · P4 ingestion 배선 병렬) → P5 통합 · 정리 → P6b(전체 회귀·시각 검수). 구현은 Phase별 Opus 서브에이전트 위임, 메인 검수.
>
> **write gate(A3, 불변식)**: individual을 실제로 write/필터에 진입시키는 두 지점 — 백필 `--write`(P3)와 `listActiveGrants`의 `audience <> 'individual'` 필터(P5) — 은 **P6a 골든에서 individual precision ≥ 0.95를 실측 확인한 뒤에만** 활성화한다. 그 전까지 P3 백필은 **dry-run·계측만**, P5 필터 배선은 **미적용(코드 준비까지만)**. 목표가 individual precision ≥ 0.95인데 검증(P6a)이 write(P3/P5) 뒤에 오면 미검증 individual이 silent loss를 유발하므로, 측정을 write **앞** gate로 이동한다.

### P0 — 계약 · canonical 신호 사전 (선행)

| 파일 | 작업 |
|---|---|
| `packages/contracts/src/enums.ts` | `GRANT_AUDIENCES` 추가 |
| `packages/contracts/src/index.ts` | re-export·`GrantAudience`·`GRANT_AUDIENCE_LABELS`·`Grant.audience` 필드(§3.1) |
| `packages/contracts/src/openapi.ts` | `GrantDetail.audience`(+필요 시 MatchCard) enum, spread 참조(§3.3) |
| ~~`packages/contracts/schemas/*.schema.json`~~ | **복제 대상 아님(A5)**: grant 객체 JSON Schema 미존재(`grant-criteria.schema.json`은 criteria 전용). audience는 이 스키마와 무관 — 작업 없음 |
| `packages/core/src/audience/canonical.ts` (신규) | **structured 신호 어휘**: kstartup `aply_trgt` company-token set(`일반기업·1인 창조기업·연구기관·대학`) / individual-token set(`일반인·청소년·대학생`), bizinfo `trgetNm` company-type set. **individual 키워드 사전**(제목·본문용, high-precision): `재직자·임직원·재직 중·직장인·심사역·심사위원·청소년비즈쿨·수강생·교육생 모집·만 ?N세` 등 + **company 확정 키워드**(관대): `기업·법인·사업자·소상공인·창업기업·입주기업`. 한국어 라벨 |
| 빌드 | `pnpm -F @cunote/contracts -F @cunote/core build` (core dist 미빌드 시 dev 미반영 — 메모리) |

**완료 기준**: typecheck 통과. `rg -n '"company", "individual"' packages apps --type ts` 하드코딩 잔재 0. 신호 사전 단위테스트(토큰 set 커버리지).

### P1 — DB 마이그레이션

1. `schema.ts:48` 인근에 `grantAudienceEnum`, grants 테이블(575-619)에 `audience` 컬럼+인덱스(§3.2)
2. `pnpm db:generate` → **생성 SQL 검수**(CLAUDE.md 규칙): 신규 enum이라 `CREATE TYPE grant_audience AS ENUM(...)` + `ALTER TABLE grants ADD COLUMN audience ... DEFAULT 'unknown' NOT NULL` + `CREATE INDEX` 형태 예상(0037 striped_gravity의 `f_authoring_mode DEFAULT 'unknown' NOT NULL` 전례와 동형). **기존 객체 재생성이 섞이면 SQL에서 제거·스냅샷만 유지**(0018~0024 교훈)
3. `pnpm db:migrate`

**완료 기준**: `select enum_range(null::grant_audience)` = `{company,individual,mixed,unknown}`. `select audience, count(*) from grants group by 1` → 전량 `unknown`(기본값). 기존 행 무손상.

### P2 — 분류기 (`packages/core/src/audience/classify.ts` 신규)

3단 분류 함수. **입력은 grant_raw payload + title**(D6), 순수 함수(deterministic 부분)와 LLM 보조를 분리.

- `classifyAudienceStructured(payload, source, title)`: kstartup `aply_trgt`/bizinfo `trgetNm` structured 신호로 `company`/`individual`/`unknown` 판정(§2 임계). company 토큰 존재 → company 조기 확정. individual-only token + 제목 individual 키워드 교집합 → individual. 그 외 → unknown(LLM 후보)
- `classifyAudienceRule(payload, title)`: high-precision individual 키워드 룰(§2-1). 애매 시 unknown
- `classifyAudienceLLM(input, {apiKey, model})`: structured+rule이 unknown/충돌인 것만. `claude-haiku-4-5-20251001`(bizinfo llm-criteria.ts:19 전례), max_tokens 200(4값 enum+source_span만), temperature 0, tool schema `{ audience: enum, confidence: number, source_span: string }`. **individual confidence < 0.85 → unknown 강등**(§2-3). 시스템 프롬프트에 오분류 비대칭·mixed 정의·company 함정(공모전/양성/청년이 기업 대상일 수 있음) 명시
- `classifyAudience(...)`: 3단 오케스트레이션(structured → rule → LLM). LLM 미호출 경로 우선.

**완료 기준**: 분류 함수 단위테스트 매트릭스 — {company 토큰 → company, individual-only+제목 신호 → individual, 애매 → unknown/LLM 위임, company 함정 키워드(공모전·양성) → company, mixed}. LLM은 mock. individual 확정에 근거 신호 부재 → 절대 individual 아님(불변 규칙 테스트).

### P3 — 백필 스크립트 (`apps/web/src/lib/server/db/backfill-audience.ts` 신규)

- 전례: `renormalize-kstartup-from-raw.ts`(플래그·배치·트랜잭션), `backfill-apply-methods.ts`(멱등·커서 배치). package.json에 `"backfill:audience"` 등록
- 플래그: `--dry-run`(기본, DB 미변경) / `--write` / `--active-only` / `--batch=500`(id 커서) / `--limit`
- 흐름: grant_raw payload + grants.title 조인 → `classifyAudience` → **grants.audience 컬럼만 업데이트**(criteria·재정규화 무관 — D9). LLM 보조는 structured/rule이 unknown인 소수 행만 호출(비용 §5)
- 대상: kstartup 29,429 + bizinfo 1,959 전량(active-only 미지정 시). `--active-only`는 매칭 우주(1,900여건)만 우선 검증용
- 진행 출력: 처리 수·audience 분포·LLM 호출 수·비용 추정

**완료 기준(A3 gate)**: dry-run에서 audience 분포 리포트(개인 후보 수)·계측 산출까지가 **골든(P6a) 전 허용 범위**. **`--write`는 P6a 골든 individual precision ≥ 0.95 확인 후에만 실행**(그 전 dry-run·계측만). gate 통과 후 `--write --active-only`로 활성 우주 먼저 반영·검증 → 전량. individual 표본 사람 검수(false individual 0 확인).

### P4 — ingestion 자동 분류 배선 (D11)

- kstartup: `packages/core/src/kstartup/normalize.ts`가 반환하는 Grant에 audience 세팅(payload 접근 가능 지점). normalizer가 payload 원문을 못 받으면 publish 경로(정규화 후 grants insert 직전)에서 `classifyAudience` 호출
- bizinfo: `apps/web/src/lib/server/ingestion/archiveBizInfoCore.ts` publish 경로에서 `classifyAudience`(trgetNm/bsnsSumryCn/pblancNm 기반) → grants.audience
- **publisher 저장 매핑 배선(A1 — 필수)**: `normalize`가 audience를 계산해도 `apps/web/src/lib/server/ingestion/normalizedGrantPublisher.ts`가 **명시 화이트리스트**로만 컬럼을 쓰므로(`grantUpdateValues`:219~ / `grantInsertValues`:211~, 예: `fAuthoringMode: grant.f_authoring_mode ?? "unknown"`) audience 매핑이 없으면 계산값이 저장되지 않고 `unknown`으로 유입된다. `grantUpdateValues`·`grantInsertValues` 양쪽에 `audience: grant.audience ?? "unknown"`을 추가한다(§3.3-8). `Grant.audience` 필드(§3.1)와 세트로만 성립
- **결정(A2 — deterministic 인라인 / LLM 배치)**: kstartup normalize는 동기 순수 함수, bizinfo는 순차 LLM 루프라 LLM을 인라인 분류에 넣으면 수집 지연·실패면(면적)이 늘어난다. 따라서 **ingestion 인라인에는 deterministic(structured+rule) 분류만** 저장하고, **LLM 보조는 야간/백필 배치로 unknown 잔여만 갱신**한다. individual 확정은 골든 통과 전까지 human-review 또는 unknown 유지(D12). 인라인 경로는 LLM을 호출하지 않는다

**완료 기준**: 신규 수집 공고가 (structured/rule로) audience 세팅되어 유입(unknown 누수 최소). **신규 수집 row의 `grants.audience`가 unknown 아님을 샘플 확인**(publisher 매핑 A1 배선 검증). e2e: 신규 individual 공고 1건 수집 → 매칭 우주 미진입.

### P5 — 매칭 통합 · match_state 정리

- `apps/web/src/lib/server/repositories/drizzle.ts:72-82` `activeWhere`에 `ne(schema.grants.audience, "individual")` AND 추가. `individual`만 제외, `mixed`/`unknown`/`company`는 포함(D8)
- `toGrant`(drizzle.ts:620-654)에 audience 매핑(§3.3-7)
- **match_state stale 정리 — 불변식(D10·A4)**: individual의 stale match_state를 두 겹으로 보장한다.
  - **(a) 읽기 차단**: `listDueMatchTransitions`(drizzle.ts:397~, 현재 `schema.matchState`만 select — :407-420에 grants join 전무)에 grants join + `ne(schema.grants.audience, "individual")` 필터를 추가. 이 경로로 `transitionPlan.ts`(:27)가 stale individual을 읽는 것을 원천 차단
  - **(b) 쓰기 시 삭제**: audience가 individual로 바뀌는 **모든 경로**(P3 백필 `--write` 반영 시·P4 ingestion 재분류 시)에서 해당 grant의 match_state 행 DELETE 실행. **match_state는 grant 삭제 cascade만 있고 audience cascade 없음**(schema/0000 마이그레이션 확인)이므로 publisher upsert가 stale을 안 지움 → 명시 삭제 필요
  - (a)+(b) 이중화라야 "stale individual 0"이 1회성 정리가 아닌 **불변식**이 된다(재분류·재수집 재발 방지)
- match_state 값 재계산은 불필요(D10 — audience가 eligibility/score를 바꾸지 않음)

**완료 기준(A3 gate)**: `listActiveGrants`의 `audience <> 'individual'` 필터 **활성화는 P6a 골든 individual precision ≥ 0.95 확인 후에만**(그 전 코드 준비까지). gate 통과 후 individual 공고가 `listActiveGrants` 결과·dashboard·teaser에서 사라짐. match_state에 stale individual 행 0(정리 후, 전 경로 불변식 — D10). 매칭 우주 건수 감소 폭 = 백필 individual 수와 일치(층화 리포트).

### P6 — 골든 · 통합 검증 (A3: P6a는 write gate, P6b는 사후 회귀)

**P6a — 골든 selection·측정 (write 전 gate, P2 직후)**:
- `packages/core/golden/matching/` 또는 audience 전용 골든 픽스처: §2 golden 셋(individual/company/mixed + company 함정 케이스). 사람 검수로 확정(AI 라벨 무검수 승격 금지)
- 분류 precision/recall 측정 리포트 — **individual precision ≥ 0.95 실측 확인이 P3 `--write`·P5 필터 활성화의 선결 gate**(A3). 미달 시 write 진입 금지, 임계·룰 튜닝 후 재측정
- **individual 확정 confidence 임계 확정**: 초기값 0.85(§2-3)는 "LLM individual **후보** 임계"로만 사용하고, 실제 individual 확정 임계는 이 골든 실측 후 확정(§2 임계정책)

**P6b — 전체 회귀·시각 검수 (P5 후)**:
- 전체 회귀: typecheck·test·build, `verify:service-data`(미종료 현상 — 출력 완주 판정)
- 시각 검수(사용자 동반, dev 서버 사용자 기동): matches에서 individual 공고 부재 확인

**완료 기준**: P6a에서 individual precision ≥ 0.95 실측(write gate 통과). 기존 golden 회귀 100%. 매칭 우주에서 individual 표본 육안 부재.

---

## 5. 백필 · 비용 산정 (DB 실측 근거)

**실측 환경**: `.env` `DATABASE_URL` = 운영 Supabase 풀러(`aws-1-ap-northeast-2.pooler.supabase.com`), `?` 뒤 파라미터 제거 후 psql. 읽기 전용 SELECT만.

### 5.1 총량
| source | grants |
|---|---|
| kstartup | 29,429 |
| bizinfo | 1,959 |
| **합계** | **31,388** |

### 5.2 kstartup structured 신호 — `aply_trgt`(닫힌 어휘 categorical, 핵심 발견)

`aply_trgt`는 고정 어휘 다중선택 코드: `청소년, 대학생, 일반인, 대학, 연구기관, 일반기업, 1인 창조기업`. 최빈값은 전체 어휘 조합("청소년,대학생,일반인,대학,연구기관,일반기업,1인 창조기업" 12,663건 — 사실상 "제한 없음" 기본값).

| 지표 | 건수 |
|---|---|
| kstartup 전체 | 29,429 |
| `aply_trgt` 공란 | 7 |
| **company 토큰 보유**(일반기업/1인 창조기업/연구기관) | **27,161 (92.3%)** → company 조기 확정, LLM 미호출 |
| company 토큰 무 + 대학 토큰까지 무(strict individual-only) | **550** → individual 후보(LLM/룰 대상) |

individual-only distinct 값: `일반인`(489), `청소년`(57), `청소년,일반인`(4). 청소년 토큰 보유(company 토큰 무) = 652건.

**함정 실증**(오분류 비대칭 근거): individual-only(`일반인`) 표본에 "부산중장년기술창업센터 **입주기업** 모집", "수성대학교 창업보육센터 신규**입주기업** 모집"이 섞여 있음 — `aply_trgt`=일반인이지만 실제는 기업 대상. **structured 신호 단독으로 individual 확정 금지, 제목 신호와 교집합 필요**(D6·§2-1).

### 5.3 bizinfo structured 신호 — `trgetNm`(company-type only)

`trgetNm` 값 전량이 기업 유형: 중소기업(1,533)·소상공인(213)·창업벤처(159)·사회적기업(25)·장애인기업(12)·여성기업(7)·마을기업(4)·제조업(3)·협동조합(3). **개인/일반인/청소년 값 0건 / 1,959.** → bizinfo는 기본 company. individual 후보는 제목·본문 키워드로만 발굴(극소수).

**함정 실증**: bizinfo에서 공모전/양성/청년 키워드가 걸린 표본이 전부 기업 대상("반려동물 창업 공모전 참가자"=창업벤처, "청년 뉴리더 양성사업 참여기업"=중소기업, "일터동행 기업 파트너십 참여기업"). → 키워드 룰이 company 함정을 반드시 걸러야 함(§2 골든 company 케이스).

### 5.4 키워드 recall 표본 (title vs raw payload)

| 신호 | kstartup title | kstartup `aply_trgt_ctnt`(raw) | bizinfo(payload text) |
|---|---|---|---|
| 재직자/임직원/근로자 | 40 | 1,071 | 24 |
| 심사역/심사위원/멘토 | 16 | 176 | 8 |
| 청소년/대학생/연령 | 125 | 2,526 | 13 |
| "만 N세" | 22 | — | 0 |

→ **제목 단독은 recall 부족**(재직자 40 vs raw 1,071). D6(원문 소스 포함) 근거. `aply_trgt_ctnt` 보유 kstartup = 22,351/29,429.

grant_criteria 레벨 "만 N세" 텍스트 잔여 = **8,227행**(개인 연령 조건이 미구조화로 남은 규모 — 게이트의 노이즈 절감 잠재).

### 5.5 LLM 보조 비용 산정

- 대상: structured/rule로 확정 안 되는 **unknown 잔여만** LLM 호출. kstartup은 92.3%가 company 조기 확정 → 잔여 ≈ 2,268행(29,429 − 27,161) 중 rule로도 안 걸리는 애매 부분(보수적으로 전량 2,268 가정). bizinfo는 trgetNm company 기본이라 LLM 대상 극소(제목 키워드 걸린 ~수백 이하).
- 보수적 상한: LLM 호출 대상 ≈ 3,000건.
- 모델 `claude-haiku-4-5-20251001`($1/MTok in, $5/MTok out). 입력 ≈ 제목+aply_trgt(~300 tok/건, sys 프롬프트 ~400 공유), 출력 max 200 tok. 건당 in ≈ 700 tok, out ≈ 100 tok.
- **3,000건: in 2.1M tok = $2.1 + out 0.3M tok = $1.5 → ≈ $3.6.** 활성 우주만(structured 확정 제외 후 ~수백)이면 **$1 미만.**
- 참고 실측: bizinfo 1,477건 haiku criteria 재추출 ≈ $4.6(연구 §4). audience는 출력이 훨씬 짧아(200 vs 2,400 max) 더 저렴. **전량 $5 미만, 사용자 승인 게이트 불요 수준.** (structured 우선으로 LLM 호출 자체를 최소화하는 것이 D5 핵심.)

---

## 6. 리스크 표

| 리스크 | 심각도 | 완화 |
|---|---|---|
| **false individual → 유효 기업 공고 silent loss** | 높음 | D4 비대칭 임계(§2): individual precision 우선, structured company 토큰 조기 확정, LLM individual confidence ≥ 0.85, mixed는 우주 포함. P6a 골든 company 함정 케이스 + write gate(A3) |
| structured 신호 오신뢰(입주기업인데 aply_trgt=일반인) | 중 | individual은 structured+제목 교집합만(D6·§2-1). §5.2 실증 케이스 골든 편입 |
| 키워드 룰 company 함정(공모전/양성/청년이 기업 대상) | 중 | §5.3 실증. company 확정 키워드 관대 적용 + LLM 프롬프트 명시 + 골든 |
| PG enum 값 제거 불가 | 낮 | D2 4값 일괄 확정(mixed 포함) |
| 계약 복제 지점 누락(M2 유형) | 중 | §3.3 전수 목록 + typecheck + `rg` 잔재 스캔 |
| drizzle toGrant 매핑 누락 → audience silent drop | 중 | §3.3-7 + P5 검증 |
| match_state stale individual 잔존(영구 stale) | 중 | **D10 강화(A4)**: (a) `listDueMatchTransitions`에 grants join+audience 필터(읽기 차단) + (b) 전 경로 write 시 match_state DELETE(쓰기). 이중화로 "stale individual 0" 불변식. 완료 기준을 "1회 정리"에서 "전 경로 불변식"으로 변경 |
| ingestion 인라인 LLM으로 수집 지연 | 중 | **D12 확정**: 인라인은 deterministic(structured/rule)만, LLM은 야간/백필 배치로 분리(A2). 수집 경로에서 LLM 미호출 |
| 백필 후 매칭 우주 급감 우려(과잉 제외) | 중 | dry-run 분포 선확인 + `--active-only` 우선 + individual 표본 사람 검수. 실측상 개인 후보는 소수(kstartup strict 550) |
| mixed 판정 모호(경계 사례) | 낮 | mixed는 우주 포함이라 오판정 비용 낮음(company와 동일 취급) |

---

## 7. 완료 기준 (측정 가능)

1. `grant_audience` enum·grants.audience 컬럼·인덱스 마이그레이션 반영, `enum_range` = 4값, 기존 행 무손상
2. 계약 복제 지점(§3.3 — 유효 8곳: JSON Schema #5는 grant 객체 스키마 미존재로 복제 대상 제외, A5) 전수 일치 + typecheck + 하드코딩 잔재 `rg` 0
3. 분류기 3단 단위테스트 통과 + **P6a 골든 individual precision ≥ 0.95** / company recall ≥ 0.98(§2 목표). **이 실측이 P3 `--write`·P5 필터 활성화의 선결 gate(A3 golden-before-write)** — 검증 전 write 진입 금지
4. 백필 전량 완료(kstartup 29,429 + bizinfo 1,959), audience 분포 리포트, individual 표본 사람 검수 false individual 0. **`--write`는 P6a gate 통과 후 실행(그 전 dry-run·계측만 — A3)**
5. `listActiveGrants`에서 `individual` 제외 배선 + dashboard/teaser 정합(**필터 활성화는 P6a 골든 individual precision ≥ 0.95 통과 후 — A3 write gate**). 매칭 우주 감소 폭 = individual 수와 일치
6. **stale individual match_state 0 — 전 경로 불변식(A4)**: `listDueMatchTransitions` join+audience 필터(읽기 차단) + 전 write 경로 match_state DELETE(쓰기). 1회 정리가 아니라 재분류·재수집에도 재발 없음 확인
7. 신규 ingestion 자동 분류 배선(D11·D12) — 인라인은 deterministic만·LLM은 배치, **신규 수집 row `grants.audience`가 unknown 아님 샘플 확인(publisher 매핑 A1)**, e2e individual 신규 공고 매칭 우주 미진입
8. LLM 보조 실비용 ≤ $5(§5.5 산정 검증)
9. 기존 golden·test·build 회귀 100%

---

## 리뷰 반영 기록 (2026-07-12, codex gpt-5.5 xhigh fast mode 심층 리뷰)

리뷰 종합 판정: **조건부 승인** — 아래 발견 5건(Major 4·Minor 1)을 전건 반영. A1·A4는 실제 코드 인용 지점을 검증해 반영, A3는 Phase 순서를 golden-before-write로 재배열. (A1·A4의 코드 지점은 메인 세션이 선확정한 것을 신뢰해 반영.)

| 발견 | 심각도 | 결정·반영 |
|---|---|---|
| **A1** publisher audience 저장 매핑 부재 — `normalizedGrantPublisher.ts`의 `grantInsertValues`/`grantUpdateValues`가 명시 화이트리스트 write라, audience를 계산해도 저장 안 되고 `unknown` 유입 | Major | P4에 "`grantInsertValues`·`grantUpdateValues` 양쪽에 `audience: grant.audience ?? "unknown"` 추가" 명시 + 완료 기준에 "신규 수집 row `grants.audience` unknown 아님 샘플 확인" 추가 + §3.3 복제 지점 표에 #8(publisher 저장 매핑) 신설 |
| **A2** ingestion 인라인 LLM 위험 — kstartup normalize는 동기 순수 함수·bizinfo는 순차 LLM 루프라 인라인 LLM은 수집 지연·실패면 확대 | Major | 초안의 열린 미결(인라인 vs 야간 배치)을 **D12로 확정**: 인라인은 deterministic(structured+rule)만 저장, LLM 보조는 야간/백필 배치로 unknown 잔여만 갱신, individual 확정은 골든 통과 전까지 human-review/unknown. P4 결정·§6 리스크 행에서 "리뷰 항목" 제거 |
| **A3** golden-before-write 순서 위반 — individual precision ≥ 0.95 목표인데 백필·통합(P3/P5) 후에 골든(P6)이 와서 미검증 individual이 write/filter 진입 | Major | 골든을 **P6a로 분리해 write 앞 gate로 이동**(실행 순서 P0→P1→P2→P6a→P3/P4→P5→P6b). P3 `--write`·P5 `listActiveGrants` 필터 활성화를 "P6a individual precision ≥ 0.95 확인 후"로 gate. 그 전 P3는 dry-run·계측만, P5 필터는 코드 준비까지. §2 임계정책에 "초기값 0.85는 LLM 후보 임계, 확정 임계는 골든 실측 후"를 명확화 |
| **A4** match_state 영구 stale — `listDueMatchTransitions`(drizzle.ts:397~)가 `schema.matchState`만 select하고 grants join 전무(:407-420)라 audience 필터 불가, `transitionPlan.ts`(:27)가 stale individual을 계속 읽음. publisher는 upsert 뒤 stale을 안 지워 1회 정리로는 불변식 아님 | Major | **D10 강화**: (a) `listDueMatchTransitions`에 grants join + `audience <> 'individual'` 필터(읽기 차단) **+** (b) individual로 바뀌는 전 경로(백필·ingestion 재분류)에서 match_state DELETE(쓰기). 완료 기준을 "1회 정리"→"전 경로 stale individual match_state 0(불변식)"으로 변경. P5·§6 리스크·§7-6에 반영, drizzle.ts:407-420·transitionPlan.ts:27 인용 추가 |
| **A5** JSON Schema 복제 지점 정정 — export된 JSON Schema는 `grant-criteria.schema.json`(GrantCriterion 전용)뿐, grant 객체 스키마는 미존재. audience와 무관 | Minor | §3.3-5를 "grant 객체 JSON Schema 미존재 — 복제 대상 아님, OpenAPI `GrantDetail`(#3)만 복제 대상"으로 확정하고 추측성 "존재 확인 필수" 문구 제거. P0 파일 표의 schema.json 행도 "작업 없음"으로 정정. §7-2의 "7곳"을 "유효 8곳(#5 제외)"으로 정정 |

리뷰가 확인한 유효 전제(변경 없음): grants 레벨 audience 컬럼(D1)·enum 4값+unknown 기본(D2)·오분류 비대칭 임계(D4)·`listActiveGrants` 단일 관문 필터(D7)·mixed/unknown 우주 포함(D8)·백필 grants 컬럼 단독(D9)·structured 우선 3단 분류(D5)·DB 실측 근거(§5).
