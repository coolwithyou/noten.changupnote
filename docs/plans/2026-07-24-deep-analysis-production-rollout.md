# 딥 공고 분석 결과 운영 매칭 적용 로드맵 및 구현 계획

> 작성일: 2026-07-24  
> 상태: **프로덕션 worker·영속 원장·딥분석 관제 운영 중 / 2공고 serving canary 통과 /
> 24시간 관측 후 20공고 확대 대기**
> 적용 대상: `analysis-lab`에서 생성하고 AI 검수·감사·검수팀 판정을 거친 공고별 조건과 확인 질문  
> 2026-07-25 확장: 활성 공고의 원문·HWP 딥분석을 사람 전수 검수 없이 운영하고,
> 단계별 증적으로 보증하는 계획은 이 문서 §14를 정본으로 사용한다.
> 선행 문서:
> - `docs/plans/2026-07-21-analysis-lab-expansion-experiment.md`
> - `docs/plans/2026-07-22-analysis-lab-shadow-harness.md`
> - `docs/plans/2026-07-23-confirmation-loop-phase-b.md`
> - `docs/plans/2026-07-23-review-team-ops-dispatch.md`

## 0. 한 줄 결론

딥 분석을 랜딩 요청 시점에 다시 실행하지 않는다. 분석 결과를 **오프라인 분석 → AI 검수·감사
→ 사람 검수 → 수거·조정 → 승격 릴리스 → `grant_criteria` 반영** 순서로 운영에 적용한다.
랜딩과 매칭 엔진은 이미 `grant_criteria`와 `grant_confirmation_questions`를 소비하므로,
남은 핵심은 새 매칭 기능 개발이 아니라 **초기 품질 게이트 종료, 변환 오류 해소, 재현 가능한
릴리스 증적, 카나리, 롤백, 운영 관측**이다.

2026-07-25 개정: 위 순서는 초기 품질 기준선을 만들기 위한 기존 릴리스 절차다. 상시 운영에서는
사람 전수 검수를 절대 선행조건으로 두지 않는다. 최상급 모델의 원문·첨부 전수 분석, 기계적
22축·근거 검증, 독립 모델의 블라인드 감사까지 모두 통과한 건은 자동 승격하고, 사람은
입력 누락·모델 불일치·계약 오류 같은 예외만 처리한다. 자세한 전환 계획은 §14를 따른다.

## 1. 목표와 완료 정의

### 1.1 목표

1. 검수된 딥 분석 조건을 운영 매칭의 진실 원천인 `grant_criteria`에 안전하게 반영한다.
2. 딥 분석이 만든 결격·자가신고 조건을 `grant_confirmation_questions`로 발행해 사용자가
   매칭 화면에서 바로 확인할 수 있게 한다.
3. 발행 전후의 매칭 변화가 검수된 원문 근거로 설명되고, 문제가 생기면 사용자 답변을 잃지
   않으면서 이전 상태로 복구할 수 있게 한다.
4. 첫 릴리스 이후에는 사람 검수 완료를 서비스 노출의 절대 선행조건으로 두지 않고,
   미확정 조건을 `needs_review=true`로 안전하게 노출하는 비차단 운영으로 전환한다.

### 1.2 완료 정의

다음 조건을 모두 충족해야 “딥 분석 결과 운영 적용 완료”로 본다.

- 초기 코호트의 검수팀 판정이 전부 수거됐고 충돌·stale 파일·receipt 불일치가 0건이다.
- 집계 게이트 6종이 사전 등록 규칙에 따라 GO다.
- 릴리스 대상의 변환 계약 오류, 변환 드롭, 질문 앵커 상실이 0건이다.
- 섀도 매칭의 모든 결과 변화가 검수된 criterion의 rule trace로 설명된다.
- 카나리 공고에서 운영 DB 반영, `match_state` 무효화, 랜딩 매칭 변화, 확인 질문 UI가
  기대값과 일치한다.
- 릴리스별 before/after 스냅샷과 쓰기 receipt가 남고, rollback 리허설이 통과한다.
- 전체 릴리스 후 대상 공고와 고정 검증 기업 표본에서 섀도 결과와 운영 결과가 일치한다.

## 2. 현재 상태

### 2.1 운영 데이터 실측

2026-07-25 읽기 전용 재확인 기준:

| 항목 | 현재 값 | 해석 |
|---|---:|---|
| 검수 배정 항목 | 66 | 현재 초기 릴리스 품질 게이트 표본 |
| decided | 42 | 판정은 저장됐으나 아직 collect 전 |
| pending | 12 | 검수 진행 필요 |
| conflict | 12 | 운영 관리자 3심 필요 |
| collected | 0 | 초기 릴리스 전 수거 필요 |
| 운영 DB의 딥 분석 criterion | 0 | 아직 랜딩 매칭에 딥 분석 미적용 |
| 운영 DB의 딥 분석 확인 질문 | 0 | 확인 CTA 미노출이 정상 |

### 2.2 2026-07-25 `lab:promote --dry-run` 실측

| 항목 | 현재 값 |
|---|---:|
| 승격 후보 공고 | 30 |
| 사람 검수 출처 | 3 |
| AI 감사 병합 출처 | 10 |
| 항목 resolver 미완 출처 | 17 |
| 발행 가능 | 30 |
| 계약 오류로 발행 거부 | 0 |
| 기존 A criterion | 60 |
| 계획된 B criterion | 240 |
| 확인 질문 | 17 |
| 강등 | 143 |
| 변환 드롭 | 0 |

계약에 맞지 않는 개별 row는 의미를 추정해 고치지 않고
`other/text_only + needs_review=true + contract_validation_failed`로 격리한다. 이 변경으로
기존 두 공고를 포함한 전체 30공고가 공고 단위 변환 실패 없이 계획되지만, 143개 강등 중
검수 미완 항목은 release 준비 게이트가 계속 거부한다.

### 2.3 이미 구현된 연결

| 영역 | 상태 | 현재 구현 |
|---|---|---|
| 딥 분석 | 완료 | 원문·첨부 기반 분석 런, immutable 파일 저장 |
| AI 검수·블라인드 감사 | 완료 | 서로 다른 모델, 사람 예외 큐 |
| 검수팀 배정 | 운영 중 | 주간 배정, 중복 표본, 수정 가능한 판정 |
| 수거·조정 | 완료 | CAS, 원자 파일 교체, receipt, reconcile |
| criterion resolver | 완료 | 확정·수정·오류·pending 상태 결정 |
| 섀도 매칭 | 완료 | DB write 없이 before/after 매칭 비교 |
| 승격 변환 | 완료 | canonical 정규화, stable key, 변환 손실 보고 |
| 승격 DB 쓰기 | 구현됨·미실행 | per-grant 트랜잭션, criteria/question upsert |
| 확인 질문 매칭·UI | 완료·dormant | 질문 데이터가 생기면 CTA와 확인 시트 노출 |
| 미검수 안전 게이트 | 완료 | `needs_review=true` hard criterion은 추천/탈락 확정 금지 |
| 릴리스 원장·롤백 | 구현 완료·미실행 | 불변 manifest, semantic question version, receipt, verify, rollback |
| 운영 카나리·관측 | 미실행 | 이번 계획에서 절차·도구 보강 |
| owned dashboard 답변 반영 | 구현 완료 | 저장 confirmation을 배치 로드해 dashboard matcher에 반영 |
| 익명 확인 CTA continuation | 구현 완료·데이터 대기 | 회사 저장·로그인 후 같은 공고 질문 자동 재개 |

### 2.4 2026-07-25 구현·배포 증적

- 구현 커밋: `62f4b3b` (`feat: gate deep analysis promotion to landing matching`)
- GitHub `main` push 완료
- DB migration: `0052_illegal_ricochet.sql` 적용, migration count `53 → 54`
- `pnpm db:doctor`: 필수 테이블·RLS 이상 없음
- Vercel production deployment: `dpl_2zQRoLerWq4f5g8qckCfrL9JauyF`, `READY`
- aliases: `https://changupnote.com`, `https://www.changupnote.com`,
  `https://changupnote.vercel.app`
- smoke: `/` 200, `/matches?biz=…` 200, 빈 teaser POST는 `biz_no_required` 400
- 배포 후 운영 DB: promotion release 0, deep criterion 0, confirmation question 0
- clean tree의 release prepare 실측: W30 미수거 66/66을 감지하고
  `pending 12 / decided 42 / conflict 12`로 쓰기 전 차단

## 3. 제품 적용 구조

```text
[공고 원문·첨부]
       │
       ▼
analysis-lab 분석 런
       │
       ├─ AI 검수(fable)
       ├─ 블라인드 AI 감사(sonnet)
       └─ ops 검수팀 사람 판정
                  │
                  ▼
       lab:collect / lab:reconcile
                  │
                  ▼
       criterion resolution + aggregate
                  │
                  ├─ lab:shadow ── 운영 DB 변경 없는 매칭 비교
                  │
                  ▼
       릴리스 manifest + dry-run
                  │
          승인된 release id
                  │
                  ▼
       lab:promote (카나리 → 전체)
                  │
          ┌───────┴────────────────┐
          ▼                        ▼
    grant_criteria       grant_confirmation_questions
          │                        │
          └──────────┬─────────────┘
                     ▼
         기존 랜딩 /matches / teaser / matcher
```

### 3.1 진실 원천

- 분석 산출과 감사 프로토콜: `spike-out/analysis-lab`의 immutable 런·review·audit·overlay
- 사람 판정 이력과 배분 provenance: `audit_dispatch_*`
- 운영 매칭 조건: `grant_criteria`
- 사용자 확인 질문: `grant_confirmation_questions`
- 사용자 답변: `company_grant_confirmations`
- 릴리스 이력과 복구 기준: 이번 계획에서 추가할 promotion release 원장

### 3.2 절대 지켜야 할 불변 조건

1. 랜딩 요청 중 LLM 호출을 하지 않는다.
2. 사람 검수 파일과 AI 검수 파일을 서로 덮어쓰지 않는다.
3. 미확정 required/exclusion은 `needs_review=true`이고 결과와 무관하게
   `unreviewed_criteria` 게이트를 통과해야 한다.
4. 발행 전 변환 계약 실패는 해당 공고를 통째로 거부한다.
5. 재승격은 stable key upsert를 사용한다. 같은 semantic definition의 질문만 기존 ID를
   보존하고, 의미가 바뀐 질문은 새 version/ID를 만들어 기존 답변을 원래 정의에 귀속시킨다.
6. 질문 앵커가 사라져도 질문·답변을 삭제하지 않고 질문만 soft-invalidate한다.
7. `match_state`는 영향 공고와 확인된 dedup 컴포넌트까지 무효화한다.
8. **release 후보 manifest를 먼저 동결**하고 aggregate·shadow·dry-run·promote가 모두
   그 manifest의 동일한 `PromotionPlan[]`만 소비한다.
9. manifest에 없거나 release shadow 결과에 없는 criterion/question은 발행을 거부한다.
10. manifest가 고정한 운영 DB baseline과 실발행 직전 baseline이 다르면 해당 공고를 거부한다.
11. 질문의 의미가 바뀌면 기존 질문을 제자리 수정하지 않고 새 question version을 만든다.
12. release receipt와 복구 스냅샷이 없으면 운영 쓰기를 열지 않는다.
13. 사업자등록번호 원문은 릴리스 산출물·로그·검증 보고서에 기록하지 않는다.

## 4. 로드맵

검수팀이 작업하는 동안 Phase 0과 Phase 2의 구현을 병행할 수 있다. 운영 DB 쓰기는
Phase 3의 GO 판정 이후에만 시작한다.

### Phase 0. 릴리스 제어면 보강 — 검수와 병행

목표: 현재 `--write --confirm-go`라는 사람의 선언만으로 열리는 실발행을, 특정 manifest와
receipt에 묶인 재현 가능한 릴리스로 바꾼다. **manifest가 release plan의 단일 원천**이며,
이후 aggregate·shadow·dry-run·promote는 각자 대상을 다시 수집하지 않는다.

구현:

- deterministic promotion manifest 생성
- manifest에 포함된 정확한 `PromotionPlan[]`을 aggregate·shadow·promote의 공통 입력으로 사용
- 공고별 기존 criteria·question·dedup 컴포넌트 baseline hash 고정
- 릴리스·공고별 before/after 스냅샷 원장
- manifest 해시와 입력 파일 해시 재검증
- 카나리 대상 선택과 allowlist
- versioned aggregate GO artifact와 release-plan 기반 shadow PASS artifact
- rollback 명령과 사용자 답변 보존 테스트
- 운영 반영 검증 명령

완료 조건:

- 같은 입력으로 두 번 manifest를 만들면 같은 plan hash가 나온다.
- 런·audit·overlay·confirmation 중 하나라도 변경되면 발행이 거부된다.
- 기존 criteria·question·dedup baseline이 바뀌면 `baseline_drift`로 발행이 거부된다.
- aggregate·shadow·promote가 소비한 release plan hash가 모두 같다.
- rollback 통합 테스트에서 기존 criteria, 질문 ID, 사용자 답변이 보존된다.

### Phase 1. 현재 검수 배치 종료와 판정 수거

목표: 초기 릴리스는 현재 W30 검수팀 배치를 완결된 품질 기준선으로 사용한다.

절차:

1. 검수팀 66개 항목 판정 완료
2. 중복 표본의 상이한 판정은 `conflict`로 전환
3. admin/owner가 3심하여 `resolved` 처리
4. `lab:collect`로 audit/overlay 파일에 원자 병합
5. `lab:reconcile`로 DB receipt와 파일 sha256 전수 대조
6. 판정 일치율·Cohen's κ·수정률·검수자별 분포 기록

초기 릴리스 완료 조건:

- pending 0, conflict 0
- collected 또는 resolved 후 collect 대기 0
- stale audit file 0
- receipt 무결성 100%
- 판정자 이메일·revision·결정 시각 provenance 누락 0

초기 릴리스 이후 정책:

- 사람 검수는 서비스 전체를 차단하지 않는다.
- 사람 판정 또는 완료된 독립 감사가 일치한 criterion만 `needs_review=false` 발행 가능
- 감사 표본에 들지 않은 `unaudited_correct`와 사람 큐 잔류 criterion은
  `needs_review=true`로만 발행
- pending criterion이 추천 또는 탈락을 확정하지 못한다는 엔진 회귀 테스트를 항상 유지

### Phase 2. 변환 계약 오류와 강등 분석

목표: 릴리스 대상에서 변환 오류·드롭을 0으로 만들고, 강등은 의도와 근거가 있는 경우만
허용한다.

작업:

1. 계약 오류 2공고의 원문, analysis criterion, AI 판정, 사람 판정을 한 화면에서 대조
2. 각 오류를 다음 중 하나로 명시 결정
   - 기존 canonical 값으로 매핑
   - evaluator·질문·기업 데이터 소싱까지 구현한 신규 canonical 값 추가
   - 기계 판정이 부적절하면 `other/text_only`로 보수 강등
   - 추출 자체가 잘못됐으면 검수 판정으로 발행 제외
3. 결정된 규칙을 `normalizeGrantLlmCriteria` 또는 Lab 변환 어댑터에 구현
4. 두 실패 사례와 동형 반례를 fixture로 추가
5. 36개 강등을 dimension·사유별로 집계하고, required/exclusion 강등은 사람 확인
6. 전체 30공고 dry-run 재실행

완료 조건:

- 발행 거부 0
- conversion error 0
- dropped criterion 0
- dropped question candidate 0
- 각 downgrade에 원인 코드와 `needs_review=true`가 기록됨
- 신규 canonical 값을 추가했다면 evaluator, 질문 planner, 계약 테스트까지 함께 통과

### Phase 3. 초기 릴리스 후보 확정

목표: 검수된 데이터가 품질 게이트와 실제 매칭 효과를 모두 통과했음을 문서화한다.

실행:

