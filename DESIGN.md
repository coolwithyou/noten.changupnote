# 창업노트 Design System

Source: Toss-inspired system from `https://oh-my-design.kr/design-systems/toss` and `https://oh-my-design.kr/toss/design.md`, implemented on top of latest `shadcn/ui` source components in `apps/web/src/components/ui`.

## Design Intent

창업노트는 정부지원사업 매칭을 빠르게 이해하고 실행하게 만드는 업무형 SaaS다. 화면은 마케팅 랜딩처럼 과장하지 않고, Toss처럼 명확한 흰 배경, 강한 숫자 위계, 부드러운 회색 표면, 파란 primary action으로 구성한다.

## Tokens

### Color Table

| Token | Value | shadcn/CSS mapping | Use |
| --- | --- | --- | --- |
| Primary | `#3182f6` | `--primary`, `--toss-blue` | CTA, selected state, focus ring, key metric accents |
| Primary hover | `#2272eb` | `--toss-blue-hover` | Primary button hover and active blue text |
| Brand blue | `#0064ff` | `--toss-brand-blue` | Logo or brand-only moments, not default UI actions |
| Foreground | `#191f28` | `--foreground`, `--text`, `--toss-grey-900` | H1/H2, strongest body text |
| Strong text | `#333d4b` | `--secondary-foreground`, `--toss-grey-800` | Card titles, labels, table body emphasis |
| Body text | `#4e5968` | `--toss-grey-700` | Supporting copy and row descriptions |
| Muted text | `#6b7684` | `--muted-foreground`, `--toss-grey-600` | Metadata, descriptions, inactive controls |
| Caption text | `#8b95a1` | `--toss-grey-500` | Tiny labels, timestamps, secondary counters |
| Canvas | `#ffffff` | `--background`, `--card`, `--popover` | Page canvas and primary card surface |
| Grey 50 | `#f9fafb` | `--toss-grey-50` | Very light section fill, table row hover |
| Grey 100 | `#f2f4f6` | `--secondary`, `--muted`, `--surface-muted` | Toggle tracks, muted panels, disabled surface |
| Grey 200 | `#e5e8eb` | `--border`, `--line` | Borders, dividers, table rules |
| Grey 300 | `#d1d6db` | `--toss-grey-300` | Stronger border and active input edge |
| Success | `#03b26c` | `--green`, `--chart-2` | Eligible, verified, positive status |
| Warning | `#fe9800` | `--amber`, `--chart-3` | Conditional, soon, attention-needed status |
| Error | `#f04452` | `--destructive`, `--red` | Ineligible, denied, destructive/error states |
| Info teal | `#18a5a5` | `--chart-4` | Secondary data category only |
| Premium purple | `#a234c7` | `--chart-5` | Rare highlight or future premium category |

### Typography

Use `"Toss Product Sans"` when available, then system Korean fonts:

```css
"Toss Product Sans", "SF Pro KR", "SF Pro Display", -apple-system,
BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI",
Roboto, Arial, sans-serif
```

- Hero: 40-68px, 700, compact line height
- Section title: 22px, 700, 1.36
- Card title: 17px, 700, 1.38
- Table/body text: 14-15px, 400-500, 1.5-1.58
- Metadata/caption: 12-13px, 700-800
- Metrics use tabular numerals.

### Shape And Spacing

- App surface radius: 16px
- Primary CTA radius: 16px
- Input radius: 14px
- Small pills: 999px
- Base spacing: 8px increments
- Panel padding: 24px desktop, 18px mobile
- Table cell padding: 12px vertical, 16px horizontal
- Form field gap: 8px label-to-control, 16px between groups
- Card list gap: 8-12px, depending on density
- Shadows stay subtle: `0 1px 3px rgba(0,0,0,0.06)` or `0 2px 8px rgba(0,0,0,0.08)`

## Component Rules

- Use shadcn components from `apps/web/src/components/ui` for new UI primitives.
- Keep shadcn components source-owned in the repo; do not hand-roll equivalent buttons, cards, badges, inputs, selects, tabs, alerts, switches, separators, skeletons, or field layouts for new work.
- Existing legacy class names may remain for layout, but interactive primitives must be shadcn-owned.
- Buttons should feel like Toss: 48-56px tall, radius 16px, primary blue fill, subtle secondary grey fills.
- Inputs should use soft fill, 14px radius, blue focus ring, and no heavy borders.
- Cards/panels should be white, quiet, lightly bordered, and information-dense.
- Tables use shadcn `Table` with muted 12px headers, 14px row text, 12/16px cell padding, and grey200 row rules.
- Binary settings use shadcn `Switch` or `Checkbox`; option sets use `ToggleGroup`; dropdown choices use `Select`.
- Avoid decorative gradients, blobs, or oversized marketing sections for app surfaces.

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
