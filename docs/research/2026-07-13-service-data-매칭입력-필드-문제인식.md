# `/dev/service-data` 매칭 입력 필드 검증 문제인식

> 작성일: 2026-07-13
> 상태: 구현 기준 진단 · 실행계획과 교차 검토 완료
> 대상: `apps/web/src/app/dev/service-data/page.tsx`와 그 서버·클라이언트 구현
> 목적: 사업자등록번호와 최소 추가 입력으로 **실제 매칭 엔진이 소비할 수 있는 회사 프로필을 만들 수 있는지** 검증한다.

## 1. 이 문서가 다루는 질문

이 페이지의 목적은 외부 API를 많이 연결했음을 보여주는 것이 아니다. 다음 네 질문에 답하는 개발용 검증 장치여야 한다.

1. K-Startup·기업마당 공고의 지원 가능 여부를 판단하는 공통 분류 체계가 충분한가?
2. 각 분류 축을 사업자등록번호, 2차 인증, 공개 명단, 최소 사용자 질문으로 실제 채울 수 있는가?
3. 채운 값이 표시 문자열이 아니라 `CompanyProfile`의 올바른 타입과 증거 메타데이터로 변환되는가?
4. 변환된 프로필을 실제 matcher에 넣었을 때 `unknown`이 줄고 지원 가능 목록이 달라지는가?

따라서 이 문서는 기존의 광범위한 [매칭 시스템 현황 평가](./2026-07-13-매칭시스템-현황평가.md)를 대체하지 않는다. 그 평가에서 확인한 문제 가운데 **자동채움 필드와 matcher 사이의 계약**만 좁혀서 다룬다.

## 2. 결론

현재 페이지의 방향은 맞다. 이미 외부 소스의 성공·빈값·전제 미충족·실패·캐시를 구분하고, 원천 종류·기준일·완전성을 표시하는 좋은 기반이 있다.

그러나 현재 구현은 **외부 데이터 응답 모니터로는 강하지만, 매칭 입력 커버리지 검증 장치로는 미완성**이다. 가장 큰 이유는 다음과 같다.

```text
현재
외부 API 응답
  -> ConnectorResult.value (표시 문자열)
  -> FieldCoverageRow
  -> 로컬 Q&A 문자열 오버레이
  -> 화면 커버리지
  -> 종료

필요
외부 API 원시 응답 / 사용자 답변
  -> 검증된 CompanyProfileFieldUpdate[]
  -> evidence 우선순위 병합
  -> 최종 CompanyProfile
  -> 실제 matchNormalizedGrant()
  -> 지원 가능/확인 필요/지원 어려움 + unknown 감소량
```

즉 지금은 “API가 값을 돌려줬다”는 사실은 검증하지만, “그 값으로 실제 공고를 판정할 수 있다”는 사실은 검증하지 못한다.

분류 체계에 대한 현재 판단은 다음과 같다.

- `other`는 사용자에게 채우게 할 자격 축이 아니다. 원문 조건이 아직 구조화되지 않았다는 **공고 측 문제**로 남겨야 한다.
- 현재 운영 19축은 첫 typed matching loop를 만드는 기준선으로 적합하다.
- 예약된 `premises`, `export_performance`는 실제 공고 표본에서 반복되는 hard condition 후보가 확인되어 폐기할 축은 아니다.
- 다만 정규식 후보 집계만으로 즉시 활성화해서는 안 된다. 표본 검수 후 활성화하면 최종 체계는 **21개 구조화 자격 축 + `other` 제외**가 될 가능성이 높다.
- 첫 구현의 우선순위는 새 API가 아니라 **typed profile 생성과 실제 matcher 연결**이다.

## 3. 확인한 현재 구조

### 3.1 페이지 파일은 진입점일 뿐이다

- `apps/web/src/app/dev/service-data/page.tsx`: 18줄, dev 전용 진입점
- `apps/web/src/features/dev/ServiceDataMonitor.tsx`: 약 1,962줄, 조회·Q&A·커버리지 UI
- `apps/web/src/lib/server/devServiceDataMonitor.ts`: 약 2,474줄, 필드 계획·커넥터·표시 행 생성
- `apps/web/src/features/dev/CodefSimpleAuthPanel.tsx`: 약 521줄, 2차 인증 흐름

