# 딥 공고 분석 결과 운영 매칭 적용 로드맵 및 구현 계획

> 작성일: 2026-07-24  
> 상태: **프로덕션 worker·영속 원장·딥분석 관제 운영 중 / 실제 HWP 포함 22축 분석 완주 /
> 2공고 serving canary 통과 / 24시간 관측 후 20공고 확대 대기**
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
- [x] 두 번째 정시 execution `cunote-deep-analysis-serving-monitor-tckmn`도 task 1/1로
  성공했다. 같은 종료 검증은 도래한 2슬롯, execution 2건, receipt 12건,
  R2 byte mismatch 0을 확인했고 cloud evidence도 Scheduler start/finish 2/2,
  Run success 2/2, receipt execution match 2/2, failure 0으로 PASS했다. 전체 판정은
  gate를 낮추지 않아 아직 `window_incomplete` 하나로 exit 2다.
- [x] 2026-07-25 14:05 KST 재검증은 `lq752`, `tckmn`, `h74jb`, `q5d2t`, `hmdx5`
  다섯 정시 execution과 도래한 5/48 슬롯을 인식했다. DB receipt 30건과
  content-addressed R2 artifact 전수 비교의 불일치는 0이고, Cloud Scheduler
  start/finish 5/5, Cloud Run success 5/5, receipt execution match 5/5도 모두 PASS다.
  종료 판정은 여전히 `window_incomplete` 하나뿐이며 조기 통과시키지 않았다.
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
- [x] 수정 commit `9b6653c`를 Cloud Build
  `fffd2398-3870-4104-ab51-bd90eb810617`에서 별도 image digest
  `sha256:7fa3cf452c25…`로 build하고 worker Job만 갱신했다. 첫 정시 execution
  `cunote-deep-analysis-87hsd`는 task 1/1, 14.5초로 성공했으며 heartbeat metadata가
  `repairedErrorCodes=30`, `serviceRevision=9b6653c…`를 기록했다. 보정 후 전체
  blocked/dead-letter queue projection은 terminal run과 정확히 일치한다:
  model policy v3 `input_not_sealed` 27건, v1/v2/v3
  `independent_audit_disagreement` 4건이며 generic `Error`는 0건이다. 같은 실행에서
  새로 차단된 공고도 `input_not_sealed`로 보존됐다.
- [x] 이 배포는 worker에만 적용했다. 24시간 관측 중인 serving monitor는 시작 commit
  `48b92c4`, image digest `sha256:ee073d72440f…`와 기존 secret/env 경계를 유지한다.
  배포 직후 `pnpm verify:deep-analysis-ops`는 분모 636의 상태 보존식, worker
  freshness, monitor `checked=2/2`, receipt failure/stale 0을 모두 확인해 PASS했다.
- [x] 최신 v3 `input_not_sealed` 27공고를 exception receipt의 실제 blocker로 분해했다.
  K-Startup은 원본 미보관 14공고/53첨부, Bizinfo는 원본 미보관 8공고/15첨부,
  원본 보관 후 변환 미완료 6공고/11첨부다. 공고 집합은 일부 중첩하며 모든 blocker는
  paid model call 전에 발생했다.
- [x] 변환 artifact가 생겨도 autonomous feeder가 `grant/raw/archive` timestamp만 보고
  `document_artifacts` 갱신을 놓쳐 자동 재분석하지 못하는 단절을 수정했다. commit
  `fd3036d`부터 검증된 markdown artifact/surface 갱신도 새 source revision 후보를
  만들며, 기존 unique identity가 중복 paid call을 계속 차단한다.
- [x] commit `a42f05a`에 LLM worker와 분리된 input-preparation 실행기를 추가했다.
  최신 `input_not_sealed` 활성 job만 source별 bounded batch로 고르고, 원본 archive →
  conversion reconciliation → R2 재봉인 검증을 수행한다. LLM 호출·promotion·matcher
  write는 포함하지 않는다. 가장 가까운 마감 1건은 항상 우선하고 나머지는 10분 epoch로
  순환해 영구 blocker가 용량을 독점하지 않으며, 더 최신 job이 있는 과거 blocker는
  대상에서 제외한다.
- [x] Bizinfo 수동 백필과 상시 실행이 같은 bounded batch 코어를 사용하도록 분리했고,
  conversion sweep을 선택한 source ID로 제한했다. production read-only target
  selection은 기본 정책 `source별 2공고 / 공고당 10첨부 / source별 20첨부 /
  conversion 10 / deadline 480초`에서 K-Startup 2·Bizinfo 2를 선택했다.
  web typecheck, 전체 deep-analysis contract suite, fail-closed 실행 검증과 두 source의
  targeted dry-run이 통과했다.
- [x] input-preparation 전용 Cloud Run Job을 `sw@noten.im`·`changupnote-com`에 별도
  배포하고, 24시간 serving monitor image는 그대로 둔 채 bounded production canary로
  archive→conversion→재봉인→새 revision 자동 enqueue를 검증한다. Scheduler는 canary
  증적과 관제 계약을 확인한 뒤에만 활성화한다. 첫 canary execution `x7d45`는
  K-Startup `178185`의 HWP+TXT와 `178613`의 HWP, Bizinfo `123716`의 HWPX+PDF를
  원본 보관했고 변환 실패 0, conversion still-pending 0을 기록했다. 이 중 K-Startup
  2공고는 즉시 재봉인·새 revision enqueue까지 완료했고, 해소되지 않은 2공고는
  `blocked_conversion`을 유지해 LLM 호출로 넘어가지 않았다.
- [x] input-preparation Scheduler
  `cunote-deep-analysis-input-preparation-scheduler`를 KST 매 10분 `:02/:12/…/:52`,
  OAuth service account, retry 0으로 활성화했다. 첫 자동 execution `xzjhd`는
  task 1/1, sealed 3/4, archive/conversion failure 0으로 성공했고, 새 image의
  `tt5gw`도 task 1/1, HWP/HWPX 5건을 포함한 archive/convert를 수행한 뒤
  `serviceRevision=b7e44e6…` heartbeat를 남겼다. 준비 Job에는 Anthropic secret이
  없고 archive/convert/reseal/enqueue만 수행한다.
- [x] 실제 HWP 분석 경로는 K-Startup `178185`로 종단 검증했다. input preparation이
  `교통환경챌린지 8기 창업기업 모집.hwp`를 `hwp5html`로 변환하고 HWP·TXT를 포함한
  source revision을 봉인했다. worker execution `68sxs`는 4분 14초, task 1/1로
  종료했고 Opus primary가 정확히 22축과 criterion 10개를 생성했다. response contract,
  axis coverage, 원문 evidence grounding이 모두 issue 0이며 Sonnet 독립 감사도
  disagreement 0/concur로 `analysis_complete`를 통과했다. 비용은 `$0.916720`이고
  이 결과는 관측 gate 중이므로 아직 promotion/matcher write를 하지 않았다.
- [x] 같은 실운영 검증에서 audit의 역할도 fail-closed로 확인했다. K-Startup
  `177978`은 실제 공고에 없는 업력 제한을 넓은 시스템 태그에서 추론한 2항목,
  Bizinfo `124039`는 특정 전환기업 대상 조건을 충분히 구조화하지 못한 1항목 때문에
  각각 독립 감사 불일치로 격리됐다. primary contract·22축·근거 통과만으로 자동
  발행하지 않았고, concurrence를 얻은 `178185`만 `analysis_complete`가 됐다.
- [x] 24시간 gate 전에 계획된 20공고 분석·승격을 앞당기지 않도록, 위 종단 검증을
  마친 2026-07-25 13:43 KST에 main Scheduler를 일시 `PAUSED`로 돌렸다. 이 상태가
  10분 worker heartbeat SLO와 충돌하므로 commit `befbf3b`에
  `DEEP_ANALYSIS_WORKER_MODE=observe_only`를 추가했다. 이 모드는 heartbeat만 쓰고
  enqueue, lease/claim, budget 상태 변경, LLM 호출을 모두 건너뛴다.
- [x] build `1474549a-70f0-4a90-a0a1-2070b6a6b54c`의 digest
  `sha256:559ec3f02394…`를 main worker에만 반영하고 정확한 commit
  `befbf3b5d56c5879e6ebb73e47486a721ead591e`와 `observe_only` env를 확인했다.
  수동 execution `k8twq`와 첫 정시 execution `cn4z6`는 각각 task 1/1,
  `enqueueSkipped=true`, `analysisSkipped=true`, `budgetMutationSkipped=true`,
  `claimed=0`으로 끝났다. Scheduler는 2026-07-25 13:59 KST 다시 `ENABLED`했으며
  48/48 PASS 뒤 같은 mode를 `active`로 바꿔 첫 20공고 배치를 시작한다.

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
- [x] commit `bda5438`에서 worker 전체 동시성을 DB advisory lock과 active lease
  count로 1개에 고정하고 lease를 획득하지 못한 호출은 model call 없이 끝내도록 했다.
  장시간 실행 중 겹친 수동 execution `bw2qf`와 정시 execution `87fl6`가 모두
  `claimed=0`, 비용 0으로 끝나 중복 유료 분석이 없음을 확인했다.
- [x] commit `fa66a9f`에서 모델이 JSON 직렬화된 HWP 줄바꿈을 표현한 evidence span을
  봉인 입력의 정확한 raw substring으로 결정론적으로 복원하도록 수정했다. 이미 실패한
  production raw response를 새 모델 호출 없이 재검증한 결과 response contract,
  22축, evidence grounding이 전부 통과했다. 일반적인 모호한 공백 변형은 계속
  fail-closed다.
- [x] commit `b7e44e6`에서 Cloud Run 30분 timeout보다 짧았던 lease를 35분으로 늘리고,
  running worker보다 뒤에 끝난 no-op heartbeat가 관제에서 실행 중인 job을 가리던 집계를
  수정했다. ops는 이제 current job, active worker/lease, stale active worker와
  `healthy`를 함께 표시한다. execution `68sxs` 중 관제 실측은 active worker 1,
  active lease 1, stale 0, 정확한 current job·service revision이었고 종료 후 모두
  0/idle로 회수됐다.
- [x] Cloud Build `e87d161f-ecea-449b-951c-785177f4aaa5`가 commit
  `b7e44e65476cd513d42a033963f5dc36511ebd99`를 immutable digest
  `sha256:140f9641f5d9…`로 만들었고 main worker와 input-preparation Job 모두 같은
  digest·정확한 commit SHA를 사용한다. main은 max concurrent 1, lease 2100초,
  invocation당 1건, 일 `$50`/공고당 `$2` 상한을 유지한다.
- [x] 새 worker 건강도 UI는 기존 `team-coolwithyou/changupnote-ops` production
  deployment `dpl_H9YSwL76QwPS1VTFeuEkthRDDQvX`로 배포해 Ready와 기존
  `ops.changupnote.com` alias를 확인했다. 비로그인 `/pipeline`은 307→login,
  overview/action API는 401이며 새 project/domain은 만들지 않았다.
- [x] commit `541ec2a`부터 worker heartbeat metadata의 `executionMode`를 관제
  계약·verifier·UI에 노출한다. production ops verifier는 정시 execution `2hpgw`를
  `observe_only`, active worker/lease 0/0, stale active 0, healthy로 확인했다.
  기존 `team-coolwithyou/changupnote-ops` deployment
  `dpl_4SwVaXu3iYRihd9FXQvopCiHvvLX`는 Ready이며 기존
  `ops.changupnote.com` alias를 유지한다. 라이브 `/pipeline` 307→login,
  summary/action API 401 경계도 다시 통과했다.

입력 준비 체크포인트 H1 — legacy 변환 등록·검증된 container 봉인 (2026-07-25):

- [x] 원본 `storage_key`·SHA는 있지만 conversion surface/markdown artifact가 없는
  과거 첨부를 현재 `input_not_sealed` target 범위에서 찾고, 기존 멱등
  `registerAttachmentConversions` 경로로 surface·job·cache hit를 복구한 뒤 같은 실행의
  poll sweep으로 넘긴다. LLM 호출·promotion·matcher write는 이 경로에 없다.
- [x] ZIP parent는 이름이나 child 존재만으로 면제하지 않는다. R2 parent 실제 바이트
  SHA를 재검증하고, 비어 있지 않은 내부 entry 전부가 지원 문서이며 현재 inventory의
  검증된 child 전문과 일대일 대응할 때만 content-addressed proof로
  `waived_non_material` 처리한다. 숨은 이미지·지원하지 않는 material entry·cap 초과·
  child 누락은 계속 fail-closed다.
- [x] 같은 stem의 HWP/HWPX가 있다는 이유만으로 이미지를 면제하던 후보 로직은 제거했다.
  검증된 OCR TXT sidecar가 없는 이미지는 계속 명시 blocker다. production read-only
  재봉인에서 K-Startup `178106`, `178232`의 HWP/HWPX 전문은 included였지만 JPG는
  `blocked_fetch`로 유지되어 게이트가 낮아지지 않았다.
