# 창업노트 — Claude Design 구현 핸드오프 (세션 이어받기)

> 작성: 2026-06-28. claude.ai/design 핸드오프(`창업노트 Claude Design 핸드오프`)를 cunote Next.js 앱에 구현하는 작업의 인계 문서.
> **다음 세션은 §0(차단 요인)부터 처리하고 §4(다음 단계)로 진행할 것.**

---

## 0. ⚠️ 지금 즉시 해야 할 것 — DB 풀 고갈로 `/`가 멈춤

현재 dev 서버의 **Postgres 커넥션 풀이 고갈**돼 있다. `/`(홈/랜딩)만 DB를 조회(`loadLandingGrantData`)하므로 `/`가 무한 대기(120s+ 타임아웃) → 브라우저에 에러 페이지가 뜬다. (`/login`·`/matches`는 DB 조회 없어 정상.) 원인은 다수 HMR 리로드로 `postgres()` 클라이언트가 누적 생성된 것(글로벌 CLAUDE.md의 HMR 누수 패턴).

**해결 — dev 서버 재시작:**
```bash
# dev 서버 터미널에서 Ctrl+C 후
rm -rf apps/web/.next/dev && pnpm --filter @cunote/web dev
# 브라우저: http://127.0.0.1:4010 → ⌘+Shift+R (하드 리로드)
```
재시작 후 `/`가 즉시 뜨고, 픽셀 포트된 랜딩이 보인다. **이 검증부터 하고 시작.**

---

## 1. 목표 / 소스 오브 트루스

- **목표**: claude.ai/design 디자인(랜딩·로그인·매칭결과)을 `apps/web`에 구현. 사용자 요구 = **dc.html과 픽셀 단위로 동일**(필요시 디자인 시스템 무시 OK).
- **디자인 소스**:
  - **DesignSync MCP**(=claude_design, `https://api.anthropic.com/v1/design/mcp`). 프로젝트 ID: `71567320-9b45-47c8-8986-f8887cdf34c5`. 첫 호출 시 인증 자동 업그레이드(`user:design:read/write`). 파일: `창업노트 랜딩 / 로그인 / 매칭결과 / 화면 탐색 / 로고 최종 .dc.html`.
  - **핸드오프 zip**: `/Users/ffgg/Downloads/창업노트 Claude Design 핸드오프-handoff.zip`. 한글 파일명 인코딩 때문에 `unzip` 실패 → **Python zipfile로 추출**(cp437→utf-8). 추출본: `/tmp/cunote_hx/` (`03__창업노트 랜딩.dc.html`, `05__로그인`, `06__매칭결과`, `07/08__화면 탐색`, `04__로고 최종`). 재추출 스니펫은 이전 세션 bash 기록 참조.
  - 레퍼런스 사본(트림): `design-handoff/창업노트 랜딩.dc.html`.
- zip의 랜딩 = DesignSync 랜딩과 **내용 동일**(디자인 변경 없었음). 차이는 포팅 근사에서 발생했던 것.

---

## 2. 완료된 것

| 영역 | 파일 | 상태 |
|---|---|---|
| **랜딩** | `apps/web/src/features/home/LandingExperience.tsx` | ✅ **dc.html 픽셀 포트(인라인 스타일 1:1)**. 그라데이션 버튼·간격·색 정확 일치. 배선: `activeCount`, 사업자번호 입력→`/matches?biz=`, FAQ 아코디언, 로그인 resume. |
| 랜딩 라우트 | `apps/web/src/app/page.tsx` | ✅ `LandingExperience` 렌더. 기존 `HomeExperience.tsx`는 **legacy 보존(미사용)**. |
| **로그인** | `apps/web/src/features/auth/LoginPanel.tsx` | ⚠️ **shadcn/토큰 근사**(픽셀 포트 아님). NextAuth(password/oauth/demo·callbackUrl·register) 로직 보존. 카카오/구글 브랜드 버튼·비번 토글 추가. 루트에 `.cunote-auth`. |
| **매칭결과** | `apps/web/src/app/matches/page.tsx` + `apps/web/src/features/matches/MatchesExperience.tsx` | ⚠️ **shadcn/토큰 근사**. **실 `/api/web/teaser` 연결**(companyEvidence.fields→사업자분석, matches+ruleTrace→조건). 서류는 teaser에 없어 생략. 로딩/에러/빈 상태 포함. 루트에 `.cunote-matches`. |
| globals | `apps/web/src/app/globals.css` | ✅ Pretendard를 `--font-cunote-sans` 앞에 추가 / 텍스처 토큰 `--grain-image`·`--grad-brand-band` / `.cunote-landing`·`.cunote-matches`의 `--lp-*`·`--m-*` 콤마값 변수 / `.lp-*` 랜딩 hover 클래스 / **레거시 전역 bare-button blue 규칙 제거**(아래 §3). |
| layout | `apps/web/src/app/layout.tsx` | ✅ Pretendard CDN `<link>`. |

