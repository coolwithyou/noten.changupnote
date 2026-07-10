# 핸드오프: 랜딩·matches 신 디자인 전면 재구축 (보존 해제)

> **트리거**: 새 세션에서 "랜딩·matches 재구축 핸드오프 진행해줘"라고 하면 이 문서대로 실행한다.
> 작성: 2026-07-11. 선행 트랙: UI 재정비 Phase 0~13 완료 (커밋 42b9054~6cf7602 + 후속).

## 🟡 목표

`/`(랜딩)와 `/matches`를 **보존 없이** 신 shadcn 디자인 시스템으로 전면 재구축한다.
UI 재정비 트랙에서 이 두 페이지만 "픽셀포트 비주얼 보존"으로 남겨뒀는데, 사용자가 보존 해제를 지시했다: *"보관되는 페이지 없이 전 페이지에 적용해줘."*

## 절대 규칙

1. **`temp/preserved-pages/`의 구 픽셀포트 사본을 열람·검색·참조하지 마라.** (gitignore로 rg에서도 제외돼 있음) 옛 디자인을 재현하는 것이 아니라 새 디자인을 만드는 것이다.
2. 현행 원본(`apps/web/src/features/home/LandingExperience.tsx`, `apps/web/src/features/matches/MatchesExperience.tsx`)은 재구축 완료 시점까지 라우트를 지탱한다. **로직 계약(아래 §로직 보존)을 추출할 때만 열람 허용, 스타일·마크업·색·레이아웃 복제는 금지.** 재구축 완료 후 두 파일과 features/home·features/matches 폴더를 삭제한다(아카이브는 temp/에 이미 존재, git 이력으로도 복구 가능).
3. **shadcn 스킬 최우선**: 착수 전 `.claude/skills/shadcn` 로드. 프로젝트 CLAUDE.md "UI 구현 규칙 (최우선)" 준수. 컴포넌트는 `npx shadcn@latest add`, 블럭은 `npx shadcn@latest view <block>`으로 패턴만 이식(직접 add 금지 — 데모 라우트 충돌).
4. 색·간격·radius·그림자·텍스처는 `apps/web/src/app/globals.css` 토큰/유틸만 사용. hex 하드코딩 금지(서드파티 브랜드 색 제외).
5. 구현은 Opus 서브에이전트에 위임, 메인은 오케스트레이션·검수 (사용자 지시 유지). 커밋은 한국어·명시 스테이징(`git add -A` 금지)·검수 후 오케스트레이터가 수행.

## 디자인 방향 (정본: DESIGN.md)

- refined-minimal, "한 화면 = 한 결정", progressive disclosure
- **Brand zone** (랜딩 히어로·매칭 성공 순간): 텍스처 유틸 `bg-mesh`·`texture-grain[data-zone="brand"]`·`bg-brand-band`·`glow-brand`, 그라디언트 CTA `var(--grad-cta)`, 블루+민트 시그니처(보라 메시 클리셰 금지)
- **Work zone** (결과 리스트·입력): 무지 배경, grain ≤0.02, 가독성 우선
- 토큰: `--brand` #3182f6 / `--brand-mint` #2bd4a8 / `--success·warning·danger` / shadow-subtle 등. Pretendard(next/font 배선 완료)
- 마이크로카피: 짧고 안심시키는 한국어 톤

## 화면 요구사항

### `/` 랜딩 (Brand zone 히어로 + Work zone 스텝)
- 비로그인 방문자가 **로그인 없이 사업자번호를 입력해 바로 조회 시작**하는 것이 유일한 주연. 000-00-00000 자동 포맷.
- 히어로: 블루+민트 라이트 메시 + grain + 입력창 뒤 글로우. 중앙 흰 검색바 + "지원사업 찾기" 그라디언트 CTA(`var(--grad-cta)`).
- 신뢰 신호(회원가입 없이 조회·암호화·30초)는 caption. 아래 "이렇게 쉬워요" 3단계는 무지 Work zone.
- 헤더는 **PublicHeader 재사용**(`src/components/app/public-header.tsx`) — 자체 nav 만들지 마라. 페이지를 `(marketing)` 그룹으로 이동해 layout이 헤더 제공.
- shadcn 블럭 hero/marketing 계열을 `view`로 열람해 구조 패턴 참조 권장.

