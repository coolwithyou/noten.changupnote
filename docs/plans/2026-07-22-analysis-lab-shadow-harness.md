# 공모 딥분석 — 매칭 임팩트 섀도 하네스 선구현 계획

> 🟢 **구현·검증 완료** (2026-07-22 수립·동일 세션 완료). 확대 실험 계획
> (`2026-07-21-analysis-lab-expansion-experiment.md`) §4 "매칭 임팩트 섀도 측정"의 측정 코드를
> 30건 완주 전에 선구현했다. 30건 검수가 끝나는 즉시 `pnpm lab:shadow`로 측정 가능하며,
> Lab→Grant criterion 변환기(shadow-convert.ts)는 이후 golden_set 승격 트랙의 발행 어댑터로
> 재사용된다. **DB 쓰기 0 · LLM 호출 0 · 외부 API 호출 0.**
> 검증: typecheck 0 · 픽스처 테스트 통과 · aggregate 리팩토링 전후 출력 byte-identical ·
> 파일럿 3건 실DB 스모크(correct 27건 전량 변환, 강등·탈락·계약실패 0 — §6 체크리스트).
> 스모크 관찰 2건은 §8 참조.

## 1. 목적과 경계

- 검수 확정된 딥분석 criteria로 match_state를 **섀도 재계산**해, 사전 등록된 4개 지표의
  전(현행 DB criteria)/후(딥분석 검수 확정 criteria) 절대량을 잰다.
- **파일럿 3건 검수 확정분으로 하네스를 스모크한다** — 이는 코드 검증이지 게이트 판정이
  아니므로 순환성 가드(파일럿의 판정 표본 제외)와 무관하다.
- 게이트 판정·golden 승격·DB 반영은 이 트랙의 범위가 아니다. 30건 완주 후 섀도 측정 결과가
  긍정일 때만 승격 트랙(DB 쓰기)에 착수한다(확대 실험 계획 §4).

## 2. 재사용 자산 (전부 기존 코드 — 신규 발명 없음)