- [x] Bizinfo `PBLN_000000000124461`은 R2 ZIP 실제 바이트의 material entry 6건과
  변환된 HWP child 6건이 정확히 대응해 sealed로 전환됐다. 반면
  `PBLN_000000000123631`의 이미지형 PDF는 기존 surface가 있지만 markdown artifact가
  없어 `blocked_conversion`을 유지한다. OCR 근거 없이 complete나 waiver로 바꾸지 않는다.
- [x] input-preparation heartbeat·ops 계약·UI에 변환 후보/surface/job/cache/skip/warning
  수를 노출하고 registration warning이 있으면 건강도를 fail-closed로 내린다.
  deep-analysis contract 전수, archive inspection, web/admin typecheck, admin pipeline
  contract test와 `git diff --check`가 통과했다.
- [x] commit `05992b5`를 Cloud Build
  `d5becbda-9ac3-4a62-8648-9372784b64a0`에서 immutable digest
  `sha256:2a0681c31c96…`로 만들고 input-preparation Job에만 배포했다. main worker
  `sha256:559ec3f02394…`·`observe_only`와 serving monitor 동결 digest
  `sha256:ee073d72440f…`는 변경하지 않았다.
- [x] 첫 수동 execution `9r2lr`에서 후보 2, surface 1, conversion job 1, skip 1,
  warning 0을 확인했지만 PDF가 같은 실행의 poll 대상이 되지 않아 완료로 판정하지 않았다.
  production read-only 조회 결과 이 PDF surface는 2026-07-11부터 `preview_ready`였지만
  markdown이 없는 partial 변환이었다. 이를 “surface 누락”으로 오인해 중복 job을 만들지
  않도록, 같은 storage identity의 surface가 하나라도 있으면 legacy 등록 후보에서 제외하고
  명시 OCR blocker로 보존하는 회귀 보정을 추가했다.
- [x] 보정 commit `b46b6af`를 Cloud Build
  `1d03ac56-2947-45e9-b487-cee8b78abad7`에서 digest
  `sha256:c34189348a63…`로 만들고 input-preparation Job만 갱신했다. exact
  `GIT_COMMIT_SHA=b46b6af507d8…`, 기존 service account·timeout·env/secret 경계를
  확인했고 main/serving monitor digest는 그대로다.
- [x] 수동 execution `hw279`는 K-Startup `178343`의 새 HWP 2건을 R2 보관하고
  `hwp5html` 전문 변환, conversion surface poll 2건 성공, sealed·priority 100 job
  생성까지 완료했다. 같은 실행에서 기존 partial PDF는 registration 후보에서 제외되어
  중복 job 0, 후보 1은 non-convertible container라 skip 1, warning 0이었다.
- [x] 바로 다음 정시 execution `fhnhr`도 task 1/1, exact revision `b46b6af507d8…`,
  sealed 2/4, 기존 명시 blocker 2, conversion candidate 1·surface/job/cache 0·skip 1,
  archive/conversion/registration warning 0으로 끝났다. `pnpm verify:deep-analysis-ops`는
  active 636 보존식, input-preparation healthy, main `observe_only`, active worker/lease
  0/0, serving monitor fresh 2/2로 PASS했다.
- [x] 새 관제 필드는 기존 `team-coolwithyou/changupnote-ops` production deployment
  `dpl_5YzKA7jub2ZYttU4FRCa3hpduXFa`로 배포해 Ready와 기존
  `ops.changupnote.com` alias를 확인했다. 라이브 `/pipeline`은 비로그인 307→login,
  summary/action API는 401이며 새 project/domain을 만들지 않았다.
- [x] 같은 시각 24시간 종료 검증은 도래한 6/48 슬롯, execution 6, receipt 36,
  R2 byte mismatch 0을 확인했다. Cloud Scheduler start/finish 6/6, Cloud Run
  success 6/6, receipt execution match 6/6도 PASS이며 전체 실패는 종료 전이므로
  `window_incomplete` 하나뿐이다.

확대 경계 체크포인트 H2 — exact 20공고 claim fence (2026-07-25):

- [x] 관제의 현재 `in_progress=599`는 main worker를 단순히 `observe_only→active`로
  바꾸면 계획한 첫 20공고가 아니라 기존 활성 backlog까지 claim할 수 있음을 뜻한다.
  따라서 48/48 gate 뒤에도 실행 범위를 별도 계약 없이 열지 않는다.
- [x] worker 정책에 `unconfigured | bounded | all` claim scope를 추가했다. active는
  `bounded` 또는 `all`이 아니면 Anthropic key 확인·enqueue·lease·budget 변경 전에
  fail-closed다. `bounded`는 1~100개의 유효한 UUID와 canonical 정렬 목록의 exact
  SHA-256이 모두 일치해야 하며, `all`은 cohort ID/hash가 섞이면 거부한다.
- [x] 이 경계는 표시용 env가 아니다. autonomous feeder의 enqueue 후보와 ledger의
  `FOR UPDATE SKIP LOCKED` claim SQL 양쪽을 같은 grant ID 집합으로 제한한다. 따라서
  과거 pending/retry_wait job과 새 source revision enqueue 모두 cohort 밖에서는
  유료 모델 실행으로 넘어갈 수 없다.
- [x] heartbeat에 claim scope/count/hash를 영속하고 ops 계약·건강도·UI에 노출했다.
  active heartbeat가 scope 미설정이거나 bounded count/hash가 불완전하면 worker
  건강도는 fail-closed다. `observe_only + unconfigured`는 현재 gate 대기 상태로
  허용한다.
- [x] `deep-analysis:plan-cohort` read-only 계획기를 추가했다. 공용 active predicate,
  current model policy의 최신 claimable job, 계획 우선순위, source round-robin을 적용한
  뒤 각 후보의 R2 실제 입력을 다시 봉인하고 current job source revision과 일치하는
  공고만 선택한다. DB/R2 write, LLM call, promotion, matcher write는 수행하지 않는다.
- [x] production read-only 리허설은 200후보를 검사해 sealed+current 20공고를
  만들었다. Bizinfo 9·K-Startup 11, HWP/HWPX 보유 15건이며, 미봉인 106건과
  source revision drift 1건은 제외됐다. cohort hash는
  `b539520370fd62e69c8e59ff1f0de78299fc9f5402b0fb84b06bd30b17138806`,
  rehearsal manifest hash는
  `7fc6ebeaca14d172ddb6bc873e92e30be7ee6f85933d6632a2c6c9fb896ae01d`다.
  이 리허설 목록은 활성화에 재사용하지 않는다. 48/48 PASS 직후 같은 계획기를 다시
  실행해 active/source/job/input freshness를 재검증하고 그때 생성된 exact ID/hash만
  bounded activation에 사용한다.
- [x] `deep-analysis:verify-cohort` read-only 종료 검증기를 추가했다. activation
  timestamp와 exact ID/hash를 필수로 받고, 20공고 active/current job, 현재 R2 입력
  재봉인, current job/run/input revision, S0~S11 전 단계, 정확히 22축, audit concur,
  공고별 `$2`·cohort `$40` 상한, activation 이후 cohort 밖 model-policy run 0을
  자동 교차 검증한다. 위반은 즉시 `FAIL`, 위반 없이 20건 미완료면 `IN_PROGRESS`,
  20/20 `analysis_complete`일 때만 `PASS`다.
- [x] 첫 production read-only 실행에서 Drizzle raw SQL에 JS 배열을 직접 넣으면
  `ARRAY[$1,…]`가 아니라 `($1,…)::text[]`로 렌더링되는 결함을 발견했다. verifier뿐
  아니라 아직 미배포 bounded claim과 기존 ID-filter current query도 같은 문제였으므로
  parameterized `ARRAY[...]::uuid[]` 공용 빌더로 수정했다. SQL renderer와 실제 claim
  문장 회귀 테스트가 tuple cast를 거부한다. main은 계속 `observe_only`여서 이 결함으로
  production claim이나 유료 호출이 실패한 적은 없다.
- [x] 수정 뒤 첫 연속 리허설은 후보 선정 직후 input preparation이 한 공고의 revision을
  바꾼 race를 `job_source_revision_stale`로 포착해 `FAIL`했다. 새 cohort를 즉시 다시
  산출한 두 번째 실행은 active/sealed 20/20, Bizinfo 8·K-Startup 12,
  HWP/HWPX 14, cohort 밖 run 0, 비용 0, terminal 0, pending 20,
  failure 0으로 정확히 `IN_PROGRESS`를 반환했다. activation 직전 재검증을 생략하거나
  stale 한 건을 허용하지 않는다.
- [ ] claim fence commit을 main worker의 `observe_only` 상태로 배포하고 수동·정시
  execution의 `claimScope=unconfigured`, claim/enqueue/비용 0을 확인한다. 동결된
  serving monitor image와 Scheduler는 변경하지 않는다. 배포 preflight에서 활성 설정은
  `sw@noten.im`·`changupnote-com`으로 정확했지만 저장 credential의 비대화형 refresh가
  재인증을 요구해 image build 전 중단했다. 별도 ADC는 세 Job의 `run.jobs.get` 권한도
  없어 사용하지 않았으며 Cloud resource 변경과 비용 발생은 0이다. 같은 계정의 gcloud
  credential이 갱신된 뒤에만 이어간다.
- [x] 같은 commit의 ops claim 필드는 exact clean archive로 기존
  `team-coolwithyou/changupnote-ops` deployment
  `dpl_2JUPFx4257ehjEVXGQZ45BPjmj4h`에 배포했다. 상태 Ready와 기존
  `ops.changupnote.com` alias, 비로그인 `/pipeline` 307→login,
  summary/action API 401을 확인했다. production verifier는 active 636 보존식,
  main `observe_only`·active worker/lease 0/0, input preparation healthy,
  serving monitor `checked=2/2`·fresh 2/2·failure/stale 0으로 PASS했다.
  아직 이전 worker heartbeat라 claim scope는 `null`이지만 observe mode에서는
  건강하며, 새 worker image 배포 뒤 `unconfigured` 명시값으로 다시 검증한다.

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
- [x] `/pipeline`이 최신 main과 ops production에 통합됨
- [x] active conservation equation 성립
- [ ] blocker·SLO·worker heartbeat alert 작동
- [ ] 동결 80공고 품질 기준 통과
- [ ] 2→20→전체 카나리 중단 조건 위반 0
- [ ] 활성 target `serving_complete + fresh` 100% 또는 명시 blocker

이 체크리스트가 끝나기 전에는 “HWP 변환이 된다”, “criterion이 몇 개 있다”,
“extraction_log가 labeled다”, “모델 API가 200이다” 중 어느 것도 딥분석 완료의
대체 증거로 사용하지 않는다.

### 14.14 검수 후 축소 실행 계획

2026-07-25 검수에서 한 번에 분석·서빙·관제·운영 자동화를 함께 확장한 것이
완료 조건을 흐린 원인으로 확인됐다. 이후 작업은 아래 규칙을 따른다.

- 한 단계는 하나의 불변식만 변경한다.
- 각 단계는 집중 테스트, 문서 체크, 단일 체크포인트 커밋으로 끝낸다.
- 앞 단계가 통과하고 작업 트리가 clean인 경우에만 다음 단계를 시작한다.
- 예상 범위가 DB migration, 새 worker, 새 UI까지 커지면 구현을 멈추고 이 문서의
  범위를 먼저 다시 검토한다.
- Phase I SLO 확장, 관제 UI 추가, retry jitter는 핵심 E2E가 닫힐 때까지 보류한다.
- production deploy, DB write, cohort 확대는 아래 로컬 게이트의 대체 증거가 아니다.

#### 축소 Step 1 — 활성화 이후 실행만 코호트 성과로 인정

범위:

- `runStartedAt < activatedAt`인 실행은 `analysis_complete` 성과로 인정하지 않는다.
- 활성화 이전 실행만 존재하는 공고는 PASS가 아니라 IN_PROGRESS 또는 FAIL이다.
- SQL 조회와 순수 evaluator가 같은 시간 경계를 사용한다.

완료 조건:

- [x] 활성화 이전 passed run 회귀 테스트가 실패를 검증
- [x] 활성화 시각과 같거나 이후인 passed run은 기존처럼 PASS
- [x] `verify:deep-analysis-contract` 통과
- [x] 체크포인트 커밋 후 worktree clean

#### 축소 Step 2A — S11 직전 source를 다시 검증

범위:

- 실행 시작 이후 source 또는 input이 변경되면 S11 완료를 거부한다.
- 현재 run을 stale로 끝내고 변경된 revision의 새 job을 enqueue한다.
- feeder 조회 조건이나 DB schema는 이 단계에서 변경하지 않는다.

완료 조건:

- [x] 분석 도중 source 변경 fixture가 S11 통과를 거부
- [x] 같은 fixture가 기존 run을 stale 처리하고 새 revision job을 enqueue
- [x] promotion 이전에 stale 결과가 차단됨
- [x] 집중 테스트와 계약 테스트 통과 후 별도 체크포인트 커밋

