# 검수팀 ops 워크스페이스 + 주간 배분 체계 — 상세 구현 계획

> **🟢 상태(2026-07-23): 구현·운영 적용 및 검수자 피드백 반영 완료.** 초안 → Codex(gpt-5.5) 리뷰 **NO-GO(발견 14건)** → 전건 반영 개정 → 구현·검증·운영 DB migration·reviewer 2계정·첫 배치·ops production 배포까지 완료했다. 검수자 화면 피드백에 따른 후속 UX·원문/HWP 참고 흐름은 §9.7에 기록한다. 반영 기록은 §8, 운영 인계와 적용 증적은 §9.
> 새 세션이 이 문서를 진입점으로 구현한다. 전사: 확인 루프 Phase A+B(`docs/plans/2026-07-23-confirmation-loop-phase-b.md` 🟢, ~d073a54).
> 관련: §10 프로토콜(`docs/plans/2026-07-21-analysis-lab-expansion-experiment.md`), 검수 판정 가이드(`docs/research/2026-07-18-공모딥분석-검수판정-가이드.md`)

## 0. 배경과 확정 결정

검수팀 2명이 합류했다. AI 감사 불일치 항목(현재 48항목·19공고)과 정기 발생할 사람 검수 가치 항목들을 주 단위로 배분하는 체계를 만든다. 사용자(창업자) 확정 결정:

1. **검수자 계정 2개**: `kim@noten.im` / `young@noten.im`. 패스워드 임의 생성 후 마크다운 문서 저장(비커밋 — §2-W3, Codex 권고에 따른 완화 조치 포함).
2. **ops(admin) 이전**: 검수 화면을 apps/admin(changupnote-ops)에 신설. 역할 기반 페이지 접근 도입, 두 계정은 **검수 전용 역할**.
3. **중복 표본 15% · 주 단위 배분.**
4. **비차단 원칙(최우선)**: 검수 미완이 공고 노출을 막아선 안 된다. AI 자동 확정으로 흐르고, 사람 검수는 사후 품질 보정. 사업자가 공고를 놓치는 것이 최악의 실패.

### 현황 전제 (조사 확인)

- admin: NextAuth v4 JWT + `admin_users`(bcrypt, `admin_role` enum owner|admin|support|viewer), 계정 CLI `pnpm admin:user:create`. 역할 게이팅은 API에만, 페이지·proxy·사이드바는 로그인만 검사. raw SQL(postgres.js, drizzle 미사용), web 코드 직접 import 금지.
- 검수 대상 데이터(런·감사 파일)는 로컬 `spike-out/` 파일 → Vercel ops가 읽으려면 DB 디스패치 계층 필수.
- **감사 파일 규약(§10)**: 대상 목록은 최초 생성 시 동결, `saveLabAuditJudgments`는 동결 목록 밖 항목 저장을 거부(audit-store.ts:361), humanVerdict/note만 갱신 가능. 이 규약은 불변이다 — 본 계획은 이를 우회하지 않는다.
- web `/internal/review`(필드맵 라벨링)는 별개 워크플로우로 존치(§6 비범위).

## 1. 아키텍처

```
[로컬 실험실 (파일 = 감사 프로토콜 원천)]        [DB (배분·수집·판정 이력의 원천)]        [ops admin (Vercel)]
 <runId>.audit.<slug>.json  ──┐                audit_dispatch_batches                /review 워크스페이스
 <runId>.human-overlay.json ◀─┤─ lab:dispatch ─▶ audit_dispatch_notices  ◀─raw SQL─  (reviewer 전용)
        ▲                     │                 audit_dispatch_items                 /review/adjudicate
        └── lab:collect ◀─────┘                 (판정 이력 불변 보존)                  (admin·owner 3심)
```

