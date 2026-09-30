# PROGRESS — 디자인 2라운드 코드 반영 (2026-09-30)

**목표.** Claude Design 2라운드(`/Users/ffgg/noten.works/cunote/docs/design/2026-09-30-workbench-claude-design-r2/`, 정본 소스 `0N *.dc.html`)를 브랜치 `coolwithyou/authoring-first`의 실제 화면에 반영한다. 기존 구현(시트 4개·탐색 패널·CTA 분리·변환 요청)·서버 계약·테스트를 깨지 않는다. 사용자 지시: "이대로 반영해줘, 반영 과정에서 구현이 틀어지지 않게 조심하고".

**완료 조건.**
- 각 WP의 화면이 디자인 소스의 구조·어휘와 일치하고, `pnpm --filter @cunote/web typecheck` 통과, 관련 단위 테스트 통과, UI 드리프트 스캔(`rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**' | wc -l`)이 기준선 **49**를 넘지 않는다.
- `packages/contracts` OpenAPI·모바일 DTO 무변경. DB 마이그레이션 추가 없음(기존 테이블만 사용). `components/app/verdict-badge.tsx`(헌법 8조 4상태) 무변경.
- WP별로 커밋(한국어 제목, 본문에 이유, 명시 스테이징, Co-Authored-By 없음). 커밋은 메인 세션이 순차 수행.

## 결정 로그
- **D1. 4상태 판정 뱃지는 유지한다.** 디자인의 "남은 쟁점 N / 필수 조건 확인 완료 / 명백한 불일치 N" 뱃지 문구는 `VERDICT_LABEL`(헌법 8조 단일 원천)을 바꾸지 않고, 그 옆·아래의 **집계 문구**("확인된 조건 N/M · 남은 쟁점 K", "불일치 J")로 반영한다. 헌법 어휘 교체는 별도 제품 결정으로 남긴다.
- **D2. 회사 자료 화면 경로는 `/settings/writing-sources`**(설정 하위, 사이드바 항목 추가 없음 — 계획 §3.2). API는 `/api/web/companies/[companyId]/writing-sources`(계획 §5.3 경로).
- **D3. 초안 문단 종류 라벨은 "회사 자료 기반 / 이번 사업 계획 / 검토할 제안"으로 통일**(rail·시트 공통, 단일 원천 `lib/documents/writingComposition.ts`).
- **D4. 관련성 이유 "전국 대상·이전 허용"은 미반영**(core relevance 변경 필요, 계획 §4.2 후속). 화면에는 기존 ranking.reasons만 표시.
- **D5. 기존 컴포넌트·토큰만 사용**(shadcn primitive, globals.css 토큰). hex·raw 엘리먼트 금지.

## 작업 패키지 (파일 겹침 없음, 병렬)