#### 축소 Step 2B — feeder source 관측과 job 운영 시각 분리

범위:

- claim/retry/complete가 바꾸는 `job.updated_at`을 source 변경 watermark로 사용하지 않는다.
- 동일 source revision의 반복 enqueue와 새 revision 누락을 모두 막는다.
- 별도 관측 상태나 migration이 필요하면 먼저 이 문서에서 schema와 rollback을 검토하고,
  Step 2A 커밋에 섞지 않는다.

고정 schema와 rollout:

- `grant_deep_analysis_jobs.source_observed_at timestamptz NULL` 한 컬럼만 추가한다.
- 값은 feeder가 실제로 조회한 grant/raw/archive/surface source 변경 시각의 최댓값이다.
- 같은 job identity가 이미 있으면 status·`updated_at`은 건드리지 않고
  `source_observed_at`만 단조 증가시킨다.
- 기존 NULL 행은 feeder의 기존 batch 제한 안에서 한 번씩 관측한 뒤 채운다.
- migration을 먼저 적용한 뒤 worker를 배포한다. 구버전 worker는 새 nullable 컬럼을
  사용하지 않으므로 migration 선적용과 호환된다.
- rollback은 새 worker를 먼저 되돌린 뒤
  `ALTER TABLE grant_deep_analysis_jobs DROP COLUMN source_observed_at`을 실행한다.

완료 조건:

- [x] claim 또는 complete 도중 source가 바뀐 fixture가 새 revision 후보로 남음
- [x] 내용이 같은 source 재수집은 무한 enqueue 후보가 되지 않음
- [x] 새 revision은 새 job identity로 enqueue
- [x] 집중 테스트와 계약 테스트 통과 후 별도 체크포인트 커밋

#### 축소 Step 3 — 정확한 코호트가 S14까지 닫혀야 확장 가능

범위:

- 코호트 manifest의 모든 grant가 S12~S14와 현재 serving hash를 만족해야 한다.
- publish되지 않은 grant도 누락되지 않고 명시 실패로 집계한다.
- 분석 완료 수와 serving 완료 수를 하나의 코호트 결과에 함께 기록한다.
- current run과 연결된 `active` release의 `applied` promotion item만 인정한다.
- 최신 S12~S14 receipt는 같은 release/item에 묶이고 serving verifier version·DB evidence
  hash·R2 artifact key를 가지며 45분 이내여야 한다.
- S12 after hash, S13 repository/trace hash, S14 source/input hash를 각각 fail-closed로
  검증한다.

완료 조건:

- [x] 20개 중 1개가 publish되지 않은 fixture가 FAIL
- [x] 20개 모두 `serving_complete + fresh`인 fixture만 PASS
- [x] 기존 2건 serving 검증 회귀 통과
- [x] 집중 테스트와 계약 테스트 통과 후 별도 체크포인트 커밋

#### 축소 Step 4 — 품질·운영 증거를 순서대로 닫기

이 단계는 새 기능 개발 단계가 아니다.

1. 동결 80공고 평가 artifact와 품질 기준 통과를 먼저 확정한다.
2. H2 claim fence의 production revision과 exact cohort scope를 확인한다.
3. 2건 카나리 24시간 48/48 slot 증거를 확정한다.
4. 위 세 증거가 모두 PASS일 때만 20건 확대 여부를 판단한다.

Step 4-1 증거 점검 체크포인트 — `STOP` (2026-07-25):

- 기존 동결 manifest pair는 무결성 검증을 통과했지만
  `validationCount=24 + sealedCount=16 = 40`이며, 이 문서가 요구하는 80공고가 아니다.
  기존 manifest hash는
  `ea25d5180880418de239f18001baf021ae585c4b146cc6142a090ecb31b80f95`다.
- 별도 `grant-analysis-llm-evaluation` worktree의 최신 증거도 3공고 Gate 2 smoke다.
  `gate2-byte-verified` checkpoint는 stage `failed=2, running=2`,
  후속 `gate2-condition-guidance-v2`는
  `success=4, skipped=1, failed=3, running=1`로 완결된 품질 평가가 아니다.
- 저장소와 현재 worktree artifact에서 80공고 manifest, 80공고 결과, 14.9.3의 기계 보증
  및 모델 품질 지표를 계산한 최종 report를 찾지 못했다. 따라서 precision, hard
  required/exclusion recall, HWP-only sentinel recall, wrong-hard rate,
  source-groundedness, catastrophic error를 통과로 판정할 수 없다.
- 판정은 `BLOCKED`다. H2 revision/cohort 확인, 24시간 카나리 증거 확인, 20건 확대는
  시작하지 않는다.

재개에 필요한 최소 증거:

1. [x] 14.9.1 층화를 만족하는 immutable 80공고 public/secret manifest pair
2. [ ] 공고별 sealed 공고+첨부 전문으로 현행 primary deep analysis를 실행하고,
   별도 allowlist 모델의 blind AI audit와 필요한 adjudication을 거쳐 최종 22축
   resolution 및 입력·출력 hash를 고정한 결과
3. [ ] 14.9.3의 기계 보증 10개와 모델 품질 지표 6개를 오류 절대 건수와 함께 계산한 report
4. [ ] 외부 호출 수·실패·재시도·비용을 포함한 실행 receipt

14.9.2의 HWP 포함/제외 및 기존 parser 비교는 첨부 효과를 측정하는 진단용 ablation이다.
과거 별도 worktree의 B/C/Judge 실험 경로를 운영 품질 실행의 주 파이프라인으로 재사용하지
않는다. 이 단계의 정본은 현행 `deep-analysis-model-policy-v3`의
`primary deep analysis -> blind AI audit -> conditional adjudication`이다.

Step 4-1A 80공고 동결 체크포인트 — `PASS` (2026-07-25):

- 기준 시각 `2026-07-25T00:00:00+09:00`, active canonical/duplicate-inclusive
  모집단 `1,519/1,519`를 read-only로 고정했다.
- K-Startup 40건 / BizInfo 40건, validation 48건 / sealed 32건이며 기존 복구 4공고를
  전부 포함한다. 이전 평가 12공고 중 현재 active인 6건은 제외했다.
- public manifest hash는
  `045b5738ed5c8205be6d21ad30179554808e3757f8f39d7347d6a8579a96c0c3`,
  selection commitment는
  `702143958f58209872d76aad7d4ee9f927640db27359232b1f6c66c9beaa04c1`다.
- 선택 결과는 HWP 44, HWPX 20, 다중 첨부 40, 복잡 문서 후보 29,
  첨부-only hard-condition sentinel 후보 15, exclusion 후보 20,
  sparse-condition 후보 19, 통합/하위사업 후보 8이다.
- 복잡 문서와 hard-condition/exclusion은 결과 label이 아니라 사전 선택용 구조 후보다.
  실제 14.9.1/14.9.3 충족 여부는 raw+첨부를 읽은 독립 audit/Judge 결과에서 다시
  확정해야 하며, 이 숫자만으로 품질 PASS를 선언하지 않는다.
- artifact는
  `tmp/deep-analysis-quality/2026-07-25/frozen-80/{public,secret}-manifest.json`에
  immutable write됐고 secret mode는 `0600`이다. 외부 LLM 호출 0, DB write 0이다.
- 집중 테스트, web typecheck, 전체 deep-analysis contract test, disk readback
  manifest pair 검증을 통과했다.

Step 4-1B 현행 입력·AI 검수 preflight 체크포인트 — `BLOCKED` (2026-07-25):

- 동결 80건을 과거 B/C 실험이 아니라 현행 운영 계약에 연결했다. 고정된 실행 계약은
  primary `claude-opus-4-8` / `deep-analysis-v2`, blind audit
  `claude-sonnet-5` / `deep-analysis-blind-audit-v1`, model policy
  `deep-analysis-model-policy-v3`다.
- 동결 시점 선택용 revision과 운영 deep-analysis source revision은 서로 다른
  알고리즘이므로 동일 hash로 간주하지 않는다. raw payload hash와 첨부 summary hash를
  다시 검증한 뒤 운영 `sourceRevisionSha256`, `attachmentManifestSha256`,
  `inputSha256`을 별도 production binding으로 연결한다.
- 운영 DB/R2 read-only preflight 결과 동결 스냅샷 일치 `79/80`, 현행 input sealed
  `23/80`, 실행 준비 완료 `22/80`, blocker `58/80`이다.
- 실행 불가 원인은 공고 기준 `blocked_fetch=48`, `blocked_conversion=9`,
  동결 후 attachment summary/selector revision 변경 `1`이다. 첨부 disposition
  기준으로는 원본 미확보 96개, 변환 전문 미확보 14개이며, 포함 가능한 전문은 52개다.
- 현재 실행 가능한 22건의 현행 경로는 mandatory logical model call 44회
  (primary 22 + independent audit 22), repair/adjudication까지 포함한 최대 logical
  call 154회다. 이는 실행 계획일 뿐 이번 checkpoint에서는 외부 LLM 호출 0,
  DB write 0, R2 write 0이며 `qualityVerdict=NOT_RUN`,
  `executionAuthorized=false`다.
- immutable redacted receipt는
  `tmp/deep-analysis-quality/2026-07-25/frozen-80-preflight/receipt.json`에 기록했다.
  sealed identity는 새 파일에 복제하지 않고 기존 0600 cohort secret의 opaque commitment로
  연결하며, receipt semantic hash는
  `1b29901c129cc5ab6e0e3824bf252cc96a70a82bd5bad9a6edd6466cf5837540`이다.
- 다음 checkpoint는 범위를 입력 복구로만 제한한다. `blocked_fetch` 48건의 원본
  archive와 `blocked_conversion` 9건의 검증된 전문을 복구하고, drift 1건은 동결
  manifest를 덮어쓰지 않은 채 exact historical bytes 사용 또는 새 commitment로
  명시적으로 재동결한다. 이후 새 output directory에서 80건 preflight를 다시 통과하기
  전에는 유료 깊은 분석·AI 자동 검수를 실행하지 않는다.

Step 4-1C frozen 입력 복구 체크포인트 — `BLOCKED`, 67/80 (2026-07-26):

- Step 4-1B의 exact attachment summary drift 판정은 archive URL·변환 상태까지 동결
  identity에 포함해, 정상적인 입력 준비가 전진할수록 cohort를 무효화하는 결함이 있었다.
  preflight v2는 이를 다음 두 상태로 분리한다.
  - `sourceContentMatched`: raw payload hash와 첨부 inventory의 선언 수·실재 수·파일명·
    source locator 존재 여부가 동결 시점과 같은지 검증하는 hard gate
  - `snapshotDriftCodes`: archive·conversion enrichment로 달라진 attachment summary와
    selector revision을 기록하되 source content가 같으면 실행을 차단하지 않는 관측값
- v2 복구 전 read-only preflight에서 source content는 `80/80`, 현행 input sealed와
  실행 준비는 `24/80`이었다. exact snapshot match `78/80`과 별개로 hard source drift는
  0건임을 확인했다. receipt hash는
  `e31f147329579510c7bd10828424a50c39cf98e3b76dc484044928ba9b58769e`다.
- frozen receipt에서 `production_input_not_sealed`인 정확한 항목만 선택하는 fail-closed
  복구 명령을 추가했다. 기본은 preview이며
  `--execute --confirm=RECOVER_DEEP_ANALYSIS_QUALITY_INPUTS`가 모두 있어야 DB/R2 쓰기를
  연다. 이 경로는 sealed input이 생겨도 analysis job을 enqueue하지 않는다.
- 최초 복구 시도에서 batch deadline이 진행 중인 무제한 원본 fetch를 취소하지 못하는
  경계를 발견했다. 15분을 넘긴 단일 실행을 중단했고 최종 receipt는 생성되지 않았다.
  성공한 archive/DB 쓰기는 멱등 보존했으며, 이후 모든 quality recovery 원본 요청에
  30초 timeout을 전달하도록 수정하고 회귀 테스트를 추가했다.
- 중단 직후 새 preflight는 sealed `41/80`, blocker `39/80`이었다. timeout을 적용한
  bounded 3-round 재실행은 이 39건 중 26건을 추가 봉인하고 13건을 명시적으로 남겼다.
  recovery receipt는
  `tmp/deep-analysis-quality/2026-07-26/frozen-80-input-recovery/receipt.json`,
  hash는 `ba2a364fad0acdb922fd40a242ae4ebbd1cc221c7eb3e0b40c6d078287edbe01`다.
- 최종 80건 read-only preflight 결과:
  - source content match `80/80`
  - current input sealed / ready for execution `67/80`
  - grant blocker `13/80`: `blocked_conversion=11`, `blocked_fetch=2`
  - attachment disposition blocker: conversion 전문 미확보 13개, 원본 미확보 2개
  - 포함 가능한 전문 145개, total evidence chars 1,623,249
  - exact snapshot match `29/80`, preparation enrichment drift `51/80`
  - external LLM call 0, analysis job enqueue 0