1. 수거 완료 artifact와 현재 운영 DB baseline으로 **release 후보 manifest를 먼저 발급**
2. `lab:aggregate --release=<id>`가 manifest의 동일 plan 집합으로 게이트 6종 JSON을 생성
3. 층별 정밀도, 누락, 구조화 비율, 검수자 일치도 확인
4. `lab:shadow --release=<id>`가 manifest의 실제 발행 criteria로 고정 profile corpus의
   before/after와 허용 전이 PASS/FAIL JSON을 생성
5. `lab:promote --release=<id> --dry-run`의 A→B, 질문, 강등, 드롭과 plan hash 대조
6. `docs/research/`에 STOP/ITERATE/GO 판정 문서 작성
7. `lab:release --approve`가 aggregate=`GO`, shadow=`PASS`, dry-run plan hash 일치를
   기계적으로 검증한 뒤에만 manifest를 승인 상태로 전환

GO 조건:

- 사전 등록 aggregate 게이트 6/6
- 계약 오류·드롭·질문 앵커 상실 0
- 영향받지 않는 공고와 control profile의 결과 변화 0
- eligibility/tier가 변한 모든 행에 검수된 required/exclusion trace가 존재
- pending criterion으로 인한 hard ineligible 또는 recommendable 전환 0
- 확인 질문의 option 극성과 criterion 의미가 100% 일치
- aggregate와 shadow artifact의 `releaseId`·`releasePlanSha256`이 manifest와 일치
- aggregate artifact의 `verdict=GO`, shadow artifact의 `verdict=PASS`
- manifest의 `beforeCriteriaSha256`·`beforeQuestionsSha256`·`dedupComponentSha256`이
  승인 시점 운영 DB와 일치

STOP/ITERATE:

- 하나라도 충족하지 않으면 실발행하지 않는다.
- 실패 원인이 데이터인지 변환기인지 matcher인지 구분해 같은 코호트로 수정 후 재실행한다.
- 게이트 기준을 결과를 본 뒤 완화하지 않는다.
- source artifact, 변환 코드 또는 plan을 수정했다면 기존 manifest를 고치지 않고
  새 release revision을 발급해 aggregate·shadow·승인을 다시 수행한다.

### Phase 4. 카나리 발행

목표: 전체 30공고를 한 번에 교체하지 않고 운영 연결과 복구 가능성을 작은 범위에서 증명한다.

카나리 선정 기준:

- 사람 검수 또는 AI 감사 병합이 완료된 공고
- pending criterion 0
- 변환 드롭·강등 0을 우선
- BizInfo와 K-Startup 소스를 모두 포함
- 확인 질문이 있는 공고 1건 이상 포함
- dedup 컴포넌트가 있는 공고가 있다면 1건 포함
- 기존 A criterion이 있는 공고와 없는 공고를 모두 포함

권장 순서:

1. **카나리 A — 1공고:** criteria 교체와 match_state 무효화만 확인
2. **카나리 B — 2~3공고:** 두 소스, 질문 CTA, dedup 전파 확인
3. 관찰·검증 통과 후 초기 확정분 전체로 확대

카나리 검증:

- DB의 criterion 수·stable key·parser version이 manifest와 일치
- question ID와 criterion FK가 연결되고 invalidated question이 활성 조회에서 제외
- 기존 사용자 답변이 있다면 행 수·question ID·answeredAt 불변
- `match_state`가 대상과 dedup 연결 공고에서만 무효화
- 고정 기업 프로필의 운영 매칭 결과가 shadow after와 일치
- 익명 랜딩 사업자번호 입력 후 대상 공고 카드의 판정·근거·질문 CTA 노출이 예상과 일치
- 질문 조회·답변·`confirmed_by_user` trace는 로그인하고 회사를 저장한 owned-company
  경로에서 검증
- 익명 카드의 CTA를 클릭하면 로그인·회사 저장 후 같은 공고 질문으로 재개
- control 공고의 카드·순위·trace는 불변

관찰 중단·롤백 조건:

- manifest와 DB row hash 불일치
- 설명할 수 없는 eligible/ineligible 또는 추천 tier 전환
- pending criterion이 추천/탈락 확정에 사용됨
- 질문 option과 disqualified 극성 불일치
- 사용자 답변 삭제·재연결 실패
- 대상 밖 공고의 match_state 또는 criteria 변경
- 비교 가능한 표본에서 기존 기준 대비 p95 응답 시간이 20% 이상 악화하거나 오류율 증가

### Phase 5. 초기 코호트 전체 발행

목표: 카나리에서 검증된 같은 release manifest의 나머지 공고를 발행한다.

절차:

1. 카나리와 같은 manifest인지 해시 재검증
2. 이미 성공한 카나리는 멱등 skip
3. 나머지 공고를 per-grant 트랜잭션으로 순차 발행
4. 공고별 성공·실패 receipt 저장
5. 일부 공고 실패 시 성공분을 숨기지 않고 릴리스를 `partial_failed`로 표시
6. 네트워크·락처럼 입력 바이트가 변하지 않은 일시 오류만 같은 release ID로 재시도
7. source artifact·변환 코드·plan 수정이 필요하면 새 release revision을 발급
8. 전체 DB 대조와 랜딩 smoke 완료 후 `active` 전환

완료 조건:

- release item 성공 수 = manifest 대상 수
- DB after hash 100% 일치
- deep criterion·question 수가 manifest 합계와 일치
- 운영 매칭과 shadow after의 결과 불일치 0
- control set 불일치 0
- 운영 오류율·응답시간 회귀 없음

### Phase 6. 상시 분석·검수·승격 운영

초기 코호트 적용 후 주간 루프:

```text
신규 open 공고 분석
→ AI 검수·블라인드 감사
→ 즉시 발행 가능한 확정 항목과 사람 큐 분리
→ 주간 dispatch
→ 사람 판정 수거
→ 변경분 release 생성
→ shadow regression
→ 카나리 또는 저위험 자동 승격
```

운영 원칙:

- 첫 발행은 공고 단위 카나리, 동일 stable key의 `needs_review true→false` 전환은 저위험 갱신
- wrong/needs_edit로 criterion 의미가 변하면 새 release와 shadow를 요구
- 공고 원문 hash가 바뀌면 기존 분석을 자동 재사용하지 않고 재분석 후보로 보냄
- 마감 공고는 신규 분석 대상에서 제외하되 기존 릴리스 이력은 보존
- 주간 품질 보고에 분석 수, 발행 수, pending 수, 수정률, rollback 수를 포함

## 5. 상세 구현 작업

### IMP-01. Promotion release manifest

신규 파일:

- `apps/web/src/lib/server/analysis-lab/promotion-release.ts`
- `apps/web/src/lib/server/analysis-lab/promotion-release.test.ts`
- `apps/web/src/lib/server/analysis-lab/promotion-release-cli.ts`

manifest 필드:

```ts
interface PromotionReleaseManifest {
  schema: "analysis-lab-promotion-release-v1";
  releaseId: string;
  revision: number;
  createdAt: string;
  gitCommit: string;
  buildDigest: string;
  cohortLabel: string;
  canaryGrantIds: string[];
  releasePlanSha256: string;
  sourceArtifacts: Array<{
    grantId: string;
    runId: string;
    runSha256: string;
    reviewSha256?: string;
    auditSha256?: string;
    overlaySha256?: string;
    confirmationsSha256?: string;
  }>;
  plans: Array<{
    grantId: string;
    planSha256: string;
    promotionPlan: GrantPromotionPlan;
    beforeCriteriaSha256: string;
    beforeQuestionsSha256: string;
    dedupComponentSha256: string;
    criteriaCountBefore: number;
    criteriaCountAfter: number;
    questionCountAfter: number;
    pendingCount: number;
    downgradedCount: number;
  }>;
  manifestSha256: string;
}
```

규칙:

- 정렬·NFC·stable JSON으로 같은 입력은 같은 hash
- manifest 준비 시점의 전체 criteria/question 내용과 confirmed dedup 연결을 canonical
  serialization하여 공고별 baseline hash로 고정
- `PromotionPlan[]`이 release의 단일 원천이며 aggregate·shadow·promote가 재수집하지 않음
- `releasePlanSha256 = sha256(canonical(sorted plans[]))`이며 모든 release artifact가
  공고별 hash와 함께 이 release-level hash를 사용
- business number와 회사 원문 프로필은 manifest에 저장하지 않음
- `spike-out/analysis-lab/releases/<releaseId>/manifest.json`에 immutable `wx` 저장
- 운영 쓰기 전 DB 릴리스 원장에도 manifest hash 저장
- release 준비·승인은 clean git tree 또는 재현 가능한 build digest에서만 허용
- manifest hash 확인 문자열은 최소 길이를 강제하고 전체 hash는 항상 서버에서 재검증
- `manifestSha256`은 해당 필드를 제외한 canonical manifest body로 계산
- gate 실행 후 manifest를 수정하지 않으며 gate hash는 별도 immutable `approval.json`에 기록

구조화 게이트 artifact:

- `aggregate.json`: versioned schema, releaseId, releasePlanSha256, 6개 gate의 기준·실측·판정,
  최종 `verdict=GO|ITERATE|STOP`. 6/6이 아니면 CLI exit 2.
- `shadow.json`: releaseId, releasePlanSha256, 고정 profile corpus hash, asOf, 허용 전이 규칙,
  before/after, 최종 `verdict=PASS|FAIL`. 규칙 위반이면 CLI exit 2.
- `dry-run.json`: versioned schema, releaseId, releasePlanSha256, 공고별 baseline/after hash,
  guard 결과, 최종 `verdict=PASS|FAIL`. 불일치나 guard 거부가 있으면 CLI exit 2.
- `approval.json`: aggregate/shadow/dry-run artifact hash, 승인자, 승인시각, manifest 전체 hash.

변경 대상:

- `apps/web/src/lib/server/analysis-lab/aggregate.ts`: manifest에 지정된 source artifact만
  집계하고 versioned JSON·exit code 생성
- `apps/web/src/lib/server/analysis-lab/shadow.ts`: manifest의 실제 promotion criteria와
  고정 profile corpus를 사용하고 PASS/FAIL JSON 생성
- `apps/web/src/lib/server/analysis-lab/promote-cli.ts`: manifest plan 외 재수집 금지
- `package.json`: release 준비·승인·검증·rollback 명령 추가

### IMP-02. 릴리스·복구 DB 원장

스키마 추가:

```text
analysis_lab_promotion_releases
  id uuid PK
  release_id text UNIQUE
  manifest_sha256 text
  git_commit text
  build_digest text
  status text
  gate_summary jsonb
  created_by text
  approved_by text null
  approved_at timestamptz null
  approval_artifact_sha256 text null
  executed_by text null
  created_at / started_at / completed_at / rolled_back_at

analysis_lab_promotion_items
  id uuid PK
  release_id FK
  grant_id FK
  run_id text
  plan_sha256 text
  before_snapshot jsonb
  before_sha256 text
  after_snapshot jsonb
  after_sha256 text
  status text
  error text null
  applied_at / rolled_back_at
  UNIQUE(release_id, grant_id)
```

DB 계약 작업:

- `apps/web/src/lib/server/db/schema.ts`에 CHECK·FK·unique/index 포함
- `db/migrations/<next>_*.sql`과 `db/migrations/meta/_journal.json` 생성·검수
- `apps/web/src/lib/server/db/requirements.ts` required table/column 검증 갱신
- migration 전후 schema drift와 rollback rehearsal용 disposable DB 검증
- 최초 릴리스는 승인자와 실행자를 분리하고 두 actor를 모두 원장에 기록

상태:

```text
prepared → approved → canary_running → canary_passed
→ applying → active
                 └→ partial_failed
어느 단계에서든 조건 충족 시 → rolling_back → rolled_back
```

스냅샷 범위:

- 대상 공고의 `grant_criteria`
- 활성·무효 질문
- 질문 ID와 stable key 연결
- 사용자 답변은 내용 복사 대신 question ID별 존재 수와 hash만 기록
- `match_state`는 복구하지 않고 criteria 복구 후 재계산하도록 삭제

### IMP-03. `lab:promote`를 manifest-bound 실행으로 변경

변경 파일:

- `apps/web/src/lib/server/analysis-lab/promote.ts`
- `apps/web/src/lib/server/analysis-lab/promote-cli.ts`
- `apps/web/src/lib/server/analysis-lab/promote.test.ts`
- `package.json`

변경:

- 기존 `--write --confirm-go`는 deprecated 처리
- 신규 실발행은 `--release=<id> --write --confirm=<manifestShaPrefix>` 모두 필요
- manifest source hash와 현재 파일 hash 재검증
- plan hash와 현재 dry-run plan hash 재검증
- 공고별 publication advisory lock을 획득한 뒤 같은 트랜잭션에서 현재
  criteria/question/dedup baseline hash 재계산
- 현재 hash가 manifest와 하나라도 다르면 `baseline_drift`로 해당 공고 거부
- analysis-lab과 기존 ingestion publisher가 같은 publication lock helper를 사용하도록 통합
- 릴리스 상태가 `approved` 또는 `canary_passed`일 때만 쓰기
- `--grantId`는 manifest 안의 카나리 allowlist에만 허용
- per-grant 트랜잭션 안에서 criteria/question 쓰기와 item receipt 기록을 함께 처리
- 재실행 시 after hash가 같으면 멱등 성공, 다르면 drift로 거부

### IMP-04. Rollback

신규 파일:

- `apps/web/src/lib/server/analysis-lab/promotion-rollback.ts`
- `apps/web/src/lib/server/analysis-lab/promotion-rollback.test.ts`
- `apps/web/src/lib/server/analysis-lab/promotion-rollback.ts`가 CLI 진입점도 함께 제공

명령:

```bash
# 신규 구현 후
pnpm lab:rollback -- --release=<id> --dry-run
pnpm lab:rollback -- --release=<id> --write --confirm=<manifestShaPrefix>
```

복구 의미론:

- before snapshot의 기존 criterion ID와 내용을 복원
- 릴리스가 새로 만든 criterion은 제거
- 릴리스가 만든 질문 version은 삭제하지 않고 `release_rolled_back`으로 soft-invalidate
- 기존 질문 version은 ID를 유지한 채 이전 활성/무효 상태로 복구
- `company_grant_confirmations` 행은 절대 삭제하지 않음
- rollback 시작 전 현재 after hash를 대조하고, 배포 후 별도 변경이 있으면 자동 복구를
  거부해 다른 변경을 덮어쓰지 않음
- promote·ingestion과 같은 publication advisory lock을 획득
- 공고별 current-after hash 확인, criteria/question 복원, match_state 무효화,
  rollback item receipt 기록을 하나의 트랜잭션에서 수행
- lock 획득 후 hash가 다르면 `rollback_drift`로 해당 공고 거부
- 대상과 dedup 컴포넌트의 `match_state` 삭제
- rollback 후 DB hash와 before hash 대조

### IMP-04-a. 질문 versioning과 답변 의미 보존

현재 `(grant_id, criterion_stable_key)` 질문 행을 제자리 갱신하는 방식은 prompt/options가
바뀐 뒤 rollback할 때 기존 답변이 다른 질문 의미에 연결될 수 있다. 다음 계약으로 바꾼다.

- semantic definition hash =
  `prompt + options + answerType + reusable + conditionKey`의 canonical hash
- 같은 criterion stable key라도 definition hash가 다르면 새 question ID와 version 생성
- 기존 unique를 `(grant_id, criterion_stable_key, definition_hash)`로 변경
- 이전 질문은 `superseded` 사유로 soft-invalidate하고 새 질문이 active가 됨
- 동일 definition 재발행은 의미 필드를 수정하지 않고 anchor/provenance/active 상태만 갱신
- 답변은 생성 당시 question ID/version에 영구 귀속
- rollback은 질문 version의 활성 상태만 되돌리고 답변을 다른 definition으로 재연결하지 않음
- active 질문 조회는 공고·stable key당 한 version만 반환

스키마 후보:

```text
grant_confirmation_questions
  definition_sha256 text NOT NULL
  version integer NOT NULL
  supersedes_question_id uuid null
  UNIQUE(grant_id, criterion_stable_key, definition_sha256)
  UNIQUE(grant_id, criterion_stable_key) WHERE invalidated_at IS NULL
```

### IMP-05. 변환 계약 오류 교정

변경 후보:

- `packages/core/src/bizinfo/llm-criteria.ts`
- `apps/web/src/lib/server/analysis-lab/shadow-convert.ts`
- 관련 contracts/evaluator/question planner
- `apps/web/src/lib/server/analysis-lab/shadow-convert.test.ts`
- `apps/web/src/lib/server/analysis-lab/promote.test.ts`

결정 순서:

1. 원문에 실제 조건이 있는지 확인
2. 기존 dimension이 맞는지 확인
3. canonical value로 기계 판정 가능한지 확인
4. 불가능하면 text-only로 보수 강등
5. 신규 enum은 서로 다른 공고 반복과 기업 데이터 소싱 가능성이 확인될 때만 추가

추가 정책 수정:

- `criterionNeedsReview("unaudited_correct")`는 `true`
- `needs_review=false`는 사람 판정 또는 완료된 독립 감사 일치만 허용
- 기존 `criterion-resolution.test.ts`의 unaudited 발행 기대값을 새 정책으로 변경
- 이 정책을 추후 완화하려면 별도 release 정책 변경과 회귀 평가가 필요

### IMP-06. 운영 검증 CLI

신규 파일:

- `apps/web/src/lib/server/analysis-lab/verify-promotion.ts`
- `apps/web/src/lib/server/analysis-lab/verify-promotion.test.ts`

명령:

```bash
# 신규 구현 후
pnpm lab:verify-promotion -- --release=<id> --scope=<canary|all>
```

검증 항목:

- manifest plan과 DB criteria/question hash
- parser/source provenance
- stable key 중복
- 질문 orphan·무효화 상태
- 사용자 답변 question ID 보존
- match_state 무효화 범위
- shadow 결과와 현재 matcher 결과
- control grant 불변
- `--scope=canary`: 적용된 canary item의 after hash와 미적용 item의 before hash를 모두 확인
- `--scope=all`: 모든 release item의 after hash 확인
- scope와 release item 상태가 맞지 않으면 exit 2

release shadow는 기존 `convertReviewedLabRun(correct-only)`를 직접 사용하지 않는다.
manifest에 고정된 `PromotionPlan.criteria`를 after 입력으로 사용해야 실제 promote와 동일하다.
manifest에 없거나 shadow record가 없는 criterion/question은 verify 단계에서 실패한다.

출력:

- 사람이 읽는 stdout 요약
- `spike-out/analysis-lab/releases/<releaseId>/verification.json`
- 종료코드 0=일치, 2=drift, 1=실행 오류

개인정보 규칙:

- `--bizNo`는 profile 해석 중 메모리에서만 사용
- shadow/verification artifact의 회사 키는 release별 salt를 사용한 pseudonymous key
- JSON, stdout, 오류 메시지에 원문 사업자등록번호가 없는지 회귀 테스트

### IMP-07. 운영 관측

최소 지표:

- 활성 공고 중 deep criterion 보유 공고 수
- deep criterion 수와 dimension·kind·needs_review 분포
- promotion release 성공·실패·rollback 수
- deep criterion이 포함된 매칭의 eligibility/tier 분포
- `unreviewed_criteria` 게이트 발생 수
- 확인 질문 노출·답변·결격 응답·답변 수정 수
- deep criterion 적용 공고의 teaser 응답시간과 오류율
- 검수 결과가 기존 AI 판정을 뒤집은 비율

주의:

- 사업자등록번호를 메트릭 label이나 로그에 넣지 않는다.
- 고카디널리티 grantId는 dashboard label 대신 release detail에서만 조회한다.
- matcher trace에 provenance를 추가한다면 외부 응답 계약에는 내부 runId를 노출하지 않는다.

### IMP-08. 문서와 운영 절차

업데이트 대상:

- 이 문서의 실행 결과와 release id
- `docs/plans/HANDOFF-2026-07-23.md`의 남은 작업
- `docs/plans/2026-07-23-confirmation-loop-phase-b.md`의 실발행 상태
- 운영자용 release/rollback runbook
- 검수팀 가이드는 판정 방법이 바뀌는 경우에만 업데이트

### IMP-09. 익명 랜딩과 owned-company 확인 경계

현재 익명 teaser는 딥 criterion으로 카드 판정·근거·질문 수를 보여줄 수 있지만, 저장된
confirmation 답변을 재조회하는 경로는 owned-company API다.

- 익명 랜딩 E2E: 카드 판정, 근거, 질문 CTA 노출까지만 검증
- 익명 CTA 클릭: 로그인과 회사 저장을 거쳐 같은 grantId 질문으로 돌아오는 continuation 저장
- 로그인 후 owned-company E2E: 질문 조회·답변·즉시 재계산 카드 적용
- 재로그인 유지: owned-company 답변과 결과로 검증
- 익명 teaser 재조회가 저장 confirmation을 반영한다고 가정하지 않음
- `loadServiceDashboard`의 owned-company read가 `listCriterionConfirmations`를 공고 묶음으로
  배치 로드하고 confirmation-aware match plan으로 카드·counts·nextQuestion을 함께 구성
- 제출 직후 응답, dashboard 최초 로드, 재로그인 후 로드가 같은 confirmation-aware matcher
  경로를 사용

변경 후보:

- `apps/web/src/lib/server/serviceData.ts`
- `apps/web/src/lib/server/productProfile/productMatchSnapshot.ts`
- `apps/web/src/lib/server/matches/matchStateRefresh.ts`
- confirmation batch loader와 dashboard 회귀 테스트

## 6. 테스트 계획

### 6.1 순수 로직

- manifest canonical serialization과 hash 결정성
- source artifact 하나 변경 시 drift 검출
- aggregate·shadow·dry-run·promote의 releaseId와 releasePlanSha256 동일성
- release 전체 `releasePlanSha256` 결정성과 공고 정렬 불변성
- aggregate 6/6 미달과 shadow 허용 전이 위반의 exit 2
- 운영 DB baseline hash 변경 시 `baseline_drift`
- pending criterion은 `needs_review=true`
- unaudited_correct도 `needs_review=true`
- pending required/exclusion의 pass/fail/unknown 전부 `unreviewed_criteria`
- contract failure와 empty criteria fail-closed
- stable key 재승격 시 criterion ID 보존
- 같은 질문 definition 재발행 시 question ID 보존
- 질문 definition 변경 시 새 question ID/version 생성
- 질문 앵커 상실 시 soft-invalidate
- shadow·verification 산출물과 stdout의 원문 사업자등록번호 누출 0

### 6.2 DB 통합

- per-grant promotion과 release item receipt가 같은 트랜잭션
- 부분 실패 시 다른 공고의 성공 상태 보존
- 재실행 멱등
- dedup 컴포넌트 match_state 무효화
- 기존 사용자 답변 보유 공고 재승격
- semantic 질문 변경 뒤 구·신 version에 각각 답변을 저장해도 의미가 섞이지 않음
- rollback 후 before hash 일치, 답변 행·question version 귀속 불변
- concurrent publisher로 baseline이 변하면 쓰기 거부
- rollback도 publication lock 획득 후 drift를 재검사하고 item receipt와 함께 커밋

### 6.3 제품 E2E

익명 경로:

1. 사업자등록번호 입력
2. `/matches` 진입
3. 카나리 공고 카드 판정·근거·질문 CTA 확인
4. CTA 클릭 후 로그인·회사 저장 continuation 확인

owned-company 경로:

1. 로그인하고 저장된 회사로 같은 공고 진입
2. 확인 질문 조회
3. 비결격 답변 후 재분류와 `본인 확인 기반` 표시
4. 결격 답변 후 탈락 처리
5. 답변 수정 후 재분류
6. 재로그인 후 답변과 결과 유지
7. dashboard counts와 nextQuestion도 저장 답변을 반영

### 6.4 성능·회귀

- 고정 기업 프로필 × 대상/대조 공고 매트릭스 before/after
- teaser p50/p95와 payload 크기 비교
- 질문 count annotation의 추가 DB 쿼리 수 확인
- 30공고 전체 발행 후 N+1 쿼리 없음

## 7. 실행 명령 순서

현재 존재하는 명령:

```bash
# 1. 검수 판정 수거
pnpm lab:collect -- --week=2026-W30

# 2. 파일·DB receipt 대조
pnpm lab:reconcile -- --week=2026-W30

# 3. 현재 품질 진단 — stdout 참고용이며 release 승인 artifact가 아님
pnpm lab:aggregate

# 4. 현재 섀도 진단 — 감사 완료 correct-only이며 실제 pending 승격 plan과 다를 수 있음
pnpm lab:shadow

# 5. 현재 승격 계획 확인 — DB write 없음, 위 shadow와 대상 차이를 반드시 확인
pnpm lab:promote -- --dry-run
```

구현된 릴리스 명령:

```bash
# 6. immutable release 후보와 DB baseline 생성
pnpm lab:release -- --prepare --cohort=2026-W30 --actor=<준비자>

# 7. 동일 manifest plan으로 구조화 게이트·섀도·dry-run 생성
pnpm lab:aggregate -- --release=<id>
pnpm lab:shadow -- --release=<id>
pnpm lab:promote -- --release=<id> --dry-run

# 8. 세 artifact의 GO/PASS/hash 일치 검증 후 승인
pnpm lab:release -- --approve --release=<id> --actor=<승인자> --confirm=<manifestShaPrefix>

# 9. 카나리
pnpm lab:promote -- --release=<id> --grantId=<id> --write --actor=<실행자> --confirm=<manifestShaPrefix>

# 10. 카나리 검증 — 적용 item은 after, 미적용 item은 before
pnpm lab:verify-promotion -- --release=<id> --scope=canary

# 11. 나머지 릴리스
pnpm lab:promote -- --release=<id> --write --actor=<실행자> --confirm=<manifestShaPrefix>

# 12. 전체 검증
pnpm lab:verify-promotion -- --release=<id> --scope=all

# 문제 발생 시
pnpm lab:rollback -- --release=<id>
pnpm lab:rollback -- --release=<id> --write --actor=<롤백담당자> --confirm=<manifestShaPrefix>
```

## 8. 역할과 승인

| 역할 | 책임 |
|---|---|
| 검수팀 | 배정 항목 판정과 필요한 근거 기록 |
| 운영 관리자 | 중복 표본 충돌 3심, 수거 상태 확인 |
| 구현 담당 | 계약 오류 교정, release/rollback/verify 구현 |
| 릴리스 검토자 | aggregate·shadow·manifest·카나리 결과 검토 |
| 최종 승인자 | 최초 운영 DB 쓰기와 전체 확대 승인 |

최초 `--write`는 aggregate GO, shadow PASS, manifest, DB baseline, rollback 리허설,
카나리 목록을 확인한 승인 artifact가 있어야만 실행된다. 준비자와 승인자는 달라야 하며,
승인자와 실행자도 분리해 원장에 각각 기록한다.

## 9. 위험과 대응

| 위험 | 대응 |
|---|---|
| 검수 중인 파일과 dispatch DB가 어긋남 | CAS, receipt, reconcile 100%를 릴리스 게이트로 |
| canonical 계약 오류가 전체 criterion을 드롭 | 공고 fail-closed, 오류 fixture, release set 드롭 0 |
| 기존 A를 B로 교체하며 조건이 사라짐 | before snapshot, plan diff, shadow, rollback |
| pending 조건이 오추천·오탈락 확정 | `needs_review=true` + `unreviewed_criteria` 엔진 가드 |
| 질문 의미 변경 후 기존 답변 오해석 | semantic definition versioning, 새 question ID, 답변 영구 귀속 |
| 부분 성공을 전체 성공으로 오인 | per-grant release item 상태와 `partial_failed` |
| 운영 결과와 섀도 결과 불일치 | 고정 프로필 verify CLI, control set, after hash |
| manifest 이후 DB 기준 변경을 덮어씀 | baseline hash, 공유 publication lock, 트랜잭션 재검증 |
| shadow가 보지 않은 pending criterion 발행 | 단일 manifest `PromotionPlan[]`을 전 단계가 소비 |
| 랜딩 응답 지연 | 요청 시 LLM 금지, DB 쿼리 수·p95 카나리 비교 |
| 운영 rollback이 더 큰 손실 유발 | 카나리 전 실제 DB와 동형 fixture에서 복구 리허설 |
| 검수 완료를 기다리다 신규 공고 노출 지연 | 초기 품질 게이트 후 항목 단위 비차단 승격 |

## 10. 2026-07-24 초기 릴리스의 비범위

> 아래는 W30 초기 승격 릴리스의 비범위다. 2026-07-25에 활성 공고 전수 운영이 새 목표로
> 확장됐으며, 해당 구현 범위와 순서는 §14가 이 목록을 대체한다.

- 랜딩 요청마다 딥 분석 LLM 실행
- 초기 W30 릴리스 안에서 모든 활성 공고를 일괄 분석
- 결정론 검증·독립 감사 없이 AI 산출을 곧바로 `needs_review=false`로 발행
- Phase C의 company_fact 답변을 `company_profiles`로 승격
- 반복 근거 없는 신규 taxonomy 축 확대
- 통합공고의 하위 사업 자동 분해
- 분석·매칭과 무관한 랜딩 UI 재설계

## 11. 의존 순서

```text
검수팀 판정 완료 ─→ collect/reconcile ─┐
                                        ├→ release 후보 manifest + DB baseline
계약 오류 교정 ─→ 전체 plan 드롭 0 ───┘                │
                                                        ├→ 같은 plan의 aggregate GO
                                                        ├→ 같은 plan의 shadow PASS
release 원장·rollback·verify 구현 및 리허설 ─────────────┤
                                                        ▼
                                              승인 → 카나리 → 전체 적용
```

Critical path는 “검수 종료”만이 아니다. 검수가 끝나기 전에 release 원장·rollback·verify와
계약 오류 교정을 병행해, 마지막 판정이 수거된 뒤 곧바로 게이트와 카나리로 넘어갈 수 있게 한다.

## 12. 체크리스트

### 구현

- [x] IMP-01 manifest
- [x] IMP-02 release DB 원장과 migration 생성·운영 적용
- [x] IMP-03 manifest-bound promote
- [x] IMP-04 rollback
- [x] IMP-04-a 질문 semantic versioning
- [x] IMP-05 계약 오류를 row 단위 보수 강등으로 격리
- [x] IMP-06 verify CLI
- [ ] IMP-07 운영 메트릭
- [x] IMP-08 runbook·handoff 갱신
- [x] IMP-09 익명→owned-company continuation

### 현재 배치

- [ ] W30 판정 42/66 (`pending 12`, `conflict 12`)
- [ ] conflict 0 (현재 12)
- [ ] collect 완료
- [ ] reconcile 100%
- [x] legacy promotion dry-run 변환 오류·드롭 0
- [ ] 수거 후 manifest-bound dry-run 오류·드롭·앵커 상실 0

### 릴리스

- [ ] release 후보 manifest와 DB baseline 동결
- [ ] 같은 plan hash의 aggregate 6/6 GO
- [ ] 같은 plan hash의 shadow PASS
- [ ] aggregate·shadow·dry-run hash 검증 후 release 승인
- [x] rollback 순수·상태 보존 테스트 PASS
- [ ] 운영 DB 동형 rollback 리허설 PASS
- [ ] 카나리 A PASS
- [ ] 카나리 B PASS
- [ ] 전체 적용
- [ ] 운영 DB hash 100% 일치
- [ ] 익명 랜딩 카드·근거·CTA E2E PASS
- [ ] owned-company 질문·답변·재로그인 E2E PASS
- [x] 구현·migration·배포 증적 문서화