### WP-A 공고 요약 (`03 공고 요약.dc.html`)
파일: `apps/web/src/features/grant-overview/**`, `apps/web/src/app/grants/[grantId]/page.tsx`, `apps/web/src/features/apply-sheet/ConversionPollTrigger.tsx`, 신규 `apps/web/src/lib/server/documents/draftResume.ts`(+test)
- [x] 저장본이 있으면 주 CTA `문서 열기` + 캡션 "저장본 N · 마지막 서버 저장 M월 D일 HH:mm · 같은 문서와 작성 상태로 돌아가요" (회사·공고별 최신 draft head revision 조회; 가상기업·관리자 미리보기는 제외) — `lib/server/documents/draftResume.ts`(`loadDraftResume`·`summarizeDraftResume`·`formatDraftResumeCaption`, RLS `withCunoteDbUser`), `grantOverviewCta` 3·4번째 선택 인자, 모드 `"resume"` 추가. 당일이면 디자인 F 처럼 "오늘 HH:mm". resume 모드에서는 디자인 F 대로 poll 트리거 숨김(workspace 가 동일 트리거 제공)
- [x] 명백한 불일치(필수·제외 fail)가 있으면 "중요 자격 쟁점 N건" 콜아웃 — 작성 CTA 유지, 잠금·삭제 없음 문구, 회사 프로필 정정 링크 — shadcn `Alert variant="destructive"`, 링크 `/settings?section=company`(SETTINGS_SECTIONS 의 `company` 확인). 조건별 문장은 `describeFailedCondition`("{조건} — 회사 정보({회사값})와 맞지 않아요."), 샘플 특정 문구 "출생연도가 다르면"은 "회사 정보가 다르면"으로 일반화
- [x] 지원 대상 지표·자격 조건 아코디언 요약을 "확인된 조건 N/M · 남은 쟁점 K(· 불일치 J)" 어휘로 — `countHardConditions`+`formatEligibilitySummary` 단일 함수, 아코디언 제목 "자격 조건"(디자인)·트리거 우측 집계·본문 캡션·"필수 · 제외"/"우대 · 집계에 넣지 않아요" 그룹 라벨. 총수 0 은 "매칭 확인 중" 유지. verdict-badge 무변경
- [x] 대기 양식 준비 요청 캡션 "양식 준비는 화면을 열 때 자동으로 시작되지 않아요. 요청해야 대기 양식을 처리해요." — idle 상태에만 muted 표시, busy 시 Spinner(data-icon). 기존 5상태 메시지 유지(none/unavailable 문구는 디자인과 다르지만 "기존 메시지 유지" 지시에 따름), props `{ grantId }` 불변
- 검증(2026-09-30): `tsx … grant-overview/logic.test.ts` 통과, `tsx … EligibilityMatchAccordion.render.test.tsx` 통과, `tsx … lib/server/documents/draftResume.test.ts` 통과, 드리프트 49, typecheck — 본인 파일 오류 0(타 WP 파일 `applications/pipeline.ts`·`documents/writingContext.ts` 오류는 별건)

### WP-B 기회 맵 (`01 공고 탐색.dc.html`)
파일: `apps/web/src/features/match-results/**`
- [x] 목록 상단 안내 "확인한 필수조건이 맞지 않는 공고만 제외했어요. 우대 조건·업종 키워드·빈 정보는 제외 사유가 아니에요." (`Programs.tsx` `EXCLUSION_POLICY_NOTE`, Alert, 회사·익명 결과 공통)
- [x] 카드 집계 문구 "확인된 조건 N/M · 남은 쟁점 K(· 불일치 J)" (기존 "충족 확인·미충족·미확인" 대체), 백분율·점수 노출 없음 (`logic.ts` `formatConditionTally`; M=0이면 "매칭 확인 중")
- [x] discovery reason 라벨: `period_unconfirmed` → "접수 여부 확인 필요", `not_started`/upcoming → "모집 예정 · M/D 접수 시작" (`logic.ts` `DISCOVERY_REASON_LABEL`/`discoveryReasonLabel`; MatchCard에 applyStart가 없어 현재 화면은 "모집 예정"까지만, 날짜는 호출부가 넘길 때 붙음)
- 검증 결과(2026-09-30): match-results 테스트 12/12 통과, typecheck는 match-results 0건(잔여 오류는 WP-A 파일), 드리프트 49
- 검증: `tsx --tsconfig apps/web/tsconfig.json apps/web/src/features/match-results/logic.test.ts` 등 match-results 테스트 전부, typecheck

