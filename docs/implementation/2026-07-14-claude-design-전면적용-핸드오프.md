# Claude Design 전면 적용 — 핸드오프 (2026-07-14)

> **인수자**: Codex (또는 후속 세션). 이 문서 하나로 이어서 작업할 수 있게 작성됨.
> **목표**: `Changupnote Frames.dc.html` 디자인(13프레임)을 기존 디자인을 완전히 대체하며 전 페이지에 적용한다. 컨셉은 "복잡한 엔진, 단순한 조종석" — 화면은 결론과 다음 행동 하나만 말하고 근거·상세는 요청 시 공개.

---

## 0. 사용자 확정 결정사항 (2026-07-14)

1. **디자인 프레임이 없는 워크스페이스 페이지는 통폐합**: `/archive`·`/roadmap`은 매칭 결과 화면(접힌 섹션 "준비하면 열려요"/"접수 예정")으로 흡수, `/onboarding`은 랜딩→회사확인 플로우로 흡수, 네비에서 제거. `/team`·`/support`는 최소 스타일 정렬만 하고 존치.
2. **과금 표면(`/pricing`·`/credits`·`/billing`·`/account/usage`)은 이번 라운드 제외**: 화면 9(요금제)·10(이용권) 프레임이 dc.html에 없고 과금모델 열린 결정 7개 대기 중. 새 헤더·토큰만 자연 반영되게 두고 레이아웃은 현행 유지. (주의: 전달 프롬프트 §0.7은 "횟수(회)" 어휘가 정본, 화면 8~10 스펙의 "크레딧" 어휘는 구버전 잔재 — 과금 UI를 만들 일이 생기면 §0.7을 따를 것)
3. **착수 순서 = 퍼블릭 퍼널부터**: 공유 기반 → 랜딩+회사확인 → 매칭 결과+내 정보 시트 → 공고 요약 → 대시보드·신청관리·캘린더 → 지원서 작성 도우미.
4. 위임 모델: 구현·대량 작업은 저비용 모델(Opus/Sonnet 급)에 위임, 스펙이 확정된 기계적 포팅은 더 저렴한 모델로 충분.

---

## 1. 디자인 소스 접근 방법

### 1-a. 레포 내 사본 (권장 — 이것만으로 충분)
디자인 원본 전체를 이미 레포에 저장해 두었다. **MCP 연결 없이 작업 가능.**

- `docs/design/2026-07-14-changupnote-frames.dc.html` — 13프레임 전체 (인라인 스타일 HTML, 1,142줄)
- `docs/design/2026-07-14-components/AppHeader.dc.html` · `NoticeCard.dc.html` · `PrecisionGauge.dc.html` — 공유 컴포넌트 3종의 정확한 스펙 (props·상태 분기 포함)
- 텍스트 스펙(디자인의 의도·금지 규칙): `docs/research/2026-07-14-claude-design-전달-프롬프트.md` — §0 공통 규칙(비주얼 토큰·상태 어휘·금지 문구)이 특히 중요
- 정보 구조의 근거: `docs/research/2026-07-14-인터페이스-단순화-제안.md` — 인터페이스 헌법 8조, 상태 어휘 SSOT, 표면 통폐합 지도

### 1-b. Claude Design 라이브 프로젝트 (디자인이 갱신된 경우에만)
- 프로젝트 URL: `https://claude.ai/design/p/668d0cda-086e-4db4-b538-d42b826cb6cd?file=Changupnote+Frames.dc.html`
- 프로젝트명 `Claude design 전달 프롬프트` (소유: 한송욱), projectId `668d0cda-086e-4db4-b538-d42b826cb6cd`
- 파일 목록: `Changupnote Frames.dc.html`(메인 캔버스), `AppHeader.dc.html`, `NoticeCard.dc.html`, `PrecisionGauge.dc.html`, `support.js`, `uploads/…`
- **Claude Code에서 접근**: `DesignSync` 도구 — `get_project`/`list_files`/`get_file` (읽기는 권한 프롬프트 없음). 대용량 파일은 결과가 파일로 떨어지므로 JSON의 `content` 필드를 추출해 저장.
- **Codex 등 외부 도구에서 접근**: claude_design MCP 서버 `https://api.anthropic.com/v1/design/mcp` (인증: Claude Code에서 `/design-login`으로 발급). MCP가 안 되면 사용자에게 dc.html 재다운로드를 요청하거나 레포 사본을 그대로 쓸 것.