평가 대상은 `page.tsx` 한 파일이 아니라 위 전체 흐름이다.

### 3.2 분류 원천이 둘로 갈라져 있다

- 계약 enum: `packages/contracts/src/enums.ts`의 22개 `CRITERION_DIMENSIONS`
- 자동채움 운영 분모: `packages/core/src/autofill/coverage.ts`의 19개 `OPERATIONAL_AUTOFILL_DIMENSIONS`
- 화면 필드 계획: `apps/web/src/lib/server/devServiceDataMonitor.ts`의 별도 정적 `FIELD_COVERAGE_PLAN`
- 실제 소비 필드: `packages/core/src/matching/match.ts`와 `CompanyProfile`

22개 enum 중 `premises`, `export_performance`는 예약, `other`는 자유서술이므로 현재 커버리지 분모가 19인 것은 설명 가능하다. 문제는 화면 계획이 matcher 계약에서 파생되지 않아, matcher가 바뀌면 수동으로 따라가야 한다는 점이다.

### 3.3 운영 공고 표본이 주는 신호

페이지 집중 재검토 때 사용한 2026-07-13 활성 공고 스냅샷은 1,802건이다. 같은 날 다른 보고서의 1,847건·1,898건과 차이가 나는 것은 수집·활성 상태 갱신 시점이 다르기 때문이다. 아래 수치는 영구 상수가 아니라 해당 스냅샷의 진단 근거다.

주요 hard condition 보유 공고 수는 다음과 같았다. 한 공고가 여러 축을 가질 수 있으므로 합계는 공고 수보다 크다.

| 축 | hard condition 보유 공고 수 |
|---|---:|
| size | 1,446 |
| region | 1,236 |
| industry | 852 |
| biz_age | 423 |
| business_status | 283 |
| target_type | 240 |
| certification | 133 |
| founder_age | 125 |
| employees | 79 |
| tax_compliance | 57 |
| revenue | 56 |
| credit_status | 55 |
| insured_workforce | 53 |
| sanction | 36 |
| ip | 34 |
| founder_trait | 20 |
| investment | 18 |
| prior_award | 15 |
| financial_health | 6 |

`other` criterion은 604개 공고에 789개가 있었고 전부 `text_only`였다. 이 중 589개 공고에서 hard condition으로 사용됐다. 이는 사용자에게 “기타 조건”을 입력받아 해결할 문제가 아니라, 공고 원문 추출·검수 품질을 개선해야 할 문제다.

정규식 기반 후보 감사에서는 다음 신호가 있었다.

- 수출 관련 hard-condition 후보: 70개 공고, 85개 criterion
- 사업장·공장·입주·특구 관련 hard-condition 후보: 125개 공고, 168개 criterion
- 수출 관련 `other/text_only`: 최소 34개 공고
- 사업장 관련 `other/text_only`: 최소 36개 공고
- 수출 임계가 현재 `revenue`로 저장된 후보: 9개 공고

이 후보 집계는 정답 라벨이 아니다. `premises`와 `export_performance`를 활성화할지 판단할 **검수 대기 표본**이다.

## 4. 보존해야 할 구현

다음은 문제의 원인이 아니므로 유지·재사용한다.

1. `live/cache/pending/failed/n-a/self-declared` 상태 구분
2. 정상 빈값, 조회 전제 미충족, API 오류를 서로 다르게 취급하는 커넥터 계약
3. `sourceKind`, provider, `asOf`, `axisCompleteness`, confidence 표시
4. exact와 fuzzy/present-only 결과를 구분하려는 안전 정책
5. 국세청·근로복지공단·KIPRIS·창업기업확인서·DART·금융위·NICE·CODEF·registry를 한 화면에서 비교하는 기능
6. 결격 플래그의 `known_flags`, 보유 플래그, 예외를 구분하는 Q&A
7. 기존 `CompanyProfileFieldUpdate`, `updateCompanyProfileField`, `resolveEvidencePrecedence`, 결정론 matcher

