# 조건 확인 공급체계 전환 — Astra medium 핸드오프

작성: 2026-09-23 KST. 구현 기준: `2adc0f4`.
수신 모델: **gpt-6-astra / medium** (사용자 지정).

## 다음 세션의 첫 임무

사용자는 남은 구현을 신규 세션으로 옮기며, 먼저 남은 작업을 다시 리뷰하고 **현재 구현과 계획이 여전히 유효한지 평가**하라고 요청했다. R3-3부터 기계적으로 구현을 재개하지 않는다. 초기 제품 목적, 실제 코드, 남은 작업, 과도한 복잡도를 대조하고 유지/단순화/삭제/순서 변경 판단을 제시한다. 필요한 계획 문서 보정까지 수행하되 이 첫 리뷰에서 제품 코드나 운영 데이터를 바로 변경하지 않는다. 리뷰 이후 남은 구현을 이어갈 수 있는 짧고 구체적인 실행 순서를 남긴다.

## 원래 제품 목적

사용자는 매칭 화면을 보고 지원할 공고가 없다고 느끼지만, 실제로는 몇 가지 회사 사실을 확인하면 판단할 수 있는 공고가 있다. 카드에서 무엇을 확인할지 보여주고 예/아니오/모름으로 답하며 즉시 재판정해야 한다. 같은 의미의 회사 사실을 사용하는 네 공고는 한 번 답하면 함께 갱신되어야 한다. 이는 기존 공고와 앞으로 들어오는 공고 모두에 적용되어야 한다.

원문 해석이나 검수가 부족한 일을 회사 정보 질문으로 떠넘기면 안 된다. 모든 조건이 확인되지 않았는데 한 질문만 답하면 지원 가능하다고 단정해서도 안 된다. 같은 회사 사실과 공고별 해석을 구분한다.

핵심 구조 목표는 새 공고마다 전수 재분석 → 개별 보완 → 예외 추가를 반복하지 않는 것이다. 검수·질문·기간 갱신만 필요한 경우 해당 단계만 처리하고 유효한 기존 분석과 답변을 재사용한다. Jev 도입은 선택 트랙이며 완료 조건이 아니다.

## 작업 위치와 소스

- 실제 개발 폴더: `/private/tmp/cunote-condition-transition` (`/tmp/cunote-condition-transition`과 같은 위치일 수 있음).
- 브랜치: `codex/condition-resolution-transition`.
- 이 문서 작성 직전 HEAD: `2adc0f4`, 작업 폴더 clean. 핸드오프 문서 커밋이 후속으로 추가될 수 있다.
- 원래 폴더: `/Users/ffgg/noten.works/cunote`, 브랜치 `main`, 별도 미커밋 변경 다수 존재.
- 원래 폴더에는 매칭 이벤트·사용자 UI·DB schema·repository·OpenAPI·migration journal 변경과 연구 문서가 있다. 이 세션 변경으로 간주해 일괄 stage/reset/merge하지 않는다.
- 현재 구현은 main으로 통합하거나 이 세션에서 push/배포하지 않았다. 시작 시 두 폴더 상태를 짧게 확인한다.
- 격리 브랜치의 AGENTS.md에 최신 하네스 제거 결정이 있다. 원래 폴더의 과거 지침만 읽고 이를 되돌리지 않는다.

## 먼저 읽을 문서

모든 경로는 개발 폴더 기준이다. 앞의 세 문서로 맥락을 잡고 코드의 해당 부분만 읽는다.

1. `docs/research/2026-09-22-조건확인-공급체계-전환-종합실행계획.md` — 목적과 T0~T7, 실행 순서 R0~R6, 9월 23일 검증 방식 보정.
2. `docs/research/2026-09-22-반복재분석-구조진단과-Jev-도입검토.md` — 근본 원인 가설과 초기 전환 이유. 연구 당시 외부 제품 정보는 역사 자료다.
3. `docs/research/2026-09-22-조건공급-R0-통합지도.md` — 주 폴더와 겹치는 영역. R1 시점 문서이므로 'writer 없음', '화면 왕복 미완료' 등은 이후 R2로 해소된 역사 상태다.
4. `docs/research/2026-09-22-R3-1-질문준비-adapter-검증.md`.
5. `docs/research/2026-09-22-R3-2-source-rebind-adapter-검증.md`.