### `/matches` 매칭 결과 (zoning 동시 노출)
- 상단 Brand zone 헤더: "지원 가능한 사업 N건을 찾았어요"(success 톤) + 요약 stat(총 지원 가능액/마감 임박/최고 적합도).
- 아래 Work zone: 흰 카드 리스트(사업명·지원금·마감 D-뱃지·적합도) — Card/Badge/Progress/Collapsible 조합. 상세는 progressive disclosure.
- PublicHeader 유지(세션 인지). `(marketing)` 그룹 이동 가능 여부는 빌드로 검증(불가 시 현행 최상위 유지).

## 로직 보존 (기능 계약 — 재구축 후에도 동일 동작)

- **랜딩**: 사업자번호 입력→검증→조회 시작 플로우 전체(BizLookup 모달/조회 API 호출/`/matches?biz=` 이동), 데모 진입 경로. 원본에서 핸들러·API 경로·상태 머신을 추출해 새 UI에 배선.
- **matches**: `app/matches/page.tsx`의 `getOptionalHeaderUser` 세션 전달, **"결과 저장하기" CTA의 `saveAndContinue()`**(pending teaser를 sessionStorage에 저장 후 회사 저장/로그인 재개 — 소실 금지), `?biz=` 파라미터 기반 조회/폴링, 피드백 컨트롤(MatchFeedbackControls 등 기존 하위 컴포넌트 재사용 가능 — 이들은 이미 shadcn 정합).
- UI 재구축이 API·저장 계약을 바꾸면 안 된다.

## 마무리 작업 (재구축 완료 후)

1. `features/home/`·`features/matches/` 원본 삭제 (라우트는 새 구현으로 대체된 상태)
2. globals.css MIGRATION PENDING의 `lp-*` 블록 삭제, grain 인라인 헬퍼가 사라지면 `.texture-grain` 실사용 배선 확인
3. DESIGN.md의 "랜딩 픽셀포트 예외" 서술 삭제(예외 소멸)
4. 메모리 `ui-shadcn-redesign-track.md` 갱신

## 게이트 (전부 통과해야 완료)

- `pnpm --filter @cunote/web typecheck && pnpm --filter @cunote/web build` 그린 (core 수정 시 core build 선행)
- 드리프트 스캔 **전량 0** (이제 랜딩 예외 없음): `rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'` — archive GET 폼(쿼리스트링 로직 결합)만 문서화된 예외
- hex 스캔: `rg -nE "#[0-9a-fA-F]{6}" apps/web/src/features/home apps/web/src/features/matches` → 재구축 후 해당 폴더 소멸로 자연 0. 새 구현 파일에서도 0(서드파티 브랜드 색 제외)
- `node apps/web/scripts/audit-css-classes.mjs` → dead 0 (lp-* 삭제 반영)
- **시각 검수**: dev 서버(사용자 소유 — 기동 요청) + 브라우저로 `/`·`/matches?biz=8938100911`(데모) 확인. 이전 트랙에서 시각 검수가 생략됐으니 이번엔 로그인 후 화면(사이드바 셸)도 함께 순회 권장.

## 참고 경로

- 신 토큰/유틸 실물: `apps/web/src/app/globals.css` (874줄)
- 공용 헤더: `src/components/app/public-header.tsx` / 앱 셸: `app-shell.tsx`
- 상세 이력·플랜: `~/.claude/plans/https-ui-shadcn-com-docs-skills-warm-hummingbird.md`
- 선행 커밋: Phase 0~13 (git log에서 "UI 재정비" 검색)
