# 이상 플로우 세로 관통 계획 — 갭 분석과 슬라이스 실행

> **🟡 진행 상황 (2026-07-08 세션 진행 중)**
>
> - 🔶 슬라이스 A: 코드 배선 완료(`ad3d8a8` — 폴링 스윕 헬퍼·cron/on-demand 라우트·ingest 말미 스윕·뷰어 진입 링크·변환 중 배지). **잔여: env 등록 + E2E** — `CONVERSION_SHARED_SECRET`이 GCP Secret Manager에만 있고 `sw@noten.im` 토큰 만료로 접근 불가. 사용자 액션: `gcloud auth login sw@noten.im` 후 세션이 .env.local·Vercel env 등록 → `pnpm conversion:poll -- --write --limit=3` E2E → 배포
> - ✅ 슬라이스 B: 구현 완료(`be6bcbf`) — B1 유입기(`pnpm import:review-docs:from-surfaces`)·B2 사전라벨(`pnpm prelabel:review-docs`, 순환성 가드 유지)·B3 승인↔반영 브리지(approve→grant_document_fields+fields_ready, unapprove→롤백). 실DB 왕복 `pnpm verify:review-surface-bridge` 11체크·잔재 0. **실데이터 흐름은 슬라이스 A 점화(env) 후**: 유입기→사전라벨→/internal/review 검수→승인→뷰어 필드 노출. B2 실 LLM 스모크도 그때 1문서로 수행
> - ✅ 슬라이스 C: 코칭/문의 연결 (`ad3d8a8` — coaching 카테고리, /support prefill, 공고 상세 '도움받기' CTA)
> - ⬜ 슬라이스 D~G: 후속 등재 (Gate 3 대조 → fill planner, 통합 작성 화면, hwp2hwpx, AI 가이드)

## 1. 목적

사용자가 정의한 서비스의 이상 플로우를 현재 코드베이스와 대조해 **왜 지금 이 플로우가 완주되지 않는지**를 평가하고, 완주 가능하게 만드는 실행 계획을 슬라이스 단위로 확정한다.

이상 플로우 (사용자 정의, 2026-07-08):

1. 랜딩에서 사업자번호 입력 → 지원사업 매칭 결과
2. 로그인 후 추가 정보 입력 → 더 정밀한 매칭, AI에게 회사 맞춤 지원 정보 가이드
3. 지원사업 선택 후 "지원하기" → 시스템이 지원 조건·상황 판단
4. **좌측: 공고의 사업계획서 등 HWP 문서 / 우측: 빈칸마다 넣을 텍스트 가이드 + 칸별 설명글**
5. 제안 동의 → 한글 파일에 입력해 다운로드
6. 헷갈리면 코칭 신청 또는 문의
7. 내부 전문가가 새 공고의 분류·지원서 내용을 수동 검수·보정하는 시스템 (AI 자동화 + 초기엔 사람 검수)

이 플로우는 마스터 설계(`docs/public-support-application-guide-master-architecture.md`) 22장 최종 제품 정의와 일치한다. **새 설계가 필요한 것이 아니라, 설계된 파이프라인의 끊어진 구간을 잇는 문제다.**

## 2. 갭 분석 — 단계별 현재 상태 (2026-07-08 실측)

| # | 이상 플로우 단계 | 현재 상태 | 판정 |
|---|---|---|---|
| 1 | 사업자번호 → 매칭 | `LandingExperience` 사업자번호 입력 → `/api/web/teaser`(`buildTeaser`) → `/matches`. 공고 30,826건(open 982) | ✅ 동작 |
| 2 | 로그인 → 정밀 매칭 | onboarding·next-question·`matchGrantCriteria`·`runLiveCompanyMatch` 존재. **병렬 세션이 `company_profiles.user_id` 분리 + MatchesExperience 개편 진행 중(0034)**. AI 대화 가이드는 없음 | 🔶 부분 |
| 3 | 지원하기 → 조건 판단 | `/grants/[grantId]` ApplySheet: 충족/확인필요 체크리스트(rule trace), 서류 그룹화, lesson 가이드 | ✅ 동작 |
| 4 | 좌 문서 / 우 필드 가이드 | 뷰어(`/grants/[grantId]/preview` + FieldInspectorPanel) **구현돼 있으나 데이터 0**: `document_artifacts` 0건, `grant_document_fields` 0건. 진입 링크도 없음(고아 페이지) | ❌ 죽어 있음 |
| 5 | 동의 → 한글 파일 다운로드 | HWPX 채움 트랙 Phase 0~3 완료(`hwpx-fill.ts`, download route `format=hwpx`). 단 한글 첨부 78%가 `.hwp`라 hwp2hwpx 필요(설계 확정, 구현 대기) | 🔶 부분 |
| 6 | 코칭/문의 | support tickets 시스템 존재(8건). 공고·필드 맥락이 실리는 CTA 없음, "코칭" 상품 흐름 없음 | 🔶 부분 |
| 7 | 내부 전문가 보정 | `/internal/review`(필드맵 검수 GUI, 질문 모드) + `/internal/knowledge`(lesson 인제스천·인박스·주입) 존재. **그러나 검수 대상이 스파이크 45문서에 고정** — 신규 공고 유입 경로 없음, 승인 결과가 사용자 화면(grant_document_fields)으로 반영되지 않음 | 🔶 부분 |

