# 창업노트 Design System

**토큰 단일 출처: `design-tokens.json`** (플랫폼 비종속). apps/web은 이 값을 셋업의 canonical 값으로 두고 `globals.css`의 shadcn 표준 변수 체계로 구현한다. 컴포넌트는 `apps/web/src/components/ui`의 `shadcn/ui`(style `base-nova`, `@base-ui/react`) 소스 위에 구현한다.

> **2026-07 전환 완료**: Toss Design System(TDS, `--tds-*` CSS 변수 100+개)은 폐기되었다. 현행 체계는 shadcn neutral(oklch) 표준 + cunote 브랜드 확장(`--brand-*`/`--success`/`--warning`/`--danger`/텍스처 토큰)이다. TDS Figma 원본은 `tds-figma-variables.json`(ARCHIVED), Claude Design 전략 문서는 `claude-design-guideline.md`(ARCHIVED)에 이력 보존만 되어 있다.

## Design Intent

창업노트는 정부지원사업 매칭을 빠르게 이해하고 실행하게 만드는 업무형 SaaS다. **유일한 원칙은 "쉽다 = 인지부하 최소화"이며, 한 화면은 하나의 결정만 요구한다.**

미적 방향은 **refined-minimal**(의도적으로 정교한 미니멀리즘)이다. bold/maximalist가 아니다. 과거의 "Toss 클론" 방향에서 벗어나, 더 미니멀하고 확장 가능한 인터페이스를 지향한다 — 차이는 *요소를 더 예쁘게*가 아니라 **정보 구조를 더 단순하게**(progressive disclosure) 만드는 데서 온다.

세련됨은 **텍스처(mesh 그라데이션 + grain + 글로우)**로 주되, 장식이 아니라 깊이·위계 도구로 쓰고 **zoning으로 구역을 분리**한다(아래 참조). 명확한 표면, 강한 숫자 위계, 부드러운 다층 쉐도우, 단일 브랜드 블루(+민트 액센트)를 유지한다.

## 토큰 파이프라인

```
design-tokens.json (정본, 플랫폼 비종속)
   ↓
apps/web/src/app/globals.css :root  — shadcn neutral(oklch) 표준 + 브랜드 확장 오버라이드
   ↓
@theme inline  — --color-*, --shadow-*, --radius-* 매핑 (Tailwind v4 유틸리티 생성원)
   ↓
Tailwind 유틸리티  — bg-brand, text-success, hover:bg-brand-pressed, shadow-subtle, rounded-lg 등
```

- `design-tokens.json`의 값(브랜드 블루 `#3182f6` 등)과 `globals.css :root`의 값은 동일해야 한다. 값이 어긋나면 `globals.css`가 아니라 `design-tokens.json`을 기준으로 교정한다.
- `documentExportTokens.ts`(`apps/web/src/lib/server/documents/documentExportTokens.ts`)는 문서(hwp/docx) 내보내기용으로 `design-tokens.json`을 **직접** import해 읽는다 (경로: `brand.primary.value`, `color.light.bg.{canvas,surface}`, `color.light.text.{strong,primary,tertiary}`, `color.light.border.default`, `color.light.fill.neutralWeak`, `radius.{sm,textField}.value`, `type.fontFamily.value`, `type.body.line`, `type.caption.size`). 이 경로/구조는 **변경 금지** — 값을 바꾸려면 `design-tokens.json`을 고치고 이 파일이 자동 반영되게 한다.
- 라이트 온리: `.dark` 팔레트는 웹에 배선하지 않는다(`color-scheme: light` 고정, `next-themes` 미설치). `@custom-variant dark (&:is(.dark *));` 선언 자체는 유지한다 — 지우면 `dark:` 유틸이 `prefers-color-scheme` 미디어쿼리로 폴백해 다크 OS 사용자에게 오발동하기 때문에, 클래스 기반 선언 + `.dark` 미부착으로 라이트 온리를 강제한다. `design-tokens.json`의 `color.dark`는 네이티브(iOS/Android) 참조용으로만 `$status: reserved` 상태로 보존.