## 13. 별도 에이전트 리뷰

### 13.1 1차 독립 리뷰 — NO-GO

별도 에이전트가 초안을 현재 코드와 대조해 **BLOCKER 4건, MAJOR 5건, NO-GO**로
판정했다. 리뷰는 파일을 수정하지 않고 수행됐다.

| 등급 | 발견 | 코드 근거 | 반영 |
|---|---|---|---|
| BLOCKER | aggregate·shadow·promote가 서로 다른 대상과 변환 결과를 소비 | `aggregate.ts`, `shadow.ts`, `promote-cli.ts`, `criterion-resolution.ts` | manifest를 먼저 동결하고 동일 plan/source 집합만 소비하도록 Phase 0·3, IMP-01·03·06 개정 |
| BLOCKER | manifest가 검토 당시 운영 DB baseline 내용을 고정하지 않음 | `promote-cli.ts`가 현재 stale criterion을 삭제 | criteria/question/dedup baseline hash, 공유 publication lock, 트랜잭션 재검증 추가 |
| BLOCKER | 질문 제자리 갱신 뒤 rollback하면 기존 답변 의미가 바뀔 수 있음 | 질문 unique와 update 방식, 답변의 question ID 귀속 | semantic definition version, 새 question ID, 답변 영구 귀속 계약 추가 |
| BLOCKER | 익명 랜딩과 owned-company 답변 E2E를 한 경로로 가정 | teaser는 질문 수만 주석, 답변 API는 회사 권한 필요 | 익명 카드·CTA와 로그인 후 질문·답변 E2E 분리, continuation 추가 |
| MAJOR | aggregate/shadow hash가 GO/PASS를 기계적으로 증명하지 않음 | aggregate는 stdout, shadow는 진단 전용 | versioned JSON, exit 2, approval의 verdict·schema 검증 추가 |
| MAJOR | `unaudited_correct`가 현재 `needs_review=false`인데 문서 정책과 충돌 | `criterion-resolution.ts`와 테스트 | 독립 감사/사람 판정 없으면 항상 `needs_review=true`로 정책 변경 |
| MAJOR | immutable manifest와 같은 revision 수정 재시도가 충돌 | 계획의 기존 재시도 문구 | 입력 불변 일시 오류만 동일 release 재시도, 변경은 새 revision |
| MAJOR | 카나리·승인자·migration 무결성 계약 누락 | manifest/원장 초안, `db/requirements.ts` | canary allowlist, 승인/실행 actor, schema·migration·journal·requirements 작업 추가 |
| MAJOR | 현재 shadow가 원문 사업자번호를 JSON에 기록 | `shadow.ts`의 `identity.bizNo` | release salt 기반 가명 키와 누출 회귀 테스트 추가 |

### 13.2 수정 후 재리뷰 기준

수정된 계획은 다음 질문에 모두 “예”여야 GO다.

1. 검토·섀도·실발행 criterion이 byte-level로 같은가?
2. 검토 이후 DB baseline이 바뀌면 자동 거부되는가?
3. 질문 문구·선택지가 바뀌어도 기존 답변의 의미가 보존되는가?
4. 익명 랜딩과 로그인 후 답변 경로가 실제 권한·데이터 흐름과 일치하는가?
5. aggregate GO와 shadow PASS를 사람이 stdout을 해석하지 않아도 검증할 수 있는가?
6. 원문 사업자등록번호가 release·shadow·verification artifact에 남지 않는가?

### 13.3 2차 독립 리뷰 — BLOCKER 0, MAJOR 4, 조건부 NO-GO

1차 발견의 핵심 방향은 모두 반영됐다는 판정을 받았다. 새 BLOCKER는 없었고, 다음 네 가지
구체화가 더 필요해 2차 시점에는 PLAN NO-GO였다.

| 발견 | 반영 |
|---|---|
| saved confirmation이 dashboard 최초 로드·재로그인 카드에 다시 적용되지 않음 | IMP-09에 confirmation batch load와 단일 confirmation-aware matcher 경로 추가 |
| release 전체 plan hash와 구조화 dry-run artifact가 없음 | `releasePlanSha256`과 versioned `dry-run.json` PASS/FAIL 추가 |
| 카나리 검증이 미적용 release item을 after로 오판할 수 있음 | verifier를 `--scope=canary|all`로 분리하고 item 상태 불일치 exit 2 |
| rollback에 promote와 같은 publication lock이 없음 | 같은 lock·트랜잭션·after hash·rollback receipt 계약 추가 |

위 네 항목을 본 계획에 반영했다. 따라서 다음 최종 재리뷰는 “새 BLOCKER/MAJOR가 없는가”만
판정하며, 통과하면 계획 수준의 GO로 확정한다.

### 13.4 최종 독립 재리뷰 — PLAN GO

최종 재리뷰 결과 **새 BLOCKER 0, MAJOR 0, PLAN GO**로 판정됐다. 동일
`PromotionPlan[]` 공유, DB baseline drift 차단, 질문 semantic versioning, 익명/owned-company
경로 분리, 구조화 gate artifact, unaudited 안전 정책, immutable revision, 카나리 scope,
rollback 공유 lock·트랜잭션이 모두 계획에 반영됐음을 현재 코드와 대조해 확인했다.

## 14. 2026-07-25 개정 — 활성 공고 딥분석 보증 체계

### 14.0 결론

리뷰어 운영에서 확인한 방향은 타당하다. 공고 웹 본문과 HWP/HWPX 등 첨부 전문을 최상급
모델에 함께 제공하고, 22개 축의 맥락과 원문 근거를 강제하면 사람의 공고별 수작업 분석은
상시 운영의 필수 단계가 아니어도 된다.

다만 “리뷰어도 GPT/Claude를 사용했고 결과에 동의했다”는 사실은 다음 두 가지로 나누어
해석해야 한다.

1. **강한 제품 증거**: 최상급 모델을 실제 검수 도구로 사용했을 때 사람이 납득할 수준의
   22축 분류와 근거 설명이 가능했다. 따라서 모델을 초안 생성기가 아니라 주 분석기로
   올릴 근거가 생겼다.
2. **아직 부족한 품질 증거**: 리뷰어 판단 역시 LLM의 도움을 받았으므로 모델과 완전히
   독립된 골든 라벨은 아니다. 같은 모델 계열의 공통 오류와 자동화 편향까지 제거됐다고
   볼 수는 없다.

그러므로 목표 운영 모델은 `human-in-the-loop` 전수 검수가 아니라 다음이다.

```text
최상급 모델 1차 분석
→ 입력·스키마·22축·원문 근거의 결정론 검증
→ 독립 모델 블라인드 감사
→ 일치 건 자동 발행
→ 불일치·입력 누락·계약 오류만 예외 큐
```

현재 상태에서 “프로덕션 딥분석이 해결됐다”고 판정하면 안 된다. 이번 수정으로 HWP 원격
변환과 누락 고지는 해결됐지만, 최상급 모델 딥분석의 프로덕션 실행기, 영속 원장, 활성 공고
전수 스케줄러, 단계별 관제는 아직 없다. 따라서 이 계획의 현재 실행 판정은 다음과 같다.

- HWP 변환 결함 복구: **GO**
- 복구 4공고의 HWP 포함 재분석: **GO**
- 활성 공고 전수의 프로덕션 딥분석 자동화: **NO-GO — 미구현**
- 사람 전수 검수 없는 자동 승격: **NO-GO — 기계 게이트와 독립 감사의 운영 영속화 선행**
- 관제시스템을 통한 단계별 보증: **NO-GO — 기존 미병합 대시보드는 딥분석을 관측하지 않음**

### 14.1 용어와 완료 의미

#### 14.1.1 “22개 분류를 채운다”

22개 축마다 criterion 한 행을 억지로 만드는 것이 아니다. 공고에 지역 조건이 없으면
`region` criterion을 생성하지 않는 것이 맞다. 대신 모든 축에 정확히 한 개의 검사 상태가
있어야 한다.

| 축 상태 | 의미 | 운영 처리 |
|---|---|---|
| `condition_found` | 해당 축 조건이 원문에 있음 | 근거가 검증된 criterion 1개 이상 필요 |
| `inspected_no_condition` | 입력을 전부 읽었고 해당 축 조건이 없음 | criterion 0개가 정상 |
| `ambiguous` | 문구는 있으나 구조화·판정이 불명확 | 자동 확정 금지, 질문 또는 예외 큐 |
| `input_missing` | 필요한 원문·첨부를 읽지 못함 | 딥분석 완료 금지 |
| `unassessed` | 모델 응답에 축 자체가 없음 | 런 실패 |

따라서 `criteria.length`나 `distinct dimension 수`는 딥분석 완전성 지표가 아니다.
**22축 상태가 정확히 22개이고, 중복·누락이 없으며, `condition_found`와 criterion이
상호 일치하는지**가 완전성 지표다.

현재 추출기는 `premises`, `export_performance` 두 예약 축을 `axis_assessments`에서는
검사하지만 criterion 생성 enum에서는 제외한다. 운영 전환 전에 다음 중 하나를 명시적으로
결정해야 한다.

- 실제 matcher/evaluator와 기업 데이터가 준비되면 두 축의 criterion 생성을 허용한다.
- 준비 전까지는 두 축을 `inspected_no_condition | ambiguous | input_missing`으로만
  관측하고, 조건이 발견되면 `other/text_only + needs_review=true`로 보존한다.

조건이 실제로 있는데 예약 축이라는 이유로 조용히 버리는 것은 금지한다.

#### 14.1.2 세 가지 완료 상태

| 완료 상태 | 필요한 마지막 단계 | 의미 |
|---|---|---|
| `analysis_complete` | 입력·22축·근거·독립 감사 통과 | 분석 산출 자체가 신뢰 가능 |
| `publication_complete` | manifest-bound 승격과 DB after hash 검증 | `grant_criteria` 정본에 반영 |
| `serving_complete` | 실제 matcher가 같은 criterion을 소비함을 검증 | 사용자 판정에 반영 |

화면과 API에서 이 세 상태를 하나의 `완료=true`로 합치지 않는다.

### 14.2 현재 구현을 다시 본 결과

#### 14.2.1 이번에 해결된 직접 결함

- Vercel에 `hwp5html`이 없어 HWP markdown 변환이 실패하던 문제를 Cloud Run 원격
  변환 경로로 복구했다.
- `analysis-lab/input.ts`가 markdown 없는 첨부를 조용히 제거하던 문제를 고쳐
  `첨부 미투입(...)` 블록과 `[입력 한계 고지]`를 남긴다.
- 복구 대상 4공고는 HWP 6개를 변환하고 `claude-opus-4-8`로 다시 분석했다.
- 신규 BizInfo 수집은 변환된 첨부 markdown을 같은 Anthropic 추출 입력에 포함한다.
- 신규 K-Startup 수집은 bounded tail sweep에서 HWP를 원격 변환·보관할 수 있다.

#### 14.2.2 아직 남은 구조적 원인

| 문제 | 현재 코드 사실 | 결과 |
|---|---|---|
| 딥분석 실행기가 dev 전용 | `/api/dev/analysis-lab/analyze`는 production에서 404 | 프로덕션 웹 배포가 Opus 딥분석을 실행하지 않음 |
| 런 저장소가 로컬 파일 | `spike-out/analysis-lab/.../<runId>.json`, DB 미사용 | Vercel/Cloud Run에서 durable 운영 원장으로 쓸 수 없음 |
| 실행이 수동 배치 | `pnpm lab:batch`가 로컬 cohort 파일을 읽음 | 신규 활성 공고가 자동 분석되지 않음 |
| K-Startup 운영 수집은 딥분석 미연결 | 크론은 수집 후 최대 4공고·6첨부 tail 변환만 수행 | HWP 저장 성공과 22축 딥분석은 별개 |
| BizInfo 운영 추출 모델이 기본 Haiku | 기본 `claude-haiku-4-5-20251001` | 첨부를 읽더라도 최상급 모델 `lab-deep-v3`와 다른 경로 |
| BizInfo 실패가 얕은 fallback으로 진행 가능 | `allowTextOnlyFallback=true`, attachment failure 허용 | 공고 발행 성공이 딥분석 성공을 뜻하지 않음 |
| 입력 누락이 있어도 LLM 호출 가능 | 누락 고지는 생겼지만 호출 자체를 막지 않음 | `error=null`인 degraded run 가능 |
| 22축 응답 후검증이 fail-closed가 아님 | 정규화가 잘못된/중복 축을 드롭한 뒤 배열을 반환 | 22개 미만이어도 provider 호출 성공으로 남을 수 있음 |
| “모델 호출 성공”과 “분석 유효”가 분리되지 않음 | `run.error === null`이 주 성공 신호 | 불완전 응답을 완료로 오인 가능 |
| 기존 관제 구현이 main에 없음 | 독립 worktree의 `/pipeline` 브랜치만 존재 | `ops.changupnote.com`에서 현재 사용할 수 없음 |
| 기존 관제 상태가 얕은 파이프라인 기준 | `grant_raw.status`, 첨부 상태, `grant_criteria`, `extraction_log` 합성 | 딥분석 run/input/audit/promotion을 증명하지 못함 |
| 수동 `mark_reviewed`가 분석 증거를 만들지 않음 | needs_review를 false로 바꾸고 labeled 로그 기록 | 딥분석 완료 플래그로 사용하면 거짓 양성 |

핵심 원인은 단순히 HWP 변환 서버가 없었던 것이 아니다. 프로덕션 수집 파이프라인과
최상급 모델 `analysis-lab`가 서로 다른 트랙이었고, 둘을 잇는 durable job·run·receipt가
없었다. 이번 HWP 수정은 **입력 재료를 준비하는 단계**를 고친 것이며, 전수 딥분석 운영
자체를 완성한 것은 아니다.

#### 14.2.3 2026-07-25 운영 읽기 기준선

아래 수치는 운영 DB를 읽기 전용으로 조회한 스냅샷이다. 활성은
`grants.status='open'`, KST 오늘 기준 접수 시작·마감 범위 안인 공고로 계산했다.

| 항목 | 전체 | BizInfo | K-Startup |
|---|---:|---:|---:|
| 활성 공고 | 624 | 350 | 274 |
| HWP/HWPX 보유 공고 | 395 | 269 | 126 |
| HWP/HWPX archive inventory 행 | 656 | 430 | 226 |
| 원본 R2 보관 완료 | 211 | 174 | 37 |
| markdown 변환 완료 | 14 | 3 | 11 |
| 변환 실패 | 6 | 0 | 6 |

추가 기준선:

- 활성 624공고 중 현재 criterion 보유는 623공고지만, 평균 distinct dimension은 3.22다.
- `analysis-lab` 승격 parser provenance를 가진 활성 공고는 0건이다.
- `analysis_lab_promotion_releases` 운영 행은 0건이다.
- 활성 공고의 운영 parser/model은 K-Startup field parser 또는 BizInfo Haiku 추출이다.
- 로컬 `spike-out`에는 `lab-deep-v3` 성공 런이 5공고 있지만 운영 DB가 이를 current
  analysis truth로 조회할 방법은 없다.

이 기준선은 `criterion이 있다`와 `딥분석됐다`가 완전히 다른 상태임을 보여준다.

### 14.3 목표 아키텍처

```text
[수집: grant_raw + 원문 revision]
              │
              ▼
[첨부 inventory] ─→ [원본 R2 archive] ─→ [HWP/HWPX/PDF/OCR text]
              │                   각 단계 hash·receipt
              └──────────────────────────┐
                                         ▼
                              [sealed input manifest]
                              raw hash + attachment set hash
                              included/waived/blocked 전건 disposition
                                         │
                                         ▼
                              [top-tier deep analyzer]
                                         │
                      schema/22-axis/evidence validators
                                         │
                                         ▼
                              [blind independent audit]
                                 │                 │
                              concur            disagree
                                 │                 │
                                 ▼                 ▼
                         auto resolution      exception queue
                                 │
                                 ▼
                         promotion release control
                                 │
                                 ▼
                 grant_criteria + confirmation questions
                                 │
                                 ▼
                        matcher serving verification

모든 화살표 = append-only stage receipt
ops 화면 = receipt의 projection, 수동 체크박스가 아님
```