파이프라인 실측 (2026-07-08 프로덕션 DB):

```
grants                     30,826 (open 982)
grant_attachment_archives  converted 1,462 · skipped 768 · null 266 · failed 10
grant_application_surfaces pending 191 (다른 상태 0 — 변환 완료가 한 건도 없음)
document_artifacts         0
grant_document_fields      0
golden_set(field_map)      0 (검수 45문서: pending 39 · in_review 6 · approved 0)
review_lessons             approved 23 (지식 루프만 가동 중)
grant_document_drafts      5 · support_tickets 8
```

## 3. 왜 플로우가 진행되지 않는가 — 구조적 원인

1. **변환 파이프라인의 마지막 마일 미배선.** `registerAttachmentConversions`는 인제스천(`normalizedGrantPublisher`)에 배선돼 surface 191건이 등록됐지만, `poll-conversion-jobs`(T8)는 **CLI로만 존재하고 호출처가 0곳**이다. 게다가 `CONVERSION_SERVER_URL`/`CONVERSION_SHARED_SECRET`이 로컬 `.env.local`에도 Vercel에도 없다(핸드오프 A7 미완). Cloud Run 변환 서버는 배포·스모크까지 끝났는데 아무도 부르지 않는다. → artifact 0건, 뷰어에 보여줄 문서 없음.
2. **필드 공급이 사람 병목에 묶인 채 대체 경로가 없음.** Phase 4 엔진 배선([F2])은 Gate 2 측정을 기다리고, Gate 2는 리뷰팀 45문서 검수(approved 0)를 기다린다. 그 동안 `grant_document_fields`는 0건 — 필드 오버레이·인스펙터·자동채움 전부 빈 상태. 사용자가 요청한 "초기에는 사람이 검수해 플로우를 굴린다"는 바로 이 병목의 우회로인데, **검수 승인 → 사용자 필드 반영 브리지가 없다** (`approveReviewDoc`는 golden 승격까지만, `applyReconciledFields`는 후보 파이프라인 전용).
3. **필드 "가이드"(값 제안 + 설명글)의 생성기가 없음.** 초안 생성은 `deterministic-document-draft-v1`(회사 프로필 복사 수준). Phase 5(Evidence-grounded Draft: fill planner + LLM structured output + validator)가 미착수라 "이 칸에 무엇을 어떻게 쓸지"의 해설이 없다. 프로젝트 규칙상 Gate 3 착수 전 외부 대조 의례가 선행돼야 한다.
4. **화면이 이어져 있지 않음.** 뷰어는 진입 링크가 없는 고아 페이지고, 작성 워크스페이스(DocumentDraftWorkspace)와 뷰어가 분리된 두 세계다. "좌 문서 / 우 가이드" 통합 화면이 없다.
5. **전문가 보정 루프가 실서비스와 절연.** 검수 도구는 스파이크 자산(45문서) 전용 임포트로만 채워지고, 새 공고가 검수 큐에 흐르지 않는다. lesson 루프만 실서비스에 닿아 있다.

## 4. 전략 — "엔진을 기다리지 않는" 세로 관통

Gate 2(엔진 자동 필드 추출)를 기다리지 않고, **사람 검수를 1급 필드 공급원으로 승격**한다:

```
[기존 설계]  첨부 → 변환 → (Gate 2 엔진) → field_candidates → reconcile → grant_document_fields
[이번 우회]  첨부 → 변환 → LLM 사전라벨 → 전문가 검수/보정(/internal/review) → 승인
                                          └→ grant_document_fields 반영 (human_review 후보 → 기존 reconcile 경로)
```

- 순환성 원칙 유지: AI 사전라벨은 검수 없이 절대 golden/사용자 노출로 승격되지 않는다. 승인된 것만 반영.
- 이 경로는 버려지지 않는다: Gate 2 이후 엔진이 붙어도 검수·보정은 마스터 9.8(리뷰어 워크스페이스)의 상시 운영 경로다. 지금 만드는 브리지가 곧 운영 도구가 된다.
- 커버리지 전략: 공고 몇백 개 수준(사용자 발언)이므로 초기의 문서 단위 수동 검수는 현실적. 노출 우선순위(open + 마감 임박 + 매칭 빈도)로 검수 큐를 정렬한다.

## 5. 슬라이스 계획

### 슬라이스 A — 파이프라인 점화 (이번 세션, 메인 직접)

목표: 실공고 첨부가 프로덕션에서 page image까지 도달하고, 사용자가 공고 상세에서 문서를 볼 수 있다.

- **A1. env 배선**: `.env.local` + Vercel(changupnote, noten 팀)에 `CONVERSION_SERVER_URL`(Cloud Run URL)·`CONVERSION_SHARED_SECRET`(Secret Manager에서, 값 비노출) 등록.
- **A2. E2E 실증**: `pnpm conversion:poll -- --limit=3`(dry-run) → `--write --limit=3` → `document_artifacts` 생성·`preview_ready` 전이 확인. 이후 전체 스윕은 cron이 흡수.
- **A3. 폴링 배선 2경로**:
  - cron 라우트 `/api/cron/poll-conversions` (`authorizeCronRequest`, `maxDuration 300`, limit 보수적) + `vercel.json` crons 등재 (Hobby 하루 1회 제약).
  - on-demand 라우트 `POST /api/web/grants/[grantId]/conversions/poll`: 로그인 사용자가 공고 상세 진입 시 해당 공고의 pending surface만 즉석 폴링(클라이언트 백그라운드 fetch, 페이지 렌더 비차단, surface ≤3·짧은 예산). 방문한 공고가 먼저 살아나는 체감 경로.
- **A4. 뷰어 진입 링크**: ApplySheetView(비dirty)에 "원문 문서 미리보기" 진입 — preview 가용성(page artifact 존재)을 서버에서 조회해 조건부 노출, 없으면 "변환 중" 상태 표기.

검증: 실공고 1건에서 상세 → 미리보기 → 페이지 이미지 렌더까지 브라우저 왕복. `conversion-dev/` 프리픽스 관례는 프로덕션 실데이터 반영이 목적이므로 미적용(검증 행 삭제 불필요 — 실서비스 데이터로 남긴다).

### 슬라이스 B — 전문가 보정 브리지 (이번 세션, Opus 위임)

목표: 새 공고가 검수 큐에 흐르고, 전문가 승인이 곧바로 사용자 필드가 된다.

- **B1. 검수 큐 유입기**: `preview_ready` surface(+page_image artifacts)를 `field_map_review_docs`에 등재하는 스크립트/관리 액션. docRef는 surface 기반 신규 네임스페이스(`surface:<id>`), 이미지 키는 artifact R2 키 재사용. 우선순위: open 공고 · 마감 임박 · `.hwp/.hwpx/.pdf` 작성형 첨부.
- **B2. LLM 사전라벨 러너**: `generate-review-questions.ts`의 Anthropic vision 호출 패턴 재사용. page image → 필드 후보(label/type/bbox/section) 생성 → 검수 문서 초기 fieldMap으로 저장(status는 어디까지나 pending). Gate 1 기준서 규칙 1~10을 프롬프트에 주입.
- **B3. 승인 반영 브리지**: `approveReviewDoc` 성공 시 확정 fieldMap을 `field_candidates`(source=`human_review`, confidence 1.0)로 적재 → 기존 `applyReconciledFields`(reconcile-v0) 경유 → `grant_document_fields` upsert + surface `fields_ready` 전이. 취소(`unapproveReviewDoc`) 시 반영 철회 정책 포함.
- 질문 생성(`generate:review-questions`)은 신규 문서에도 동일 적용.