### `:root` 변수 목록 (globals.css)

| 변수 | 값 | 용도 |
| --- | --- | --- |
| `--background` / `--foreground` | oklch neutral | 페이지 캔버스 / 기본 텍스트 |
| `--card`, `--popover` (+ `-foreground`) | oklch neutral | 카드·팝오버 표면 |
| `--secondary`, `--muted` (+ `-foreground`) | oklch neutral | 보조 표면, 저강조 텍스트 |
| `--border`, `--input` | oklch neutral | 구분선·인풋 테두리 |
| `--chart-1`~`-5`, `--sidebar-*` | oklch neutral | 차트 카테고리, 사이드바 shadcn 표준 세트 |
| `--primary` / `--primary-foreground` | `#3182f6` / `#ffffff` | 브랜드 오버라이드 — 기본 CTA |
| `--ring` | `#3182f6` | 포커스 링 |
| `--accent` / `--accent-foreground` | `#e8f3ff` / `#2272eb` | 선택/포커스 약한 배경 |
| `--destructive` | `#f04452` | 파괴적 액션(shadcn 표준명) |
| `--radius` | `1rem` | 기준 반경 — 16px 룩 보존(shadcn 기본 10px 아님) |
| `--brand` / `--brand-pressed` / `--brand-hover` | `#3182f6` / `#2272eb` / `#1b64da` | 브랜드 확장 네임스페이스(버튼 hover/press 등 유틸 전용) |
| `--brand-mint` / `--brand-mint-soft` | `#2bd4a8` / `#e6fbf1` | 시그니처 민트 액센트 |
| `--brand-tint` | `#e8f3ff` | 브랜드 톤 배경 |
| `--success` / `--warning` / `--danger` (+ `-soft`) | `#03b26c` / `#ffc342` / `#f04452` | 상태 색 + 옅은 배경(`color-mix`) |
| `--shadow-subtle` / `--shadow-standard` / `--shadow-elevated` | 잉크톤 낮은-alpha | 카드 / 팝오버 / 모달 (TSX 19곳 이상이 `--shadow-subtle` 직접 참조) |
| `--grad-mesh` | 블루+민트 radial mesh + `--background` | Brand zone 배경 (`bg-mesh` 유틸) |
| `--grad-brand-band` | 블루+민트 radial + linear band | Brand zone 밴드 (`bg-brand-band` 유틸) |
| `--grad-cta` | `linear-gradient(180deg,#4790ff,#3182f6)` | CTA 버튼 그라데이션(구 `GRAD_BTN`) |
| `--grad-text-brand` | `linear-gradient(120deg,#3182f6,#2bd4a8)` | 텍스트 그라데이션(구 `GRAD_TEXT`) |
| `--grad-bar-brand` | `linear-gradient(90deg,#2bd4a8,#3182f6)` | 진행바 그라데이션(구 `GRAD_BAR`) |
| `--glow-brand` | radial glow, `rgba(49,130,246,.22)` | 버튼/입력 포커스 글로우 (`glow-brand` 유틸) |
| `--grain-image` / `--grain-tile` / `--grain-opacity-brand` / `--grain-opacity-work` | SVG data-URI / `180px` / `0.05` / `0.02` | 노이즈 오버레이 (`.texture-grain`, `[data-zone="brand"]`) |

`@theme inline`은 이 변수들을 `--color-*`/`--shadow-*`/`--radius-*` 이름으로 재매핑해 Tailwind 유틸리티(`bg-brand`, `text-success`, `shadow-subtle`, `rounded-xl` 등)를 생성한다. `--radius-sm/md/lg/xl/2xl/3xl/4xl`은 `--radius`의 배율식(`--radius-lg = --radius` = 16px 룩 보존)이다.

## Typography