### 1-c. 프레임 인벤토리 (dc.html 행 범위)

| 섹션 id | 내용 | 행 범위 |
|---|---|---|
| `s8` | 화면 8 지원서 작성 도우미 — 변형 A(HWP 렌더 60%+인터뷰 카드 40%)/B(직접 입력)/C(완료)/전체 목록 토글/모바일 390/💬 물어보기 채팅+기관 문의 | 35~225 |
| `v3` | **랜딩 v3 (정본)** 1440 전체 + 마감 캘린더 v2(캘린더 연동 팝오버·리마인더)+캘린더 모바일 | 227~473 (랜딩 프레임 230~350) |
| `adj` | 로그인(카카오/네이버/이메일) 479~494 · 알림 설정 모달 495~519 · 작성 코칭 인터뷰(단일 질문) 520~546 · 마감 캘린더 547~599 · 계정 설정 600~617 | 476~618 |
| `s2` | 화면 2 회사 확인 다이얼로그 — 로딩/확인/오류 3상태 | 620~658 |
| `s3a` | 화면 3 매칭 결과 상태 A (기본, "준비하면 열려요" 펼침 포함) | 660~708 |
| `s3x` | 화면 3 카드 펼침 — AI 조언 변형 ①(문장만)/②(자가응답 버튼 2개+스낵바) | 710~779 |
| `s3b` | 화면 3 상태 B — 답변 직후(민트 토스트 카드+게이지 +9%p+NEW/제외 이동) + 무변화 답변 보조 컷 | 781~849 |
| `s3c` | 화면 3 상태 C — 질문 소진+0건 | 851~867 |
| `s3m` | 화면 3 모바일 390 | 869~910 |
| `s4` | 화면 4 내 정보 시트(420px) — 기본/인라인 편집/저장 직후 | 912~1013 |
| `s5` | 화면 5 공고 요약 + CTA 문구 변형 3종 스와치 | 1015~1057 |
| `s6` | 화면 6 신청 관리 리스트(⋯ 메뉴 열림 포함) | 1059~1103 |
| `s7` | 화면 7 대시보드(다음 행동 카드 1장 + 화면 3 재사용) | 1105~1139 |

키프레임 애니메이션 정의(랜딩 데모 카드용 k1~k7·g1·n1~n4, marquee, spin, caret)는 dc.html 13~31행.

**주의**: 화면 9(요금제)·화면 10(이용권) 프레임은 **없다**. 과금 접점(견적 배지·소진 모달·차감 토스트)도 프레임에 없음 — 결정 대기(§0-2).

---

## 2. 완료된 작업 — Phase 1 기반 (이 세션, 빌드 통과)

`pnpm --filter @cunote/web build` exit 0, 드리프트 스캔 37건(작업 전과 동일) 확인됨. **미커밋 상태.**