검증: 실공고 1건 — B1 등재 → B2 사전라벨 → 검수 GUI에서 승인 → `/grants/[grantId]/preview`에 필드 오버레이 노출까지 왕복.

### 슬라이스 C — 코칭/문의 연결 (이번 세션, 소형)

- ApplySheetView·DocumentDraftWorkspace·preview 인스펙터에 "막히는 부분 문의하기 / 코칭 신청" CTA. 기존 support tickets 재사용, 공고·문서·필드 anchor를 subject/본문에 prefill. 신규 카테고리 `coaching`.
- 9.9(필드 단위 질문 + Tier 0 즉답)는 Phase 8 슬라이스로 후속 — 여기서는 anchor 실린 티켓까지만.

### 슬라이스 D — Gate 3 외부 대조 → Phase 5 fill planner (후속 세션)

- 관문 의례: `docs/research/CALIBRATION-TEMPLATE.md` 사전 등재 전제(fill strategy 5종·evidence 정렬 validator·적합도 라벨 UX) 외부 대조 먼저.
- fill planner: 필드 × 회사 프로필/증거 → 제안값 + 쉬운 해설 + 근거 + confidence (LLM structured output, hallucination validator, 근거 없는 수치 금지 — 마스터 3.4/7.6/8.7/8.8).
- 저장: `grant_document_fields`의 fill plan 확장 또는 `field_fill_plans` (마스터 7.6 준거). 인스펙터·작성 워크스페이스에 표시.

### 슬라이스 E — 통합 작성 화면 "좌 문서 / 우 가이드" (후속 세션, wilson/Opus 위임)

- `/grants/[grantId]/workspace`: 좌측 페이지 이미지 뷰어(기존 DocumentPreviewView 재사용) + 우측 필드 인스펙터(제안값·해설·근거·수정 저장·검토 완료) + 진행률 + "동의한 값으로 HWPX 다운로드"(기존 download route 연결).
- 기존 preview·DocumentDraftWorkspace는 이 화면으로 수렴.

### 슬라이스 F — hwp2hwpx 트랙 (설계 확정 완료 — 별도 트랙 착수 대기)

- `.hwp` 78% 커버. 기존 확정 설계 문서를 따른다. 완료 시 슬라이스 E의 다운로드가 대부분의 정부 양식을 커버.

### 슬라이스 G — AI 가이드/질문 루프 (Phase 8 정렬, 후속)

- 매칭 결과·공고 상세에서 회사 맥락 실린 대화형 가이드(Tier 0 응답 에이전트), 필드 단위 질문하기 → 리뷰어 에스컬레이션(9.4/9.9), 검증 Q&A 공개.

## 6. 이번 세션 실행 범위와 순서

1. 슬라이스 A 전체 (메인 직접 — env·배선·링크는 소규모 정밀 작업)
2. 슬라이스 B 전체 (Opus 서브에이전트 위임, 메인 검수·통합·커밋)
3. 슬라이스 C (소형)
4. D~G는 본 문서 등재로 후속 세션 트리거

병렬 세션 주의: `MatchesExperience.tsx`·`schema.ts`·repositories·`seed-demo.ts`·0034 마이그레이션이 미커밋 상태(사용자별 프로필 분리 작업 중) — **이 파일들은 건드리지 않고, 커밋은 경로 명시 스테이징**으로만.

## 7. 리스크와 가드

- **변환 서버 용량**: max-instances 1, 2Gi. cron/on-demand 모두 limit 보수적(cron ≤20, on-demand ≤3)·타임박스. 폭주 시 pending으로 남고 다음 사이클이 회복(재조정 스윕 설계 그대로).
- **LLM 사전라벨 순환성**: pending으로만 저장, 승인 없이는 어떤 사용자 노출·golden에도 닿지 않음 (기존 `field-map-review-guard` 재사용).
- **Hobby cron 하루 1회**: 체감 경로는 on-demand 폴링이 담당. 신규 공고 대량 유입 시 수동 `pnpm conversion:poll` 병행 가능.
- **hwp2hwpx 미완**: 당분간 HWPX 다운로드는 `.hwpx` 원본 공고에 한정 — UI에 정직하게 표기(기존 `hwpxTemplateAvailable` 플래그 그대로).