Pretendard를 `next/font/local`로 self-host한다(jsDelivr CDN `<link>` 제거 완료). 폰트 스택:

```css
--font-sans: var(--font-pretendard), "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif;
```

~~"Toss Product Sans"~~는 사용하지 않는다(과거 TDS 표기 삭제).

- Display: 28px / 1.25 / 700
- Title: 20px / 1.35 / 600
- Body: 16px / 1.55 / 400
- Caption: 13px / 1.45 / 400
- 지표·금액은 `tabular-nums`.

`design-tokens.json`의 `type.fontFamily.value`는 여전히 `"Pretendard", "Toss Product Sans", ...` 폴백 스택을 포함하는데, 이는 `documentExportTokens.ts`(문서 내보내기)가 읽는 값으로 **변경 금지** 대상이라 그대로 둔다 — 웹 UI 폰트 스택과는 별도로 취급할 것.

## Texture And Zoning

질감은 *모든 화면*이 아니라 **브랜드 순간에만** 적용한다. 희소할수록 강하게 각인되고 "쉽다"와 충돌하지 않는다. 토큰은 `design-tokens.json`의 `texture`/`zoning`, 웹 구현은 `globals.css`의 `--grad-*`/`--grain-*` 변수와 유틸리티 클래스를 참조.

- **Brand zone** (질감 풀가동: mesh + grain `~0.05` + 글로우 + 그라데이션 버튼): 온보딩, 히어로/랜딩, 빈 상태, 매칭 성공 순간, 주요 CTA, 마케팅. 유틸리티: `bg-mesh`, `bg-brand-band`, `glow-brand`, `.texture-grain[data-zone="brand"]`.
- **Work zone** (절제: 거의 무지 + grain `~0.02`, 가독성 우선): 사업자번호 입력, 매칭 결과 리스트, 코칭 체크리스트, 대시보드, 내부/관리 콘솔. 유틸리티: `.texture-grain`(data-zone 미지정 시 work 강도 기본값).
- **시그니처 변주**: 메시 hue는 **블루+민트**, grain 입자 `180px`·`mix-blend: overlay`로 일관. "다크+보라 메시" 기본값으로 수렴 금지(= generic AI 클리셰).
- 그라데이션은 *깊이·면 구분/분위기* 전용이며 Work zone에서는 보이지 않을 정도로 절제한다.
- **랜딩(`LandingExperience.tsx`) 예외**: 랜딩은 시각 변화 0을 목표로 구조 재작성 없이 토큰화만 수행했다(hex → `var(--brand)` 등 1:1 치환). 그라데이션 stop 계산에 쓰이는 일부 1회성 색상(`#4f8bff`, `#1f4fc4` 등 gradient 내부 stop)은 토큰 정의(`--grad-brand-band`) 안으로 흡수되어 있고, 완전히 매핑하기 애매한 극소수 hex가 주석과 함께 잔존할 수 있다 — 이는 **픽셀포트 보존을 위한 의도된 예외**이며 신규 작업에서 다른 화면에 이 패턴을 복제하지 않는다.

## Component Rules