약 5천 줄의 dev 구현은 유지보수 부담이지만, 파일 분할 자체는 첫 미션의 필수 조건이 아니다. 지금 대규모 리팩터링하면 본질에서 벗어난다.

## 5. 문제 목록

### P0. 화면 값이 typed `CompanyProfile`로 이어지지 않는다

`ConnectorResult.value`는 문자열이고 `buildFieldCoverage()`는 표시용 행을 만든다. 클라이언트의 `mergeFieldsWithQna()`도 문자열 행만 덮어쓴다.

그 결과:

- 외부 응답이 `CompanyProfileFieldUpdate` 계약을 통과했는지 알 수 없다.
- 숫자 단위, canonical label, 배열 completeness가 matcher 기대와 맞는지 검증하지 않는다.
- 여러 원천이 충돌할 때 `resolveEvidencePrecedence()`와 동일한 결과인지 알 수 없다.
- 페이지가 `matchNormalizedGrant()` 또는 `matchGrantCriteria()`를 호출하지 않는다.
- 질문 하나가 실제로 몇 개 공고의 `unknown`을 줄였는지 알 수 없다.

이것이 최우선 문제다.

### P1. 필드 계획과 matcher 계약이 중복되어 드리프트한다

화면은 별도 `FIELD_COVERAGE_PLAN`을 유지한다. 최근 matcher 계약 변경을 화면이 완전히 따라가지 못한 사례가 이미 있다.

| 축/필드 | matcher·profile 계약 | 현재 페이지 | 문제 |
|---|---|---|---|
| `prior_award` | scope, self kind, channel, program, state, 기간, known 범위 | 자유 텍스트 1개 | exact-match와 부재 판정에 필요한 구조를 만들 수 없음 |
| `ip` | 권리 종류와 목록 completeness | 보유 건수 숫자 | matcher는 건수를 읽지 않음 |
| `financial_health.interest_coverage_ratio` | 실제 판정 필드 | 없음 | 해당 criterion은 항상 profile missing |
| `financial_health.capital_krw` | 부분자본잠식 파생 입력 | 없음 | `equity < capital`인 부분잠식 판별 불가 |
| `financial_health.fiscal_year` | 재무 기준연도 | 없음 | 오래된 수치와 최신 수치를 구분하기 어려움 |
| `insured_workforce.months_since_last_layoff` | 무감원 기간 판정 필드 | Q&A에는 있으나 coverage row·typed patch 없음 | 표시와 실제 소비 계약이 분리됨 |
| `industry_codes` | KSIC exact/prefix 매칭 | 별도 진단 없음 | 업종 문자열 확보와 코드 판정 가능을 혼동 |
| `list_completeness` | industry, trait, cert, prior award, IP, target type의 부재 판정 | 일부 축의 단순 complete/partial | positive hit와 소진적 목록을 구분하지 못함 |

### P2. 자본잠식 표시가 부분자본잠식을 놓칠 수 있다

현재 DART·금융위·NICE 경로 일부는 `자본총계 <= 0`만 자본잠식으로 표시한다. 그러나 matcher의 `CompanyProfile`은 다음을 구분한다.

- 완전자본잠식: `equity_krw <= 0`
- 부분자본잠식: `0 < equity_krw < capital_krw`
- 정상: `equity_krw >= capital_krw`

자본금 없이 `equity > 0`만 보고 “정상”으로 표시하면 부분잠식 공고에서 잘못된 통과 근거가 될 수 있다. `total_assets_krw`, `equity_krw`, `capital_krw`, `fiscal_year`는 파생·진단 필드로 보존하되, matcher가 직접 소비하는 `impairment`와 구분해야 한다.

### P3. `target_type` 표시가 실제 의미보다 좁다

현재 라벨은 “대상 유형(법인/개인)”이다. 실제 criterion은 법인·개인뿐 아니라 예비창업자, 스타트업, 사회적기업, 대학, 비영리 등 신청 주체 태그를 포함할 수 있다.

지금 새 top-level dimension을 만드는 것은 이르다. 우선 한 축 안에서 다음을 시각적으로 나누고 completeness를 표시해야 한다.