### 2-a. 토큰 보강 — `apps/web/src/app/globals.css` (+78줄)
`:root` + `@theme inline` 매핑으로 Tailwind 유틸 자동 생성. 기존 토큰 이름 변경 없음.
- 잉크: `--ink #222222`, `--ink-strong #191f28`
- 텍스트 램프: `--text-nav #4b5563`, `--text-secondary #6b7280`, `--text-tertiary #8b95a1`, `--text-quaternary #b0b8c1`
- 민트: `--brand-mint-ink #0ba678` 신설 (`--brand-mint-soft #e6fbf1`는 기존 재사용)
- 서피스: `--surface-soft #f8fafb`, `--surface-muted #f2f4f6`, `--surface-muted-hover #e5e8eb`, `--surface-hard #f7f8fa`
- 보더: `--border-subtle #f1f3f5`, `--border-muted #edf0f3`, `--border-card #eef2f6`, `--border-card-hover #c9def8`
- 판정 시맨틱 세트: `--verdict-open-bg/-fg`, `--verdict-answer-bg/-fg`, `--verdict-check-bg/-fg`, `--verdict-closed-bg/-fg`
- 그라디언트: `--grad-logo`(180deg 블루), `--grad-gauge`(90deg 민트) + `@utility bg-grad-logo`/`bg-grad-gauge` (Tailwind v4 콤마-arbitrary 함정 회피용)
- 그림자: `--shadow-notice`, `--shadow-notice-hover`, `--shadow-logo` — `shadow-[var(--…)]`로 사용

### 2-b. 공유 컴포넌트 신설 — `apps/web/src/components/app/`
후속 단계는 이 시그니처를 그대로 임포트할 것:

- **`verdict-badge.tsx`** — `VerdictStatus = "open" | "one_answer" | "check_source" | "closed"`, `VERDICT_LABEL`(지금 신청 가능/답하면 확정/원문 확인 필요/이번엔 어려움), `VerdictBadge({ status, … })`. **판정 4상태 어휘의 SSOT — 5번째 상태 발명 금지.**
- **`notice-card.tsx`** (client) — `NoticeCard({ title, dday, supportSummary, status, isNew?, note?, href?, onClick? })`, `status: VerdictStatus | "upcoming"`. 접힘 카드 4요소 계약(제목/뱃지/D-day/지원 요약): 실데이터 매칭 표면은 `실제 금액 > 신뢰 가능한 혜택 분류 > 공고문 확인 필요` 순으로 정하고, 기존 우측 굵은 텍스트 스타일을 유지한다. 정적 랜딩 예시는 금액을 그대로 쓸 수 있다. `D-N` N≤14 → 레드. `upcoming`은 뱃지 없이 D-day 자리 텍스트+정적 `접수 예정` 안내를 표시한다. `href`→`<a>`, `onClick`→`<button>`.
- **`precision-gauge.tsx`** — `PrecisionGauge({ pct, label, caption, meta, delta? })`. pct 0~100 클램프, 8px 민트 그라디언트 바, delta 민트 뱃지.
- **`app-header.tsx`** — `AppHeader({ user, links?, loginCallbackUrl?, homeHref? })`. 64px 스티키. 비로그인=로그인 버튼만, 로그인=링크(최대 3, `MAX_HEADER_LINKS`)+아바타(AccountMenu `variant="avatar"`). 기본 링크: 내 신청 현황→`/applications`, 내 정보→`/settings`(추후 내 정보 **시트** 트리거로 교체 예정 — Phase 3).

### 2-c. 셸 전환 (사이드바 폐지)
- `app-shell.tsx` — AppHeader+단일 칼럼 `<main>`으로 재작성. SidebarProvider/AppSidebar/SidebarTrigger/AppBreadcrumb/CreditBalanceWidget 사용 제거. **export 시그니처 유지** → `(app)/layout.tsx`, `team/page.tsx`, `grants/[grantId]/page.tsx` 무수정.
- `public-header.tsx` — AppHeader 래퍼로 재작성(시그니처 유지). 비로그인 마케팅 헤더는 디자인대로 로그인 버튼만(네비 링크는 로그인 시에만). 이 결정이 싫으면 여기서 뒤집을 것.
- `account-menu.tsx` — `variant?: "pill" | "avatar"` 추가 (기본 pill, 하위호환).
- `app-sidebar.tsx`/`app-breadcrumb.tsx`는 **미사용 상태로 존치** (통폐합 라운드에서 정리).