- **이원 원천 명시**: 감사 판정의 프로토콜 원천은 파일(§10 규약 그대로), **판정 이력·provenance의 원천은 DB**다. 파일에는 최종 판정만 병합되고(additive `decidedBy`), 원판정·중복 표본 양측 판정·3심 이력은 DB에 불변 보존된다(파일 규약 버전업 불요 — Codex #6 반영).
- **수집 이원화(Codex #1 반영)**: 동결된 감사 대상 항목(`LabAudit.items` — 불일치·unsure·미판정)의 판정만 감사 파일에 병합한다. **확장 선별 항목**(span 미검증·저신뢰 correct 등 동결 목록 밖)은 감사 파일에 넣지 않고 **신규 사이드카 `<runId>.human-overlay.json`**(schema `human-review-overlay-v1`)에 수집한다 — 동결 규약 무손상. overlay는 aggregate 게이트 표본에 편입하지 않으며(프로토콜 불변), 승격 resolver(§2-W1)와 사례집·프롬프트 개선의 입력으로만 쓴다.

## 2. 워크스트림

### W1. 비차단 승격 개정 — resolver 선행 + 엔진 게이트 규칙 (Codex #2·#3·#4 반영)

**W1-a. criterion 해소 상태 resolver (선행 설계 — 단일 원천).** 파일들(런·review·audit·overlay)로부터 criterion별 `resolutionState`를 계산하는 순수 모듈:

- `confirmed_correct` — 사람 검수 correct / 감사 항목의 humanVerdict=correct / AI 감사 concur(correct)
- `confirmed_edited`·`confirmed_wrong` — needs_edit/wrong 확정(발행 제외 또는 수정 반영은 기존 규약대로)
- `pending` — 감사 불일치·unsure·미판정(사람 큐 잔류)
- `unaudited_correct` — 감사 비대상 correct(§9 표본 밖). **런 미완 중에도 확정으로 볼지는 프로토콜 결정 사항** → 본 계획의 결정: **AI 검수 correct + 감사 비대상이면 발행 허용(needsReview=false)**. 근거: §9 캘리브레이션(correct→wrong 오검출 0)이 이 방향의 안전성을 실측했고, 비차단 원칙의 실질이 여기에 있다. 단 aggregate 게이트 표본 규약은 불변(런 완료 단위).

criteria 발행과 질문 발행이 모두 이 resolver를 소비한다. **질문 발행은 `confirmed_*` exclusion에만** — pending exclusion에는 질문을 달지 않는다(잘못된 질문 위험, 명시 테스트).

**W1-b. 엔진 게이트 규칙(신규).** `deferUnreviewedHardFail`은 fail→unknown 전환만 하므로, pass하는 needs_review 항목이 비핵심 축에서 `recommendable`로 새는 구멍이 있다(Codex #2 실증). **새 규칙: required/exclusion 중 `needs_review=true` 항목이 하나라도 있으면 평가 결과(pass/fail/unknown)와 무관하게 review gate를 `needs_core_review`로 강제**한다(reason 신설 `unreviewed_criteria`). 테스트: region(비핵심)·biz_age·prior_award·결격 축 × pass/fail/unknown 매트릭스로 "미확정 보유 공고는 항상 check_source 노출"을 봉인.

**W1-c. promote 항목 단위 개정.** 대상을 "확정 항목 보유 런"으로 확장, resolver 상태별 발행: confirmed → needsReview=false, pending → **needsReview=true로 발행**(W1-b가 노출 위치를 보장). 미확정 항목 제외 발행은 기각 유지(배제 조건 누락 = 역방향 오류).

**W1-d. 재승격·답변 보존(사전 설계 — Codex #4).** 현행 전체 삭제·재삽입 + 답변 존재 시 공고 전체 거부는 사람 검수 반영을 영구 차단할 수 있다. 개정:

- criterion **안정 키** 도입: `dimension + kind + operator + normalize(value) + sourceSpanHash`의 해시. 발행 시 `grant_criteria`에 저장(신규 컬럼 `stable_key` 또는 criterion_ref 확장).
- 재승격은 안정 키 기반 **upsert**: 동일 키는 UPDATE(needsReview 전환 포함), 신규 키 INSERT, 소멸 키 DELETE(단, 질문이 앵커된 키는 질문·답변 유지 판단 필요 — 아래).
- 질문은 안정 키로 재연결해 **ID 보존**(답변 FK 유지). 질문의 앵커 criterion이 소멸·변질된 경우만 질문 무효화(답변은 이력 보존, soft-invalidate — cascade 삭제 금지).
- **수용 기준(필수)**: "사용자 답변 존재 공고에서 criteria만 갱신하고 질문·답변이 유지되는" 안전 경로 테스트.

### W2. DB 디스패치 스키마 + lab:dispatch / lab:collect (Codex #1·#5·#9·#11 반영)

**테이블 3개** (drizzle 스키마 정의 → generate→migrate, admin은 raw SQL 조회):

```
audit_dispatch_batches   -- 배치 재현성 (Codex #9)
  id uuid PK, week text, seed int, reviewer_ids uuid[], overlap_ratio real,
  guide_sha256 text, dispatched_by text, item_count int, notice_count int,
  created_at timestamptz, UNIQUE(week)

audit_dispatch_notices
  id uuid PK, batch_id uuid FK(restrict), grant_id uuid, run_id text, source text, source_id text,
  title text, input_text text, input_sha256 text, analysis_markdown text,
  review_model text, audit_schema text, audit_file_sha256 text,   -- CAS 기준(수거 시 대조)
  ai_review_model text, ai_review_prompt_ver text,
  created_at timestamptz, UNIQUE(batch_id, run_id)

audit_dispatch_items     -- 판정 이력 불변 보존 (삭제 금지 — FK restrict)
  id uuid PK, notice_id uuid FK(restrict),
  source_item_key text,        -- 감사 항목: kind+criterionIndex/dimension 안정 키 | overlay: 확장 키
  collect_target text CHECK IN ('audit_file','overlay'),          -- Codex #1 수집 이원화
  item_kind text CHECK IN ('criterion','axis','question_check'),
  criterion_index int null, dimension text null,
  payload jsonb, payload_sha256 text,
  assignee_id uuid FK(admin_users, restrict), assignee_email text,  -- FK가 정본(Codex #8)
  overlap_group uuid null, blind boolean default false,             -- 중복 표본은 blind=true(Codex #10)
  status text CHECK IN ('pending','decided','conflict','resolved','collected'),
  human_verdict text null, note text null, decided_at timestamptz null,
  final_verdict text null, finalized_by uuid null, resolved_at timestamptz null,  -- 3심(Codex #11)
  revision int default 0, updated_at timestamptz,
  collected_at timestamptz null, collect_receipt jsonb null,        -- 수거 영수증(Codex #5)
  CHECK (status <> 'decided' OR human_verdict IS NOT NULL),
  CHECK (status NOT IN ('resolved') OR final_verdict IS NOT NULL),
  UNIQUE(notice_id, source_item_key, assignee_id), INDEX(assignee_id, status)
```

**`lab:dispatch`** (주 1회, 로컬):
- 선별기: ① 동결 감사 항목 중 미판정(불일치·unsure — `collect_target=audit_file`) ② span 미검증 required/exclusion ③ 저신뢰(<0.6) ④ 신규 확인 질문 스팟체크 ⑤ missed_condition (②~⑤는 `collect_target=overlay`). 기판정·기배분 제외(멱등 — source_item_key 기준).
- 배분: 공고 단위 반분(항목 수 균형, batch.seed 결정론), 15%(공고 기준, 최소 1) 중복 — overlap 항목은 양측 모두 `blind=true`.
- dispatch 시점의 감사 파일 sha256을 notice에 기록(CAS 기준).
- 플래그: `--week=` `--dry-run` `--reviewers=`.

**`lab:collect`** (판정 회수, 로컬):
- 대상: `status=decided`(비중복) 및 `resolved`(3심 완료) 중 `collected_at IS NULL`.
- **CAS + crash-safe(Codex #5)**: 파일 현재 sha256을 dispatch 기록과 대조 — 불일치면 해당 공고 스킵·`stale_audit_file` 보고(AuditSheet·ai-audit 병행 변경 감지). 병합은 임시파일 쓰기 후 rename(원자 교체), 성공 시 DB에 `collected_at`+`collect_receipt`(병합 후 파일 sha256) 기록. 파일 성공·DB 실패 잔재는 재실행 시 receipt sha 대조로 멱등 복구(`lab:reconcile` 서브커맨드 — receipt 무결성 전수 점검).
- `collect_target=audit_file` 항목만 `saveLabAuditJudgments` 재사용 병합(동결 규약 그대로 — 목록 밖 거부가 곧 안전망). 항목 additive 필드 `decidedBy`(이메일) 기록 — 계약은 lab-audit-v1 유지(additive optional, 원판정 이력은 DB가 원천).
- `collect_target=overlay` 항목은 `<runId>.human-overlay.json`에 기록(신규 스토어, 기존 감사 파일 무접촉).
- **중복 표본 충돌(Codex #11)**: 양측 판정 불일치 → 두 row를 `conflict`로 마킹(병합 보류). 3심은 ops의 admin·owner 전용 `/review/adjudicate` 화면(양측 판정·사유 나란히 표시)에서 `final_verdict`·`finalized_by` 기록 → `resolved` → 다음 collect가 최종 판정만 병합. 일치 → 그대로 병합(둘 다 collected).

### W3. admin reviewer 역할 + 전 라우트 권한 정비 + 계정 (Codex #7·#12 반영)

- DB: `ALTER TYPE admin_role ADD VALUE 'reviewer'`(단독 statement). TS union·`ROLE_ORDER` **최하위(index 0)** 삽입·계정 CLI 화이트리스트.
- **기존 라우트 전수 정비(Codex #7 — 필수 선행)**: `requireAdminSession`만 쓰는 라우트(최소 13개 — 골든셋 승격 POST, 구독 변경 PATCH, 티켓 메시지 등)에 최소 `requireAdminRole("viewer")` 이상을 명시 추가. 구현 세션은 `rg "requireAdminSession" apps/admin/src/app/api`로 전수 목록화 후 라우트별 적정 역할을 표로 기록.
- 검수 API 게이트: `requireAnyAdminRole(session, ["reviewer","admin","owner"])` 신설(서열 아님 — 명시 집합).
- 페이지 가드 + proxy: role→경로 매트릭스 단일 정의 공유. reviewer는 `/review/**`만(그 외 redirect), 타 역할 현행 유지 + `/review`는 admin·owner 열람 허용. proxy는 보조 방어(라우트 검사를 대체하지 않음 — 주석 명시).
- **JWT role 신선도**: jwt 콜백에서 role 재조회를 "없을 때만"에서 "5분 경과 시"로 확장(강등·역할 변경 반영). `getOptionalAdminSession`의 매 호출 DB 재검증은 기존대로.
- 사이드바: `NAV_GROUPS` role 필터 — reviewer에겐 "검수" 그룹만.
- **계정 생성**: `admin:user:create`를 **stdin 비표시 프롬프트** 지원으로 확장(argv 패스워드 노출 제거 — Codex #12). 생성 순서: Google 로그인(@noten.im, `findOrLinkGoogleAdminUser`)을 **주 경로**로 안내하고 패스워드는 보조 경로. `ADMIN_ALLOWED_EMAILS` 설정 여부 확인 후 두 이메일 등재. 크레덴셜 문서는 사용자 결정대로 마크다운(`spike-out/ops/review-team-credentials.md`, gitignore 실측 확인)에 저장하되: 전달 후 파일 폐기·첫 로그인 시 회전 문구·Google 주 경로 안내를 문서에 포함. 커밋 절대 금지.

### W4. ops 검수 워크스페이스 (`/review`) (Codex #8·#10·#14 반영)

- `/review` 내 큐: **본인 배정분만**(assignee_id = 세션 admin_user_id — 서버 강제). 주차·진행률·미판정 우선.
- `/review/[noticeId]` 상세: 원문 뷰(`input_text`) + `analysis_markdown` 탭 + 항목 카드(판정 어휘 정확/수정 필요/오류/판단 불가, 뒤집기 사유 필수 — 실험실 `parseItemJudgments` 규칙을 contracts로 승격해 공유).
  - **객체 단위 접근 제어**: reviewer는 본인 assignment가 존재하는 notice만 GET 가능(UUID 추측 열람 차단), 응답 items도 본인 배정분만. admin·owner는 전체 열람.
  - **blind 항목(중복 표본)**: `blind=true`면 AI 판정·AI 감사 스냅샷·타 검수자 판정을 **렌더하지 않는다**(κ 앵커 편향 제거 — Codex #10). 비중복 항목은 AI 맥락 표시(효율).
  - **마크다운 보안(Codex #14)**: raw HTML 금지(sanitize 강제), 외부 링크 `rel="noopener noreferrer"`, 응답 크기 상한, 필드 최소화.
- `/review/adjudicate` (admin·owner 전용): conflict 항목 양측 판정 나란히 → 최종 판정 기록(§2-W2 3심).
- API: `GET /api/admin/review/queue` · `GET .../notices/[id]` · `PUT .../notices/[id]/verdicts`(자기 배정 + revision 낙관 잠금) · `POST .../adjudicate/[itemId]`. 전부 명시 역할 집합 검사.
- 온보딩 `/review/guide`: 판정 가이드·사례집·리트머스 요약.
- 보존 정책: input_text·analysis_markdown은 배치 종료 2분기 후 null 처리(판정 이력은 영구 보존) — 운영 부록에 명시.

### W5. 주간 사이클 + 품질 측정 (Codex #10 반영)

- **측정 리포트**(`lab:collect` 산출): item_kind별 **κ + 단순 일치율 + 쌍 수 + 범주 분포**를 분리 보고(합산 κ 금지). κ 정의 불능 케이스(단일 범주 완전 일치 → 분모 0)는 "일치율 100%·κ N/A"로 표기. 15% 공고 표본의 클러스터 효과(공고 단위 배분) 주석 병기.
- **시차 재검수는 유지**(동시 2인 중복이 시간 드리프트·공유 rubric 편향을 못 재므로 대체 불가 — §10 규약 존속): 분기 1회, 소표본.
- κ < 0.7 → 가이드 보정·사례집 등재·재교육(§10 신뢰 조항 연동).
- 주간 runbook: 월 `lab:dispatch` → 검수(ops, 상시) → 금 `lab:collect` → conflict는 `/review/adjudicate` 3심 → 재collect → aggregate·promote 반영. 첫 배치 = 48항목(audit_file) + 질문 15건 스팟체크(overlay). 온보딩: 첫 1공고는 창업자 판정과 대조.

### W6. 심판 에이전트 연계 (훅만)

`audit_dispatch_items`의 불변 판정 이력(원판정·3심·blind 여부 포함)이 이종 모델 심판 에이전트 캘리브레이션 정답지로 축적된다. 본 계획에서는 이력 보존 보장까지만 — 설계·캘리브레이션은 별도 문서.

## 3. 구현 순서·세션 분할

| 순서 | 내용 | 의존 | 규모 |
|---|---|---|---|
| 세션 1 | W1-a resolver → W1-b 엔진 게이트 규칙 → W1-c/d promote 개정(안정 키·upsert) | 없음 | 중~대 |
| 세션 2 | W2 스키마 3테이블 → W3 역할·라우트 전수 정비·가드·계정 | 없음(세션 1과 병행 가능) | 중 |
| 세션 3 | W4 ops UI+API → W2 dispatch/collect/reconcile CLI | 세션 1·2 | 대 |
| 세션 4 | W5 첫 사이클 동반(온보딩·측정 첫 실측) + ops 배포(`--scope team-coolwithyou`, 대화형 크레덴셜) | 세션 3 | 소 + 사용자 동반 |

## 4. 검증 계획 (수용 기준)

- W1: needs_review 게이트 매트릭스 테스트(축 4종 × pass/fail/unknown → 전부 check_source); pending exclusion 질문 미발행; 안정 키 upsert 후 질문 ID·답변 보존 테스트(**필수**); resolver 상태 전이 전수 테스트.
- W2: dispatch 멱등·결정론(seed 고정 스냅샷); collect CAS 스킵(파일 변조 시)·crash point 3종(파일 후 DB 실패/역방향/중복 실행) 각각 복구 테스트; conflict→adjudicate→resolved→collect 왕복; overlay 항목이 감사 파일에 절대 안 닿는 것.
- W3: **정적 라우트-역할 매트릭스 테스트**(verify:ops-admin 확장 — 전 라우트를 review 전용/viewer+/support+/admin+/owner로 분류, session-only 라우트 0 강제) + reviewer 세션 실 403 테스트(크레딧·플라이휠·registry 각 1) + reviewer 페이지 redirect.
- W4: 타인 배정 notice GET 403; blind 항목 응답에 AI 판정 필드 부재; sanitize(raw HTML 미렌더) 테스트; revision 충돌 409.
- W5: 측정 리포트 유닛 테스트 — κ 정상 케이스·단일 범주 N/A 케이스·item_kind 분리.
- 공통: 루트 typecheck·기존 lab 테스트 7종·admin 정적 검증. dev 검증은 `pnpm dev:ops`(사용자 기동).

## 5. 비용·규모 추정

- 신규 LLM 비용 없음(배분·검수·수집은 전부 결정론 코드). ops 배포는 기존 프로젝트.
- 코드 규모: resolver+엔진 규칙+promote 개정 ~600줄, 스키마+CLI ~800줄, admin 역할·가드 ~400줄, ops UI ~1000줄 (테스트 별도).

## 6. 비범위

- web `/internal/review`(필드맵 라벨링) role 게이트 정비 — 불일치 존치 기록만.
- 심판 에이전트(§11) 구현·캘리브레이션. 딥분석 실행 서버화. Phase C 미리채움. 과금 feature code.
- aggregate 게이트 표본 규약 변경(런 완료 단위 유지 — overlay는 표본 밖).

## 7. 리스크·주의

- `ADD VALUE` 롤백 불가 — 역할명 `reviewer` 확정 후 진행.
- ROLE_ORDER 최하위 삽입의 전제(기존 API 최소 요구 viewer 이상)는 W3 라우트 전수 정비가 완성한다 — 정비 전 reviewer 계정 생성 금지(순서 강제).
- 감사 파일 병행 쓰기(AuditSheet·ai-audit·collect)는 CAS로 감지·스킵 — 강제 병합 절대 금지.
- 크레덴셜 문서는 커밋 금지 + 전달 후 폐기. `outputs/`는 gitignore 불일치 가능성 — 사용 금지.
- 판정 이력 row는 어떤 경로로도 삭제하지 않는다(FK restrict + 마이그레이션 시 보존 확인).

## 8. Codex 리뷰 반영 기록 (2026-07-23, NO-GO → 개정)

| # | 심각도 | 요지 | 처리 |
|---|---|---|---|
| 1 | 치명 | 확장 선별 항목은 동결 감사 목록 밖 → collect 구조적 실패 | **반영** — 수집 이원화(`collect_target`, human-overlay 사이드카) |
| 2 | 치명 | needs_review pass 항목이 recommendable로 샘 | **반영** — W1-b 엔진 게이트 규칙 신설 + 매트릭스 테스트 |
| 3 | 중대 | 항목 단위 승격의 상태 모델 부재·질문 과발행 위험 | **반영** — W1-a resolver 선행, 질문은 confirmed exclusion만 |
| 4 | 중대 | 재승격 답변 보존을 미룰 수 없음 | **반영** — 안정 키 upsert·질문 ID 보존·수용 기준 필수화 |
| 5 | 중대 | 파일↔DB 원자성·CAS·복구 부재 | **반영** — sha256 CAS·rename 원자 교체·receipt·lab:reconcile |
| 6 | 중대 | humanVerdictBy로는 provenance 부족 | **반영** — DB를 판정 이력 원천으로 격상(불변 보존), 파일은 최종 판정+decidedBy additive |
| 7 | 중대 | session-only 라우트 13+개 → reviewer 격리 미완성 | **반영** — W3 전 라우트 권한 정비 필수 선행 + JWT role 신선도 |
| 8 | 중대 | 객체 단위 접근 제어 미기술 | **반영** — 본인 assignment 서버 강제·admin_user_id FK |
| 9 | 중대 | 배치 재현성·CHECK·이력 보존 부재 | **반영** — batches 테이블·CHECK·UNIQUE·FK restrict·revision |
| 10 | 중대 | κ 앵커 편향·합산 κ·정의 불능·시차 재검수 대체 불가 | **반영** — overlap blind 모드·kind별 분리 보고·N/A 처리·시차 재검수 존속 |
| 11 | 중대 | 3심 흐름 데이터상 미폐쇄 | **반영** — conflict 일급 상태·`/review/adjudicate`·final_verdict 경로 |
| 12 | 중대 | 평문 크레덴셜 md·argv 노출·Google 전제 조건부 | **부분 반영** — stdin 프롬프트·Google 주 경로·allowlist 확인·폐기/회전 문구. md 저장 자체는 사용자 확정 결정이라 유지(완화 조치 부가) |
| 13 | 경미 | 검증 계획이 격리를 증명 못함 | **반영** — 정적 라우트-역할 매트릭스·실 403·crash point 테스트 |
| 14 | 제안 | 원문 렌더 XSS·보존 정책 | **반영** — sanitize 강제·크기 상한·2분기 보존 정책 |

## 9. 구현 결과와 운영 인계 (2026-07-23)

### 9.1 구현된 경계

- W1: criterion resolver, `needs_review` 강제 review gate, pending 포함 항목 단위 승격, 안정 키 criteria/question upsert, 질문 soft-invalidate와 답변 FK 보존.
- W2: dispatch 3테이블 migration(`0051_next_alex_power.sql`), 결정론 배분·15% blind 중복·질문 15건 표본·기배분 제외, audit/overlay 이원 수거, CAS·원자 교체·receipt 복구·reconcile, item_kind별 κ 리포트.
- W3: `reviewer` 역할, 모든 admin API의 명시 역할 검사, 공유 경로 매트릭스와 서버 페이지 가드, 5분 JWT role 재조회, reviewer 전용 사이드바, 숨김 입력/Google-only/안전한 임시 비밀번호 생성 계정 CLI.
- W4: `/review`, `/review/[noticeId]`, `/review/guide`, `/review/adjudicate`; 본인 assignment SQL 강제, 타인 notice 403, blind payload 서버 제거, sanitize된 Markdown, revision 409, conflict 3심.
- 공유 판정 어휘는 `@cunote/contracts`가 단일 원천이다. axis에는 `confirmed_absent|missed_condition`만 허용하며 criterion에만 `unsure`를 허용한다.

개발 서버는 실행하지 않았다. 운영 migration·계정 생성·첫 배치·production 배포는 §9.6의 적용 증적대로 완료했다. 파일 수거는 사람 판정 완료 뒤 금요일 주간 사이클에서 시작한다.

### 9.2 최초 운영 적용 순서

1. 운영 DB 백업/대상 환경을 확인한 뒤 `pnpm db:migrate`로 `0051_next_alex_power.sql`을 적용한다.
2. 기존 `ADMIN_ALLOWED_EMAILS` 값을 보존하면서 `kim@noten.im,young@noten.im`을 추가한다. 빈 allowlist는 활성 `admin_users` 전체를 허용하므로 운영에서는 사용하지 않는다.
3. Google 로그인을 주 경로로 쓸 때:

   ```bash
   pnpm --filter @cunote/admin admin:user:create -- --email kim@noten.im --role reviewer --google-only
   pnpm --filter @cunote/admin admin:user:create -- --email young@noten.im --role reviewer --google-only
   ```

4. 사용자 확정안대로 임시 비밀번호도 발급할 때는 `--generate-password`를 사용한다. 비밀번호는 stdout/argv에 나오지 않고 gitignore된 `spike-out/ops/review-team-credentials.md`에 mode `0600`으로 추가된다. 동시에 각 계정에 바로 전달할 수 있는 `spike-out/ops/review-team-guide-<email>.md`가 생성되며, 공용 가이드 원본은 `docs/guides/review-team-member-guide.md`다.

   ```bash
   pnpm --filter @cunote/admin admin:user:create -- --email kim@noten.im --role reviewer --generate-password
   pnpm --filter @cunote/admin admin:user:create -- --email young@noten.im --role reviewer --generate-password
   ```

   전달 후 파일을 폐기하고 최초 로그인 뒤 비밀번호를 회전한다. 계정 생성 전에 allowlist와 DB migration 적용을 먼저 확인한다.
5. 사용자가 `pnpm dev:ops`를 기동한 환경에서 reviewer 계정으로 `/review`만 열리고 `/credits`, `/registry-imports`, `/internal/live-match`가 redirect/403 되는지 확인한다. admin·owner로 `/review/adjudicate`를 확인한 뒤 별도 승인 하에 ops를 배포한다.

### 9.3 주간 runbook

월요일 배분은 먼저 dry-run으로 대상·부하·blind 수를 확인한다.

```bash
pnpm lab:dispatch -- --week=2026-W30 --reviewers=kim@noten.im,young@noten.im --dry-run
pnpm lab:dispatch -- --week=2026-W30 --reviewers=kim@noten.im,young@noten.im
```

금요일에는 판정 완료분만 수거한다. `stale_audit_file`이 하나라도 있으면 해당 공고 파일은 덮어쓰지 말고 병행 편집자를 확인한다. 3심 후 같은 collect를 다시 실행한다.

```bash
pnpm lab:collect -- --week=2026-W30
pnpm lab:reconcile -- --week=2026-W30
```

측정 파일은 `spike-out/ops/review-metrics-<week>.json`이다. item_kind별 κ·일치율·쌍 수·범주 분포를 따로 읽고, κ가 정의되지 않는 단일 범주 완전 일치는 `N/A`로 유지한다. κ < 0.7이면 가이드 보정·사례집 등재·재교육을 먼저 수행한다.

### 9.4 2분기 보존 정책

분기 운영 점검 때 배치 생성 후 6개월이 지난 원문·분석 스냅샷만 null 처리한다. `audit_dispatch_items`와 판정·3심·receipt 이력은 삭제하지 않는다.

```sql
UPDATE audit_dispatch_notices AS notice
SET input_text = NULL,
    analysis_markdown = NULL
FROM audit_dispatch_batches AS batch
WHERE notice.batch_id = batch.id
  AND batch.created_at < now() - interval '6 months'
  AND (notice.input_text IS NOT NULL OR notice.analysis_markdown IS NOT NULL);
```

### 9.5 코드 검증 명령

```bash
pnpm --filter @cunote/contracts build
pnpm --filter @cunote/web typecheck
pnpm --filter @cunote/admin typecheck
pnpm lab:resolution:test
pnpm lab:promote:test
pnpm lab:dispatch:test
pnpm lab:collect:test
pnpm lab:audit:test
pnpm lab:ai-audit:test
pnpm verify:review-workspace
pnpm verify:admin-routes
pnpm verify:ops-admin
```

### 9.6 운영 적용 증적 (2026-07-23)

- 구현 커밋: `381ea8b` (`feat: 검수팀 ops 워크스페이스와 주간 배분 구현`)
- 운영 dry-run에서 주차 해시 seed가 PostgreSQL `integer` 범위를 넘는 결함을 발견했다. 최초 write는 transaction 시작 시 거부돼 dispatch row가 0건인 것을 확인했고, 31-bit 정규화와 경계 회귀 테스트를 `47a8eb2`로 보정했다.
- 운영 DB migration 적용 완료: Drizzle migration id `52`, hash `7f2d10af3756406ba4ecc574120e93a200ca349c028ff8a30e53ff749ea4f125`. `reviewer` enum, dispatch 3테이블, FK/CHECK/UNIQUE/index, criteria/question 안정 키 컬럼을 재조회해 확인했다.
- Vercel production `ADMIN_ALLOWED_EMAILS`는 기존 활성 운영자 3명을 보존하면서 `kim@noten.im`, `young@noten.im`을 추가해 encrypted 값으로 설정했다.
- 두 계정은 운영 DB에서 `active/reviewer`와 password hash 보유 상태를 확인했다. 비밀번호는 stdout/argv에 출력하지 않았고 아래 비커밋 파일을 mode `0600`으로 생성했다.
  - `spike-out/ops/review-team-guide-kim-noten.im.md`
  - `spike-out/ops/review-team-guide-young-noten.im.md`
  - 운영자 통합본: `spike-out/ops/review-team-credentials.md`
- 첫 배치: `2026-W30`, batch id `453c8904-9a8c-4b69-b2bd-e54770438310`, seed `236500258`, 공고 21건, 논리 항목 54개, 배정 row 66개, blind 24 row/12쌍. `kim` 27항목, `young` 39항목이며 전부 pending이다. 재실행 멱등 종료, 각 blind 그룹 2인 배정, assignee FK 누락 0건을 확인했다.
- production deployment: Vercel deployment `dpl_EdYgpZq14FzXZj8goRhgJCPC9on3`, `READY`, alias `https://ops.changupnote.com`.
- 실제 reviewer password 세션 검증:
  - `kim`: 큐 10공고/27항목, `young`: 큐 14공고/39항목.
  - 양 계정 `/review`·`/review/guide` 200.
  - `/credits`와 `/review/adjudicate`는 `/review`로 307, flywheel·registry API는 403.
  - `kim` 세션의 타인 전용 notice GET 403, 본인 blind notice GET 200, blind item payload 금지 키 0건.
- Cloudflare allowlist WAF는 적용 전후 모두 활성 상태를 유지했다. 규칙이나 허용 IP는 변경하지 않았다.

남은 것은 시스템 구현이 아니라 사람 검수 사이클이다. 운영 담당자는 개인 전달 문서를 각 본인에게 1:1로 보낸 뒤 공용 파일을 폐기하고, 첫 공고를 창업자 판정과 대조해 온보딩한 다음 금요일 `lab:collect`·`lab:reconcile` 순서로 진행한다.

### 9.7 검수자 화면 피드백 후속 반영 (2026-07-23)

첫 운영 화면 점검에서 확인된 가독성·판정 흐름 문제를 다음처럼 보정했다.

- 큐의 검수 CTA를 배경과 텍스트가 명확히 구분되는 outline `검수 시작` 버튼으로 변경했다.
- `size` 같은 내부 영문 필드는 `기업 규모` 등 한글 업무 용어를 주 표기로 바꿨다. 영문 필드명은 식별이 필요할 때만 보조 정보로 남겼다.
- 원본 JSON 대신 `AI 분석: 이 공고의 기업 규모 조건은 “소기업”이며 필수 조건입니다. 공고 원문에서도 실제로 이렇게 요구하나요?` 형식의 질문을 주 화면에 표시한다. 추출 값·원문 인용·검수 대상 선정 이유를 사람이 읽을 수 있는 문장으로 정리하고 JSON은 접힌 `기술 정보 보기`로 이동했다.
- 한 화면에 모든 JSON 카드를 쌓는 대신 현재 필드 1개를 판정한다. `저장하고 다음 미판정 항목` 성공 후 다음 미저장 필드가 자동으로 열리고, 이미 저장된 필드는 초기 진입에서 건너뛴다.
- 오른쪽 `전체 필드` 사이드바에 저장 완료·저장 전 변경·미판정과 저장한 판정명을 표시한다. 저장한 필드도 명시적으로 선택해 수정할 수 있다.
- 왼쪽 근거 영역에 실제 공고 원문 페이지 링크를 추가했다.
- 배정 공고의 HWP/HWPX 첨부 목록을 연결하고 기존 `@rhwp/editor` 기반 RHWP Studio 미리보기 페이지를 ops에 추가했다. 미리보기는 새 탭으로 열려 현재 판정 입력을 보존하며, 파일은 서버에서 공고 출처별 허용 호스트만 프록시한다. reviewer의 notice assignment를 첨부 메타·파일 API에도 동일하게 강제하고 30MB 상한, redirect 후 호스트 재검증, `no-store`를 적용했다.
- 화면 내 가이드와 `docs/guides/review-team-member-guide.md`를 새 흐름에 맞춰 갱신했다. 개인 전달본은 같은 가이드 원문으로 다시 생성한다.

후속 검증은 한글 질문 변환·blind 질문·첨부 URL allowlist 단위 테스트, admin typecheck/build, admin route 역할 검증을 포함했다.

- 구현 커밋: `99c6585` (`feat: 검수 워크스페이스 판정 흐름 개선`)
- RHWP 운영 검증 보정:
  - `79e0d8e` — HWPX 복구/비표준 안내가 뜰 때 바깥 로딩 오버레이가 Studio 조작을 막지 않도록 수정.
  - `270fbb6` — `@rhwp/editor` iframe에 `width: 100%`, `height: max(32rem, calc(100vh - 18rem))`을 지정해 기본 150px 높이로 안내 버튼이 잘리는 문제를 수정.
- 최종 production deployment: `dpl_8rjkmEPZ4Uts8K5iw9TLCDdxCG4L`, `READY`, alias `https://ops.changupnote.com`.
- 실제 `kim@noten.im` reviewer 세션에서 판정 저장은 건드리지 않고 다음을 확인했다.
  - 큐의 `검수 시작` CTA가 outline 스타일로 표시됨.
  - 상세에서 `#1 기업 규모`와 보조 영문 `size`, `소상공인, 소기업` 추출 값, 필수 조건 질문, 원문 인용이 표시됨.
  - 오른쪽 전체 필드에 `0/1`, `미판정`과 진행률이 표시됨.
  - 공고 원문 링크와 HWPX 첨부 170KB가 reviewer 권한으로 열림.
  - HWPX 비표준 자동 보정 후 로컬 글꼴 권한을 요청하지 않고 대체 글꼴을 선택해 28페이지 RHWP 미리보기 완료. 상단 완료 문구와 Studio 상태줄의 `1 / 28 쪽`을 확인했다.
- 공용 멤버 가이드와 `kim`, `young` 개인 전달본을 새 화면·RHWP 안내 흐름으로 갱신했으며 개인본 mode `0600`을 유지했다.