- 법적 사업자 형태: 개인/법인
- 신청 주체 태그: 예비창업자/창업기업/사회적기업/대학/비영리 등

사업자등록번호 기반 기본 시나리오에서 “예비창업자” 체크박스를 상시 기준 입력으로 두는 것도 모순이다. 사업자 미등록 시나리오를 별도 토글로 분리해야 한다.

### P4. `other`와 관심 목표가 섞여 있다

`other`는 자격 판정에서 항상 `text_only/unknown`이어야 한다. 반면 `support_goals`, `interest_goals`는 hard eligibility가 아니라 공고 정렬의 관련성 신호다.

현재 페이지의 “기타 조건” 자유 입력은 neither이다.

- `other` hard condition을 해결하지 못한다.
- `other_conditions.support_goals` 또는 `interest_goals` typed 값도 만들지 않아 ranking에 쓰이지 않는다.

따라서 `other` 입력을 자격 커버리지에서 제거하고, 필요하면 별도의 **추천 정렬용 관심 목표** 섹션으로 둔다. 이 값은 자격 분모를 늘리지 않는다.

### P5. 부모 축 `complete`가 실제 판정 가능성을 과장한다

현재 커버리지는 부모 행이 채워지고 `axisCompleteness=complete`이면 축 전체가 판정 가능하다고 센다. 하지만 복합 축은 criterion이 참조하는 하위 필드마다 준비 상태가 다르다.

예:

- `financial_health`에서 자본잠식만 알아도 부채비율·이자보상배율 criterion은 unknown이다.
- `insured_workforce.no_layoff=true`는 무감원 criterion에는 충분하지만 피보험자수 criterion에는 부족하다.
- `investment.tips_backed=true`는 TIPS 조건에는 충분하지만 투자금 하한에는 부족하다.
- `industry` 문자열 일부를 알더라도 KSIC 코드 조건이나 제외 업종 전체 부재를 판정할 수 없다.
- `target_type`의 법인 여부만 알아도 모든 신청 주체 태그가 complete인 것은 아니다.

따라서 “축 전체 complete”와 별도로 **criterion-sensitive readiness**가 필요하다. “공고 X의 조건 Y를 판정하는 데 필요한 하위 필드가 모두 있는가”를 기준으로 계산해야 한다.

### P6. 현재 공고 가중치가 실제 hard eligibility 빈도를 대표하지 않는다

`loadCoverageGrantWeights()`는 현재 다음 방식이다.

- 활성 공고 최대 500개만 읽음
- criterion 발생 건수를 그대로 더함
- `needs_review=true`만 제외
- preferred, text-only, unresolvable 조건이 섞일 수 있음
- 같은 공고의 같은 dimension 중복을 제거하지 않음
- canonical contract 통과 여부를 보지 않음

필요한 가중치는 다음과 같다.

- 전체 활성·deduped 공고
- canonicalized criterion
- hard `required/exclusion`만
- `text_only`와 profile로 해결할 수 없는 조건 제외
- `공고 × dimension`을 한 번만 집계
- reviewed와 pending을 분리 표시

### P7. 서로 다른 세 커버리지가 한 숫자처럼 보인다

제품 의사결정에는 최소 세 지표가 필요하다.

1. **프로필 소싱 커버리지**: 회사 값을 어떤 원천에서 얻었는가?
2. **canonical match-ready 커버리지**: 그 값이 typed profile과 evidence 계약을 통과했는가?
3. **공고 추출 준비도**: 공고 criterion이 구조화·검수되어 판정 가능한가?

최종 end-to-end 판정 가능률은 세 지표의 교집합이다. API가 회사 값을 완벽히 채워도 공고 조건이 `other/text_only`이면 확정 판정할 수 없다.

### P8. 조회 전제 필드가 자격 축과 섞여 보이지 않는다

다음은 criterion dimension은 아니지만 외부 조회 성공에 필수다.

- 사업자등록번호
- 상호
- 법인등록번호
- 권위 있는 개인/법인 구분
- 2차 인증 완료 여부와 시각
- registry 매칭 방식: exact/fuzzy/present-only