### 2-d. 이 세션이 만든/수정한 파일 (커밋 대상)
```
M  apps/web/src/app/globals.css
M  apps/web/src/components/app/account-menu.tsx
M  apps/web/src/components/app/app-shell.tsx
M  apps/web/src/components/app/public-header.tsx
A  apps/web/src/components/app/app-header.tsx
A  apps/web/src/components/app/notice-card.tsx
A  apps/web/src/components/app/precision-gauge.tsx
A  apps/web/src/components/app/verdict-badge.tsx
A  docs/design/2026-07-14-changupnote-frames.dc.html
A  docs/design/2026-07-14-components/ (3파일)
A  docs/implementation/2026-07-14-claude-design-전면적용-핸드오프.md (이 문서)
```
**⚠️ 워킹트리에 병렬 세션의 미커밋 변경이 섞여 있다** (`serviceData.ts`, `repositories/*`, `publicLookupProtection*`, API route 등). **`git add -A` 절대 금지** — 위 목록만 명시 스테이징하고, add와 commit은 한 호출로.

### 2-e. 중단 지점
Phase 2(랜딩) 서브에이전트를 기동 직후 중단시킴 — **랜딩 코드 변경은 없음**. Phase 2부터가 인수 범위.

---

## 3. 남은 단계 (권장 순서)

### Phase 2 — 랜딩 v3 + 회사 확인 다이얼로그
- 대상: `apps/web/src/app/(marketing)/page.tsx`, `src/features/landing/*`
- v3 프레임(230~350행)대로 5섹션: ①히어로(뱃지 실공고수+헤드라인 그라디언트+대형 입력폼+캡션) ②데모 카드 480px(16s 키프레임 루프 — dc.html 13~31행 키프레임을 globals.css에 등재) ③마퀴 공고 밴드(실데이터) ④3단계 카드 ⑤최종 CTA+FAQ 4개+한줄 푸터
- **Features 섹션·TrustStats 섹션 삭제** (파일은 미사용 존치). 금지: 통계 타일, 아이콘 그리드, CTA 문구 2종 이상
- 회사 확인 다이얼로그(s2, 620~658행) 3상태 — 기존 `biz-lookup-dialog`/`biz-lookup-form`의 API·플로우(`/api/web/business-lookup-suggestions` 등)는 유지, 표시만 교체
- 데이터: 히어로 뱃지 공고 수·마퀴 밴드는 `loadLandingGrantData` 실데이터. 실데이터 없는 수치는 표시 생략(목업 하드코딩 금지). 데모 카드 안의 "바다상회" 예시는 연출이므로 허용

### Phase 3 — 매칭 결과 루프 + 내 정보 시트 (★ 제품의 심장 1)
- 대상: `/(marketing)/matches` (`features/match-results/*`), 이후 `/dashboard`가 이 컴포넌트를 재사용
- s3a/s3b/s3c/s3x/s3m + s4 프레임대로: 결과 헤드라인(민트/블루 숫자) → PrecisionGauge → 다음 질문 카드(화면의 유일한 입력, 예/아니요/모름+보상 문구) → "지금 신청 가능" NoticeCard 목록(≤5+더보기, upcoming 흐리게) → 접힌 섹션 3줄(답하면 확정/준비하면 열려요/원문 확인 필요) → 바닥 한 줄(내 정보 시트 트리거)
- 카드 펼침: 충족 N건 요약 1줄 + 확인 필요 조건 행 + AI 조언 블록(데이터 있는 공고만) + 링크 2개 + 주 CTA 1개 + ⋯ 메뉴
- 상태 B(답변 직후): 민트 토스트 카드+변화 요약+게이지 delta+NEW 뱃지+제외 카드 흐림. 상태 C(0건). 모바일 390(질문 카드 첫 스크린)
- 내 정보 시트(s4): shadcn Sheet 420px — `자동으로 확인했어요 (N)`(민트, 출처 캡션) / `직접 채우면 더 정확해져요 (M)`(블루, **각 행에 보상 표기 필수**) / 인라인 편집 / 저장 직후 피드백. 기존 ProfileSection 11필드 그리드는 이 시트로 강등
- 데이터 배선: 기존 `POST /api/web/teaser`, TeaserQuestionForm 재사용. 판정 매핑: eligible→`open`, 프로필 입력으로 풀리는 conditional→`one_answer`, 원문 확인 필요→`check_source`, ineligible→`closed`
- **데이터 gap (근사 허용)**: 매칭 정밀도 %·질문 보상 수치("+9%p·9건 확정")·답변 직후 변화 요약은 백엔드 집계가 아직 없음 → 확인된 필드 수/전체 기반 근사로 시작하고, 유도 불가능한 수치는 비노출. 목업 수치 하드코딩 금지
- **금지 문구**: "지원 가능성이 높음"·합격 확률 등 확률 약속 절대 금지. 점수 %는 접힘 카드 노출 금지

