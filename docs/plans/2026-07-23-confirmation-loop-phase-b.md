# 확인 루프 Phase B — 프로덕션 착지 실행 계획

> **🟢 계획 확정(2026-07-23)** — 구현 미착수. Phase A(lab-deep-v3 confirmation)는 커밋 0ba5229로 완료.
> 설계 정본: `docs/research/2026-07-23-미판정-결격-사용자확인-루프-검토.md` (발견·3단계 실행안·결정 이력)

목표: 딥분석이 사전 생성한 자가신고 확인 질문을 실제 사용자에게 노출하고, 답변으로 공고를 재분류한다 — "확인 필요" 섹션 → 확인 모달 → 결격 없음이면 지원 가능 승격.

## 0. 확정 결정 (연구 문서 §6 열린 결정의 처리)

1. **기존 30건 질문 보강 = 경량 보강 패스 채택** (전체 재분석 기각)
   - 근거: 확대 실험(v2)의 검수·감사 자산은 동결 상태다. v3 전체 재분석($12)은 미감사 산출물을 새로 만들 뿐이고, 질문의 올바른 앵커는 **감사 확정된 criterion**이다.
   - 방식: `pnpm lab:confirmations` 보강 CLI — 감사 완료 런의 확정(correct) exclusion criterion만 대상으로, 공고 원문 + criterion + sourceSpan을 입력해 질문만 생성. 런 파일 불변 원칙에 따라 사이드카 `<runId>.confirmations.json`에 저장(기존 .review/.audit 패턴).
   - 모델: 기본 `claude-sonnet-5`(env `ANALYSIS_LAB_CONFIRMATION_MODEL`) — 판정이 아닌 카피 생성이라 감사 순환성 무관. 예상 비용 코호트 전체 ~$1.
   - **우발 재분석 차단**: batch의 스킵 기준을 "현행 버전 ok 런"에서 "**버전 무관 ok 런**"으로 바꾸고 `--reanalyze-outdated` 탈출구를 추가한다(현재는 v3 승격 여파로 `lab:batch` 실행 시 30건 전체 재분석 ~$12).
2. **per_notice 선언 질문 = 모달 포함**
   - 답변은 공고 스코프(`company_grant_confirmations`)에만 저장, 기업 메타(`company_profiles`) 미저장(Phase A 분류 그대로).
   - 서약형 문구의 어색함("허위로 작성한다" 선택지)은 질문 생성 프롬프트 v4 개정 후보로 기록만 — Phase B에서 프롬프트 변경 없음.
3. **재분류 후 표시 = "본인 확인 기반" 보조 뱃지**
   - 헌법 8조 4상태 어휘(verdict-badge)는 불변. 확인 완료로 open 승격된 카드에 보조 뱃지 + 확인 일시 + 재확인(답변 수정) 진입점만 추가.
   - D9 가드 유지: 확인 미완 동안 "지원 가능성 높음"류 문구 금지.

## 1. 구현 항목과 순서

### 게이트 전 — 지금 착수 가능 (실사용자 노출 없음)

- **B-0. 경량 보강 CLI + batch 가드** (결정 1) — 실험실 내부, DB 무관.
- **B-1. DB 스키마** — 마이그레이션 2테이블(§2). `pnpm db:generate` → `pnpm db:migrate` 순서 준수. 테이블만 선행 생성, 쓰기는 B-4부터.
- **B-2. 엔진 통합(packages/core)** — match 입력에 (company, grant) 확인 답변을 추가:
  - 비결격 답변 → 해당 exclusion criterion 해소(unknown 소거, ruleTrace에 confirmed_by_user 기록)
  - 결격 답변 → hardFail → `ineligible`(closed)
  - 미답변 → 현행 그대로 unknown → conditional
  - 순수 로직 + 테스트로 완결 가능(데이터 없이도 검증).
- **B-3. 확인 모달 UI + CTA** — `DisqualificationSheet` 패턴 재사용. `one_answer`/`check_source` 버킷 카드에 "확인하기" CTA. 질문 데이터가 없으면 CTA 미노출이라 선행 배선이 안전. 답변 저장 → match_state 재계산 → 섹션 이동.

### 게이트 후 — 잔여 48항목 감사 → aggregate GO → `lab:shadow` 긍정이 선행 관문

- **B-4. 승격 파이프라인** — 감사 확정 criteria(shadow-convert 어댑터 재사용, golden_set 승격 트랙과 동일 경로) + confirmations 사이드카 → `grant_criteria` + `grant_confirmation_questions` 발행. provenance(runId·promptVer·감사 상태) 필수 기록.
- **B-5. 실노출 롤아웃** — 승격 공고 한정으로 CTA 활성화 + 본인 확인 뱃지(결정 3).

## 2. 스키마 초안

```
grant_confirmation_questions
  id uuid PK
  grant_id uuid FK→grants
  grant_criteria_id uuid FK→grant_criteria (nullable — 재발행 내성)
  criterion_ref jsonb            -- {dimension, kind, sourceSpanHash} 보조 참조
  prompt text
  options jsonb                  -- [{value, label, disqualifies}]
  answer_type text               -- single | multi
  reusable text                  -- company_fact | per_notice
  condition_key text null
  prompt_ver text                -- lab-deep-v3 | confirmations-v1(보강 패스)
  provenance jsonb               -- {runId, auditState}
  created_at timestamptz

company_grant_confirmations
  company_id uuid FK→companies
  grant_id uuid FK→grants
  question_id uuid FK→grant_confirmation_questions
  answer jsonb                   -- {values: [...]}
  disqualified boolean           -- 판정 시점 옵션 극성 스냅샷(옵션 개정 내성)
  answered_by uuid FK→users
  answered_at timestamptz
  PK (company_id, question_id)
```

- 기업 메타 재사용(Phase C)은 `company_profiles` EAV 그대로 — Phase B에서는 company_fact 답변도 공고 스코프만 저장하고, Phase C에서 승격 로직을 붙인다(범위 밖).

## 3. 검증 계획

- B-0: 보강 결과를 실험실 UI(ConfirmationPreview)로 렌더해 코호트 표본 사람 확인. batch `--dry-run`으로 스킵 가드 검증(대상 0건이어야 함).
- B-2: match 유닛 테스트 — 해소/hardFail/미답변 3경로 + D9 가드 회귀.
- B-3: dev 서버에서 모달 왕복(답변 → 재계산 → 섹션 이동) 사용자 동반 검증.
- B-4: 발행 전후 shadow 방식 대조(발행분이 섀도 측정과 동일 결과인지) + provenance 무결성.

## 4. 비범위 (명시)

- Phase C 미리채움(company_profiles 승격·condition_key 매칭)
- 질문 생성 프롬프트 v4 개정(서약형 문구 개선, #10류 질문 재현율)
- 과금 feature code(`deep_analysis`) 등록 — 운영화 결정 이후
- 통합공고 분해·전 공고 운영화(기존 트랙 잔여 그대로)