### WP-C 신청 관리 (`02 신청 관리.dc.html`)
파일: `apps/web/src/lib/server/applications/pipeline.ts`(+ 신규 test), `apps/web/src/features/applications/ApplicationPipelineView.tsx`
- [x] 항목별 세 진행 상태(자격 확인 / 작성 기능 / 문서 완성) 서버 집계(additive 필드) — 기존 테이블만(grant_document_drafts, grant_document_revisions, document_writing_sections, MatchCard ruleTrace) — `ApplicationPipelineItem.writing?` + 순수 함수 `buildWritingStatus`
- [x] 카드에 3열 표기 + CTA `문서 열기`/`작성 시작`/`저장본 열기`, 마감 문서 캡션, 완료율 미표시 고지
- [x] 헤더 캡션·하단 고지 문구 (h1도 디자인대로 "신청 관리"로, 전체 빈 상태는 장면 B 문구)
- 검증: 신규 `pipeline.test.ts`(집계 순수 함수), `applicationManagementFeedback.test.ts`, typecheck — 2026-09-30 통과(6/6, ok, exit 0), 드리프트 49
- 미구현(의도): "저장하지 않은 변경 N건" 콜아웃(브라우저 탭 상태라 서버가 모름), "공고 링크로 시작"(계획 태그·동작 없음), 대기 양식 준비 요청 인라인(ConversionPollTrigger는 WP-A 소유)
- 메모: 메인 체크아웃 `.env`가 가리키는 DB에는 `document_writing_sections` 테이블이 없다(브랜치 마이그레이션 미적용). 문안 집계는 별도 트랜잭션·try/catch라 0으로 강등되고 초안 스냅샷은 보존됨(실측: 초안 4건·저장본 15건 회사에서 items 3, saved 합 15 일치)

### WP-D 회사 자료 (`04 회사 자료.dc.html`, 계획 §5.3)
파일: 신규 `apps/web/src/app/(app)/settings/writing-sources/page.tsx`, 신규 `apps/web/src/features/company-sources/**`, 신규 `apps/web/src/app/api/web/companies/[companyId]/writing-sources/**`, 신규 `apps/web/src/lib/server/documents/companyWritingSources.ts`, `apps/web/src/lib/server/documents/writingContext.ts`(내부 공유 최소 리팩터), `apps/web/src/features/settings/SettingsPageView.tsx`(링크 1개)
- [x] 회사 공통 자료 목록(제목·범위·기준일·PDF 쪽·사용 중인 문서 N건·상태) / 내용 보기 / PDF 원본 / 사용 중단 / 텍스트·PDF 추가 — `/settings/writing-sources` + `features/company-sources/` + `/api/web/companies/[companyId]/writing-sources{,/pdf,/[sourceId],/[sourceId]/original}` + `lib/server/documents/companyWritingSources.ts`
- [x] 권한: 회사 멤버 읽기, owner/admin/member 쓰기(`canWriteCompany` 단일 원천 = RLS `can_current_user_write_company`). 경로 companyId는 `requireCompanyAccess({ companyId })` + `assertCompanyPathScope` 2중 검사. 이번 신청 전용 자료는 목록 표시 + "작성 화면 열기" 링크만(이 API에서 중단 시 409)
- 검증(2026-09-30 실행): `tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/documents/companyWritingSources.test.ts` PASS · `apps/web/src/features/company-sources/presentation.test.ts` PASS · `apps/web/src/features/company-sources/CompanySourcesView.render.test.tsx` PASS · writingContext 기존 테스트 3건 PASS · `pnpm --filter @cunote/web typecheck` exit 0 · 드리프트 49(신규 파일 0)
- 미구현(의도): 디자인의 "다시 사용"(DB `protect_writing_source` 트리거가 withdrawn_at 되돌리기 금지), "추출 중/추출 실패" 상태(동기 추출이라 상태 값 없음, 디자인도 계획 태그), h1 옆 "계획" 태그(구현됐으므로 제거). RLS 0094 확인: draft_id NULL 행 읽기(멤버)·insert(쓰기 역할+created_by 본인)·update 허용 → 마이그레이션 불필요

