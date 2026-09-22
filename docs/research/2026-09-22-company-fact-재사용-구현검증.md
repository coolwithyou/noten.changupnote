# company_fact 공고 간 재사용 — 구현 검증

작성일: 2026-09-22. 범위: T3 공통 사실 재사용, 수정 충돌, 철회, 관련 공고 재판정.

## 구현 결과

- `company_fact`라는 선언과 모델 생성 키만으로 답변을 공유하지 않는다. 검수된 v2 질문이며 영문 snake_case 키, 단일 선택, `satisfied / unsatisfied / unknown`의 유일한 선택지가 모두 있고, criterion의 dimension·kind·operator·정규화 value가 같을 때만 같은 사실이다.
- criterion value에 들어 있는 사업장 범위와 기준일이 의미 SHA에 포함된다. 같은 시흥 사업장 조건 네 공고는 공유하지만 본사 한정 조건과 다른 기준일 조건에는 공유하지 않는다.
- 저장 원장은 기존 `company_grant_confirmations`를 유지한다. GET과 matcher repository가 현재 source에 유효한 답변 가운데 같은 의미의 최신 답변을 대상 질문에 투영한다.
- 공고별 answer revision과 별도의 company fact revision을 비교한다. 다른 공고에서 같은 사실이 바뀐 뒤 낡은 화면이 저장을 시도하면 `confirmation_company_fact_conflict`로 거부한다.
- 답변 수정 시 같은 의미의 관련 공고를 함께 재계산한다. 제품 화면은 재계산한 공고 수를 알린 뒤 전체 결과를 다시 읽는다.
- 답변 철회는 source binding이 있는 tombstone을 남겨 과거 답변이 질문 rollback 뒤 되살아나지 않게 하고, 관련 공고를 미확인 상태로 재계산한다. 범위·기준일이 다른 답변에는 영향을 주지 않는다.

## 현행 데이터 읽기 전용 점검

운영 DB의 활성 `company_fact` 질문은 65개였고 condition key도 65개로 모두 서로 달랐다. 저장된 company fact 답변은 0개였다. 65개 질문은 전부 현행 v2 evaluation contract가 아닌 역사 질문이다.

따라서 이번 reader를 배포하는 것만으로 과거 질문을 임의 공유하지 않는다. 신규 또는 검수 재발행 질문이 v2 계약과 동일한 표준 키·조건 의미를 가져야 재사용된다. 과거 질문의 자동 키 병합이나 답변 이관은 수행하지 않았다.

## 검증 증거

- `pnpm test:company-fact-reuse`
  - 같은 의미 네 질문의 identity 일치
  - 본사 한정과 다른 기준일의 identity 분리
  - 같은 시각의 상충 답변 fail-closed
- `pnpm test:product-postgres`
  - 실제 PostgreSQL에서 한 답변을 네 공고 matcher 입력으로 전파
  - 범위·기준일이 다른 두 공고에는 비전파
  - 다른 공고의 수정 반영과 낡은 company fact revision 거부
  - 철회 뒤 네 공고 모두 미확인 복귀
  - 기존 RLS·question CAS·source drift·publication lock 회귀 통과
- `pnpm build:packages`
- `pnpm --filter @cunote/web typecheck`
- confirmation route의 viewer PUT/DELETE 차단 테스트 통과

## 남은 경계

- 코드와 격리 DB 검증까지 완료했다. 프로덕션 배포와 실제 사용자 UAT는 수행하지 않았다.
- 현행 65개 역사 질문은 의미가 같다고 검증되지 않았으므로 자동 이관하지 않는다. T6 이관 단계에서 원문·criterion·질문 의미를 검수한 exact 대상만 v2로 재발행한다.
- 신규 질문 생성기가 같은 회사 사실에 공통 키를 안정적으로 부여하는지는 T6/T7 전향 표본에서 측정한다. 키가 달라도 임의 유사도 병합은 하지 않는다.
