# 딥 공고 분석 결과 운영 매칭 적용 로드맵 및 구현 계획

> 작성일: 2026-07-24  
> 상태: **제어면 구현 완료 — W30 검수 수거·운영 카나리 전**  
> 적용 대상: `analysis-lab`에서 생성하고 AI 검수·감사·검수팀 판정을 거친 공고별 조건과 확인 질문  
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

## 10. 이번 릴리스의 비범위

- 랜딩 요청마다 딥 분석 LLM 실행
- 모든 활성 공고 약 1,500건의 일괄 분석
- 검수 없이 AI 산출을 곧바로 `needs_review=false`로 발행
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