현재 일부는 내부 profile이나 note에만 존재한다. 이들을 **조회 전제·식별 정보** 섹션으로 분리해야, “필드 미확보”와 “조인키 미확보”를 구분할 수 있다.

단, CODEF 인증에 사용한 생년월일·휴대폰번호·대표자명·인증 token 원문은 이 섹션이나 최종 profile preview에 노출하면 안 된다. matcher에 필요한 대표자 연령·특성처럼 최소 파생값과 “인증 완료” 상태만 표시한다.

### P9. 현재 테스트는 display-to-match 경계를 검증하지 않는다

현재 canonicalization, matcher, question planner, dev monitor 단위 테스트는 각각 유효하다. 그러나 다음 회귀를 막는 테스트가 없다.

- 운영 축과 화면 부모 행의 정확한 parity
- matcher가 읽는 모든 중첩 profile path가 화면 계획에 있는지
- 커넥터/Q&A가 만드는 typed update가 `updateCompanyProfileField()`를 통과하는지
- 원천 병합 뒤 최종 profile이 예상대로 유지되는지
- 입력 전후 actual unknown과 eligibility가 예상대로 바뀌는지
- `other`가 자격 커버리지 분모에 들어가지 않는지
- `premises`·`export_performance`가 승인 전 matcher 확정 판정에 들어가지 않는지

## 6. 필드 체계 보정안

### 6.1 top-level 자격 축

| 분류 | 축 | 판단 |
|---|---|---|
| 유지 | 현재 운영 19축 | typed matching loop의 기준선으로 사용 |
| 활성 후보 | `premises`, `export_performance` | 표본 검수와 계약·evaluator·입력 소스가 준비된 뒤 각각 승격 |
| 자격 입력에서 제외 | `other` | 공고 추출·원문 확인 문제로만 취급 |

19축은 다음과 같다.

`region`, `biz_age`, `industry`, `size`, `revenue`, `employees`, `founder_age`, `founder_trait`, `certification`, `prior_award`, `ip`, `target_type`, `business_status`, `tax_compliance`, `credit_status`, `sanction`, `financial_health`, `insured_workforce`, `investment`.

### 6.2 top-level 축을 늘리지 않고 추가할 필드

- `industry_codes`
- 6개 list dimension의 `list_completeness`
- `financial_health.interest_coverage_ratio`
- `financial_health.capital_krw`
- `financial_health.fiscal_year`
- `insured_workforce.months_since_last_layoff`
- 구조화된 `prior_award_history`
- IP 권리 종류·상태와 completeness
- `target_type`의 법적 형태와 신청 주체 태그 구분

### 6.3 자격 분모 밖에 둘 필드

- 식별·조회 전제: 사업자번호, 상호, 법인번호, 인증 상태, match method
- 파생·설명 보조: 자산총계, 자본총계, 자본금, 기준연도
- 추천 정렬: 지원 관심 목표
- 원시 응답·오류·캐시·비용·latency 진단

## 7. 페이지가 준비됐다고 볼 수 있는 완료 조건

다음이 모두 보여야 한다.

1. 각 소스의 raw/sourced 상태
2. 각 값의 canonical typed update 성공·실패
3. evidence 우선순위를 적용한 최종 `CompanyProfile` 미리보기
4. 필드별 `sourced -> normalized -> match-ready` 단계
5. 활성 공고 전체의 engine eligible/conditional/ineligible 수
6. review/extraction gate를 포함한 사용자 노출 4상태 수: 지원 가능성이 높음/정보 확인/원문 확인/지원 어려움
7. unknown을 `회사 필드 부족`과 `공고 text-only/needs-review`로 분리한 수
8. 각 API·사용자 답변을 추가하기 전후의 unknown 감소량
9. 현재 가장 많은 공고를 확정시키는 다음 질문
10. 19축/예약축/`other`의 분모 포함 여부와 근거

영속 저장은 이 페이지의 첫 완료 조건이 아니다. 우선 dev 메모리 안에서 typed profile과 shadow matching이 재현되면 된다. 이후 제품 경로와 동일한 저장 API를 쓰는 브라우저 E2E를 별도 게이트로 둔다.