- 최종 preflight receipt는
  `tmp/deep-analysis-quality/2026-07-26/frozen-80-preflight-after-recovery/receipt.json`,
  hash는 `585a19568996fb88156106ccfa45aaf7db7b6301748153f73f3fb155743f899c`다.
- 결론은 여전히 `BLOCKED`다. 다음 checkpoint는 위 13건의 변환 11건과 fetch 2건만
  다룬다. 새 preflight가 source content `80/80`과 ready `80/80`을 동시에 통과하기
  전에는 primary deep analysis·blind AI audit·conditional adjudication을 실행하지 않는다.

Step 4-1D 잔여 구조·PDF 입력 복구 체크포인트 — `BLOCKED`, 79/80 (2026-07-26):

- Step 4-1C의 정확한 13건을 새 read-only preflight로 다시 고정했다. source content는
  `80/80`, ready는 `67/80`, blocker는 변환 11건·fetch 2건이었고 receipt hash는
  `16c0c80f07368acde0593c2e0baf5a6d5bc35b7324bdeec78b1f5c304521a115`다.
  이 시점에도 외부 LLM 호출·analysis job enqueue·DB/R2 write는 모두 0이었다.
- pending surface 6개를 기존 변환 cache와 bounded poll로 재조정한 뒤 ready는 `70/80`으로
  전진했다. 새 blocker는 구조 문서·이미지·PDF 10건이며 receipt는
  `tmp/deep-analysis-quality/2026-07-26/frozen-80-preflight-after-long-conversion-poll/receipt.json`,
  hash는 `fc4cb96e57e0e3486764d21db34cd5a1597b211d395606052241dc3a82a71736`다.
- 일반 운영 기본값을 넓히지 않고 frozen recovery의 명시적 옵션에서만 이미 archive된
  HWP/HWPX/TXT/ZIP/XLSX/PPTX와 이미지를 전문 부재 시 재처리하도록 했다. ZIP child
  지원 포맷에 XLSX/PPTX를 추가하고, quality recovery의 entry 상한만 20으로 올려
  실제 18-entry ZIP도 전부 검증한다. 이 실행은 정확한 10건 중 5건을 추가 봉인했고
  5건의 PDF를 남긴 `PARTIAL`이다. receipt는
  `tmp/deep-analysis-quality/2026-07-26/frozen-80-input-recovery-remaining-10/receipt.json`,
  hash는 `bb3410f2776e786e366180f89934f5f0175a51739413c24cf36d6e6048091790`다.
- ZIP 복구 뒤 생성된 `부모명__NN__자식명`이 source inventory 증가로 오인되어 2건의
  false drift를 만들었다. source-content v2는 동일 inventory 안의 실제 ZIP parent와
  생성 규칙이 일치하는 child만 source identity에서 제외한다. 원 raw payload와 새
  최상위 첨부는 계속 hard gate다. 회귀 테스트 뒤 source content `80/80`, ready
  `75/80`, PDF blocker `5/80`을 확인했다. receipt는
  `tmp/deep-analysis-quality/2026-07-26/frozen-80-preflight-after-container-identity-fix/receipt.json`,
  hash는 `fd2ea5b89a439b7fa1479ec2ece59d2d5014ffa3de1c25d4ae98cbf287a735b0`다.
- PDF 5개는 frozen preflight가 지목한 5개 surface만 받는 별도 fail-closed 경로로
  복구했다. PDF/page-image SHA readback, 페이지 완전성, OCR 페이지별 최소 신뢰도
  `0.6`, 최소 텍스트 길이를 모두 통과한 뒤에만 content-addressed markdown artifact를
  기록한다. 1개 556쪽 문서는 `pdftotext -layout`으로 676,253자를 직접 추출했고,
  나머지 4개 이미지 PDF(총 6쪽)는 macOS Vision OCR로 복구했다. OCR 평균 신뢰도는
  약 0.70~0.84다. 결과는 `5/5 COMPLETE`, 실패 0이며 receipt는
  `tmp/deep-analysis-quality/2026-07-26/frozen-80-pdf-text-ocr-recovery/receipt.json`,
  hash는 `e78fb15459c74ddb29c51333c5983a9d5defba7393e2d81de72898dbef67b1ec`다.
  macOS Vision은 이 frozen quality input 복구에만 사용한 로컬 provider이며,
  지속 가능한 production OCR provider가 배포됐다는 뜻은 아니다.
- 최종 read-only preflight는 첨부 fetch/conversion blocker를 0으로 만들었지만 ready
  `79/80`에서 fail-closed 됐다. 남은 한 건은 556쪽 전문까지 포함한 총 입력
  `1,136,482`자가 현행 운영 상한 `800,000`자를 넘는 `blocked_cap`이다. 전체 결과는
  source content `80/80`, current sealed/ready `79/80`, attachment included 169,
  external LLM call 0, analysis job enqueue 0이다. receipt는
  `tmp/deep-analysis-quality/2026-07-26/frozen-80-preflight-after-pdf-text-ocr-recovery/receipt.json`,
  hash는 `a78d2ad9342e7abe17c08954e8268aeeacfe4fc12224b80ce32dd61eaee58cdd`다.
- 다음 checkpoint의 범위는 이 exact 1건의 장문 정책뿐이다. 현재 analyzer는 22개
  chunk map+synthesis로 전문을 처리할 수 있지만, 입력 상한만 올리면 primary+blind
  audit 호출 수와 공고별 `$2` 비용 상한이 불일치한다. 문서를 임의 절단·면제하거나
  상한만 올리지 말고, 장문 실행 계약과 사전 비용 gate를 함께 결정한 뒤 새 preflight
  `80/80`을 만들어야 한다. 그 전에는 primary deep analysis와 AI 자동 검수를 실행하지
  않는다.

Step 4-1E-1 통합공고 사람 승인 경계 체크포인트 — `PASS`, 전체는 `BLOCKED`
(2026-07-26):

- `blocked_cap`이라고 해서 모든 장문 공고를 분리하지 않는다. 다른 입력 blocker 없이
  상한만 초과했고 제목이 통합공고임을 명시한 경우에만
  `oversized_aggregate_notice` 케이스를 만든다. 장문 단일사업 공고와 원문 복구가 덜 된
  공고는 이 경로에 들어오지 않는다.
- 알려진 exact 사례
  `2026년 중앙부처 및 지자체 창업지원사업 통합공고`
  (`1,136,482/800,000`자, 입력 chunk 22개)를 회귀 fixture로 추가했다.
- `grant_aggregate_split_cases`는 `(grant_id, source_revision_sha256)`당 한 행만 만들고,
  입력 크기·상한·chunk/첨부 수·감지 evidence hash를 보존한다. detector 재실행은 이미
  승인된 상태를 검토 대기로 되돌리지 않는다.
- production feeder와 processor는 각각 enqueue/모델 호출 전에 이 케이스를 멱등
  등록한다. 일반 공고의 처리 경로와 80만 자 상한은 바꾸지 않았다.
- Ops 공고 상세에는 `통합공고 분리 필요` 경고와 입력/상한/chunk 증거를 표시한다.
  `admin/owner`만 `분리 처리 수락`을 실행할 수 있고, 같은 request ID는 멱등 처리된다.
  승인 시 case가 `pending_review -> approved`로 이동하고 actor·시각·원문 revision·
  입력 크기는 기존 append-only `admin_deep_analysis_actions` 감사 원장에 남는다.
  최신 job의 원문 revision과 다른 오래된 케이스 승인은 fail-closed로 거부한다.
- 이 체크포인트의 `approved`는 **별도 분리 worker 대기**를 뜻한다. 아직 하위 공고를
  만들거나 parent 공고를 매칭에서 제외하거나 딥분석 job을 enqueue하지 않는다. 따라서
  이 단계만으로 80번째 공고가 ready가 된 것으로 계산하지 않는다.
- schema migration은 코드로 생성했지만 이 체크포인트에서는 production DB 적용, 앱
  배포, 외부 LLM 호출, 하위 공고 생성, 딥분석 job enqueue를 하지 않는다.

Step 4-1E-2 승인 케이스 분리 manifest 체크포인트 — `PASS`, 전체는 `BLOCKED`
(2026-07-26):

- 별도 worker는 `approved` 또는 lease가 만료된 `processing` case 하나만
  `FOR UPDATE SKIP LOCKED`로 claim한다. DB claim/lease 갱신은 짧게 끝내고 R2·LLM
  호출을 트랜잭션 안에서 수행하지 않는다. 기본 실행 수는 invocation당 1건, 최대
  attempt는 3회이며 retry는 `approved + available_at`으로 되돌린다.
- server가 봉인된 전체 입력을 source별로 다시 조립하고 chunk offset·text SHA를 검증한
  뒤, 최대 6,000자의 content-addressed segment로 무손실 분할한다. 모델은 offset이나
  원문을 새로 만들지 않고 제공된 segment ID만 `program/shared/navigation`으로 분류한다.
- allowlist의 최상급 primary model `claude-opus-4-8`이 segment map과 pass 간 하위사업
  synthesis를 수행한다. 독립 server validator는 모든 segment와 provisional program이
  정확히 한 번 귀속됐는지, 하위사업이 2~300개인지, 중복 사업 identity가 없는지,
  shared를 포함한 각 파생 입력이 기존 800,000자 상한 이하인지 검증한다.
- 승인 case에는 누적 비용 상한 `$12`를 고정한다. worker 환경 상한은 사람 승인 상한을
  높일 수 없고, 보수적인 최대 비용 추정이 남은 상한보다 크면 외부 호출 전에
  fail-closed한다. 모델·prompt version·외부 호출 수·token·실비·attempt·lease·오류를
  case 원장에 누적한다.
- 원문 입력, 모델 raw pass, 검증 완료 manifest는 각각 내용 SHA가 들어간 R2 key로 쓰고
  즉시 readback hash를 검증한다. DB의 `completed`는 input/raw/manifest key와 SHA,
  program/segment 수, 실제 외부 호출 증거가 모두 있을 때만 허용된다. 중간 pass 뒤
  실패한 경우도 성공한 pass와 오류를 별도 불변 raw artifact로 남긴 뒤 retry/failed로
  전환한다.
- Ops 공고 상세에는 대기/처리/완료/실패, attempt, worker lease, 승인 비용 상한,
  input/manifest/raw hash와 key, model/prompt, segment/program, 호출/token/비용을
  단계별로 표시한다. `completed`는 아직 **검증된 분리안 생성 완료**만 뜻하며 파생
  공고 생성 또는 매칭 노출 완료로 표시하지 않는다.
- 회귀 검증은 `verify:aggregate-split`, 기존 `verify:deep-analysis-contract`,
  `verify:db-migrations`, Ops deep pipeline 계약 테스트, web/admin typecheck와 package
  runtime freshness까지 통과했다.
- 이 체크포인트에서는 production DB migration 적용, worker 실행, 외부 LLM 호출,
  R2 쓰기, 앱 배포, 파생 공고 생성, 딥분석 job enqueue, parent 매칭 제외를 하지 않았다.

Step 4-1E-3A 파생 공고 입력 준비 체크포인트 — `PASS`, 전체는 `BLOCKED`
(2026-07-26):

- E-2 `completed` case만 받는 별도 materialization queue를 만들었다. pending 또는
  만료 lease 한 건을 짧은 `FOR UPDATE SKIP LOCKED` 문장으로 claim하고, R2 read/write는
  DB transaction 밖에서 수행한다. 기본 invocation은 1건, 최대 attempt는 3회다.
- 소비 시점에 E-2 input/manifest를 R2에서 다시 읽고 DB SHA와 readback SHA를 대조한다.
  input chunk의 ID·offset·text SHA·전체 문자 수·attachment manifest SHA와 manifest의
  segment ID·offset·text SHA·전문 coverage·program/shared/navigation 정확히 한 번
  귀속·stable program key·하위사업 수·입력 상한을 server가 다시 계산한다.
- 파생 후보의 source와 공고 메타데이터는 현재 `grants` 행이 아니라 E-2 input 안에
  봉인된 `deep-analysis-structured-source-v1` 스냅샷에서만 가져온다. 따라서 E-2와
  E-3A 사이에 parent가 갱신돼도 옛 원문과 새 메타데이터가 섞이지 않는다.
- 아직 실제 `grants` 행을 만들지 않고 별도 `grant_aggregate_split_children` 원장에
  미노출 후보를 기록한다. `(case, stable key)`, `(case, ordinal)`, `(source, sourceId)`
  identity는 유일하며 후보 UUID는 다음 승격에서 실제 `grants.id`로 재사용한다.
  sourceId는 parent sourceId·승인 revision·stable program key로 결정한다.
- 각 후보는 program 소유 segment와 shared segment만 포함하고 navigation segment는
  제외한다. 후보 raw payload, grant projection, source revision, attachment manifest,
  전체 input artifact를 내용 hash로 봉인하고 R2 write 뒤 readback을 검증한다.
  미래 E-3B가 projection/raw를 그대로 승격하면 기존 `prepareDeepAnalysisInput`이 같은
  source revision과 input SHA를 재생성할 수 있는 계약이다.