원칙:

1. 랜딩 요청 중 LLM 호출은 하지 않는다.
2. 수집 크론은 deep analysis를 동기 실행하지 않고 durable job만 enqueue한다.
3. source revision이 같으면 같은 분석을 멱등 재사용한다.
4. source raw hash나 attachment manifest hash가 바뀌면 기존 런은 즉시 `stale`이다.
5. 첨부 하나라도 disposition이 없으면 input을 seal하지 않는다.
6. 길이 제한을 넘는 문서는 조용히 자르지 않고 chunk 전수 처리하거나 `blocked`로 남긴다.
7. provider HTTP 200은 `model_call_passed`일 뿐 `analysis_complete`가 아니다.
8. stage flag는 receipt에서 계산하며 운영자가 직접 true로 바꿀 수 없다.
9. 사람은 예외를 해소할 수 있지만, 분석하지 않은 공고를 완료로 표시할 수 없다.
10. 최종 matcher는 생성형 모델이 아니라 검증·발행된 `grant_criteria`만 소비한다.

### 14.4 단계별 보증 상태

공통 stage status enum:

```text
pending | running | passed | failed | blocked | stale | not_applicable
```

- `passed`: 검증 함수와 증적 hash가 모두 있음
- `failed`: 실행했으나 계약/인프라 오류
- `blocked`: 선행 입력이 없어 실행하면 안 됨
- `stale`: 통과 당시 source revision과 현재 revision이 다름
- `not_applicable`: 명시된 규칙과 근거로 해당 단계가 불필요
- `pending`, `running`: 미완료

`passed`는 UI나 액션에서 직접 입력하지 않는다. 각 stage verifier가 evidence를 만들고
트랜잭션 안에서 receipt를 기록할 때만 생긴다.

| 단계 | flag | `passed`의 기계적 조건 | 대표 차단 사유 | 필수 증적 |
|---|---|---|---|---|
| S0 | `source_fresh` | 현재 raw/content revision hash 확정 | raw 없음, source fetch 실패 | raw hash, collectedAt, source URL |
| S1 | `attachment_inventory_complete` | 원문에 선언된 첨부 전건이 inventory에 있음 | detail 미수집, 링크 파싱 실패 | attachment ID·URL·filename·content hash 목록 |
| S2 | `attachment_archive_complete` | 모든 분석 대상 원본이 R2에 있고 sha256 일치 | download 실패, size 초과 | R2 key, bytes, sha256 |
| S3 | `attachment_text_complete` | 모든 분석 대상 문서가 text/markdown/OCR로 읽힘 | converter 실패, 암호화, 손상 | converter/version, markdown key/hash |
| S4 | `input_coverage_verified` | 첨부 전건이 included/duplicate/waived/blocked 중 하나이며 blocked 0 | 조용한 제외, cap 초과 | input manifest, disposition reason |
| S5 | `input_sealed` | raw hash+attachment set+rendered chunks의 canonical hash 고정 | hash drift | input artifact R2 key, inputSha256 |
| S6 | `model_call_passed` | allowlisted 최상급 모델의 tool response 수신 | timeout, refusal, rate limit | model ID, prompt version, usage, raw response hash |
| S7 | `response_contract_valid` | JSON/tool schema·enum·canonical criterion 계약 100% 통과 | invalid operator/value, parse drop | validation report |
| S8 | `axis_coverage_complete` | 22축 정확히 1개씩, 중복·누락 0 | 21축, duplicate axis | 22 axis rows, dimension set hash |
| S9 | `evidence_grounded` | hard criterion 전건 source span exact match, found↔criteria 일치 | 근거 없음/오인용 | span offsets, block/attachment refs |
| S10 | `independent_audit_passed` | 블라인드 감사 모델이 자동 발행 대상 전건에 concur | disagreement, unsure | audit model/prompt, item verdict hash |
| S11 | `analysis_complete` | S0~S10 passed, ambiguous/input_missing/unassessed 0 | 선행 단계 하나라도 미통과 | aggregate verification receipt |
| S12 | `publication_complete` | 승인된 manifest item과 DB after hash 일치 | baseline drift, partial failure | release/item ID, after hash |
| S13 | `serving_complete` | matcher가 현재 published criterion IDs/hash를 실제 소비 | cache stale, orphan question | fixed-profile trace hash |
| S14 | `analysis_fresh` | current source revision = run source revision | 공고/첨부 변경 | freshness check receipt |

#### 14.4.1 attachment disposition

모든 첨부는 input manifest에 다음 중 하나로 반드시 남는다.

```text
included
duplicate_of:<attachmentId>
waived_non_text_with_reason
waived_non_material_with_reason
blocked_conversion
blocked_fetch
blocked_cap
```

HWP/HWPX 신청서·사업계획서 양식에도 자격 확인문, 서약, 결격 조건이 있을 수 있으므로
파일명에 `양식`·`신청서`가 있다는 이유만으로 자동 waiver하지 않는다. HWP/HWPX는 기본
분석 대상이며, waiver는 동일 본문 hash 중복처럼 기계적으로 증명 가능한 경우만 허용한다.

PDF·이미지는 이 계획의 HWP 보증을 약화시키지 않도록 같은 manifest에 포함한다. 이미지형
공고나 스캔 PDF가 유일한 원문이면 OCR 실패를 `blocked`로 둔다.

#### 14.4.2 상태 보존식

매 관제 집계에서 다음 식이 정확히 성립해야 한다.

```text
active_total
= serving_complete_fresh
+ analysis_complete_not_published
+ in_progress
+ blocked_or_failed
+ stale
```

어느 버킷에도 속하지 않는 활성 공고가 1건이라도 있으면 dashboard 자체를 `degraded`로
표시한다. 퍼센트만 보여주고 분모에서 실패 공고를 제외하는 방식은 금지한다.

### 14.5 영속 데이터 계약

현재 `spike-out` 런 형식을 바로 삭제하지 않는다. 추출기·검수 자산을 재사용하되 운영
정본을 DB+R2로 옮긴다.

#### 14.5.1 신규 테이블

```text
grant_deep_analysis_jobs
  id uuid PK
  grant_id FK
  source_revision_sha256 text
  model_policy_version text
  priority integer
  status text
  attempt_count integer
  available_at / leased_at / lease_expires_at
  worker_id text null
  last_error_code / last_error_message
  created_at / updated_at
  UNIQUE(grant_id, source_revision_sha256, model_policy_version)

grant_deep_analysis_runs
  id uuid PK
  run_id text UNIQUE
  job_id FK
  grant_id FK
  source_revision_sha256 text
  attachment_manifest_sha256 text
  input_sha256 text
  input_artifact_key text
  output_artifact_key text null
  raw_response_artifact_key text null
  model text
  prompt_version text
  model_policy_version text
  status text
  input_chars / input_tokens / output_tokens
  cost_usd numeric
  started_at / completed_at
  supersedes_run_id uuid null
  error_code / error_message

grant_deep_analysis_stage_receipts
  id uuid PK
  run_id FK
  stage text
  status text
  verifier_version text
  evidence jsonb
  evidence_sha256 text
  artifact_key text null
  attempt integer
  created_at
  UNIQUE(run_id, stage, attempt)

grant_deep_analysis_axis_results
  run_id FK
  dimension criterion_dimension
  status text
  confidence real
  comment text
  evidence_refs jsonb
  criterion_semantic_hashes text[]
  PRIMARY KEY(run_id, dimension)

grant_deep_analysis_audits
  id uuid PK
  run_id FK
  model text
  prompt_version text
  input_sha256 text
  verdict text
  item_results jsonb
  artifact_key text
  artifact_sha256 text
  started_at / completed_at
```

기존 `analysis_lab_promotion_items.run_id`는 새 run ID를 참조하도록 계약을 강화한다.
마이그레이션 시 기존 5개 `lab-deep-v3` 런은 해시를 재계산해 import할 수 있지만, 원본
artifact가 검증되지 않으면 `legacy_imported` 상태로만 남기고 자동 발행에는 쓰지 않는다.

#### 14.5.2 current 상태 projection

`grant_deep_analysis_current` SQL view 또는 서버 query를 둔다.

- 현재 source revision에 맞는 최신 run만 선택
- stage receipt의 최고 attempt를 사용
- `analysis_complete`, `publication_complete`, `serving_complete`, `fresh`를 파생
- 첫 blocking stage와 error code를 계산
- 임의 저장 boolean을 진실 원천으로 사용하지 않음
- ops 목록 성능을 위해 materialized summary를 둘 수 있으나 원본 receipt와 정기 대조

#### 14.5.3 불변·보안

- 입력 전문과 모델 원응답은 private R2에 저장하고 DB에는 key와 hash만 둔다.
- overwrite 금지. 같은 logical run의 재시도도 attempt 또는 새 run으로 남긴다.
- raw/input/output/audit/promotion hash chain을 끊을 수 없다.
- 문서 안의 지시문은 비신뢰 데이터다. 모델에 브라우징·코드 실행·외부 tool 권한을 주지 않는다.
- 로그에는 presigned URL, API key, 사업자등록번호, 첨부 전문을 남기지 않는다.

### 14.6 프로덕션 실행기

#### 14.6.1 배치 구조

Vercel 수집 크론에서 Opus 분석을 동기 호출하지 않는다. 현재 한 공고가 수 분 걸리고
Cloudflare custom domain은 장기 요청에서 524가 발생한 전례가 있어, 수집과 분석 수명을
분리해야 한다.

권장 구조:

1. 수집 publisher가 새/변경 source revision을 커밋한다.
2. 같은 트랜잭션 또는 outbox consumer가 `grant_deep_analysis_jobs`를 멱등 enqueue한다.
3. `changupnote-com` 프로젝트의 별도 Cloud Run worker가
   `FOR UPDATE SKIP LOCKED`로 job을 lease한다.
4. worker가 archive/convert 선행 상태를 확인한다.
5. 선행 단계가 부족하면 변환 job을 만들고 `blocked`가 아니라 재시도 가능한 `pending`
   상태로 돌린다. 영구 실패만 `blocked`.
6. input seal → top-tier call → validators → independent audit까지 실행한다.
7. 통과하면 promotion candidate를 만들고 정책에 따라 자동 release 또는 카나리에 넣는다.
8. heartbeat와 dead-letter를 ops에 노출한다.

새 worker는 HWP 변환 서비스와 분리한다. `apps/conversion`은 비신뢰 문서 변환에 집중하고,
LLM 분석 worker는 DB/R2/Anthropic 권한과 비용 정책을 별도로 가진다.

#### 14.6.2 멱등성과 재시도

job identity:

```text
grantId
+ sourceRevisionSha256
+ modelPolicyVersion
```

- 같은 identity의 `passed` run이 있으면 재호출하지 않는다.
- 429/5xx/timeout은 지수 backoff와 jitter로 재시도한다.
- schema/22축/evidence 오류는 같은 원응답을 고치지 않고 1회 repair call 후 새 attempt로 남긴다.
- 변환 불가·암호화·손상은 무한 재시도하지 않고 예외 큐로 보낸다.
- lease 만료 job은 다른 worker가 회수할 수 있다.
- max attempt 초과는 dead-letter이며 활성 공고 분모에서 계속 보인다.

#### 14.6.3 비용·동시성 가드

- `DEEP_ANALYSIS_PRIMARY_MODEL`은 allowlist로 고정하고 임의 env 문자열로 저가 모델에
  내려가지 못하게 한다.
- `model_policy_version`에 primary/audit 모델과 prompt version을 함께 기록한다.
- 일별 USD 상한, 동시성, source별 rate limit, 공고당 token 상한을 둔다.
- 비용 상한 도달은 공고를 성공 처리하지 않고 `pending_budget`으로 관제한다.
- 2026-07-25 활성 624공고의 초기 비용은 기존 실측을 기준으로 primary만 약
  `$125~250` 범위일 수 있다. 첫 20건 실측 후 실제 token 분포로 전체 cap을 확정한다.

### 14.7 분석·감사·자동발행 정책

#### 14.7.1 주 분석기

현재 `lab-deep-v3`의 장점은 유지한다.

- 구조화 공고 필드 + 첨부 전문
- 22축 전수 assessment
- criterion별 source span
- program intent와 확인 질문
- tool schema 강제

다만 dev UI 소유 계약에서 공용 운영 계약으로 분리한다.

- `apps/web/src/features/dev/analysis-lab/contract.ts`에만 두지 않음
- 공용 contract/validator를 `packages/contracts` 또는 서버 공용 모듈로 이동
- dev analysis-lab은 새 운영 분석 코어의 read-only adapter가 됨
- 입력 캡 초과는 잘린 단일 prompt가 아니라 chunk manifest + synthesis로 처리

#### 14.7.2 결정론 validator

자동 발행 전 다음을 100% 통과해야 한다.

1. 22개 dimension set exact equality
2. axis 중복 0
3. `condition_found` 축마다 criterion 1개 이상
4. criterion이 있는 축은 `condition_found`
5. `input_missing`, `unassessed` 0
6. `ambiguous` criterion은 자동 확정 대상에서 제외
7. required/exclusion source span exact input match 100%
8. source span이 어느 raw/attachment block에서 왔는지 역참조 가능
9. canonical value 계약 통과
10. 예약 축 조건의 silent drop 0
11. 동일 semantic criterion 중복 0
12. input manifest의 unresolved attachment 0

정규화 과정에서 잘못된 행을 드롭해 성공시키지 않는다. raw response의 예상 행 수와
정규화 결과가 다르면 validation failure다.

#### 14.7.3 독립 모델 감사

사람 전수 검수를 없애는 대신 모델 자기확신만으로 자동 발행하지 않는다.

- primary 결과와 기존 criteria를 숨긴 상태로 source input과 검증 대상 항목만 제공
- 가능하면 다른 모델 계열/제공자의 최상급 모델을 사용
- 각 criterion의 존재·dimension·kind·operator·value·근거를 판정
- 빈 축은 `inspected_no_condition`이 맞는지 표본이 아니라 전축 검사
- `concur`만 자동 확정
- `disagree`, `unsure`, audit timeout은 자동 발행 금지

초기 운영은 전건 독립 감사를 한다. 품질 기준이 충분한 기간 유지된 뒤에만 저위험
`inspected_no_condition` 일부를 deterministic sampling으로 줄일 수 있다. required와
exclusion criterion은 계속 전건 감사한다.

#### 14.7.4 사람 예외 큐

사람이 필요한 경우:

- 원문 또는 첨부가 손상·암호화·미수집
- primary와 audit 불일치
- `ambiguous`
- canonical 계약으로 표현 불가
- 예약 축에서 조건 발견
- 하나의 통합공고에 서로 다른 하위사업 조건이 섞임
- 모델이 prompt injection성 문구를 분석 지시로 해석한 의심
- 카나리 matcher 결과가 허용 전이를 위반

사람의 역할은 원문을 처음부터 다시 분석하는 것이 아니라, **명시된 blocker를 해소하고
근거 있는 최종 결정을 기록하는 것**이다. 이 결정도 append-only event와 actor·reason·hash를
가져야 한다.

### 14.8 ops 관제시스템 재점검과 통합

#### 14.8.1 기존 구현의 위치와 한계

기존 관제는 독립 worktree에 구현돼 있다.

- worktree: `/Users/ffgg/orca/workspaces/cunote/ops-notice-pipeline-dashboard`
- branch: `coolwithyou/ops-notice-pipeline-dashboard`
- 구현 커밋: `7e696e2`(P0/P1), `3a06cba`(P2~P4)
- 화면/API: `/pipeline`, summary/notices/detail/actions
- 기능: 소스→상태 캔버스, 트리아지 큐, 22축 dot grid, 첨부 상태, mark reviewed,
  reconvert, 관리자 action audit