| 자산 | 위치 | 역할 |
|---|---|---|
| `buildGrantAnalysisShadowMatch` | `apps/web/src/lib/server/ingestion/grantAnalysisPilotVariants.ts:165` | entry+criteria+company+asOf → MatchResult(랭킹 포함). 07-15 파일럿의 섀도 매칭 엔진 그대로 |
| `normalizeGrantLlmCriteria` | `packages/core/src/bizinfo/llm-criteria.ts:153` | LLM raw row → 검증·canonicalize된 `GrantCriterion[]`. 축별 value 정규화·강등·region 방어·계약 검증 포함 — Lab→Grant 변환의 본체 |
| `collect()` (검수 런 수집) | `apps/web/src/lib/server/analysis-lab/aggregate.ts:33` | review.json↔run 짝짓기 + cohort 필터. 공유 모듈로 추출해 aggregate와 공용 |
| `resolveSystemProductCompanyProfile` | `productProfile/resolveProductCompanyProfile.ts:358` | companyId → CompanyProfile. `system_recompute` 컨텍스트는 popbill_cache(cache_only) — 외부 호출 없음 |
| `resolveAnonymousProductCompanyProfile` | `serviceData.ts` | bizNo → 익명 프로필(팝빌 캐시). 07-15 파일럿 스크립트가 오프라인으로 사용한 선례 |
| `planProfileQuestions` / `isProfileResolvableCriterion` | `packages/core/src/matching/question-planner.ts:71,253` | "질문 1개로 확정 가능" 지표 재료 |
| `hydrateGrants` | `apps/web/src/lib/server/repositories/drizzle.ts:976` | 행 → NormalizedGrant 조립(비공개 — #4에서 재사용) |

## 3. 설계 결정

1. **후(after) 변형 = 검수 `correct` criterion만 변환해 현행 criteria를 대체**(엄격).
   `needs_edit`는 구조화된 수정값이 없으므로 미포함(건수만 보고). 승격 트랙의 실동작
   (`publish-reviewed-grant-annotations.ts`의 delete+insert)과 동일한 의미론.
2. **변환은 `normalizeGrantLlmCriteria` 재사용**: `LabCriterion`(camelCase)을 함수가 기대하는
   row 형태(snake_case: `source_span` 등)로 리매핑 후 통과. 옵션
   `{sourcePrefix:"lab-shadow", parserVersion:"analysis-lab-shadow-v1", forceNeedsReview:false}`.
   사람 검수를 거쳤으므로 **needs_review=false** — `deferUnreviewedHardFail`이 hard-fail을
   유예하지 않아 exclusion 효과가 섀도에 그대로 드러난다(지표 4의 전제).
3. **변환 손실 무은폐**: normalize가 강등(text_only)·탈락시킨 criterion 수를 공고별로 보고.
   correct인데 변환에 실패하면 그것 자체가 승격 트랙의 사전 신호다.
4. **공고 로딩은 신규 repository 메서드 `listGrantsByIds`**: 코호트 공고는 실험 중 마감
   (closed)될 수 있는데 `listActiveGrants`는 status(open/upcoming/unknown) 필터라 누락된다.
   grants+grant_raw+grant_criteria를 id로 select해 기존 `hydrateGrants`로 조립(+~25줄,
   read-only). 승격 트랙에서도 재사용.
5. **회사 집합**: 기본 = companies 테이블 전 행(실사용자)을
   `resolveSystemProductCompanyProfile`로 해석(cache_only — 외부 호출 없음). `--bizNo=CSV`로
   팝빌 캐시 익명 프로필 추가 가능. 회사 0이고 bizNo 미지정이면 명확한 에러로 종료.
6. **missed_condition(누락 조건)은 섀도에 미반영** — 구조화된 값이 없다. 건수만 caveat로
   병기(누락 반영 시 후 지표는 하한 추정임을 명시).
7. **런 선택**: 공고당 검수 보유 최신 런 1개(aggregate와 동일 dedupe). 기본은 cohort.json
   코호트 공고만, `--all`이면 전수(스모크는 파일럿 3건이 코호트 외일 수 있으므로 `--all` 사용).

## 4. 지표 4종 (확대 실험 계획 §4 사전 등록 문구와 1:1)

전/후 각각, 회사×공고 격자로 계산해 회사별 + 전체 집계를 보고한다.

| # | 사전 등록 문구 | 계산 정의 |
|---|---|---|
| 1 | 공고당 확정 판정(eligible/ineligible) 조건 수 — 절대량 | rule_trace 중 `result ∈ {pass, fail}` 건수(공고당, 회사 평균 병기). 비율 지표는 쓰지 않는다(분모 착시 — 계획 §4) |
| 2 | recommendable·eligible 전환 공고 수 | 전→후 tier(review_gate.tier)·eligibility 전이 행렬. recommendable/eligible로 올라선 공고 수와 역방향 수 |
| 3 | "질문 1개로 확정 가능" 공고 수 | eligibility=conditional이고, hard unknown criterion이 전부 `isProfileResolvableCriterion`이며 그 dimension이 1종뿐인 공고 수(question-planner `onlyRemainingDimension` 로직과 동일 정의). 참고로 `planProfileQuestions` 상위 질문의 resolvesGrantCount 병기 |
| 4 | 신규 exclusion이 제거하는 오추천 수 | 전=recommendable(또는 eligibility≠ineligible)인데 후=ineligible로 바뀐 공고 수. 후 rule_trace의 fail(required/exclusion) dimension 목록 병기 |

보조(회사 무관, 컨텍스트): 공고당 criteria 수 A/B, 구조화(≠text_only) 수 A/B, 변환 손실 수.

## 5. 구현 항목

| # | 파일 | 내용 |
|---|---|---|
| 1 | `analysis-lab/reviewed-runs.ts` 신설 | aggregate.ts의 `collect()`+최신 런 dedupe+cohort 필터를 추출한 공유 모듈. aggregate.ts는 이를 import(동작 무변경) |
| 2 | `analysis-lab/shadow-convert.ts` 신설 | `LabRun`+`LabReview` → `{criteria: GrantCriterion[], report: 변환 보고}`. 순수 함수(테스트 대상). correct 필터 → row 리매핑 → `normalizeGrantLlmCriteria` → 손실 집계 |
| 3 | `analysis-lab/shadow.ts` 신설 | CLI 러너: 검수 런 수집 → `listGrantsByIds` → 회사 프로필 해석 → 전/후 `buildGrantAnalysisShadowMatch` → 지표 계산 → `spike-out/analysis-lab/shadow/<runId>/shadow-report.json` + stdout 요약. **명시적 process.exit**(batch.ts 전례) |
| 4 | `repositories/drizzle.ts` | `listGrantsByIds(ids)` 추가 — status 무관 id 조회, `hydrateGrants` 재사용 |
| 5 | `package.json` | `"lab:shadow": "tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/analysis-lab/shadow.ts"` |
| 6 | `analysis-lab/shadow-convert.test.ts` | 픽스처 단위 테스트(lab:roundtrip:test의 node --import tsx 패턴): correct만 변환·needs_edit 제외·needs_review=false·강등 보고·value 정규화 왕복 |

CLI: `pnpm lab:shadow -- [--all] [--bizNo=CSV] [--companyId=CSV] [--asOf=ISO] [--verbose]`

## 6. 검증 체크리스트

- [x] `pnpm typecheck` 0 에러, 드리프트 스캔 0 (히트 4파일은 전부 HEAD 기존 코드 — stash로 증명)
- [x] shadow-convert 픽스처 테스트 통과 (`pnpm lab:shadow:test`)
- [x] 실스모크: `pnpm lab:shadow -- --all` (파일럿 3건 검수 + 실DB read-only) — 전/후 지표
      산출, DB 쓰기 0, 외부 호출 0, 프로세스 정상 종료 확인. `--bizNo`(팝빌 캐시)·미존재
      `--companyId` 에러 경로(exit 1)도 실측
- [x] 변환 보고 일치: correct 27건 → 27건 변환(강등 0·탈락 0·계약 실패 0), 미반영
      needs_edit 1·missed_condition 0
- [ ] 30건 완주 시(이 계획 밖): `pnpm lab:shadow` 실행 결과를 판정 문서에 첨부

## 7. 한계 (사전 명시)

- missed_condition 누락 조건 미반영 → 후 지표는 하한 추정.
- needs_edit 미반영(엄격) → 마찬가지로 하한. 두 건수 모두 보고서에 병기한다.
- 섀도 결과는 진단 전용 — 게이트·승격 판단은 확대 실험 계획의 사전 등록 절차를 따른다.

## 8. 구현 이력·스모크 관찰 (2026-07-22)

계획 대비 조정 4건:

1. **회사 조인 키를 label이 아니라 고유 키(companyId/bizNo)로** — dev DB에 동명 회사 다수
   (총 125행)라 label 키는 per-company 지표를 오염시킴(1차 스모크에서 발견·수정).
2. stdout 회사 블록은 12곳까지만(초과는 `--verbose`/JSON 안내) — 보고서 JSON에는 전 회사 상세.
3. 지표 3은 §4 정의 그대로(isProfileResolvable + dimension 1종) 구현. question-planner의
   비공개 `isExhaustiveQuestionDimension`은 복제하지 않고 `planProfileQuestions` 상위 질문
   병기로 보완.
4. `listGrantsByIds`는 attachment archive·manifest 하이드레이션 없는 최소 구현(섀도 매칭에
   불필요).

**스모크 관찰 2건 — 30건 판정 문서에서 반드시 참고:**

- **빈 프로필에서 후(after) 지표가 0으로 붕괴하는 것은 프로덕션 실동작이다**: 딥분석
  criteria에 text_only hard criterion이 섞이면 `extractionReadinessFor`(match.ts)가
  partial을 반환해 review gate·질문 플래너에서 제외되고, region evaluator는 회사 소재지
  미상이면 nationwide 검사 전에 unknown을 반환한다(match.ts:302). 파일럿 3건×회사 125행
  스모크에서 확정 판정 합계 160→0, recommendable 이탈 160이 나온 원인.
- **팝빌 캐시 프로필에서는 지표 1이 전 2(0.67/공고)→후 4(1.33/공고)로 증가** — 기업 측
  데이터가 있어야 딥분석 증분이 확정 판정으로 전환된다. 계획 §4의 "부정 분기(기업 측 데이터
  부재로 conditional 적체 → 소싱 트랙 재조정)" 신호를 파일럿 스모크가 이미 시사하므로,
  30건 측정은 실사용자·팝빌 캐시 보유 사업자 기준으로 해석해야 한다(사전 등록 문구와 동일).