- 후보별 `pending/prepared/failed`, input SHA/key/문자 수/source revision/error를
  독립 보존한다. 일부만 성공하면 성공 후보를 되돌리지 않고 case의 준비 수와 실패
  evidence를 남겨 재시도한다. identity·개수 불일치는 재시도로 덮지 않고 fail-closed한다.
  마지막 허용 attempt의 worker lease가 만료된 case는 `processing`에 고착시키지 않고
  별도 오류 evidence와 함께 `failed`로 회수한다. case는 검증된 모든 program 후보가
  `prepared`일 때만 `prepared`가 된다.
- DB CHECK는 완료 case와 materialization 상태·lease·attempt·준비 수의 일관성을
  강제한다. 기존 E-2 완료 CHECK의 SHA 조건도 명시적 `IS NOT NULL`을 추가해 PostgreSQL
  `NULL` 통과 가능성을 닫았다. 기존 완료 case는 migration에서 `pending`으로 backfill한다.
- Ops 공고 상세에는 materialization 대기/처리/준비/실패, lease, attempt, 준비 수와
  후보별 제목·기관·sourceId·input SHA/R2 key/source revision/error를 표시한다.
  화면은 이 상태가 아직 실제 공고 생성·딥분석 enqueue·매칭 노출이 아님을 명시한다.
- 회귀 검증은 `verify:aggregate-split`, 기존 `verify:deep-analysis-contract`,
  `verify:db-migrations`, Ops deep pipeline 계약 테스트, web/admin typecheck와 package
  runtime freshness를 대상으로 한다.
- 이 체크포인트에서는 production DB migration 적용, materialization worker 실행,
  R2 쓰기, 외부 LLM 호출, 앱 배포, 실제 파생 `grants/grant_raw` 생성, 딥분석 job
  enqueue, parent 매칭 제외를 하지 않았다.

Step 4-1E-3B-1 staged serving visibility 체크포인트 — `PASS`, 전체는 `BLOCKED`
(2026-07-26):

- `grants.status`는 source revision에 포함되므로 pipeline 상태를 숨기는 용도로 바꾸지
  않는다. 별도 enum `grant_serving_state = visible | staged | suppressed`를 추가했고
  기존·일반 수집 공고는 migration default `visible`을 유지한다. 따라서 staged 분석과
  최종 노출 전환은 공고 원문 revision을 불필요하게 stale로 만들지 않는다.
- 일반 사용자가 소비하는 DB 경로는 하나의 `grantServingVisiblePredicate()`를 사용한다.
  main matcher의 active candidate와 dedup hydration, 일반 공고 상세 조회, 랜딩 전체/source
  집계와 active banner, 공개 캘린더, 공고 아카이브 결과와 기관 자동완성에서
  `serving_state = visible`만 허용한다. 기존 `match_state`의 due transition 조회도
  grants와 join해 staged/suppressed parent의 stale 행이 전환 이벤트를 만들지 못하게 한다.
- active 딥분석 모집단 함수 `cunote_active_deep_analysis_grants`도 같은 visible 조건으로
  교체한다. TypeScript 제품 계약 `isGrantActiveForDeepAnalysis` 역시 serving state를
  필수 입력으로 받고 staged/suppressed를 날짜·공고 status와 무관하게 제외한다. 이전
  날짜-only evidence와 혼동하지 않도록 active policy version을
  `deep-analysis-active-kst-v2`로 올렸다.
- 명시적 내부 `listGrantsByIds`와 `prepareDeepAnalysisInput`에는 visible predicate를
  넣지 않는다. 다음 단계가 staged child를 ID로 검증·분석할 수 있어야 하며, 일반
  matcher/serving caller는 이 우회 인터페이스를 사용하지 않는다.
- `(serving_state, status, apply_end)` index를 추가해 visible+활성 status+마감일 조회가
  새 상태 필터 때문에 전체 scan으로 후퇴하지 않게 했다. grants의 기존 RLS는 유지한다.
- 회귀 guard는 shared predicate의 SQL parameter, matcher candidate+dedup hydration+
  상세 조회, 랜딩·캘린더·아카이브 적용, active DB 함수, 내부 ID/입력 준비 우회를
  구분하고 stale `match_state` transition 차단도 검증한다. `verify:aggregate-split`,
  기존 깊은 분석·AI 자동 검수 계약,
  migration, web/admin typecheck, package runtime freshness와 관련 화면 로직 검증을
  통과했다.
- 현재 로컬 DB에는 0062 migration을 적용하지 않았다. 랜딩 검증의 DB query는 새 컬럼
  부재로 실패한 뒤 development fallback fixture로 통과했으므로 live DB 증거로 세지
  않는다. 이 체크포인트에서는 DB migration 적용, 실제 serving state 변경, 파생
  `grants/grant_raw` 생성, 딥분석 enqueue, R2/외부 LLM 호출, 앱 배포를 하지 않았다.

Step 4-1E-3B-2 staged child 승격·깊은 분석 연결 체크포인트 — `PASS`, 전체는
`BLOCKED` (2026-07-26):

- E-3B 전용으로 E-2/E-3A 문서를 다시 해석하는 별도 파서를 만들지 않았다. 기존
  `loadValidatedAggregateSplitBundle`로 parent input/manifest를 다시 검증하고,
  `buildAggregateSplitChildDrafts`와 `sealAggregateSplitChildInput`으로 child의
  projection/raw/source revision/input artifact를 재생성한다. DB child projection과 R2
  readback은 이 재생성 결과와 hash·byte 단위로 같아야만 승격할 수 있다.
- 모든 prepared child는 case row와 parent를 lock한 하나의 짧은 transaction에서 동일
  UUID의 `grants(serving_state=staged)`와 `grant_raw(status=published)`로 멱등
  insert한다. R2 read는 transaction 전에 끝내며, child count·ordinal·sealed identity,
  parent `visible`, grants/grant_raw exact readback 중 하나라도 다르면 transaction 전체가
  rollback된다.
- commit 뒤 각 child는 `deep-analysis-model-policy-v3`의 기존 queue identity
  `(grant, sealed source revision, model policy)`로 직접 enqueue된다. 일반 active feeder가
  staged를 제외하는 것은 유지하며, 우회 이유
  `aggregate_split_staged_direct_enqueue`, job ID, enqueue 시각을 case/child 원장에
  보존한다. 따라서 이후 실행은 새 분석 경로가 아니라 기존 최상급 모델 → validator →
  독립 AI 자동검수/repair → publication pipeline을 그대로 탄다.
- case에는 `pending/staged/enqueued/failed`, staged/enqueued exact count와 완료 시각,
  마지막 오류를 기록한다. child에는 staged grant 생성 시각, job identity, enqueue 시각,
  우회 이유와 승격 오류를 기록한다. DB CHECK는 materialization readiness, count,
  staged/enqueued 시각, 우회 이유와 job FK의 일관성을 강제한다.
- Ops 공고 상세은 child별 `serving_state`, job/run 상태, 최신 S0~S14 receipt,
  passed stage 수, S11 분석 완료 상태, 독립 AI audit verdict와 승격/enqueue 오류를
  표시한다. parent는 계속 `visible`, child는 `staged`이며 이 화면의 enqueue 증거를
  실제 모델 처리 완료 증거로 오인하지 않는다.
- active worker가 `DEEP_ANALYSIS_CLAIM_SCOPE=bounded`이면 새 child UUID가 해당 cohort에
  포함되기 전에는 job이 pending일 수 있다. E-3B-2는 안전장치를 우회해 claim scope를
  넓히지 않았고, Ops의 기존 worker claim scope와 child job/receipt를 함께 보게 했다.
- 회귀 검증은 `verify:aggregate-split`, `verify:deep-analysis-contract`,
  `verify:db-migrations`, Ops deep pipeline 계약 테스트, web/admin typecheck와 package
  runtime freshness를 통과했다.
- migration `0063_little_krista_starr.sql`은 생성했지만 적용하지 않았다. 이
  체크포인트에서는 production DB migration, R2/외부 LLM 호출, staged child 실제 생성,
  job enqueue, worker 실행, parent/child 노출 전환, 앱 배포를 하지 않았다.

Step 4-1E-3B-3A staged publication gate·S12 체크포인트 — `PASS`, 전체는
`BLOCKED` (2026-07-26):

- 통합공고 release 준비는 `--aggregate-split-case=<case UUID>`로만 연다. case의 전체
  child를 DB 원장에서 다시 수집해 completed/prepared/enqueued exact count와 parent
  `visible`을 먼저 확인한다. 통합공고 child UUID를 일반 `--run` CSV에 넣어 일부만
  release하는 우회는 명시적으로 거부한다.
- 각 child는 prepared/staged 상태, child 원장 job ID와 실제 job/grant/source revision,
  `deep-analysis-model-policy-v3`, job `succeeded`, 그 job의 latest run identity와
  sealed input/source hash, run `passed`를 순서대로 확인한다. latest receipt의 S0~S11
  12단계가 전부 `passed`이고 latest AI audit가 같은 input hash에 `concur`여야 한다.
  하나라도 다르면 case release manifest와 원장을 만들지 않는다.
- gate를 통과해도 새 발행 구현을 만들지 않는다. 기존 deep-analysis release 준비가
  current source/input을 `prepareDeepAnalysisInput`으로 다시 봉인하고, normalized output,
  audit/R2 source artifact, 현재 promotion baseline을 검증한 뒤 기존 immutable manifest와
  `analysis_lab_promotion_releases/items`를 만든다. release `gate_summary`에는 case,
  parent, 전체 child/run/source/input identity를 남긴다.
- 실제 criteria/question 쓰기는 기존 승인·카나리·manifest hash·baseline drift·per-grant
  transaction 경로만 사용한다. 일부 item 적용 실패가 있어도 child는 계속 `staged`라
  사용자에게 노출되지 않으며, case 전체 S12가 닫히기 전 노출 전환 조건을 만족하지
  않는다.
- serving verifier에 `--publication-only`를 추가했다. 이 모드는 applied promotion
  snapshot을 다시 읽어 S12 `publication_complete`만 append하고 의도적으로 S13/S14를
  만들지 않는다. full verifier는 이제 grant `serving_state=visible`을 명시 검증하므로
  staged child를 내부 ID로 읽었다는 이유만으로 S13을 잘못 `passed` 처리할 수 없다.
  정기 active monitor도 아직 visible이 아닌 release는 receipt를 만들지 않고 skip해,
  의도된 staged 대기 구간을 S13 실패로 오염시키지 않는다.
- Ops 통합공고 child 행은 exact job/run/source/input/model policy, 최신 S0~S11 상태,
  AI audit input/verdict, 같은 run의 promotion item과 S12 receipt를 같은 공유 gate
  계약으로 평가한다. child별 첫 blocker와 release/item/S12 상태, case S12 완료 수를
  표시하며 하나라도 blocker가 있으면 전체 노출 전환 금지를 안내한다.
- 회귀 검증은 `verify:aggregate-split`, `verify:deep-analysis-contract`,
  `verify:db-migrations`, Ops deep pipeline 계약 테스트, web/admin typecheck와 package
  runtime freshness를 통과했다.
- 이 체크포인트는 새 DB 컬럼·migration을 만들지 않았다. production migration/deploy,
  실제 staged child 생성·worker/외부 LLM 실행, release 준비·승인·적용, R2 receipt 쓰기,
  parent/child 노출 전환은 실행하지 않았다.

Step 4-1E-3B-3B 원자적 노출 전환·S13/S14 체크포인트 — `PASS`, 전체는
`BLOCKED` (2026-07-26):

- `deep-analysis:aggregate-split-expose`는 case UUID와 actor를 명시하고
  `AGGREGATE_SPLIT_EXPOSURE_EXECUTE=1` 또는 `--execute`까지 준 경우에만 실행된다.
  completed/prepared/enqueued exact count, active release, E-3B-3A case gate summary,
  immutable manifest의 전체 child 집합, applied item과 sealed run identity, 같은
  release/item의 최신 S12를 전부 다시 확인한다.
- E-3B-3A 검수 중 확인한 연결 결함도 함께 닫았다. 일반 release 승인기가 준비 단계의
  `gate_summary`를 승인 artifact hash 세 개로 덮어쓰고 있었으므로, 이제 기존 case/child
  PASS 증적을 보존한 채 승인 hash를 병합한다. 이 보존이 없으면 정상적으로 승인·적용된
  통합공고 release도 최종 노출 gate에서 거부된다.
- case와 parent/전체 child grant를 잠근 짧은 transaction에서 parent
  `visible → suppressed`, 모든 child `staged → visible`, case
  `not_ready|rolled_back → verifying`을 CAS로 한꺼번에 바꾼다. lock/statement timeout을
  제한하고 R2 read와 서빙 검증은 DB lock 밖에서 실행한다. commit 뒤 중단된
  `verifying` case는 같은 release identity와 visibility가 유지되는 경우 재실행해
  검증을 이어갈 수 있다.