### Phase 4 — 공고 요약 (s5)
- 대상: `/grants/[grantId]` (`features/grant-overview/*`) — 이미 5섹션 구조로 모범적, 스타일 정렬 위주
- ①뱃지+제목+기관 ②핵심 3지표(마감/금액/대상) ③주 CTA 1개+캡션(작성 지원 3모드별 CTA 문구 분기 — 1041~1055행 스와치) ④접힌 아코디언 3개 ⑤푸터 링크 2개

### Phase 5 — 대시보드(s7)·신청 관리(s6)·마감 캘린더(2e/3b/3c)
- 대시보드: 인사 한 줄 + **다음 행동 카드 1장**(ActionQueue 점수 로직을 표면 1카드로 흡수) + 상태 탭 3개 + **Phase 3 매칭 컴포넌트 재사용**. OpportunityMap·RoadmapStrip·NotificationFeedPanel 표면 제거
- 신청 관리: 8레인 보드 → 3그룹 리스트(진행 중/결과 대기/종료), 행=공고명/상태 한 줄/주 버튼 1개/⋯ 메뉴. 내부 8단계는 데이터 모델 보존. "캘린더로 보기" → 캘린더 화면 신설(기존 .ics 내보내기 기능과 연결)
- 통폐합 실행: `/archive`·`/roadmap`·`/onboarding` 라우트 → 매칭 결과/플로우로 리다이렉트 or 네비 제거 (기능 회귀 확인: 아카이브 검색은 존치 여부 사용자 재확인 권장)

### Phase 6 — 지원서 작성 도우미 (s8, ★ 제품의 심장 2)
- 대상: `/grants/[grantId]/workspace` (`features/apply-workspace/*`, PreviewCanvas·ChatPanel·FieldPanel 기존 부품 재조립)
- 2칼럼(문서 렌더 60% + 인터뷰 카드 40%), 셀 3상태(채움 민트✓/확인 중 블루 하이라이트/빈 회색), 인터뷰 카드(설명 1줄+제안 값+주 CTA `이 값으로 채우기`+보조 링크 2), 변형 A/B/C, `하나씩|전체 목록` 토글, 💬 물어보기(ChatPanel 재사용+기관 문의 카드), FieldCard 버튼 6개→주 CTA 1개+⋯
- 로그인(adj 2b — 카카오/네이버/이메일), 알림 설정 모달(2c), 계정 설정(2f — `/settings`+`/account` 축소 통합)은 이 단계 전후 적당한 틈에

---

## 4. 작업 규칙 (전 단계 공통 — 엄수)