## 현재 구현 위치

| 단계 | 현재 증거 | 남은 범위 |
| --- | --- | --- |
| R0 정본·통합 지도 | 재개 기준과 격리 브랜치 확보 | 실제 main 통합은 R5 |
| R1 검수→v2 초안 | 사람 decision set을 기존 의미 계약의 migration draft/release plan에 연결 | 실제 사람 결정과 운영 발행은 별도 |
| R2 소량 이관·사용자 왕복 | 격리 PostgreSQL 및 인증된 Next runtime에서 저장·수정·철회·네 공고 반영 확인 | 운영 제한 표본 UAT |
| R3 후속 작업 | R3-0 공통 실행 경계, R3-1 질문 준비, R3-2 source rebind 구현 | 모집 갱신, coverage·조건 검수, 기존 자산 재사용 처리 |
| R4 신규 공고 연결 | 선행 계약만 있음 | 수집부터 질문·매칭까지 공통 경로와 관측 연결 |
| R5 통합·운영 반영 | 이관·rollback 코드/격리 증거 일부 | 통합, schema, 배포, 제한 이관, 운영 UAT |
| R6 전향 관찰 | 미착수 | 설계 고정 뒤 신규 50건 이상·최소 7일 |

현재 위치: **R3-2 완료, R3-3 착수 전**. 이 순서는 리뷰에서 바꿀 수 있다.

진척률을 코드 줄 수나 커밋 수로 계산하지 않는다. 이전 보고의 약 50%는 R0~R6 단계 기준 대략치이며, T0~T7의 완결 항목만 세면 T2/T3의 격리 인수 2/8=25%였다. 두 수치는 다른 분모이며 실제 운영 적용률이 아니다. 기존 서비스 전체의 완성도가 0%라는 뜻도 아니다. 다음 리뷰에서는 남은 사용자 결과 기준으로 더 일관된 산정 방법을 제안할 수 있다.

## 주요 커밋

- `b3d16fd` 조건 해소·최소 후속 작업 판정.
- `8a010e8` 회사 사실 답변의 관련 공고 재사용.
- `d56475b` 변경 영향 분류.
- `579c14c`, `32c022d`, `5f51b4a`, `3ad2725`, `3a082ce` 레거시 shadow·검수 packet·결정→초안.
- `6e322e9`, `a0d9b1a` 제한 이관 plan·writer·rollback.
- `a88c555`, `81db94c` 이관 질문 왕복·인증 화면 인수.
- `575ecae` R3-0 후속 작업 실행 경계.
- `d2f7388` R3-1 question preparation.
- `0ebcf97` R3-2 source rebind.
- `2adc0f4` 일괄 검증 하네스 제거.

## 핵심 코드 지도

- `apps/web/src/lib/server/productReadiness/grantReadiness.ts`, `grantReadinessLoader.ts`: 공통 준비도와 현재 근거 로딩.
- 같은 폴더 `grantNextWork.ts`, `grantNextWorkExecution.ts`: 최소 후속 작업 판정과 실행·재평가.
- `questionPreparationAdapter.ts`: 검수된 질문 release를 기존 promotion writer에 연결.
- `sourceRebindAdapter.ts`, `sourceRebindRelease.ts`, `sourceRebindServing.ts`: 의미 불변 raw 변경의 재결속 및 reader.
- `legacyQuestionMigrationDraft.ts`, `legacyQuestionMigrationReleasePlan.ts`, `legacyQuestionMigrationRelease.ts`, `legacyQuestionMigrationServing.ts`: 이관 경로.
- `apps/web/src/lib/server/ingestion/grantSourceChangeImpact.ts`: 변경 영향.
- `apps/web/src/lib/server/repositories/drizzle.ts`: 사용자 답변과 서비스 데이터 소비 경로.
- `apps/web/src/lib/server/analysis-serving/verifiedDeepSources.ts`: source rebind 후 유효 근거 채택.
- `db/migrations/0090_source_rebind_successor.sql`: 신규 source rebind 원장. 서비스 DB 미적용.