- 새 서빙 판정기를 만들지 않았다. 기존 full serving verifier를 import 가능한 seam으로
  열어 전체 release에 S13 `serving_complete`와 S14 `analysis_fresh` readback을 수행한다.
  모든 child의 최신 receipt가 같은 release/item에 묶인 `passed`일 때만 두 번째 짧은
  transaction이 case를 `visible`로 확정하고 `serving_verified_at`을 기록한다.
- 검증 실패뿐 아니라 최종 확정 실패도 parent `visible`·전체 child `staged`로 한
  transaction에서 즉시 원복한다. case는 `rolled_back`, exposed count 0, rollback 시각과
  오류를 기록하고, 모든 child에 최신 attempt의 S13 `failed`와 S14 `blocked` receipt를
  append해 먼저 성공한 일부 child도 사용자 노출 완료로 오인되지 않게 한다.
- migration `0064_polite_monster_badoon.sql`은 exposure
  `not_ready/verifying/visible/rolled_back`, release/actor/count, visible·verified·rollback
  시각과 오류 필드를 추가한다. DB CHECK는 각 상태에서 허용되는 증적 조합을 강제한다.
- Ops 상세은 parent뿐 아니라 visible child로 열어도 같은 case와 전체 sibling을
  조회한다. case exposure 상태·시각·오류와 child별 S12/S13/S14, 첫 blocker를 표시하며,
  전환 완료 뒤에도 “미노출”로 보이던 이전 단계 문구는 제거했다. catalog verifier는 새
  9개 컬럼의 실제 존재도 확인한다.
- 회귀 검증은 `verify:aggregate-split`, `verify:deep-analysis-contract`,
  `verify:db-migrations`, Ops deep pipeline 계약 테스트, promotion release gate 보존
  테스트, web/admin typecheck와 package runtime freshness를 통과했다.
- migration `0064_polite_monster_badoon.sql`은 생성했지만 적용하지 않았다. 이
  체크포인트에서는 production DB migration/deploy, 실제 staged child 생성,
  worker/외부 LLM 실행, release 준비·승인·적용, R2 receipt 쓰기, parent/child 실제
  노출 전환을 실행하지 않았다.

Step 4-1P-1 제한 production 진입 체크포인트 — `PASS`, 전체는 `BLOCKED`
(2026-07-26):

- production DB의 실제 선행 상태를 읽기 전용으로 확인한 결과 최신 migration은
  `0056_deep_analysis_ops`였고, `0057_deep_analysis_source_observation`이
  `0058~0064`보다 먼저 필요한 정확한 첫 blocker였다. `pnpm db:migrate`로
  `0057~0064`를 순서대로 적용했고, 적용 뒤 migration catalog, aggregate split
  case/child와 `grants.serving_state`, case exposure 컬럼, FK/RLS를 다시 확인했다.
  `verify:deep-analysis-ledger`와 `verify:deep-analysis-ops`도 production DB에 대해
  통과했다.
- web production은 feeder SQL hotfix를 포함한 clean/pushed `c5a8ecd`를
  `noten/changupnote`에 배포했다. deployment
  `dpl_HZnhScgJ4Nv7HvVquy3hJjZWKXTs`는 READY이며 `changupnote.com`과
  `www.changupnote.com`이 모두 200을 반환했다. 배포 인증은 저장소
  `.env.vercel.local`의 token을 shell에만 주입했고 project/domain/env를 새로 만들거나
  바꾸지 않았다.
- Ops production은 aggregate split 승인·관제·노출 증적 구현을 포함한 clean/pushed
  `de52eec`를 기존 `team-coolwithyou/changupnote-ops`에 배포했다. deployment
  `dpl_323jM5vUrCHcwqmJNYMA5QMNNY1Z`는 READY이며 `ops.changupnote.com/pipeline`의
  login redirect, login 200, 비인증 summary/action API 401을 확인했다.
- 승인 대상은 `kstartup/175783`, parent grant
  `1e7f6fd6-7c58-4a53-bbf9-25c87b3eb676`,
  `2026년 중앙부처 및 지자체 창업지원사업 통합공고` 한 건으로 고정했다. enqueue job
  `9b52f594-98a6-4d82-a46e-e755b8f9dc7e`를 UUID 하나짜리 bounded cohort로 실행했다.
- 첫 실행은 모델 호출 전에 active feeder candidate projection의 바깥
  `grants.id/source/source_id/updated_at`가 qualify되지 않아 PostgreSQL
  `column reference "id" is ambiguous`로 중단됐다. 이 범위만
  `c5a8ecd`에서 qualify하고 pending/source-change SQL 회귀 테스트, 전체
  `verify:deep-analysis-contract`, web typecheck를 통과시킨 뒤 위 web revision을 다시
  배포했다.
- 재실행은 외부 모델을 호출하지 않고 의도한 oversized aggregate gate에서 닫혔다.
  case `daa12917-6c8b-4f3a-ae5f-6d4c7fe5c163`은 `pending_review`,
  `oversized_aggregate_notice`, 입력 1,136,482자/상한 800,000자, chunk 22개,
  attachment 3개다. parent job은 `blocked/input_not_sealed`, case의
  `external_calls_made`, token, 비용, 승인 request/시각은 모두 null이고 비용 증거가
  있는 run은 0건이다. materialization/promotion/exposure도 모두 `not_ready`다.
- 이 상태는 556쪽 통합공고를 일반 22축 단일 공고로 억지 분석하지 않고, 사람 승인
  전에는 비용·파생 공고·노출을 발생시키지 않는 설계와 일치한다. 다음 mutation은
  Ops의 `admin/owner`가 실제 `분리 처리 수락` 액션을 수행해 append-only
  `admin_deep_analysis_actions`와 승인자 identity를 남기는 것이다. 이후 실제
  `sw@noten.im` Ops 관리자 세션에서 확인 모달의 대상·입력 크기·비용 상한과
  “승인만으로 발행·노출되지 않는다”는 결과를 확인하고 수락했다. case는
  `approved`, approval request
  `ebbe7c31-2552-4eb5-ad52-7101bc96ec05`가 됐고 같은 request/actor의
  `approve_aggregate_split/succeeded` append-only action을 DB에서 교차 확인했다.
  DB 직접 수정이나 임의 관리자 identity로 이 관문을 우회하지 않았다.
- GCP CLI의 active account/project 기본값은 `sw@noten.im` /
  `changupnote-com`, region은 `asia-northeast3`로 확인했다. `sw@ba-ton.kr`는
  비활성 저장 credential일 뿐 이 실행에서 사용하지 않았다. 다만 현재 access token
  refresh가 비대화형 재인증을 요구해 Cloud Run의 live revision·billing과 최신 verifier
  배포는 확인/실행하지 못했다. 따라서 사람 승인이 끝나더라도 최신 staged-skip/full
  visibility verifier를 배포하기 전에는 release 활성화와 E-3B-3B 노출 전환을 금지한다.

현재 Step 4-1 전체 판정은 여전히 `BLOCKED`다. staged child의 실제 깊은 분석·AI 자동
검수·S12 발행과 parent/child 원자적 노출 전환 및 S13/S14 production readback 증거를
실제로 닫기 전에는 H2 revision/cohort 확인과 24시간 카나리 단계로 넘어가지 않는다.
Step 4-1P-1 시점의 다음 체크포인트는 새 기능 추가가 아니라 위 단일 case를 Ops에서
사람 승인한 뒤
E-2 → E-3A → E-3B-2 → child 깊은 분석·AI 자동 검수 → E-3B-3A까지 실행하는
제한 production 운영 검증이다. 그동안 GCP 재인증과 최신 verifier 배포를 독립적으로
닫고, 두 의존성이 모두 통과한 뒤에만 E-3B-3B와 S13/S14 production readback을 실행한다.

Step 4-1P-2 통합공고 실분리 preflight 체크포인트 — `BLOCKED`
(2026-07-26):

- 위 승인 case에 E-2 worker를 두 번만 실행했다. 첫 attempt는 Opus 외부 호출 1회,
  input/output token `41,240/1,916`, 실비 `$0.254100`을 원장과 실패 raw artifact에
  남긴 뒤 `aggregate_split_map_non_program_invalid`로 fail-closed했다. 모델은
  `shared/navigation` disposition을 올바르게 선택했지만 required string 필드에
  `__toc__`와 설명용 제목도 채웠다. 원본 tool input은 raw evidence에 그대로 보존하고,
  ownership에 사용하지 않는 비사업 key/title만 adapter 경계에서 비우며 prompt를
  명확히 한 `4dab1f8`을 커밋했다.
- 두 번째 attempt는 map 1~3을 통과하고 map 4에서
  `aggregate_split_map_coverage_invalid`로 닫혔다. 누적 외부 호출 5회,
  input/output token `206,572/13,486`, 누적 실비 `$1.370010`이며 승인 상한 `$12`에
  포함된다. 실패 raw를 읽어보니 5,913자 segment 하나가 `## Page 158~162`의 서로 다른
  사업 여러 개를 포함했고, 모델은 실제 내용을 숨기지 않기 위해 같은 segment ID를
  6개 사업에 귀속했다. 모델의 맥락 판단보다 server의 6,000자 일반 경계가 잘못된
  것이므로 HWP/PDF에 보존된 `## Page N`을 최우선 무손실 경계로 쓰는 `532819c`을
  커밋했다.
- production 입력에 새 segmenter를 read-only 적용하면 전체 1,136,482자를 손실 없이
  666개 segment로 재구성하고, segment당 page heading 최대 1개, 복수 page heading
  segment 0개가 된다. 다만 현재 72,000자 map batch 기준 보수 비용 추정이
  `$12.162410`으로, 이미 사용한 `$1.370010`을 제외한 남은 승인 상한
  `$10.629990`보다 크므로 현재 worker는 세 번째 attempt의 외부 호출 전에 다시
  fail-closed해야 한다.
- 더 중요한 규모 gate도 확인했다. 봉인 입력에는 page marker 556개와 숫자형
  사업 페이지 후보 527개가 있지만 현재 E-2 검증 계약은 최종 program `2~300`개다.
  이 제한을 단순히 600으로 올리면 E-2 synthesis 출력뿐 아니라 이후 수백 개 child의
  최상급 primary 분석·독립 AI 자동검수 비용을 한 승인으로 열게 된다. Ops가 보여준
  `$12`는 분리 worker 상한일 뿐 child 전체 비용 승인이 아니다.
- 따라서 마지막 attempt를 소모하거나 program 상한·비용 상한을 임의로 올리지 않았다.
  현재 case는 `approved`, attempt `2/3`, child 0, materialization/promotion/exposure
  모두 `not_ready`, parent `visible`이다. staged grant, child job, criteria/question,
  사용자 노출 변경은 0건이다.
- 다음 순차 의존성은 “한 통합공고를 최대 300개 이하의 사람이 확인 가능한 partition으로
  나누는 계약”과 “partition별 E-2 및 전체 child 딥분석·AI 자동검수 누적 비용 상한”을
  Ops 승인 화면과 원장에 먼저 추가하는 것이다. 이 두 승인 증거 없이 세 번째 E-2,
  E-3A, E-3B-2로 진행하지 않는다. GCP의 `sw@noten.im` access token refresh와 최신
  verifier 배포도 여전히 E-3B-3B 이전 독립 blocker다.

Step 4-1P-3 통합 연간 안내책자 사람 예외 확정 체크포인트 — `PASS`, 전체는
`BLOCKED` (2026-07-27):

- full partition 원장·worker·Ops 승인 제품은 구현하지 않는다. aggregate 전용 runtime/SQL
  경로가 이미 큰 상태에서 단일 연간 안내책자 때문에 partition lifecycle을 추가하면
  §14.14의 “DB migration + 새 worker + 새 UI가 함께 필요하면 중단” 규칙을 다시
  위반하고, 실제 활성 공고의 22축 깊은 분석·독립 AI 자동검수라는 목표를 흐린다.
- `6d7130e`는 봉인 입력의 `## Page N` 경계를 원문 source별로 결정론 재조립해 300개를
  초과하면 `aggregate_split_manual_review_required`를 non-retryable로 반환한다.
  이 gate는 model/budget 계산보다 먼저 실행되며, 301페이지 fixture에서 외부 모델 호출
  0회를 확인했다. 새 schema, migration, queue, API, Ops UI는 추가하지 않았다.
- production의 승인 case `daa12917-6c8b-4f3a-ae5f-6d4c7fe5c163` 한 건만 worker
  경로로 다시 claim했다. page marker 556개가 자동 상한 300개를 초과해 attempt `3/3`,
  status `failed`, stable error `aggregate_split_manual_review_required`로 닫혔다.
  외부 호출은 누적 5회, token `206,572/13,486`, 비용 `$1.370010`, raw response SHA는
  이전 값과 같아 이 차단 실행의 추가 외부 호출·token·비용·R2 raw write는 0이다.