현재 branch는 main보다 49커밋 뒤이고 2커밋만 앞이다. branch의 migration
`0047_outgoing_layla_miller.sql`은 현재 main의 migration 계보와 번호가 충돌한다.
따라서 두 커밋을 통째로 cherry-pick하지 않는다.

통합 방법:

1. 최신 main에서 pipeline UI/contract/read query를 파일 단위로 port
2. 현재 `grant_criteria`, question versioning, promotion release 스키마에 맞게 SQL 재작성
3. 필요한 `admin_pipeline_actions`는 현재 다음 migration 번호로 새로 생성
4. deep analysis receipt를 L6~L14 계층으로 추가
5. 기존 `mark_reviewed`는 딥분석 완료 액션에서 제거
6. 기존 HTTP·구조 검증 뒤 실제 ops production에 배포

#### 14.8.2 대시보드 정보 구조

상단 KPI:

- 활성 공고 전체
- source/attachment 준비 완료
- 분석 대기·실행 중
- `analysis_complete`
- `publication_complete`
- `serving_complete + fresh`
- blocked/failed
- stale
- 분석 SLO 초과

상단 funnel:

```text
활성
→ 원문 확보
→ 첨부 inventory
→ 원본 archive
→ text 변환
→ input sealed
→ top-tier analyzed
→ 22축 valid
→ evidence grounded
→ independent audit
→ published
→ serving verified
```

각 노드는 다음을 표시한다.

- 현재 공고 수
- 이전 단계에서 넘어오지 못한 수
- 가장 오래 막힌 시간
- source별 분해
- 최근 1시간 유입/완료량
- 클릭 시 해당 blocker 큐

트리아지 큐 열:

| 열 | 내용 |
|---|---|
| 공고 | 제목, sourceId, 기관 |
| 활성/마감 | D-day, source freshness |
| 첨부 | 전체/HWP/HWPX, archive·converted·blocked 수 |
| 입력 | sealed 여부, chars/chunks, manifest hash short |
| 모델 | primary model, prompt, attempt, cost |
| 22축 | found/no-condition/ambiguous/input-missing/unassessed 색 분리 |
| 감사 | concur/disagree/unsure 수 |
| 발행 | release/item 상태, parser provenance |
| serving | matcher hash 일치 여부 |
| blocker | 첫 실패 stage와 재시도 가능 여부 |

22축 dot 의미:

- 진한 초록: `condition_found` + criterion/evidence/audit pass
- 연한 초록/회색 체크: `inspected_no_condition` + audit pass
- 주황: `ambiguous` 또는 audit disagreement
- 빨강: `input_missing`
- 빈칸: `unassessed`
- 보라/파랑 테두리: published/serving 여부는 별도 표현

기존 dot grid처럼 criterion이 없는 축을 단순 빈칸으로 표시하지 않는다. “검사했으나 없음”과
“검사 안 됨”을 시각적으로 구분해야 한다.

#### 14.8.3 공고 상세 Sheet

탭:

1. `단계 증적`: S0~S14 receipt, verifier version, timestamp, hash, error
2. `원문·첨부`: inventory 전건, disposition, R2/archive/markdown hash
3. `분석 입력`: block/chunk 목록, included/waived/blocked, input hash
4. `22축 결과`: axis 상태, criteria, source span, 원문 위치
5. `독립 감사`: primary를 숨긴 blind audit 결과와 disagreement
6. `승격·서빙`: release manifest, DB before/after, matcher trace
7. `이력`: source change, stale 전환, retry, rollback

민감한 원문 전문은 권한이 있는 상세 요청에서만 읽고 목록 API에는 포함하지 않는다.

#### 14.8.4 ops 액션

허용:

- archive 재시도
- conversion 재시도
- deep analysis 재시도
- 독립 감사 재시도
- exception adjudication 저장
- release 카나리 준비

금지:

- stage를 수동으로 `passed`로 변경
- 분석 없이 `mark_reviewed`로 `needs_review=false`
- 다른 source revision의 run을 current로 지정
- model/prompt provenance 없는 criterion 발행

비용이 드는 액션은 대상 수, 예상 input tokens, 예상 비용, model policy를 확인 다이얼로그에
표시하고 idempotency key를 요구한다.

#### 14.8.5 알림

최소 alert:

- 활성 공고인데 2시간 안에 input seal 안 됨
- input seal 후 2시간 안에 analysis complete 안 됨
- HWP/HWPX conversion failed
- worker heartbeat 10분 이상 없음
- source 수집 heartbeat 지연
- axis coverage 22 미만
- hard criterion evidence verification 실패
- audit disagreement 비율 급증
- publish after hash 또는 matcher serving hash 불일치
- fresh serving coverage가 목표 이하

alert도 고카디널리티 grantId를 metric label로 사용하지 않는다. 상세 링크에서 대상 목록을
조회한다.

### 14.9 품질 검증 계획

#### 14.9.1 새 골든 코호트

기존 검수 결과는 폐기하지 않지만 `LLM-assisted reviewer consensus`로 라벨링한다.
자동 발행 정책 확정에는 별도의 동결 코호트를 사용한다.

최소 80공고, 중복 stratification 허용:

- K-Startup 40 / BizInfo 40
- HWP 포함 30 이상
- HWPX 포함 15 이상
- 다중 첨부 20 이상
- 장문·표·병합셀 15 이상
- 웹 본문은 얕고 첨부에만 hard 조건이 있는 공고 15 이상
- 결격 조건 포함 20 이상
- 조건이 거의 없는 공고 10 이상
- 손상·암호화·변환 실패 fixture 전부
- 통합공고/하위사업 혼합 사례

기존 복구 4공고는 HWP 누락 회귀 fixture로 반드시 포함한다.

#### 14.9.2 비교군

각 공고에서 다음을 byte-level로 동결해 비교한다.

1. 현재 운영 parser/Haiku 결과
2. HWP 없이 top-tier 분석
3. HWP 포함 top-tier 분석
4. 독립 top-tier blind audit
5. 사람 예외 판정이 있는 경우 최종 resolution

특히 `HWP 포함 - HWP 제외` 차이로 **첨부에서만 발견된 criterion**을 별도 집계한다.

#### 14.9.3 통과 기준

기계 보증은 예외 없이 100%여야 한다.

- active target 누락 0
- attachment disposition 누락 0
- sealed input hash 불일치 0
- 22축 exact coverage 100%
- axis duplicate 0
- `condition_found`↔criterion 불일치 0
- hard criterion exact source evidence 100%
- unresolved attachment가 있는 `analysis_complete` 0
- audit disagreement가 있는 자동 발행 0
- source revision이 다른 stale run 발행 0
- publication/matcher after hash 불일치 0

모델 품질 기준:

- 자동 발행 criterion precision ≥ 99%
- hard required/exclusion recall ≥ 98%
- HWP-only hard condition sentinel recall = 100%
- wrong hard criterion rate ≤ 0.5%
- source-groundedness = 100%
- notice-level catastrophic error(가능↔불가 반전) = 0

표본이 작으면 비율만 보지 않고 Wilson confidence interval과 오류 절대 건수를 함께 기록한다.
기준 미달 시 모델 prompt를 즉시 운영에 덮어쓰지 않고 새 `model_policy_version`과 새
평가 run을 만든다.

#### 14.9.4 실패 주입

- HWP 원본 download 500/timeout
- 변환 서버 401/422/503/timeout
- R2 markdown key 없음/해시 불일치
- 첨부가 input cap을 초과
- 모델 429/529/refusal/max_tokens
- 21축 응답
- 같은 축 2번 응답
- invalid criterion enum/value
- source span hallucination
- analysis 중 source revision 변경
- promotion 직전 baseline drift
- matcher cache가 구 criterion을 소비

각 실패는 `passed`가 아니라 예상 stage의 `failed|blocked|stale`로 끝나야 한다.

### 14.10 구현 단계

#### Phase A. 정의와 기준선 동결

작업:

- 활성 공고 eligibility SQL을 단일 함수/contract로 고정
- S0~S14 enum·완료 정의 확정
- attachment disposition 규칙 확정
- 모델 policy와 자동 발행/예외 조건 확정
- 현재 624공고 기준선 report를 JSON artifact로 저장하는 read-only verifier 작성

완료 조건:

- web worker, ops API, CLI가 같은 active predicate를 공유
- `criteria 보유`가 deep complete로 계산되는 경로 0
- 기준선 conservation equation 성립

구현 체크포인트 A (2026-07-25):

- [x] `deep-analysis-active-kst-v1` 정책으로 KST 활성 eligibility를 공용 contract와
  Drizzle SQL에 고정했다.
- [x] S0~S14 stage, stage status, 22축 status, attachment disposition을
  `@cunote/contracts`에 고정했다.
- [x] 22축 exact set과 `analysis_complete`/`publication_complete`/
  `serving_complete`/`fresh`를 서로 다른 플래그로 계산한다.
- [x] 기존 criteria 보유 여부를 완료로 추정하지 않는 read-only verifier를 추가했다.
- [x] 실데이터 기준선은 활성 624, HWP/HWPX 보유 395, 첨부 656, archive 211,
  converted 14, failed 6, criteria 보유 623, deep provenance 0이다.
- [x] 원장이 아직 없으므로 624건 전부를
  `deep_analysis_instrumentation_missing` blocker로 분류했고,
  `624 = 0 + 0 + 0 + 624 + 0` 보존식이 성립한다.
- [x] 불변 기준선은
  `spike-out/deep-analysis/baselines/active-2026-07-24T23-44-41-076Z.json`에
  기록했다. 이 경로는 gitignored 운영 증적이며 소스에는 포함하지 않는다.
- [x] `pnpm verify:deep-analysis-contract`,
  `pnpm --filter @cunote/contracts typecheck`,
  `pnpm --filter @cunote/web typecheck`,
  `pnpm verify:active-deep-analysis -- --stdout-only`가 통과했다.

#### Phase B. 운영 run·stage 원장

작업:

- 신규 DB tables/check/FK/index/migration
- R2 immutable artifact naming
- append-only receipt writer
- current projection query
- source revision/attachment manifest hash
- 기존 promotion item과 run provenance 연결

완료 조건:

- 같은 job identity 중복 enqueue 0
- stage 수동 pass API 없음
- DB receipt ↔ R2 artifact round-trip/hash 검증 통과
- source 변경 즉시 stale 파생

구현 체크포인트 B1 (2026-07-25):

- [x] migration `0053_deep_analysis_ledger`에 job/run/stage receipt/axis/audit 5개
  테이블과 promotion run FK를 추가했다.
- [x] `(grant_id, source_revision_sha256, model_policy_version)` unique identity와
  `ON CONFLICT DO NOTHING` enqueue를 구현했다.
- [x] queue claim은 짧은 `FOR UPDATE SKIP LOCKED` 문장으로 구현했고, 외부 R2/LLM
  호출은 lease 트랜잭션 밖에 남겼다.
- [x] receipt/axis/audit update·delete를 DB trigger로 차단하고, run identity가 job의
  grant/revision/model policy와 일치하는지 DB trigger로 검사한다.
- [x] 신규 운영 원장 5개 테이블에 RLS를 활성화하고 client 수동 pass route는 만들지 않았다.
- [x] R2 artifact key에 grant/revision/run/kind/content SHA-256을 포함하고,
  upload 뒤 read-back SHA-256이 일치할 때만 verified key를 반환한다.
- [x] 최신 job revision과 과거 run revision이 다르면 `fresh=false`, `stale=true`,
  첫 blocker `analysis_fresh`로 파생하는 current query를 구현했다.
- [x] 로컬 disposable PostgreSQL에서 migration 적용, 중복 identity 거부,
  append-only trigger, 5개 테이블, stale projection을 검증한 뒤 DB를 삭제했다.
- [x] Drizzle schema drift 0, web typecheck, migration static verifier,
  deep analysis ledger unit test가 통과했다.
- [x] 운영 DB migration 적용과 실제 R2 private bucket 왕복은 B2에서 별도 검증한다.

구현 체크포인트 B2 (2026-07-25):

- [x] `db:doctor`로 대상이 Supabase `changupnote` DB이고 기존 필수 테이블·RLS가
  정상임을 확인한 후 `pnpm db:migrate`로 `0053`을 적용했다.
- [x] 운영 catalog에서 원장 table 5, RLS 5, append-only trigger 3,
  run identity trigger 1, promotion FK 1을 재검증했다.
- [x] private R2에 202바이트 verifier artifact를 content-addressed key로 기록한 뒤
  다시 읽어 SHA-256 `c367d15df900e06d3381818ceaa0b5e5d2f2d28ff4ca750b13ebed6945d387be`
  일치를 확인했다.
- [x] 재검증 명령은 `pnpm verify:deep-analysis-ledger`이며,
  실제 R2 왕복은 명시적인 `--write-r2`에서만 수행한다.

#### Phase C. 입력 전수성 보증

작업:

- source detail과 attachment inventory 대조
- HWP/HWPX 원본 archive backlog
- HWP/HWPX markdown conversion backlog
- PDF/image/OCR disposition
- input manifest/seal
- chunked long-document input

완료 조건:

- 분석 대상 첨부의 silent drop 0
- HWP/HWPX archive/markdown coverage 100% 또는 명시 blocker
- cap 초과가 truncation 성공으로 남는 사례 0
- 복구 4공고의 input manifest 회귀 통과

구현 체크포인트 C (2026-07-25):

- [x] 공고 구조화 원문·raw payload·attachment inventory를 source revision SHA-256으로
  봉인하는 운영 입력 조립기를 추가했다.
- [x] 모든 첨부를 `included|duplicate|waived_*|blocked_*` 중 정확히 하나로 분류하고,
  HWP/HWPX의 waiver는 동일 본문 중복 외에는 거부한다.
- [x] 60,000자 단위 chunk manifest와 전구간 round-trip 검증을 추가했다. 정책 총량을
  넘으면 `blocked_cap`이며 단일 prompt 뒷부분을 잘라 성공시키지 않는다.
- [x] 기존 HWP archive markdown뿐 아니라 conversion service의 검증된
  `document_artifacts(kind=markdown)`도 동일 R2 SHA-256 검증 뒤 입력에 연결한다.
- [x] 이미지 waiver는 같은 공고의 included OCR sidecar가 source URI/정규화 stem으로
  연결되고 sidecar SHA-256이 proof일 때만 허용한다.
- [x] S0~S5 receipt 초안을 input seal에서 결정론적으로 생성하며 archive/text/coverage
  blocker를 `passed`로 올리지 않는다.
- [x] 복구 fixture `178320`, `178329`, `178352`,
  `PBLN_000000000121478` 모두 sealed 되었다. HWP 6개 전문과 PDF 1개 전문,
  OCR sidecar 3개가 포함되며 이미지 3개는 proof-bound waiver다.
- [x] `178320` PDF/HWP pending surface 2건을 운영 conversion service로 변환해
  둘 다 `preview_ready`로 영속했다.
- [x] 활성 HWP/HWPX 656개는 ready 14, `blocked_fetch` 445,
  `blocked_conversion` 197로 보존식이 성립하며, 미준비 642개를 첨부 단위 blocker로
  열거한다.
- [x] `pnpm verify:deep-analysis-input -- --require-sealed`,
  `pnpm verify:deep-analysis-input-readiness`, input manifest/stage unit tests,
  web typecheck가 통과했다.

#### Phase D. 프로덕션 deep analysis worker

작업:

- 공용 extractor/contract/validator 분리
- Postgres job lease worker
- Cloud Run 배포 구성
- top-tier model allowlist
- retry/repair/dead-letter/cost cap
- heartbeat

완료 조건:

- production에서 dev route를 열지 않고 worker로 실행
- 동일 revision 재실행 시 paid call 0
- 실패 재시도와 dead-letter 증적 보존
- worker 중단을 ops에서 10분 안에 감지

구현 체크포인트 D1 — 실행 기반 (2026-07-25):