R3-2는 raw-only/evidence_refresh만 허용한다. 현재 source/material/serving 상태가 맞아야 하며 질문과 답변의 출처 결속을 transaction으로 함께 전진시킨다. 답변 값과 판정·revision은 보존한다. 같은 promotion 아래 반복 변경은 분기 없는 successor chain으로 처리한다. 조건·첨부·모집 변경은 이 경로가 처리하지 않는다.

## 사용자 결정: 개발 하네스 제거

사용자는 개발 속도 저하를 지적하고 프로젝트의 개발 하네스를 없애라고 지시했다. `2adc0f4`에서 다음을 적용했다.

- package.json의 `test`와 `test:product-journey` 일괄 명령 삭제.
- `.github/workflows/matching-ci.yml` 삭제.
- AGENTS.md 및 계획서에서 매 단계 집계 gate, 반복 검증, 별도 검증 문서/영수증 작성을 의무화하지 않도록 변경.
- 개별 테스트·격리 PostgreSQL·브라우저 도구는 필요할 때 선택해서 쓰도록 유지.
- 서비스의 권한, 답변 보존, 출처·조건 의미 검증, 운영 승인 경계는 유지.

전체 suite나 새로운 관제·하네스를 만드는 일을 다음 작업의 선행 조건으로 두지 않는다. 변경한 동작을 직접 확인하는 최소 검증으로 진행한다. 사용자 요청 없이 자동 CI를 복원하지 않는다.

## 검증 증거와 알려진 문제

- R2: 격리 DB와 source snapshot의 Next production runtime에서 password 로그인, inline 긍정, 네 공고 갱신 안내, 지원 가능 전환, 신청 준비 이동, 수정 진입, 부정 변경·철회·질문 재노출 확인. 운영 DB UAT가 아니다.
- R3-1: 격리 PostgreSQL에서 B→A, criterion ID와 v2 source 결속 보존, 모델 호출 0.
- R3-2: 답변이 있는 공고에 의미 불변 변경 두 번 연속 적용, 매번 D/source_rebind→A/reuse_ready, 멱등성과 답변 보존, 모델 호출 0.
- 이전 구현 당시 typecheck, migration 검사, 관련 readiness/PostgreSQL/serving/authoring 검사 통과 기록이 있다. 문서·CI 삭제 후 전체 suite를 다시 실행하지 않았다.
- 과거 product-journey 집계는 source-correction-browser.test.mjs에서 실패했다. 재현 명령: `node --test tools/product-uat/source-correction-browser.test.mjs`. 약 65ms 만에 `migration confirmation fixture grant가 누락됐습니다`로 실패했다.
- 이는 테스트가 생성한 connection fixture와 공통 validator의 필수 필드 불일치다. 운영 승인이나 외부 환경 부재로 설명했던 이전 보고는 정정했다. 관련 도구를 변경할 때 국소적으로 고칠 수 있으며 일반 구현 전체의 차단 사유로 삼지 않는다.
- 검증 기록의 '적용'은 격리 fixture 적용인 경우가 많다. 실제 서비스 DB migration·공고 이관·배포와 혼동하지 않는다.

## 리뷰에서 반드시 판단할 쟁점

