# 창업노트 Design System

**토큰 단일 출처: `design-tokens.json`** (플랫폼 비종속). 이 문서·`globals.css`·Figma·네이티브 테마는 모두 그 값을 따른다. 색·간격 기반 ramp는 TDS Figma 변수(`tds-figma-variables.json`)에서 가져왔고, 컴포넌트는 `apps/web/src/components/ui`의 `shadcn/ui` 소스 위에 구현한다.

## Design Intent

창업노트는 정부지원사업 매칭을 빠르게 이해하고 실행하게 만드는 업무형 SaaS다. **유일한 원칙은 "쉽다 = 인지부하 최소화"이며, 한 화면은 하나의 결정만 요구한다.**

미적 방향은 **refined-minimal**(의도적으로 정교한 미니멀리즘)이다. bold/maximalist가 아니다. 과거의 "Toss 클론" 방향에서 벗어나, 더 미니멀하고 확장 가능한 인터페이스를 지향한다 — 차이는 *요소를 더 예쁘게*가 아니라 **정보 구조를 더 단순하게**(progressive disclosure) 만드는 데서 온다.

세련됨은 **텍스처(mesh 그라데이션 + grain + 글로우)**로 주되, 장식이 아니라 깊이·위계 도구로 쓰고 **zoning으로 구역을 분리**한다(아래 참조). 명확한 표면, 강한 숫자 위계, 부드러운 다층 쉐도우, 단일 브랜드 블루(+민트 액센트)를 유지한다.

## Tokens

### Color Table

Canonical UI color tokens come from the TDS `Color` collection. Use semantic tokens first; base ramps are for charts and rare category color only.

| TDS token | Light | Dark | CSS mapping | Use |
| --- | --- | --- | --- | --- |
| `Semantic/Background/Default` | `#ffffff` | `#17171c` | `--background` | Page canvas |
| `Semantic/Background/Floated` | `#ffffff` | `#202027` | `--card`, `--popover`, `--surface` | Cards, popovers, elevated surfaces |
| `Semantic/Background/Lower` | `#f2f4f6` | `#101013` | `--bg`, `--surface-muted` | Muted page bands and soft panels |
| `Semantic/Text/Primary` | `#000c1ecc` | `#e4e4e5` | `--foreground`, `--text` | Main readable text |
| `Semantic/Text/Secondary` | `#031228b2` | `#fdfdffbf` | `--secondary-foreground` | Labels, emphasized supporting text |
| `Semantic/Text/Tertiary` | `#00132b94` | `#f8f8ff99` | `--muted-foreground`, `--muted-ink` | Descriptions, metadata |
| `Semantic/Text/Quaternary` | `#03183275` | `#f2f2ff78` | `--tds-text-quaternary` | Disabled or very low-emphasis text |
| `Semantic/Text/Strong` | `#191f28` | `#ffffff` | `--tds-text-strong` | Strong display numbers and headings |
| `Semantic/Text/Brand` | `#2272eb` | `#449bff` | `--accent-foreground` | Brand text and selected labels |
| `Semantic/Fill/Brand` | `#3182f6` | `#3182f6` | `--primary`, `--toss-blue` | Primary CTA, selected controls |
| `Semantic/Fill/Brand Weak` | `#3182f629` | `#3182f629` | `--accent` | Soft brand backgrounds |
| `Semantic/Fill/Neutral Weak` | `#07194c0d` | `#d9d9ff1c` | `--secondary`, `--input` | Field fill, subtle chips, neutral buttons |
| `Semantic/Fill/Pressed` | `#0220470d` | `#d9d9ff1c` | `--tds-fill-pressed` | Pressed/hover surface feedback |
| `Semantic/Border/Default` | `#001b371a` | `#dedeff30` | `--border`, `--line` | Dividers, card rings, input borders |
| `Semantic/Fill/Success` | `#03b26c` | `#16bb76` | `--green`, `--chart-2` | Eligible, verified, positive status |
| `Semantic/Fill/Warning` | `#ffc342` | `#ffb134` | `--amber`, `--chart-3` | Conditional, soon, attention-needed status |
| `Semantic/Fill/Danger` | `#f04452` | `#f04251` | `--destructive`, `--red` | Ineligible, denied, destructive/error states |
| `Base/Teal/Teal 500` | `#18a5a5` | `#2eaab2` | `--chart-4` | Secondary data category only |
| `Base/Purple/Purple 500` | `#a234c7` | `#ae3dd1` | `--chart-5` | Rare highlight or future premium category |

### Typography

Use `"Toss Product Sans"` when available, then system Korean fonts:

```css
"Toss Product Sans", "SF Pro KR", "SF Pro Display", -apple-system,
BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI",
Roboto, Arial, sans-serif
```