- 컴포넌트는 `apps/web/src/components/ui`의 **shadcn 37종**(style `base-nova`, `@base-ui/react`) 위에 구성한다: accordion, alert, alert-dialog, avatar, badge, breadcrumb, button, card, chart, checkbox, collapsible, combobox, dialog, dropdown-menu, empty, field, input, input-group, label, pagination, popover, progress, scroll-area, select, separator, sheet, sidebar, skeleton, sonner, spinner, switch, table, tabs, textarea, toggle, toggle-group, tooltip.
- Button/Card/Dialog 등 shadcn에 이미 존재하는 primitive를 **hand-roll 하지 않는다**. 컴포넌트 추가는 `npx shadcn@latest add <name>`(apps/web에서 실행 — `components.json`의 `style: "base-nova"`를 자동 해석, `--style` 플래그 없음).
- **블럭(sidebar-07, login-03 등)은 직접 `add` 하지 않는다**(데모 라우트 파일과 충돌) — `npx shadcn@latest view <block>`으로 소스를 열람해 패턴만 이식한다. 실제 구현은 `AppSidebar`/`LoginPanel` 등 자체 컴포넌트에 손으로 이식.
- 색·간격·radius·그림자는 `globals.css`의 토큰(CSS 변수 또는 Tailwind 유틸)만 사용한다. hex 하드코딩 금지(랜딩 예외 제외).
- 동적으로 계산되는 좌표/폭(문서 오버레이, progress 폭 등)만 인라인 `style={{}}` 예외로 허용한다. 정적 색·간격·폰트 인라인 스타일은 금지.
- 폼은 controlled `useState` + `field.tsx`/`input-group.tsx`로 통일한다. **React Hook Form(`form.tsx`) 도입 금지.**
- 드리프트 스캔(0건이 정상): `rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'`, `rg -n "tds-|toss-" apps/web/src`, `rg 'title="' apps/web/src/features`.

## App Shell

```
src/app/
├─ layout.tsx            # root: Pretendard 폰트(next/font/local) + <Toaster/>(sonner) + TooltipProvider
├─ (marketing)/layout.tsx # PublicHeader(세션 인지 상단 헤더) — 랜딩·pricing·matches·support·privacy·terms·team/invite
├─ (auth)/layout.tsx      # 중앙정렬 브랜드존 캔버스 — login·forgot-password·reset-password
├─ (app)/layout.tsx       # AppShell = SidebarProvider + AppSidebar + SidebarInset — dashboard·archive·applications·
│                         #   roadmap·team·billing·credits·settings·account·onboarding·grants/[grantId]
├─ grants/[grantId]/preview/  # 전체화면 문서 뷰어 — 셸 없는 독립 라우트
└─ internal/              # ReviewWorkspaceShell(자체 Sidebar 셸, AppSidebar와 별도)
```

- `AppShell`(`apps/web/src/components/app/app-shell.tsx`)이 (app) 그룹의 표준 셸이다: `AppSidebar`(nav-main: 기회 맵/아카이브/신청 관리/로드맵, nav-secondary: 팀/플랜/크레딧/설정, footer: `AccountMenu`) + 상단바(`SidebarTrigger` + `AppBreadcrumb` + `CreditBalanceWidget` + `AccountMenu`).
- 인증 가드는 **layout이 아니라 page 단위**로 유지한다(라우트별 `callbackUrl`이 다르므로).
- `service-header.tsx`의 landing variant는 `(marketing)`의 `PublicHeader`로 대체되었다.
- URL은 route group 도입으로 변하지 않는다(그룹명은 URL에 노출되지 않음).

## Implementation Notes

- shadcn 소스: `apps/web/src/components/ui`. 제품 레벨 래퍼: `apps/web/src/components/app`(`app-shell.tsx`, `app-sidebar.tsx`, `public-header.tsx`, `account-menu.tsx`, `app-breadcrumb.tsx`, `metric-card.tsx`, `status-badge.tsx`).
- 전역 토큰·텍스처 유틸리티는 `apps/web/src/app/globals.css`(`:root` → `@theme inline` → 유틸리티)에 있다.
- `globals.css`에는 아직 Tailwind로 완전히 이관되지 않은 소수의 레거시 클래스(`document-draft-*`, `company-evidence-*`, `.eyebrow`, `.panel-empty` 등, "MIGRATION PENDING" 주석 섹션)가 남아 있다 — 이들은 실제 TSX 소비처가 있는 살아있는 CSS이며 정리 대상이지 신규 작업의 참조 대상은 아니다. 신규 UI는 반드시 shadcn 컴포넌트/Tailwind 유틸로 작성한다.
- 드리프트 스캔 명령(전체 게이트):
  ```bash
  rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'
  rg -n "tds-|toss-" apps/web/src
  rg 'title="' apps/web/src/features
  ```
  모두 0건이 정상.