- [x] 운영 prompt/model policy를 공용 contract로 옮기고 primary/audit 모델을 명시
  allowlist로 닫았다. dev analysis-lab은 운영 extractor를 재사용하는 adapter가 되었다.
- [x] `premises`와 `export_performance`도 축과 criterion에서 보존하되, matcher canonical
  데이터가 열리기 전에는 해당 dimension의 `text_only`로 기록해 분석 누락과 자동 판정
  활성화를 분리했다.
- [x] 입력이 단일 prompt 상한을 넘으면 60,000자 무손실 chunk별 map 분석 후 전체
  synthesis를 수행한다. 모든 pass의 raw 결과·usage·비용을 보존할 수 있는 실행 결과 계약과
  single/map-reduce 회귀 테스트를 추가했다.
- [x] allowlist·일별/공고별 비용 상한·최대 입력·lease·batch 크기를 fail-closed env
  policy로 고정하고, 429/5xx/timeout exponential retry와 dead-letter 분류를 구현했다.
- [x] Cloud Run 호출 단위 queue loop는 짧은 `SKIP LOCKED` lease 뒤 외부 처리를 수행하며,
  budget 대기·재시도·blocker 결과를 job 상태로 보존한다.
- [x] migration `0054_deep_analysis_worker`에 `pending_budget` 상태와 worker heartbeat
  원장을 추가했다. heartbeat stale 기준은 기본 600초이며 RLS를 활성화했다.
- [x] `verify:db-migrations`, contracts/web typecheck,
  `verify:deep-analysis-contract`가 통과했다.
- [x] 실제 job processor는 Phase E의 validator·독립 감사를 모두 통과한 경우에만
  `analysis_complete`를 기록한다. processor 중간의 예상하지 못한 R2/DB 오류도 run을
  `running`에 방치하지 않고 append-only 예외와 terminal failure로 닫는다.

구현 체크포인트 D2 — 배포 가능한 worker 이미지 (2026-07-25):

- [x] 일별 비용 상한에 도달하면 claim 가능한 pending/retry job을 성공처럼 남기지 않고
  `pending_budget`으로 일괄 전환하며, 다음 KST 날짜에만 다시 연다.
- [x] 모노레포 루트 전용 `Dockerfile.deep-analysis-worker`와 Cloud Build 구성을 만들고,
  contracts/core를 이미지 안에서 빌드한 뒤 dev route가 아닌 worker CLI를 직접 실행한다.
- [x] `.dockerignore`로 `.env*`, `.git`, Vercel 상태, node_modules, 로컬 spike 산출물을
  build context에서 제외했다. `gcloud meta list-files-for-upload`에서도 로컬 secret env가
  업로드 대상이 아님을 확인했다.
- [x] 로컬 linux/amd64 호환 이미지 `cunote-deep-analysis-worker:checkpoint-d2` 빌드가
  성공했고, 시크릿 없는 실행은 `ANTHROPIC_API_KEY is required`로 fail-closed 종료했다.
- [x] commit `b27b792` image를 Artifact Registry digest
  `sha256:16b4f31a044a…`로 push하고 Cloud Run Job `cunote-deep-analysis`에 고정했다.
  execution `tjlrj`와 Scheduler 수동 호출 `hkcp5`, 정시 호출 `xhpbd`가 모두 task 1/1
  성공했으며 DB heartbeat의 revision·model policy·0-error 집계가 Cloud Logging과 일치했다.
- [x] Cloud Scheduler `cunote-deep-analysis-scheduler`는 5분 주기, OAuth service account,
  retry 0으로 활성화했다. 전파 중 잠긴 임시 paused scheduler는 삭제해 운영 job을 하나만
  남겼다.

구현 체크포인트 D3 — 활성 공고 autonomous feeder (2026-07-25):

- [x] 배포 검증 중 worker가 기존 queue만 소비하고 새 활성 공고 enqueue는 수동 CLI에
  남아 있음을 발견했다. 이를 완료로 오판하지 않고 공유
  `activeDeepAnalysisGrantPredicate` 기반 feeder를 worker invocation 앞에 결합했다.
- [x] 현재 model policy job이 없거나, 마지막 job 이후 grant/raw/attachment가 바뀐
  공고만 KST 활성 분모에서 최대 5건씩 선택한다. seal에서 계산한
  `grantId+sourceRevisionSha256+modelPolicyVersion` unique identity가 동시 실행과 재실행의
  중복 paid call을 차단한다.
- [x] 한 공고의 R2 seal 실패는 같은 batch의 다른 enqueue를 막지 않으며,
  examined/ensured/failed와 공고별 실패를 execution heartbeat metadata에 남긴다.
- [x] production read-only query에서 첫 feeder 후보 5건을 확인했고, unit test·web
  typecheck·전체 deep-analysis contract test가 통과했다.
- [x] feeder 포함 commit `144cdec` image를 digest
  `sha256:7df25adaee3e…`로 Job에 갱신했다. Scheduler execution `vgdck`는 active 후보
  `examined=5`, `ensured=5`, feeder failure 0을 heartbeat와 Cloud Logging에 동일하게
  기록하고 그중 1건을 즉시 claim했다.
- [x] 첫 claim `kstartup/178382`는 첨부 4건의 `blocked_fetch` 때문에 paid model call
  전에 job `blocked`로 닫혔고, 나머지 4건은 `pending`으로 보존됐다. 즉 자동 feeder도
  입력 누락을 성공이나 분석 완료로 바꾸지 않는다.

#### Phase E. 결정론 검증과 독립 감사

작업:

- 22축 exact validator
- found↔criteria consistency
- exact evidence locator
- independent blind audit adapter
- criterion-level resolution
- exception event model

완료 조건:

- S7~S11 validator test 전부 통과
- disagreement 자동 발행 0
- 사람 판정 없이 concur 건의 `analysis_complete` 가능
- 사람 판정은 blocker 해소 event로만 작동

구현 체크포인트 E1 — fail-closed 분석·감사 게이트 (2026-07-25):

- [x] raw response와 정규화 결과를 함께 검사하는 validator가 22축 exact set,
  found↔criteria 상호 일치, canonical value, semantic duplicate, 예약 축 보존,
  sealed source의 exact span 및 chunk 역참조를 모두 fail-closed로 검증한다.
- [x] schema/축/근거 오류는 원응답을 조용히 보정하지 않고 동일 모델의 별도 repair pass로
  최대 2회 재생성한다. 각 pass의 raw tool input·usage·비용은 immutable R2 artifact에
  남는다.
- [x] primary를 숨긴 `claude-sonnet-5` 블라인드 전축 분석 후 semantic set을 비교하고,
  차이가 있을 때만 source+양쪽 결과를 보는 criterion/axis 단위 adjudication을 실행한다.
  감사 호출도 timeout 및 429/5xx 1회 재시도 뒤 fail-closed로 종료한다.
- [x] migration `0055_deep_analysis_exceptions`로 사람/시스템 blocker를 append-only
  event로 만들었다. production catalog는 deep-analysis table 7, RLS 7, append-only
  trigger 4, run identity trigger 1, promotion FK 1을 검증했다.
- [x] `kstartup/178329` canary는 투자유치 상한을 잘못 canonicalize한 primary 오류와
  제재 문구 ambiguity를 S10에서 포착했고, `kstartup/178352` canary는 가산점 누락을
  S10에서 포착했다. 두 경우 모두 S11을 쓰지 않고 exception+dead-letter로 보존했다.
- [x] 활성 `bizinfo/PBLN_000000000121478`은 sealed input 2,861자와 첨부 1건을 읽고,
  job `4d362b29-73b3-40af-b290-e420e0e2c883` / run
  `da-20260725T010027650Z-0a0b4bdc-e747-4a02-a856-aba032d7cefb`에서
  22축·5 criteria·원문 근거·독립 감사 `concur`를 통과해 사람 판정 없이 S11
  `analysis_complete=passed`가 기록됐다. 총 모델 비용은 `$0.598330`이다.
- [x] contracts/core build, web typecheck, validator/audit/repair/adjudication 회귀 테스트,
  migration verifier, production ledger verifier가 모두 통과했다.

#### Phase F. 기존 ops 관제 최신 main 통합

작업:

- `pipeline` branch UI/read path port
- 현재 migration 번호로 admin action audit 재생성
- deep stage funnel/current query/API
- 상세 receipt/axis/audit/promotion 탭
- 역할별 capability
- 수동 `mark_reviewed`를 deep complete 경로에서 제거

완료 조건:

- owner/admin은 전체와 액션, reviewer는 exception 배정만 접근
- 현재 활성 공고가 정확히 한 최종 버킷에 속함
- 목록 수치와 verifier JSON 일치
- blocker 클릭 → 해당 공고 목록 → 증적 확인 왕복 가능

구현 체크포인트 F1 — receipt 기반 관제와 역할별 액션 (2026-07-25):

- [x] 오래된 `pipeline` branch의 migration/얕은 query는 cherry-pick하지 않고, 최신 main의
  shadcn/base-ui shell에 `/pipeline` UI와 summary/notices/detail/actions API를 파일 단위로
  새로 구현했다.
- [x] 활성 모집단은 DB 함수 `cunote_active_deep_analysis_grants(timestamptz)`를 단일
  SQL 경계로 사용하며 web worker predicate도 같은 함수를 호출한다.
- [x] 최신 model policy job/run과 stage별 최신 receipt만 projection에 반영한다.
  job 이후 grant/raw/attachment가 갱신되거나 run/job revision이 다르면 과거 성공보다
  `stale`이 우선한다.
- [x] 최종 버킷은 `serving_complete_fresh | analysis_complete_not_published |
  in_progress | blocked_or_failed | stale` 다섯 개로 배타적으로 계산한다. 운영 실측은
  활성 636건 = `0 + 1 + 630 + 5 + 0`이며 verifier와 목록 count가 모두 일치했다.
- [x] S0~S14 funnel 노드와 첫 blocker 필터를 연결해
  blocker 클릭 → 해당 공고 목록 → 상세 Sheet의 receipt/evidence hash/첨부 R2 hash/
  22축/독립 감사/승격 이력 왕복을 구현했다.
- [x] migration `0056_deep_analysis_ops`로 예외 `assigned|released` event와
  `admin_deep_analysis_actions` append-only 감사 원장, RLS, mutation 방지 trigger를
  운영 DB에 적용했다.
- [x] owner/admin만 failed job 재처리를 실행하고 reviewer는 예외 self claim/release만
  실행한다. 모든 액션은 UUID idempotency key를 요구하며 성공/실패를 최종 감사 원장에
  남긴다.
- [x] 딥분석 stage를 직접 `passed`로 바꾸거나 `mark_reviewed`로 완료시키는 API는 없으며
  회귀 테스트가 `mark_reviewed` 요청을 거부한다.
- [x] `pnpm verify:deep-analysis-ops`, admin typecheck, deep-analysis contract test,
  migration verifier, `db:doctor`, production admin build가 통과했다. 현재 사용자 실행
  서버에서는 `/pipeline` 비로그인 307→login, 관제 API 비로그인 401을 확인했다.
- [x] `ops.changupnote.com` production 배포와 로그인 전 경계 검증은 배포 체크포인트
  H0에서 완료했다. 인증 세션 시각 왕복은 사용 가능한 로그인 browser session이 없어
  남아 있다.

#### Phase G. shadow와 카나리

순서:

1. 동결 80공고 offline 평가
2. 20공고 production shadow run
3. source별·첨부별 10공고 카나리 analysis complete
4. 그중 고정 기업 profile로 promotion/matcher shadow
5. 2공고 실제 promotion canary
6. 24시간 serving/hash/SLO 관측
7. 20공고 확대
8. 오류 0이면 active backlog

중단 조건:

- HWP-only hard condition 누락 1건 이상
- catastrophic match flip 1건 이상
- unresolved attachment인데 complete 1건 이상
- publication/serving hash drift 1건 이상
- 자동 발행 항목의 audit disagreement 1건 이상

구현 체크포인트 G1 — deep run과 기존 promotion release 결합 (2026-07-25):

- [x] production deep run을 기존 immutable promotion manifest와
  `analysis_lab_promotion_items.deep_analysis_run_id`에 결합하는 전용 prepare 명령을
  추가했다. prepare 시점에 current job/source revision, S11, 독립 감사 concur,
  sealed input hash, R2 output/audit 실제 바이트 hash를 다시 검증한다.
- [x] validated normalized output을 기존 `planGrantPromotion` 계약으로 변환하되
  criterion 변환 drop, `needs_review`, 미확정 resolution, 질문 anchor drop 중 하나라도
  있으면 release 생성 전에 fail-closed 차단한다.
- [x] promotion source verifier가 deep source일 때 로컬 실험 파일을 신뢰하지 않고
  production DB run/job/receipt/audit와 private R2 artifact 및 현재 입력을 재검증한다.
- [x] 실제 적용 뒤 기존 after snapshot 검증, Drizzle production repository 재조회,
  고정 비식별 기업 profile 3종에 대한 matcher `rule_trace` criterion ID 전수 소비,
  current source/input freshness를 검증하고 S12/S13/S14 receipt를 append-only로 남기는
  `deep-analysis:verify-serving` 명령을 추가했다.
- [x] deep promotion adapter 테스트를 전체 deep-analysis contract suite에 포함했고,
  web typecheck와 기존 release/promote/verify/shadow 회귀 테스트가 통과했다.
- [x] production canary release의 aggregate → shadow → dry-run → approve → write →
  promotion verify → S12/S13/S14 증적은 G2에서 clean commit을 기준으로 실행한다.

운영 체크포인트 G2 — 첫 production serving canary (2026-07-25):

- [x] `e238ba6` clean commit에서 Bizinfo
  `PBLN_000000000121478`의 passed run을
  `deep-production-r1-20260725T020110Z-e238ba64` immutable release에 결합했다.
  이 공고는 본문+첨부 1건을 포함하고 22축·criterion 5개·독립 감사 concur를
  통과한 run이다.
- [x] aggregate 6/6 GO, source drift 0, production shadow
  `1 notice × 125 pseudonymized companies` issue 0, release dry-run baseline 1/1,
  canary write 1/1, canary verification issue 0을 순서대로 통과했다.
- [x] 같은 1-item release를 active로 완료한 뒤 after snapshot hash와 repository
  criteria hash 일치, 고정 비식별 profile 3종의 matcher trace criterion ID 전수 소비,
  current source/input hash 일치를 재검증했다. S12/S13/S14 최신 receipt가 모두
  `passed`이며 관제의 `serving_complete_fresh`가 0→1로 전환됐다.
- [x] 두 번째 K-Startup S11 통과 공고는 별도 immutable release
  `deep-production-r1-20260725T020427Z-e238ba64`로 준비했지만 aggregate coverage
  ratio가 `4/3 = 1.333`으로 1.5 gate에 미달해 ITERATE로 중단했다. 다른 5개 gate와
  source drift는 통과했으나 shadow·승인·write는 실행하지 않았다.
- [x] gate를 낮추지 않고 새 worker가 통과시킨 K-Startup `178466` run으로
  `deep-production-r1-20260725T022203Z-5fcb677b` release를 준비했다. 본문+첨부 2건
  중 텍스트 1건을 포함하고 non-text 1건은 검증된 waiver이며, 22축·criterion 5개·
  독립 감사 concur를 통과했다.
- [x] 두 번째 실제 canary도 aggregate 6/6 GO, source drift 0, production shadow
  1×125 issue 0, dry-run baseline 1/1, canary/all promotion verify issue 0,
  S12/S13/S14를 모두 통과했다. 관제는 `serving_complete_fresh=2`,
  `publication_complete=2`, `serving_complete=2`, `analysis_fresh=2`로 확인됐다.
- [x] `deep-analysis:verify-serving -- --active`가 active deep release를 DB에서
  자동 발견하고, DB embedded manifest의 manifest/release-plan hash를 다시 검증한 뒤
  로컬 `spike-out` 파일 없이 S12/S13/S14를 재검증하도록 확장했다. 두 active release,
  두 공고에 대한 첫 monitor 실행은 PASS였다.