- TDS Display: 26/28/30px, 700, `1.35`
- TDS Title: 17/20/22/24px, 500-700, `1.35`
- TDS Body: 13/17/19px, 400-500, `1.5`
- TDS Subtext: 12/13/15px, 400-500, `1.35`
- TDS Label: 13/15/17/19px, 500-700, `1.252`
- Web landing heroes may scale above TDS mobile display sizes, but should keep the same 700 weight, zero letter spacing, and compact line height.
- Metrics use tabular numerals.

### Texture And Zoning

질감은 *모든 화면*이 아니라 **브랜드 순간에만** 적용한다. 희소할수록 강하게 각인되고 "쉽다"와 충돌하지 않는다. 토큰은 `design-tokens.json`의 `texture`/`zoning` 참조.

- **Brand zone** (질감 풀가동: mesh + grain `~0.05` + 글로우 + 그라데이션 버튼): 온보딩, 히어로/랜딩, 빈 상태, 매칭 성공 순간, 주요 CTA, 마케팅.
- **Work zone** (절제: 거의 무지 + grain `~0.02`, 가독성 우선): 사업자번호 입력, 매칭 결과 리스트, 코칭 체크리스트, 대시보드, 내부/관리 콘솔.
- **시그니처 변주**: 메시 hue는 **블루+민트**, grain 입자 `180px`·`mix-blend: overlay`로 일관. "다크+보라 메시" 기본값으로 수렴 금지(= generic AI 클리셰).
- 그라데이션은 *깊이·면 구분/분위기* 전용이며 Work zone에서는 보이지 않을 정도로 절제한다.

### Shape And Spacing

- App surface radius: `16px` (`Radius/Semantic/XS`)
- Primary CTA radius: `16px`
- Input radius: `14px` (`Radius/Component/Text Field/Box/Field`)
- Small pills: 999px
- TDS semantic gap: `6px` small, `8px` medium
- TDS page side padding: `12px`, `16px`, `20px`, `24px`
- Panel padding: 24px desktop, 16-20px mobile
- Table cell padding: 12px vertical, 16px horizontal
- Form field box padding: 14px vertical, 16px horizontal, 6px label/control gap
- List rows: 20-24px side padding, 8/12/16/24px vertical sizes
- Shadows use TDS effects: tiny `0 1px 3px #001b371a`, weak `0 2px 30px #001b371a`, medium `0 16px 60px #001d3a2e`

## Component Rules

- Use shadcn components from `apps/web/src/components/ui` for new UI primitives.
- Keep shadcn components source-owned in the repo; do not hand-roll equivalent buttons, cards, badges, inputs, selects, tabs, alerts, switches, separators, skeletons, or field layouts for new work.
- Existing legacy class names may remain for layout, but interactive primitives must be shadcn-owned.
- Buttons should feel like Toss: 48-56px tall, radius 16px, primary blue fill, subtle secondary grey fills.
- Inputs should use soft fill, 14px radius, blue focus ring, and no heavy borders.
- Cards/panels should be white, quiet, lightly bordered, and information-dense.
- Tables use shadcn `Table` with muted 12px headers, 14px row text, 12/16px cell padding, and grey200 row rules.
- Binary settings use shadcn `Switch` or `Checkbox`; option sets use `ToggleGroup`; dropdown choices use `Select`.
- Texture(mesh/grain/glow)는 Brand zone에만. Work zone(app surfaces)은 거의 무지 + grain ≤0.02로 가독성 우선. 장식적 blob·과장된 마케팅 섹션을 app surface에 넣지 않는다.

## Public Surfaces Covered

| Route | Surface | shadcn primitives applied |
| --- | --- | --- |
| `/` | Landing and teaser | `Card`, `MetricCard`, `Button`, `Input`, `Select`, `ToggleGroup`, `Field`, `Alert`, `Badge`, `Spinner` |
| `/login` | Auth provider selection | `Card`, `Button`, `Alert`, `Empty`, `Spinner` |
| `/dashboard` | Dashboard shell, settings, questions, opportunity map, side panels | `Card`, `MetricCard`, `Button`, `Input`, `Select`, `Switch`, `Checkbox`, `ToggleGroup`, `Field`, `Alert`, `Badge`, `Empty`, `Spinner` |
| `/roadmap` | Full roadmap and strip | `Card`, `MetricCard`, `Badge`, `Empty`, shadcn button variants for links |
| `/grants/[grantId]` | Apply sheet | `Card`, `MetricCard`, `Badge`, `Empty`, shadcn button variants for apply links |
| `/internal/live-match` | Internal match console | `Card`, `Field`, `Input`, `Checkbox`, `Button`, `Alert`, `Empty`, `MetricCard`, `Table`, `Badge`, `Spinner` |
| `/admin` | Admin runtime/flywheel panels | `Card`, `MetricCard`, `Table`, `Badge`, `Empty` |

## Implementation Notes

- shadcn source lives under `apps/web/src/components/ui`.
- Product-level wrappers live under `apps/web/src/components/app`.
- Global Toss token mapping and legacy-layout bridge live in `apps/web/src/app/globals.css`.
- The scan target for exposed primitive drift is:
  `rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'`