### WP-E 작성 화면 카피 정합 + WP-F 랜딩 (`06 문항별 작성.dc.html`, `05 랜딩 히어로.dc.html`)
파일: `apps/web/src/features/apply-workspace/WritingSectionsPanel.tsx`, `FieldAgentRail.tsx`, `WritingContextPanel.tsx`, `apps/web/src/lib/documents/writingComposition.ts`, `apps/web/src/features/landing/landing-hero.tsx`, `marketing-sections.tsx`
- [x] 문단 종류 라벨 단일 원천 통일(D3), 초안 카드 "인용 근거 보기 · N건", 보완 질문 캡션, 문안 저장≠파일 반영 상시 고지
- [x] WritingContextPanel에 "회사 공통 자료 관리 →" 링크(`/settings/writing-sources`)
- [x] 랜딩 히어로 카피(아이브로·헤드라인 3행·서브·신뢰 문장·CTA "내 회사로 시작") + 특징 3열 카피
- 검증: `pnpm test:apply-workspace`, 랜딩 render 테스트(`tsx --tsconfig apps/web/tsconfig.json apps/web/src/features/landing/landing-copy.render.test.tsx`), `tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/documents/writingComposition.test.ts`, typecheck

## 진행 상태
- 2026-09-30 21:20 기준선: typecheck 통과, 드리프트 49, 워크트리 클린(HEAD d7098d9).
- WP-E/F 완료(미커밋): test:apply-workspace 14건·landing-copy.render·writingComposition 테스트 통과, 드리프트 49 유지. typecheck는 본인 파일 무오류(동시 작업 중인 WP-D `lib/server/documents/writingContext.ts` 1건만 실패). 디자인과 다르게 한 점·미반영 항목은 WP-E/F 보고 참조.
- 2026-09-30 22:14 WP-A~E/F 서브에이전트 5개 병렬 착수(세션 모델 상속, 파일 비중첩). 검수·커밋은 메인 세션.

- 2026-09-30 22:50 메인 검수·커밋: WP-B 7b38186(related_candidate 라벨을 "확인된 필수조건 불일치 없음"으로 완화), WP-A 664efc6(저장본 포맷 함수를 `lib/documents/draftResume.ts` 순수 모듈로 분리 — 화면 로직이 DB 클라이언트를 import하지 않게), WP-E/F c260922. 각각 관련 테스트 통과·드리프트 49. typecheck 잔여 오류는 WP-D 작업 중인 writingContext.ts 1건.

- 2026-09-30 23:40 **전 WP 커밋 완료(브랜치 `coolwithyou/authoring-first`, d7098d9 → 6커밋)**: 7b38186 WP-B 기회 맵 · 664efc6 WP-A 공고 요약 · c260922 WP-E/F 문안 시트·랜딩 · a51d62b WP-D 회사 자료(+브레드크럼 라벨) · 6f71e59 WP-C 신청 관리 · (다음 커밋) `test:design-r2` 스크립트·이 진행 파일. 최종 typecheck 통과, 드리프트 49, `pnpm test:design-r2`(8파일) 통과, `pnpm test:apply-workspace`·match-results 12건·writing-context 스위트 통과. contracts/core/db 무변경.
- 메인 세션이 에이전트 산출물에 가한 수정: WP-B `related_candidate` 라벨 "필수 조건 확인 완료"→"확인된 필수조건 불일치 없음"(unknown 조건이 남아도 candidate가 되므로 "확인 완료"는 과장); WP-A 저장본 포맷 함수를 `lib/documents/draftResume.ts`로 분리(화면 로직→DB 클라이언트 import 차단); WP-D `app-breadcrumb.tsx`에 `/settings/writing-sources: 회사 자료` 추가.