## 8. 명시적 비목표

이번 개선에서 하지 않는다.

- 새 외부 API 또는 유료 provider 추가
- generic connector framework 재작성
- 5천 줄 dev 페이지의 전면 컴포넌트 리팩터링
- production dashboard UI 재설계
- 새 profile persistence 테이블 또는 DB migration
- `other/text_only`를 억지로 새 축으로 분해
- 인증·IP 전체 카탈로그를 사전에 완성
- LLM이 hard eligibility의 최종 pass/fail을 직접 결정
- 모든 필드를 사용자에게 한 번에 질문
- `premises`, `export_performance`를 표본 검수 없이 즉시 활성화

## 9. 구현 우선순위에 대한 판단

첫 번째 성공 마일스톤은 다음 한 문장이다.

> 사업자번호 1개를 현재 연결된 소스와 최소 Q&A로 조회하면 typed `CompanyProfile`이 만들어지고, 실제 활성 공고 shadow match에서 어떤 unknown이 얼마나 줄었는지 설명할 수 있다.

이 마일스톤 전에는 새 커넥터 수를 늘려도 첫 미션의 달성도가 크게 올라가지 않는다.

## 10. 실행계획과의 교차 리뷰 결과

[통합 실행계획](../plans/HANDOFF-2026-07-13-service-data-매칭입력.md)과 문제 목록을 일대일로 대조했다.

과설계 위험은 다음처럼 줄였다.

- `premises`·`export_performance` 표본 검수는 유지하지만 19축 typed loop의 blocker로 두지 않는다.
- 첫 shadow match는 provider별 기여도 전수 실험이 아니라 기본 profile 대 최종 profile만 비교한다.
- 새 API·DB migration·production UI·generic connector framework는 명시적으로 제외한다.
- dev 페이지 전체 리팩터링 대신 typed profile 경계만 작은 별도 모듈로 분리한다.

부족했던 부분은 다음처럼 계획에 추가했다.

- Q&A typed 변환은 클라이언트가 아니라 서버에서 수행해 기존 bundle 경계를 보존한다.
- engine 3상태와 사용자 노출 4상태를 분리한다.
- unreviewed/partial 공고를 “지원 가능성이 높음”으로 올리지 않는다.
- 인증 개인정보가 profile preview·로그·snapshot으로 새지 않는 검증을 추가한다.
- 대표 scalar/list/compound 3종으로 먼저 세로 절단을 검증하되, 이것을 Phase 2 전체 완료로 오인하지 않는다.

교차 리뷰 후에도 최우선 문제는 P0이다. 따라서 첫 구현은 필드 수 확대가 아니라 `ConnectorResult/Q&A -> CompanyProfileFieldUpdate -> CompanyProfile -> matcher` 연결이다.

## 11. 근거 코드

- `apps/web/src/app/dev/service-data/page.tsx`
- `apps/web/src/features/dev/ServiceDataMonitor.tsx`
- `apps/web/src/features/dev/CodefSimpleAuthPanel.tsx`
- `apps/web/src/lib/server/devServiceDataMonitor.ts`
- `packages/contracts/src/enums.ts`
- `packages/contracts/src/index.ts`
- `packages/core/src/autofill/coverage.ts`
- `packages/core/src/company/update-profile-field.ts`
- `packages/core/src/company/evidence-priority.ts`
- `packages/core/src/matching/match.ts`
- `packages/core/src/matching/question-planner.ts`
- `packages/core/src/matching/relevance.ts`

## 12. 관련 문서

- [신규 세션 통합 실행계획](../plans/HANDOFF-2026-07-13-service-data-매칭입력.md)
- [매칭 시스템 현황 평가](./2026-07-13-매칭시스템-현황평가.md)
- [사업자번호 우선 자동채움 실행 가이드](../plans/2026-07-12-사업자번호-우선-자동채움-실행가이드.md)
- [공고 매칭 1차 미션 복구 계획](../plans/2026-07-13-first-mission-recovery-plan.md)