- child 0, materialization/promotion/exposure `not_ready`, parent `visible/open`을
  readback했다. 기존 Ops case error seam이 stable code와 한국어 message를 그대로
  표시하므로 별도 화면 변경 없이 사람 전용 예외가 관제된다. 이 공고를 완료로 세거나
  조용히 분모에서 삭제하지 않는다.
- 같은 시각 production Ops 정본 집계는 활성 626 =
  serving complete/fresh 2 + in progress 587 + blocked/failed 6 + stale 31이다.
  이 사람 예외 1건을 빼면 실제 자동 분석 대상은 625이고 blocked/failed만 5로 줄며,
  완료 2·진행 587·stale 31은 변하지 않는다. 22축 exact는 4, 같은 input SHA의 독립
  audit `concur`와 S11을 함께 통과한 건은 2, S12~S14까지 모두 통과한 건도 2다.
- 다음 checkpoint는 partition 개발이 아니다. frozen 80 receipt에서 이 1건을
  `human exception / not evaluated`로 명시 보존하고, 나머지 실제 79건의 입력 gate와
  작은 분석 cohort를 기존 primary → 22축 validator → 독립 AI 자동검수 경로로
  닫는 것이다.

Step 4-1P-4 실제 개별 HWP 2건 소규모 분석 체크포인트 — `PASS 1 / HUMAN
EXCEPTION 1`, 확대는 `BLOCKED` (2026-07-27):

- production의 current claimable job에서 HWP가 있는 실제 활성 개별 공고 2건만
  봉인했다. `bizinfo/PBLN_000000000124603`은
  `호주 그린ㆍ에너지 시장개척단 참가기업 추가모집 공고`, input 7,049자/첨부 4건이고,
  `kstartup/178574`는 `ESG × AI 챌린지 해커톤 참가자 모집`, input
  11,833자/첨부 2건이다. 556쪽 통합 안내책자는 terminal human exception이라 이
  bounded cohort에 포함되지 않았다.
- 첫 BizInfo 실행은 primary의 exact 22축·response contract·원문 evidence가 모두
  issue 0이었지만, 신청서의 `수출실적 유무` 정보기재란을 우대조건으로 해석해 독립
  audit가 차단했다. `d130be6`은 신청서 빈칸·체크박스·기업정보 기재란만으로
  required/exclusion/preferred를 만들지 않고, 필수·제외·우대·배점 효과가 명시된
  경우만 조건으로 보도록 primary/audit 공용 prompt를 `deep-analysis-v3`, blind
  audit를 `v2`, model policy를 `v4`로 올렸다. 새 schema·worker·queue·UI는 만들지
  않았다.
- 같은 BizInfo 입력의 v4 재실행에서는 잘못된 수출실적 criterion이 사라졌다. 대신
  독립 audit가 `호주 그린·에너지 산업 진출 희망 기업`의 `target_type` 누락과
  구조화 필드 `중소기업`을 강행조건으로 볼 수 있는지의 불확실성을 잡아
  `independent_audit_disagreement`로 fail-closed했다. v3/v4 실행 비용은 각각
  `$1.025835`/`$0.822875`다. 이 공고는 자동 승격하지 않고 사람 예외로 남겼으며,
  불일치를 프롬프트 반복 수정으로 억지 합의시키지 않았다.
- 첫 K-Startup v4 실행도 primary 22축·evidence는 issue 0이었지만 adjudicator가
  “미성년자 보호자동의서 조건은 primary에 이미 반영된 중복이므로
  `accept_primary`가 맞다”고 설명하면서 구조화 verdict만 `change_required`로
  반환해 차단됐다. `13ffe13`은 “이미 반영/중복”이라는 reason과 verdict가
  반대가 되지 않도록 기존 adjudication prompt 한 곳만 보강하고 version을
  `deep-analysis-audit-adjudication-v2`, model policy를 `v5`로 올렸다. reason
  문자열을 서버가 임의 해석해 통과시키는 우회는 추가하지 않았다.
- K-Startup v5 재실행 job `e1bea519-a308-41eb-9e53-5c977d1f006d`, run
  `da-20260726T232300814Z-fc0bede2-f268-4816-a56a-06955dd38e11`은 `$0.973465`에
  `succeeded/passed`로 끝났다. source/input hash는 계획 시 봉인값과 같고,
  primary `claude-opus-4-8`이 정확히 22축과 criterion 6개를 생성했다.
  response contract, axis coverage, evidence grounding은 모두 issue 0이며,
  `claude-sonnet-5` 독립 audit는 disagreement 0/`concur`로
  `independent_audit_passed`와 S11 `analysis_complete`가 모두 `passed`다.
- 이 체크포인트는 실제 HWP를 읽는 깊은 분석과 AI 자동 검수가 production DB/R2
  경로에서 성공할 수 있음을 한 건으로 증명했고, 의미상 충돌하는 공고는 사람
  예외로 남기는 fail-closed도 한 건으로 증명했다. 그러나 2건 중 1건이 사람
  예외이므로 20건 확대 조건은 충족하지 않았다. promotion/release/S12,
  `grant_criteria`·질문·matcher write, Vercel/GCP 배포는 수행하지 않았다.

Step 4-1P-5 v5 web/Ops production 정합 배포·GCP blocker 체크포인트 —
`PARTIAL`, worker는 `BLOCKED` (2026-07-27):

- 위 P-4 코드와 문서를 포함한 exact clean commit `247f132`를 main에 push했다. 다른
  세션의 미커밋 notice-calendar/schema/migration 변경은 배포 source와 commit에
  포함하지 않았다.
- Ops는 저장소 지침의 예외 인증 경로를 따라 비대화형
  `coolwithyou`와 `team-coolwithyou/changupnote-ops`, Root Directory
  `apps/admin`을 확인했다. clean git archive의 `apps/admin/.vercel/project.json`만
  임시 root link로 사용해 deployment
  `dpl_4RxeS4QYj21cL8F5TXE5R5FMpJ4u`를 production에 배포했다. 상태는 READY,
  `ops.changupnote.com` alias이며 `/pipeline`의 login redirect 307, `/login` 200,
  비인증 `/api/admin/pipeline/summary` 401을 확인했다.
- web은 저장소 `.env.vercel.local`의 `VERCEL_CLI_TOKEN_FULL`을 shell의
  `VERCEL_TOKEN`으로만 매핑했다. 토큰 값은 출력·명령 인자·commit에 넣지 않았고,
  `noten-dev` / `noten/changupnote`, Root Directory `apps/web`을 확인한 뒤 exact
  clean commit으로 deployment `dpl_5n1dRaKAtp1NXRktKywqcb9QiBCW`를 production에
  배포했다. 상태는 READY이고 `changupnote.com`, `www.changupnote.com` 모두 200이다.
- v5 코드 기준 `verify:deep-analysis-ledger`는 production catalog/RLS/append-only
  계약을 PASS했다. `verify:deep-analysis-ops`는 활성 626을
  `analysis_complete_not_published=1`, `in_progress=625`로 정확히 보았고, P-4의
  local bounded worker heartbeat와 S0~S11 각 1건을 확인했다. 반면 v5
  input-preparation heartbeat가 없고 old-policy serving 2건은 current v5 completion으로
  세지 않으므로 전체 verdict는 의도대로 FAIL이다. local heartbeat는 지속 worker
  증거가 아니며 stale SLO가 지나면 worker도 blocker로 전환된다.
- gcloud의 active account/project/region 설정은 계속
  `sw@noten.im` / `changupnote-com` / `asia-northeast3`다.
  `gcloud auth print-access-token`은 `Reauthentication failed: cannot prompt during
  non-interactive execution`으로 실패했다. 다른 계정이나 service credential로
  우회하지 않았고 Cloud Build, Cloud Run Job, Scheduler, Secret, billing mutation은
  수행하지 않았다. 따라서 current v5 worker/input-preparation/verifier image와
  scheduler revision은 아직 production에 반영되지 않았다.
- 다음 mutation은 `sw@noten.im`의 대화형 gcloud 재인증 뒤 current worker 계열만
  exact commit으로 배포하고, worker는 우선 `observe_only`, input-preparation은
  LLM secret 없는 기존 최소 권한을 유지한 채 heartbeat/readback을 닫는 것이다.
  그 전에는 20건 확대, claim scope `all`, promotion/S12, matcher write를 금지한다.

Step 4-1P-6 v5 worker·입력 준비·관제 production 정합 체크포인트 —
`PASS`, 전체는 `BLOCKED` (2026-07-27):

- `sw@noten.im`을 base account로 하고 `changupnote-com`만 대상으로 하는 전용
  configuration `cunote-codex-dev`를 만들었다. 실제 API 호출 주체는 keyless
  impersonation 서비스 계정
  `cunote-codex-dev@changupnote-com.iam.gserviceaccount.com`이다. JSON key는 만들지
  않았고 `sw@ba-ton.kr` 계정은 사용하지 않았다. IAM은 세 Job의 developer, runtime·
  build service account user, Cloud Build editor, 로그·Scheduler viewer,
  Artifact Registry reader와 exact staging bucket object 권한으로 제한했다.
- old revision을 제한 배포해 확인하던 중 input-preparation heartbeat의 기본
  `modelPolicyVersion`이 v3으로 하드코딩된 결함을 발견했다. 기본값을 contracts의
  current `DEEP_ANALYSIS_MODEL_POLICY_VERSION`으로 단일화하고 회귀 테스트를 추가한
  commit `7accca0e3334122bb8cc249a54374019edb122f3`을 main에 push했다.
  focused test, 전체 deep-analysis contract와 web typecheck가 통과했다.
- Cloud Build `5533a94b-82ee-4820-9fe7-66791a9ede07`가 위 exact commit을
  `SUCCESS`로 빌드했다. 불변 image digest
  `sha256:46e5e1caac17f42555af5809a57793ca70905301fb30a540e7abc5a3d4d0c8ae`를
  세 Job에 배포했고 generation은 main/input-preparation/serving-monitor 각각
  `15/11/4`다. runtime service account와 command/args/secret 참조는 보존됐고,
  메인만 `ANTHROPIC_API_KEY`를 가진 채 `observe_only`다.
- 수동 실행 `cunote-deep-analysis-l7m5t`는 policy v5, exact revision,
  `claimScope=unconfigured`, claim·enqueue·analysis·budget mutation 0으로 성공했다.
  `cunote-deep-analysis-input-preparation-gnm72`는 policy v5 heartbeat를 남기고
  target/unresolved/error 0으로 성공했다. `cunote-deep-analysis-serving-monitor-sw4hq`는
  활성 release 2건·item 2건의 source/analysis/criteria/trace 연결을 full mode로
  재검증해 `PASS`했다.
- 정시 Scheduler도 enabled 상태를 유지한다. 11:10 KST main execution
  `cunote-deep-analysis-9dff7`와 11:12 KST input-preparation execution
  `cunote-deep-analysis-input-preparation-lv8q5`가 같은 digest·revision으로
  성공했고, 두 heartbeat 모두 policy v5/current revision이다. serving monitor는
  `5,35 * * * *` Scheduler를 유지하며 위 current revision 수동 실행으로 먼저
  검증했다.
- current code의 production read-only `verify:deep-analysis-ledger`는
  catalog/RLS/append-only/identity/promotion FK를 `PASS`했다.
  `verify:deep-analysis-ops`도 활성 626 보존식과 worker/input-preparation/
  serving-monitor 건강도를 모두 확인해 `PASS`했다. 현재 분포는
  `analysis_complete_not_published=1`, `in_progress=625`, blocker/stale 0이며,
  완료된 실제 HWP 분석 1건은 S0~S11과 독립 AI 자동검수까지 각 1건으로 유지된다.
- 이 체크포인트는 P-5의 GCP 배포 blocker와 “지속 실행 revision이 구버전” 문제를
  닫는다. 활성 626건의 분석 완료나 20건 확대를 의미하지 않는다. 메인은 계속
  `observe_only`이므로 다음 단계는 새 기능 추가가 아니라 current v5 sealed 입력 중
  exact 소수 cohort만 claim fence로 고정해 `2건 이하` 분석·독립 AI 자동검수를
  재검증하는 것이다. 그 증거 전에는 `all` scope, 20건 확대, S12/promotion 및
  matcher write를 금지한다.

Step 4-1P-7 current v5 exact 2건 bounded 자동 실행 체크포인트 —
`FAIL 0/2`, 확대는 `BLOCKED` (2026-07-27):

- `observe_only` 상태의 current v5 claimable job은 0건이었다. backlog 전체를 feeder로
  열지 않고 공용 active enqueue predicate의 후보를 읽기 전용으로 다시 봉인해, 실제
  HWP가 있고 blocker가 없는 BizInfo 2건만 선택했다. 556쪽 통합공고는 포함하지
  않았다. cohort는
  `97bf2f16-36e6-4ad7-a50d-f26789f3964d`와
  `c66793bb-8d50-444f-a86c-fba2f4fea398`, exact hash는
  `751c70103c8121dc5e944cd42f340720a576485278d3de11680d63ec3ae4cf01`,
  activation은 `2026-07-27T02:18:47Z`다.