1. **shadcn 스킬 우선**: UI 작업 전 `.claude/skills/shadcn` 로드. 컴포넌트는 `npx shadcn@latest add <name>` (apps/web에서). primitive hand-roll 금지
2. **hex 하드코딩 금지**: `globals.css` 토큰만. 부족하면 토큰 추가 후 사용
3. **드리프트 스캔**: `rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'` — 현재 37건, 늘리지 말 것 (장기적으로 0 목표)
4. **Tailwind v4 함정**: 콤마 포함 arbitrary 클래스는 dev에서 미생성 → CSS 변수/`@utility`로 우회
5. **상태 어휘 고정**: 판정 4상태(VerdictBadge가 SSOT) + 필드 3상태(자동 확인✓/직접 입력됨◉/미입력). 새 상태 라벨 발명 금지
6. **금지 문구**: 확률·합격 약속("지원 가능성이 높음" 류) 금지 — D9 문구 게이트
7. **검증**: 각 단계 후 `pnpm --filter @cunote/web build` 통과 + 드리프트 스캔. 시각 검수는 dev 서버가 필요하며 **dev 서버는 사용자가 직접 기동** (세션이 백그라운드로 띄우지 말 것)
8. **git**: `git add -A` 금지(병렬 세션 변경 혼재), 명시 스테이징+add·commit 한 호출, 커밋 메시지 한국어, Co-Authored-By 서명 금지, 사용자가 요청할 때만 커밋

## 5. 참고 문서
- 디자인 텍스트 스펙: `docs/research/2026-07-14-claude-design-전달-프롬프트.md`
- 정보 구조 근거: `docs/research/2026-07-14-인터페이스-단순화-제안.md` (+ 짝 문서 복잡도 현황평가)
- 과금 정본: `docs/research/2026-07-14-과금모델-초안과-프라이싱-구성.md`
- 현재 페이지·기능 인벤토리: 이 문서 §3의 각 Phase 대상 경로 참조 (셸/네비 구조는 `components/app/` 소스가 정본)

---

## 6. Codex 인수 구현 결과 (2026-07-14)

Phase 2~6 구현과 접근 가능한 동적 검증을 완료했다. 상세 비교·테스트 증거는 루트의 `design-qa.md`를 정본으로 본다.

- **Phase 2**: 랜딩 v3, 실데이터 공고 수·마키, 회사 확인 다이얼로그 3상태 구현
- **Phase 3**: 매칭 4상태, 정밀도 게이지, 다음 질문, 내 정보 Sheet, 답변 직후 상태 구현
- **Phase 4**: 공고 요약 5섹션, 작성 모드별 CTA, eligibility trace CTA 구현
- **Phase 5**: 대시보드 다음 행동 1장+3탭, 신청 관리 3그룹, 신청 캘린더 구현. 신청 관리는 사용자 행동이 있는 공고만 편입
- **Phase 6**: ladder a/b의 60/40 문서·인터뷰 화면, 하나씩/전체 목록, 모바일 프리뷰, ladder c 채팅·초안 폴백, 채팅 타임아웃·재요청 구현
- **인접 화면**: 로그인, `/settings` 계정·회사·알림 통합, `/account` 호환 경로, 앱 헤더 데모 상태 정합화
- **통폐합**: `/archive`, `/roadmap`은 `/dashboard`로 연결하고 관련 새 내비는 제거

검증 결과:

- contracts/core/web typecheck와 production build 통과
- OpenAPI 28 paths, route policy 132 API / 10 cron / 6 protected pages 통과
- 집중 회귀 테스트, service use cases, active grant filter, calendar subscription 통과
- raw control 37건 유지, 신규 hex 하드코딩 0건, 금지 확률·합격 문구 0건, `git diff --check` 통과
- Orca 동적 검증에서 랜딩→매칭, 공고, 대시보드 3탭, 신청 3그룹, 캘린더 이동, 채팅 응답을 확인하고 콘솔 error 0건 확인

남은 외부 데이터 게이트 1건:

- 실제 HWP/HWPX 공고 2건은 archive만 있고 application surface/page artifact/document field가 0건이라 ladder c가 정직한 현재 상태다.
- surface 백필은 DB 쓰기뿐 아니라 외부 변환 job과 R2 쓰기를 동반하고 자동 rollback이 없다. 이번 구현에서는 dry-run만 확인하고 실행하지 않았다.
- surface 등록+conversion poll 뒤 ladder b, field candidate 검수·적용 뒤 ladder a를 실제 데이터로 재검증해야 한다.

git staging·commit은 수행하지 않았다. 기존 병렬 세션의 미커밋 변경도 그대로 보존했다.