## 디자인 대비 의도적 차이·후속 (사용자 확인용)
- **판정 뱃지 4상태 어휘 유지(D1)** — 디자인의 "남은 쟁점 N / 필수 조건 확인 완료 / 명백한 불일치 N" 뱃지는 집계 문구로만 반영. 헌법 8조 어휘 교체는 별도 결정.
- **"전국 대상·이전 허용" 관련성 이유 미반영(D4)** — core relevance 변경 필요.
- **"모집 예정 · M/D 접수 시작"의 날짜 부분** — MatchCard DTO에 applyStart가 없어 현재는 "모집 예정"까지만(함수는 날짜 옵션 지원). contracts 확장 시 즉시 표시 가능.
- **접힌 카드(NoticeCard)에는 집계 문구 미표시** — 펼친 카드에만. 디자인은 목록 카드에도 "확인된 조건 N/M" 표시 → 원하면 NoticeCard note 확장.
- **랜딩 "지금 신청 가능한 지원사업 N건" 필 제거** — 디자인 05에 없음. `openCount` prop은 계약 유지용으로만 남음. 신뢰 문장이 "입력 정보는 암호화돼요 · 광고 전화 없어요"를 대체.
- **회사 자료 "다시 사용"(restore) 미구현** — DB `protect_writing_source` 트리거가 withdrawn_at 되돌리기를 금지. 제품 결정 필요.
- **신청 관리 자동 반영 분자는 근사치** — 서버에 결속 상태가 저장되지 않아 fieldId가 있는 답변 수로 계산(스튜디오 실시간 boundCount와 다를 수 있음).
- **신청 관리 저장본 수 vs 공고 요약 저장본 수 정의 차이** — 공고 요약 "저장본 N"은 문서(초안) 수, 신청 관리는 revision 수를 저장본 유무 판정에만 사용(숫자 미표시). 화면 간 충돌 없음.
- **시각 검수 미수행** — dev 서버는 사용자 소유. 확인 경로: `/dashboard`(안내·집계·사유 라벨), `/grants/<id>`(콜아웃·문서 열기·아코디언), `/applications`(3열), `/settings/writing-sources`, `/grants/<id>/workspace` 문안 시트, `/` 랜딩.
- 메인 `.env` DB에 `document_writing_sections` 없음(브랜치 마이그레이션 0094~0098 미적용) → 그 환경에서 문안 집계는 0으로 강등.

## 운영 반영 (2026-09-30 밤, 사용자 지시 "운영에도 반영해줘")
- **운영 DB 마이그레이션**: `.env`의 DATABASE_URL(운영 Supabase, 풀러 6543)과 같은 경로의 **세션 모드(포트 5432)** 접속으로 `pnpm db:migrate` 실행 → 0094~0098 적용(적용 행 95→100). 사후 확인: 새 테이블 5개 존재, RLS 전부 on, 정책 15개, `protect_writing_source` 트리거 존재. 모두 추가 전용 SQL(DROP/TRUNCATE/DELETE 없음, `drizzle-kit generate`는 스키마 드리프트 0).
- **주의(실측)**: `.env`의 `POSTGRES_URL_NON_POOLING`은 같은 프로젝트 ref지만 **공용 테이블 0개인 빈 DB**를 가리킨다(`drizzle.__drizzle_migrations` 없음). 마이그레이션에 쓰면 안 됨. journal의 `0005_familiar_thaddeus_ross`는 적용 이력과 시각이 어긋나 있으나 마이그레이터는 마지막 적용 시각 이후만 적용하므로 영향 없음(기존 상태).
- **배포**: 워크트리 HEAD 675ac15를 `.git`·node_modules 제외 사본(`scratchpad/deploy/changupnote-675ac15`, 루트 `.vercel/project.json` 복사)에서 `vercel deploy --prod --yes --scope noten` → `dpl_J2eadgJZQTAY3DPhQ8iq8sZzWogK` READY(production). 직전 운영 배포는 09-28 23:36(origin/main ab4e725 상당).
- **운영 env 미설정으로 비활성인 기능**: `CUNOTE_WRITING_SOURCE_KEY_BASE64` 없음 → 회사 자료 PDF 업로드 비활성(텍스트 자료는 동작), `CUNOTE_WRITING_SECTION_AGENT_ENABLED` 없음 → 문항별 문안 "초안 요청"·신청 관리 "문안 제안" 비표시. 켜려면 Vercel production env 추가 후 재배포(PDF 키는 분실 시 기존 원본 복호 불가 — 보관 정책 결정 필요).
- **git**: origin/main(ab4e725)은 배포본보다 16커밋 뒤. main 머지·push는 배포 연동 가능성이 있어 사용자 판단으로 남김. 로컬 main의 d7958c6(랜딩 확인 모달 상호 재조회)과 74개 미커밋 변경은 이번 배포에 포함되지 않음.

## 막힘
- (없음)