- main generation 16에 위 두 UUID와 hash만 `bounded`로 넣고
  invocation당 최대 1건·동시 lease 1건·공고당 `$2` 상한을 유지했다. worker
  `cunote-deep-analysis-jkw2m`은 exact 두 건만 enqueue하고 첫 job
  `b005ab92-a12d-4d86-bfc0-f06eeb2c5432`를 claim했다. 동시에 들어온 11:20 KST
  Scheduler `cunote-deep-analysis-q8dzx`는 active lease를 확인해 추가 claim 없이
  종료했다.
- 첫 공고 `2026년 중견기업-공공연 개방형 혁신 지원 사업 신규과제 모집 공고`는
  57,624자·첨부 22건이며 20건 included, container 2건 waived_non_material로
  완전 봉인됐다. primary `claude-opus-4-8`은 exact 22축, response contract,
  axis coverage, evidence grounding을 issue 0으로 통과했고 `$1.123690`이
  발생했다. audit 예상비용 `$1.123690`을 더하면 `$2` 상한을 넘으므로 audit 호출
  전에 run
  `da-20260727T021945502Z-a639bda5-05c8-48d5-86d5-351b3e014274`가
  `pending_budget`으로 차단됐다. 비용이 0인 pre-call 차단으로 잘못 해석하지 않는다.
- 두 번째 worker `cunote-deep-analysis-nrf5m`은 남은 job
  `10b6d5b5-b7c5-40cc-a0f4-1189a91db91b`만 claim했다. 11:25 KST Scheduler
  `cunote-deep-analysis-nt4xj`도 lease 상한 때문에 중복 실행하지 않았다. 대상
  `2026년 2차 산업 공정부산물의 탄소중립 전환 재자원화 기술 실증지원센터 구축사업
  지원계획 공고`는 23,368자·HWP 포함 첨부 3건 전부 included다.
- 두 번째 run
  `da-20260727T022501449Z-d56d9c8a-4977-478f-861e-2f192c1e5c1a`도 primary
  exact 22축·response contract·evidence는 issue 0으로 통과했다. 그러나 독립
  `claude-sonnet-5` audit는 “부도 또는 파산기업(예정 포함)” 배제조건을
  `credit_status`에만 두고 `business_status` 축에는 조건 없음으로 둔 것을
  실질 누락으로 판정했다. criterion/axis disagreement 2건이므로 worker는 이를
  우회하지 않고 `independent_audit_disagreement` dead letter로 보존했다. 비용은
  `$1.293335`다.
- exact 종료 verifier는 active/HWP/current input 2/2, out-of-cohort v5 run 0,
  axis 22/22를 확인했지만 analysis complete 0, terminal 2, 총비용
  `$2.417025`로 정확히 `FAIL`했다. 20건 확대 조건은 충족하지 않았다.
- 종료 직후 main을 generation 17 `observe_only`로 복귀시키고 claim scope/ID/hash를
  제거했다. `cunote-deep-analysis-9fflq` readback은 policy v5, exact revision,
  claim/enqueue/analysis/budget mutation 0이다. 11:35 KST 정시 main
  `cunote-deep-analysis-txnrl`도 같은 `observe_only` 설정으로 성공했고, 정시
  serving monitor `cunote-deep-analysis-serving-monitor-mv7z7`는 활성 release
  2건·item 2건을 full mode로 다시 `PASS`했다. production Ops verifier는 활성
  626 = analysis complete 미발행 1 + in progress 623 + blocked/failed 2,
  worker/input-preparation/serving-monitor healthy, stale 0으로 `PASS`했다.
- 이 체크포인트에서는 비용 상한을 올리거나 prompt/taxonomy를 바꾸지 않는다. 다음
  단계는 두 실패를 섞지 않고 (1) primary 완료 후 audit 예약을 포함하는 비용정책,
  (2) 파산 조건의 `credit_status`/`business_status` 중복 표현 계약을 각각
  코드·기존 receipt 기준으로 검수하는 것이다. 그 검수와 별도 체크포인트 전에는
  재queue, 추가 유료 호출, 20건/`all` 확대, S12/promotion 및 matcher write를
  금지한다.

Step 4-1P-8 P7 두 blocker 로컬 교정 체크포인트 —
`PASS`, production 재실행은 아직 `PENDING` (2026-07-27):

- 비용정책은 primary 비용을 audit 비용으로 그대로 복제하던 `primaryCost * 2` 가정을
  제거했다. 실제 primary usage를 configured audit model의 명시 단가로 다시 계산하고,
  독립 감사와 최대 50k input/8k output의 adjudication 예약을 합친 projected total이
  공고당 `$2` 상한 안에 있을 때만 audit을 시작한다. 비용을 알 수 없는 pass는 0으로
  간주하지 않고 fail-closed하며, 호출 뒤 실제 primary+audit+adjudication 합계도 기존
  `$2` 상한으로 다시 검증한다. 상한 자체는 올리지 않았다.
- 파산 cross-axis 계약은 `business_status=active/closed 같은 사업자등록상 운영 상태`,
  `credit_status=지급불능·부도·파산·회생·법정관리·청산`으로 단일화했다. 동일 사실을
  두 축에 중복 criterion/`condition_found`로 내지 않으며, P7 원문인
  “부도 또는 파산기업(예정 포함)”은 `credit_status`의
  `bond_default`/`bankruptcy_filed`만 사용한다. primary와 blind audit이 공유하는
  추출 prompt 및 adjudication 계약에 같은 규칙을 넣었다.
- prompt는 v4, blind audit은 v3, adjudication은 v3, model policy는 v6으로 올렸다.
  비용정책 구현 커밋은 `0bcf678`, 축 계약 통합 커밋은 `8dc717e`다.
- 통합 clean worktree에서 package build, 전체 `verify:deep-analysis-contract`,
  `@cunote/web` typecheck, `git diff --check`가 모두 통과했다.
- 이 체크포인트는 로컬 계약 교정까지만 닫는다. production deploy/requeue/LLM 호출,
  S12~S14 발행, matcher write, 20건/`all` 확대는 수행하지 않았다. 다음 단계는 같은
  exact 2건만 v6 bounded cohort로 재실행해 2/2 S11을 확인하는 것이다.

Step 4-1P-9 v6 실제 재실행·HTML 공백 인용 비용 증폭 교정 체크포인트 —
`LOCAL PASS`, production v7 재실행은 아직 `PENDING` (2026-07-27):

- exact commit `40c5b76bb615b89218d7ae2475f6edf2b32f4a38`을 Cloud Build
  `f8b1bcc0-55dd-4395-9197-c7970c11247c`로 빌드했다. 불변 image digest
  `sha256:05829b68ed549680cd5da7c1abfd996bc4fc940883c5237cadfd32e0106207ad`를
  main/input-preparation/serving-monitor generation `18/12/5`에 배포했다.
  main observe-only `v8phs`, input-preparation `2nw4b`, serving monitor `9bsc9`
  smoke가 모두 성공했고, monitor는 기존 active release 2건·item 2건을 PASS했다.
- activation `2026-07-27T03:58:04Z`에 P7과 같은 두 UUID·같은 cohort hash만 main
  generation 19 `bounded`, invocation/동시 lease 1, 공고당 `$2`로 열었다. 첫 worker
  `cunote-deep-analysis-ql5wb`만 유료 분석을 수행했고, 04:00 정시 worker `h8nks`는
  active lease를 확인해 claim 0으로 종료했다.
- 첫 공고 v6 run
  `da-20260727T035900861Z-d05b6af8-6926-4132-8a7d-b7a785fdaebd`는 57,624자·22축·
  criterion 12개를 만들었지만 primary 비용이 `$1.590835`까지 증가해 audit 호출 전에
  `pending_budget`으로 차단됐다. 중단 조건에 따라 두 번째 공고는 호출하지 않았고,
  main을 즉시 generation 20 `observe_only`로 복귀시켜 claim scope/ID/hash를 제거했다.
- 비용 증가 원인은 모델이나 공고 분량 자체가 아니라 exact source span repair 2회였다.
  첫 응답은 `$0.502735`에 의미상 완전했지만 structured source의
  `☞&nbsp;중견기업…`을 `☞ 중견기업…`으로 인용해 한 criterion만 byte-exact 검증에
  실패했다. 첫 repair는 다른 criterion에 불필요한 장식 문자를 붙여 다시 실패했고,
  두 번째 repair에서야 통과했다.
- 상한을 올리거나 exact grounding을 완화하지 않았다. `&nbsp;`, `&#160;`,
  `&#xA0;`처럼 화면상 공백인 HTML 표기만 공백으로 비교하고, 정규화 결과가 유일할
  때 모델 인용을 실제 sealed raw substring으로 되돌린다. 서로 다른 raw 후보가
  둘 이상이면 기존처럼 미검증으로 남겨 repair/fail-closed한다. 모델 정책은 v7로
  올려 기존 v6 job/run과 멱등 identity를 섞지 않는다.
- 같은 production 원시 응답을 네트워크 호출 없이 새 정규화기로 재생한 결과 첫
  `$0.502735` pass 자체가 criterion 12개·22축·validation issue 0으로 통과했다.
  package build, 전체 `verify:deep-analysis-contract`, web typecheck,
  `git diff --check`도 PASS했다. 다음 mutation은 이 작은 v7 commit을 observe-only로
  배포한 뒤 같은 exact 두 건만 다시 실행하는 것이다.

Step 4-1P-10 v7 실제 AI 감사·semantic duplicate 교정 체크포인트 —
`LOCAL PASS`, production v8 재실행은 아직 `PENDING` (2026-07-27):

- v7 commit `ddf402dd7a52ab4b18325e2d551855e0e2bcd86d`를 Cloud Build
  `9f27ef1f-e3f1-4caa-8498-651700750427`, digest
  `sha256:2637f1c111a09ff97380207c5427038aafe8c07e12f4bf8740f200d6b1eb3f7d`로
  main/input-preparation/serving-monitor generation `21/13/6`에 배포했다.
  observe-only `2brt9`, input `8nc7t`, monitor `6hvch` smoke는 v7/current revision,
  mutation 0, 기존 active release 2건 PASS를 확인했다.
- activation `2026-07-27T04:18:32Z`에 같은 exact 두 UUID·cohort hash만 generation
  22로 열었다. 첫 run
  `da-20260727T041918686Z-1a0b0e24-8603-4f5c-87e0-b76f835c7d06`은 22축을 만들고
  실제 primary+audit+adjudication 비용 `$1.999572`로 `$2` 안에서 독립 AI 감사까지
  완료했지만 최종 `independent_audit_disagreement`였다. 두 번째 공고는 호출하지
  않았고 main은 generation 23 `observe_only`, claim fence 제거 상태로 복귀했다.
- disagreement 원문을 읽기 전용으로 대조한 결과 실제 자격조건 누락이 아니라 두 종류의
  semantic duplicate였다. `credit_status`의 같은 flags가 배열 순서만 달라 hash가
  갈렸고, adjudicator는 reason에서 “primary에 이미 반영된 중복”이라고 확인하면서
  구조화 verdict만 `change_required`로 반대로 냈다. 또 `중견기업` 규모 조건을 primary가
  `size`에 반영했는데 audit가 동일 문구를 `target_type`에도 중복 요구했다.
- exact semantic hash가 같은 criterion은 모델 전체 응답을 재생성하지 않고 validation
  projection에서 한 건으로 접는다. criterion value 안의 문자열 배열은 집합 의미 비교
  때 중복 제거·정렬해 flags 순서 차이를 같은 hash로 본다. 원문 근거·축·operator·kind·
  value가 실제로 다르면 계속 별개 후보로 남는다.
- `중소기업·중견기업·대기업` 같은 규모는 `size`로만, `target_type`은 개인/법인·
  협동조합·비영리처럼 신청 주체의 법적 형태·역할 유형으로만 쓰는 공유 규칙을 primary,
  blind audit, adjudication에 동일하게 넣었다. prompt v5, blind audit v4,
  adjudication v4, model policy v8로 올렸다.
- 실제 v7 첫 primary raw response를 네트워크 호출 없이 새 validator로 재생한 결과
  `$0.525735` 첫 pass가 raw criterion 12개를 semantic 11개로 안전하게 접어 22축·
  validation issue 0으로 통과했다. focused validator/analyzer/adjudication 테스트,
  package build, 전체 deep-analysis contract, web typecheck, diff check도 PASS했다.
  상한·모델·cohort·발행 gate는 변경하지 않았다.

중단 조건:

- 동결 80 품질 미달
- worker revision 또는 cohort hash 불일치
- 24시간 slot 누락
- blocker 없는 active grant가 S14에 도달하지 못함

위 조건 중 하나라도 발생하면 cohort를 확대하지 않고 해당 단계만 수정한다.