- [x] commit `eba1597` image digest `sha256:e9a1b5b8fd6b…`로 검증 전용 Cloud Run Job
  `cunote-deep-analysis-serving-monitor`를 배포했다. 이 Job에는 Anthropic key를
  연결하지 않았고 DB·R2와 receipt 기록에 필요한 secret만 연결했다.
- [x] 검증 Job 수동 execution `jpxt8`과 30분 Scheduler의 첫 자동 execution
  `47cwc`가 모두 task 1/1, `checkedReleases=2`, `checkedItems=2`, PASS로 완료됐다.
  Scheduler `cunote-deep-analysis-serving-monitor-scheduler`는 매시 `:05/:35`,
  OAuth service account, retry 0으로 활성화됐다.
- [x] 관제 실행이 중단됐는데 마지막 S14가 계속 신선해 보이는 사각지대를 없앴다.
  active monitor가 쓰는 S12/S13/S14 receipt에 Cloud Run execution ID·runtime·
  observation mode를 기록하고, ops는 최신 cloud-run monitor 실행의 전수 확인 수,
  fresh S14 수, 실패·stale receipt 수, 마지막 확인 시각을 별도 건강도로 집계한다.
- [x] monitor heartbeat가 없거나 45분을 넘기고, 활성·applied 대상 전수와
  checked/fresh 수가 다르거나 실패·stale receipt가 하나라도 있으면
  `pnpm verify:deep-analysis-ops`가 fail-closed로 종료하도록 했다. 배포 전 기존
  `eba1597` receipt만 있는 production에서 의도적으로
  `execution=null`, `checked=0/2`, `fresh=0`, exit 2를 확인했다.
- [x] contracts/core build, web/admin typecheck, deep-analysis contract suite,
  monitor summary 단위 테스트와 admin production build가 통과했다.
- [x] clean commit `48b92c4`를 `sw@noten.im`·`changupnote-com`에서 build한
  immutable image digest `sha256:ee073d72440f…`로 worker와 serving monitor Job을
  함께 갱신했다. 두 Job의 service account와 기존 env/secret 경계, monitor 인자,
  30분 Scheduler는 유지했다. 다음 5분 주기의 worker execution
  `cunote-deep-analysis-sjqfd`도 task 1/1로 성공했고 ops heartbeat의
  `serviceRevision=48b92c44…`, stale=false를 확인했다.
- [x] 새 image의 monitor execution
  `cunote-deep-analysis-serving-monitor-8whjx`가 task 1/1,
  `checkedReleases=2`, `checkedItems=2`, PASS로 끝났다. 이후 같은 production
  ops verifier가 `execution=…-8whjx`, `checked=2/2`, `fresh=2/2`,
  실패 0, stale 0, `healthy=true`로 PASS해 배포 전 의도적 실패를 해소했다.
- [x] ops UI는 기존 `team-coolwithyou/changupnote-ops`에 deployment
  `dpl_EKEXVNindWKomMw657dTRM8Ri4ns`로 배포해 Ready와
  `ops.changupnote.com` alias를 확인했다. 라이브 `/pipeline`은 비로그인
  307→login, summary/action API는 401로 닫혀 있다. 새 project/domain은 만들지
  않았다.
- [x] 24시간 종료를 현재 heartbeat 한 점이나 수동 로그 검토로 통과시키지 않도록
  `deep-analysis:verify-serving-window`를 추가했다. 명시한 24시간 구간의 30분 슬롯
  48개가 각각 5분 안에 첫 receipt를 쓰고 10분 안에 전수 receipt를 끝내며, 동결된
  active/applied item 전부의 S12/S13/S14가 정확히 하나씩 passed인지 검증한다.
  각 receipt의 canonical evidence hash와 content-addressed R2 artifact 실제 바이트도
  최대 8개 병렬 read로 재검증한다. 미래 종료시각, 누락·중복 실행, item/run 불일치,
  실패·stale, R2 불일치는 모두 exit 2다.
- [x] 같은 종료 검증기에 gcloud cloud evidence를 결합했다. active account/project가
  `sw@noten.im`·`changupnote-com`인지, Scheduler가 enabled·`:05/:35`·KST·retry 0·
  지정 OAuth service account/Run URI인지 먼저 고정한다. 각 슬롯의 Scheduler
  AttemptStarted/AttemptFinished HTTP 200, Cloud Run task 1/1·10분 이내 완료,
  DB receipt execution ID 일치를 자동 교차 검증하며 하나라도 다르면 exit 2다.
- [x] 첫 정시 execution `cunote-deep-analysis-serving-monitor-lq752`가 task 1/1로
  성공한 직후 production read-only 종료 검증을 실행했다. 전체 48슬롯 중 현재 도래한
  1슬롯과 item 2개, receipt 6개를 정확히 인식하고 R2 6건 byte mismatch 0을 확인했지만,
  종료시각이 미래이므로 `window_incomplete` 하나로 exit 2했다. 미래 슬롯을 조기 성공이나
  누락으로 오인하지 않으며 24시간이 실제 경과하기 전 PASS할 수 없음을 확인했다.
  같은 실행의 cloud evidence도 Scheduler start/finish 1/1, Run success 1/1,
  receipt execution match 1/1, failure 0으로 별도 PASS했다.
- [ ] serving canary 관측은 2026-07-25 11:35 KST부터 유지되고 있다. 다만 execution
  metadata/R2 전수 종료 검증은 새 image의 첫 정시 슬롯인 2026-07-25 12:05 KST부터
  2026-07-26 12:05 KST까지 더 엄격하게 다시 센다. 종료 뒤 DB/R2 48슬롯 판정과
  Cloud Scheduler/Run execution 48건을 같은 명령으로 교차 확인해 닫는다.
  20공고 확대는 이 관측 gate 뒤에만 진행한다.

#### Phase H. 활성 공고 백필 (2026-07-25 실측 분모 636)

준비 체크포인트 H-pre — 20공고 후보와 blocker 분류 보존 (2026-07-25):

- [x] 관측 gate 중에는 release/승격을 실행하지 않고 current S11+audit concur 후보를
  read-only로 집계했다. 현재 3건 중 Bizinfo 1·K-Startup 1은 이미 serving이고 신규
  후보는 K-Startup 1건뿐이므로 20공고 확대 조건은 아직 충족되지 않는다.
- [x] worker는 invocation당 처리 1, enqueue 5, 일 비용 `$50`, 공고당 `$2`,
  primary `claude-opus-4-8`, audit `claude-sonnet-5` 상한을 유지한다. 당일 실측은
  model run 28건, 비용 `$2.526885`여서 후보 부족 원인은 비용 cap이 아니다.
- [x] blocked/dead-letter job의 `last_error_code` 26건이 모두 JS `Error.name`으로
  축약된 반면 같은 job의 terminal run에는 `input_not_sealed` 25건,
  `independent_audit_disagreement` 1건이 보존된 것을 확인했다. worker가 current
  attempt의 run error code를 우선 기록하고, 기존 generic code는 최신 terminal run에서
  mutable queue projection만 보정하도록 수정했다. append-only receipt/exception/run은
  변경하지 않는다.
- [ ] 수정 worker를 별도 image로 배포해 기존 26건의 job code 보정과 신규 실패의
  구체 code 보존을 production에서 확인한다. 24시간 관측 중인 serving monitor image는
  바꾸지 않는다.

배포 체크포인트 H0 — 관제·worker production 반영 (2026-07-25):

- [x] 검증·커밋된 `f3c2973`을 `origin/main`에 push하고
  `NOTEN/changupnote` production deployment
  `dpl_3Y3uY5HWKgjxmwhosnJH8mLjBp1z`로 배포했다. 배포 상태 Ready,
  `changupnote.com`과 `www.changupnote.com` 라이브 응답은 모두 200이다.
- [x] ops의 실제 소유권이 토큰 scope `noten`이 아니라
  `team-coolwithyou/changupnote-ops`임을 read-only inspect로 확인했다. clean commit의
  `.git`·env 제외 임시 패키지를 기존 project link로 배포한
  `dpl_GSJbJG6YsBqfQqmJo65crP58dPaR`가 Ready이며 기존
  `ops.changupnote.com` alias를 유지한다.
- [x] 라이브 `/pipeline`은 비로그인 307→`/login?callbackUrl=/pipeline`,
  overview API와 action POST는 모두 401로 닫혀 있다. 배포 과정에서 새 Vercel
  project나 domain을 만들지 않았다.
- [x] `sw@noten.im`·`changupnote-com`에서 `f3c2973` worker 이미지를 build해
  Artifact Registry digest `sha256:101ba48003a4…`로 Cloud Run Job을 갱신했다.
  기존 service account, Secret Manager 연결, 비용/입력/lease/env 상한은 유지했다.
- [x] 새 이미지 수동 execution `cunote-deep-analysis-6bfnl` task 1/1이 성공했고,
  DB heartbeat `serviceRevision=f3c2973…`, stale=false로 교차 확인했다. 해당 실행의
  입력 blocker는 paid model call 없이 fail-closed 분류됐다.
- [x] `.env.vercel.local` NOTEN token을 웹 배포 정본으로 쓰되, ops 소유권 예외와
  모노레포 Root Directory 이중 경로 방지 절차를 `AGENTS.md`에 추가했다.

우선순위:

1. D-day 7일 이내
2. HWP/HWPX 보유
3. 현재 text-only/needs_review/낮은 dimension coverage
4. 사용자 match 노출 빈도 높은 공고
5. 나머지 활성 공고

배치:

- 첫 20공고로 cost/latency/오류율 재산정
- 일별 cost cap 안에서 source 균형 유지
- 분석 중 마감된 공고는 신규 paid call 착수 전 제외
- source revision 변경 공고를 오래된 backlog보다 우선
- 성공 수가 아니라 `serving_complete + fresh` 수로 진척 측정

완료 조건:

- 활성 target의 `serving_complete + fresh` 100% 또는 명시 blocker
- blocker 공고는 원인·재시도/사람 action·SLA가 모두 있음
- deep provenance 없는 기존 criteria를 current deep으로 오인하는 공고 0

#### Phase I. 상시 운영

목표 SLO:

- 새/변경 활성 공고 95%: 2시간 안에 `analysis_complete`
- 새/변경 활성 공고 99%: 6시간 안에 `serving_complete`
- HWP/HWPX 영구 blocker: 발생 30분 안에 ops 노출
- worker/source heartbeat 지연: 10분 안에 경고
- stale serving 공고: 0을 목표, 30분 초과 0

주간 품질 보고:

- active/fresh serving coverage
- source별 stage conversion
- HWP-only criterion 수
- primary↔audit disagreement
- exception 원인 분포
- wrong/missed/catastrophic error
- 평균·p95 분석 시간과 공고당 비용
- retry/dead-letter/rollback
- model policy별 품질 변화

### 14.11 예상 파일 경계

공용 계약:

- `packages/contracts/src/deep-analysis.ts`
- `packages/contracts/src/index.ts`

DB·운영 코어:

- `apps/web/src/lib/server/db/schema.ts`
- `db/migrations/<next>_*.sql`
- `apps/web/src/lib/server/deep-analysis/eligibility.ts`
- `apps/web/src/lib/server/deep-analysis/source-revision.ts`
- `apps/web/src/lib/server/deep-analysis/input-manifest.ts`
- `apps/web/src/lib/server/deep-analysis/validator.ts`
- `apps/web/src/lib/server/deep-analysis/receipts.ts`
- `apps/web/src/lib/server/deep-analysis/current.ts`
- `apps/web/src/lib/server/deep-analysis/jobs.ts`

추출 코어 이관:

- `apps/web/src/lib/server/analysis-lab/extractor.ts`
- `apps/web/src/lib/server/analysis-lab/input.ts`
- `apps/web/src/lib/server/analysis-lab/analyze.ts`
- `apps/web/src/features/dev/analysis-lab/contract.ts`

worker:

- `apps/deep-analysis-worker/`
- 또는 공용 패키지 + Cloud Run entrypoint
- Cloud Build/Run 배포 설정

ops:

- `apps/admin/src/app/pipeline/page.tsx`
- `apps/admin/src/app/api/admin/pipeline/**`
- `apps/admin/src/features/pipeline/**`
- `apps/admin/src/lib/server/admin/pipelineGraph.ts`
- `apps/admin/src/lib/server/admin/deepAnalysisPipeline.ts`
- `apps/admin/src/lib/server/admin/pipelineActions.ts`

검증:

- `tools/verify-active-deep-analysis.mjs` 또는 typed CLI
- `pnpm verify:deep-analysis-contract`
- `pnpm verify:deep-analysis-pipeline`
- `pnpm verify:active-deep-analysis`
- `pnpm verify:admin-pipeline`

파일명은 구현 중 현재 모듈 경계를 보고 조정할 수 있지만, dev UI와 운영 worker가 서로 다른
extractor 구현을 가지는 것은 금지한다.

### 14.12 테스트 매트릭스

#### 순수 로직

- active eligibility KST 경계
- source revision canonical hash
- attachment manifest 정렬·hash 결정성
- disposition 전수성
- 22축 exact set
- found↔criteria consistency
- evidence exact locator
- reserved dimension 보존
- job identity/idempotency
- stage state transition
- conservation equation
- source revision stale 전환

#### DB 통합

- publisher+outbox/job enqueue 원자성
- `SKIP LOCKED` concurrent lease 중복 0
- lease expiry recovery
- append-only receipt
- current projection latest attempt
- source drift 후 old run non-current
- promotion item run provenance FK/검증
- R2 artifact hash mismatch fail

#### worker 통합

- primary success
- retryable provider error
- non-retryable contract error
- repair success/failure
- cost cap
- dead-letter
- heartbeat
- graceful shutdown lease 반환

#### 제품 E2E

1. 새 활성 공고 수집
2. HWP inventory/archive/convert
3. input seal
4. primary analysis
5. 22축·evidence pass
6. blind audit concur
7. ops funnel 이동
8. manifest promotion
9. matcher serving trace 일치
10. source attachment 변경
11. 기존 run stale
12. 재분석·재발행 후 fresh 복구

#### 회귀 fixture

- kstartup 178320
- kstartup 178329
- kstartup 178352
- bizinfo PBLN_000000000121478
- HWP table/merged-cell fixture
- HWPX XML fixture
- 손상·암호화·초대용량 fixture

### 14.13 구현 완료 정의

다음을 모두 만족해야 이 요청을 “프로덕션 딥분석 해결”로 닫는다.

- [ ] 활성 공고 predicate가 코드 한 곳에서 공유됨
- [ ] S0~S14 receipt가 DB+R2에 영속됨
- [x] production deep analysis worker가 자동 실행됨
- [ ] HWP/HWPX 첨부 전건이 included 또는 명시 blocker
- [x] 22축 exact validator가 fail-closed
- [x] hard criterion source evidence 100%
- [x] 독립 audit disagreement 자동 발행 0
- [x] 사람 전수 검수 없이 concur 건 자동 analysis complete
- [ ] promotion manifest가 run/source revision에 묶임
- [ ] matcher serving hash 검증
- [ ] source 변경 시 stale 자동 전환·재분석
- [ ] `/pipeline`이 최신 main과 ops production에 통합됨
- [x] active conservation equation 성립
- [ ] blocker·SLO·worker heartbeat alert 작동
- [ ] 동결 80공고 품질 기준 통과
- [ ] 2→20→전체 카나리 중단 조건 위반 0
- [ ] 활성 target `serving_complete + fresh` 100% 또는 명시 blocker

이 체크리스트가 끝나기 전에는 “HWP 변환이 된다”, “criterion이 몇 개 있다”,
“extraction_log가 labeled다”, “모델 API가 200이다” 중 어느 것도 딥분석 완료의
대체 증거로 사용하지 않는다.