검증: 전부 `pnpm --filter @cunote/web typecheck` 통과. (랜딩 픽셀 포트 후에도 통과.) `pnpm build`는 로그인/매칭 추가 전에 성공 → **재실행 권장**.

---

## 3. ⚠️ 핵심 함정 (다시 밟지 말 것)

1. **Turbopack + Tailwind v4 = 콤마 포함 arbitrary 클래스 미생성.** `px-[clamp(20px,5vw,40px)]`, `grid-cols-[repeat(auto-fit,minmax(250px,1fr))]`, `bg-[image:linear-gradient(...,...)]` 등이 dev CSS에 통째로 누락 → 레이아웃 붕괴(webpack `next build`에선 생성돼 빌드는 통과해 놓치기 쉬움). **회피**: 콤마값은 globals의 CSS 변수(`--lp-*`/`--m-*`)에 넣고 `[var(--x)]`(콤마 없이) 참조, 또는 **인라인 스타일**. 폰트크기는 `text-[length:var(--x)]`, 배경 그라데는 `bg-[image:var(--x)]`. (auto-memory: `tailwind-v4-turbopack-comma-arbitrary`)
2. **레거시 전역 element 규칙 bleed.** `globals.css`의 `button { background:var(--blue); min-height:44px }`(특이도 0,0,1)와 `button:not([data-slot="button"])`가 bare `<button>`을 파랗게 칠해 FAQ/토글/dot이 깨졌었음 → **두 규칙 제거 완료**(옛 페이지는 전부 shadcn Button이라 영향 0). `h1/h2/h3/p` 전역 타이포도 존재하나 유틸리티가 이김. **랜딩은 인라인 스타일(`.lp-root`)이라 이 bleed와 무관.**
3. **브라우저/Turbopack 캐시.** dev 청크 파일명이 고정 재사용 → 일반 새로고침 시 옛 CSS 캐시. **⌘+Shift+R** 또는 DevTools "Disable cache". CSS가 갱신됐는지는 `.next/dev/static/chunks/*globals*.css` grep으로 확인.
4. **DB 풀 고갈**(§0). `/`가 멈추면 코드가 아니라 dev 서버 재시작 문제일 확률 높음.
5. **claude_design MCP = DesignSync 툴.** `get_file`로 dc.html 원문 read 가능(프로젝트 ID §1).

---

## 4. 다음 단계

1. **(필수)** dev 서버 재시작(§0) → `/` 렌더 확인 → 랜딩이 dc.html과 일치하는지 시각 검증(가능하면 claude-in-chrome 스크린샷).
2. 사용자가 원하면 **로그인·매칭결과도 dc.html 픽셀 포트**로 전환(현재 shadcn 근사). 소스: `/tmp/cunote_hx/05__…로그인.dc.html`, `06__…매칭결과.dc.html`. 랜딩과 동일하게 인라인 스타일 1:1 포트 + 기존 배선(NextAuth / teaser API) 유지.
   - 로그인 포트 시 주의: NextAuth `signIn(password/oauth/demo, {callbackUrl})` 로직 보존, 카카오 `#FEE500`/구글 4색은 브랜드색이라 하드코딩 OK.
   - 매칭 포트 시: 실데이터(teaser) 매핑 유지, 서류 섹션은 생략/안내 처리.
3. `pnpm --filter @cunote/web build` 재실행으로 전체 그린 확인.
4. (선택) HMR DB 풀 누수 항구 수정: `apps/web/src/lib/server/db/index.ts`에 `globalThis` 캐싱 패턴 적용(글로벌 CLAUDE.md 참조) — 반복되는 §0 차단을 근절.
5. `화면 탐색`(`design_doc_mode:canvas`)은 시안 나열 캔버스라 **구현 대상 아님**. `로고`는 `BrandMark`로 구현됨.

---

## 5. 흐름(라우팅) 요약

- 랜딩 hero/CTA "지원사업 찾기" → `/matches?biz=<10자리>` (비로그인 teaser 결과).
- 매칭 "결과 저장하기"/CTA → `/login?callbackUrl=/?resumeCompany=1` → 로그인 후 랜딩 resume effect가 회사 생성 → `/dashboard`.
- nav 로그인/무료로 시작 → `/login`. 로그인 후 nav는 "기회 맵"→`/dashboard`.
- 기존 `/dashboard`(기회 맵, 실데이터 기능 페이지)·`/roadmap`·`/grants/[id]`·`/admin`·`/internal/live-match`는 **건드리지 않음**(레거시 유지).