1. 초기 문제를 해결하는 최단 경로인가? 기존 재고의 모든 처리기를 끝낸 뒤 R4 신규 유입을 연결하는 순서가 타당한가, 대표 유형으로 더 일찍 종단 연결할 수 있는가?
2. `sourceRebindRelease.ts` 등을 포함한 승인·원장·successor 구조가 실제 답변 보존에 필요한가? 최근 R3-2만 20개 파일/약 2천 줄 추가였다. 기존 공통 저장·실행 경로로 단순화할 수 있는 부분을 구체적으로 지목한다.
3. 공통 실행 구조가 분석 재사용과 최소 재개를 실제로 구현하는가, 처리 불가를 계속 다음 검수 대기로 보내는가?
4. 원문 의미 불변 분류의 근거가 충분한가? 잘못된 답변 재사용과 과도한 무효화 모두 살핀다.
5. 새로운 공고의 질문 생성·검수·발행까지 실제로 누가/어떤 경로로 완료하는가? 유형별 수동 예외나 반복 전수 검수로 회귀하는 구멍이 있는가?
6. 현재 구현/계획 중 삭제·통합할 수 있는 중복은 무엇인가? 운영 계약을 개발 절차와 혼동하지 않는다.
7. 이미 확보한 격리 인수 증거를 재사용하고 실제로 부족한 증거만 구분한다. 조사와 테스트 자체를 장기 프로젝트로 만들지 않는다.

## 리뷰 이후 남은 후보 작업

현 계획의 순서이며, 리뷰 결과로 보정 가능하다.

- R3-3 recruitment_refresh: recruitment_only 변경을 ingestion 정본의 신청 시작/마감/공개 상태에 연결. 기존 분석 재사용, 마감 재고 제외, 앞선 successor chain 보존.
- R3-4 coverage_review: 새 조항·첨부의 유지/부분 수리/추가 분석 경로.
- 조건/결속 검수의 유형별 처리, 질문 구조 수리와 프로필 판정 후보 연결, 분석 후보의 기존 자산 재사용 판정.
- R4 신규 유입 종단 연결과 공급 지연·검수량·재분석·답변 성공 관측.
- R5 main 변경과 파일별 통합, DB schema·배포·승인 표본 이관과 rollback·운영 사용자 왕복.
- R6 신규 공고 50건·7일 관찰 후 확대 판단.

537건, 조건/결속 검수 296건, 분석 후보 194건, 원문 변경 42건, 질문 준비 5건, 레거시 질문 22개(구조 수리 17·프로필 후보 3 등)는 과거 snapshot이다. 현행 수량이나 처리 완료 건수로 인용하지 않는다. 이번 리뷰를 위해 전수 운영 조사를 다시 할 필요는 없다.

## 다음 세션의 결과물

- 현재 방식 유지/부분 단순화/중요 재설계 중 근거 있는 결론.
- 유지할 코드와 단순화·제거할 코드, 제품 위험과 실제 이점.
- 원래 목적에 가까운 남은 실행 순서. 다음 한 묶음의 기능과 종료 조건을 명시.
- 종합계획의 필요한 보정. 새로운 거대 관리 문서는 만들지 않는다.
- 구현·운영 적용·관찰을 구분한 진행 상태.

## 제약

- 한글 커밋, Co-Authored-By 금지. 원래 dirty 작업 보존.
- 개발 서버는 사용자가 띄운다. 자동 실행하지 않는다.
- live 모델 실행·서비스 DB 쓰기·배포·Cloudflare 변경은 기존 exact 승인 범위를 확인해야 한다. 일반 구현/오프라인 확인에 과거 Gate R을 전이하지 않는다.
- 운영 main worker observe_only 유지. 유료 모델 호출이나 실제 사업자 조회를 테스트로 사용하지 않는다.
- 검수자의 결정을 AI가 실제 사람 결정인 것처럼 기록하지 않는다.
- 사용자 지정 Astra medium으로 이 리뷰를 수행한다. 이후 구현 모델 배정은 기존 비용 절감 의도에 맞춰 필요한 범위로 정한다.
