# 창업노트 — Claude Design 핸드오프 브리프 v0.1

> 이 문서는 Anthropic **Claude Design (claude.ai/design)** 페이지에서 디자인을 직접
> 디벨롭하기 위한 컨텍스트 브리프다. §0의 절차대로 진행하고, §1–§9를 프로젝트 지침으로
> 붙여넣은 뒤 §6 프롬프트로 화면을 생성·정교화한다.
> **토큰 단일 출처: `design-tokens.json`** — 모든 색/질감/간격 값은 그 파일을 정본으로 한다.

---

## 0. Claude Design (claude.ai/design)에서 진행하는 절차

> 전제: Claude Pro/Max/Team/Enterprise 구독. (Enterprise는 조직 설정에서 기본 off → 관리자 활성화)

1. **디자인 시스템 주입 (가장 중요).** Claude Design은 온보딩에서 코드베이스/디자인 파일을 읽어 팀 디자인 시스템을 구축하고, 이후 결과물을 그 시스템과 대조·자동 교정한다. 둘 중 택1:
   - **GitHub 레포 연결** → 이 레포를 가리키면 `design-tokens.json` + `globals.css`(TDS :root) + `shadcn/ui` 컴포넌트를 시스템으로 흡수.
   - **직접 업로드** → 레포 연결이 어려우면 `design-tokens.json`, `DESIGN.md`, 그리고 §7의 프로토타입 HTML 2개를 업로드.
   → "우리 색·타이포·컴포넌트로 빌드하고 결과를 design-tokens.json과 대조해 교정하라"고 명시.
2. **프로젝트 지침 고정.** 이 문서의 §1–§5, §8을 프로젝트 지침/첫 메시지로 붙여넣어 방향(refined-minimal·탈-토스·zoning)과 금지 규칙을 lock.
3. **레퍼런스 입력.** §7의 `prototype-web-landing.html` / `prototype-matching.html`를 업로드하거나, 실제 사이트가 있으면 **web capture 도구**로 요소를 그대로 가져와 "실제 제품"처럼 시작.
4. **화면 생성.** §6의 화면별 프롬프트로 1차 버전 생성. 한 번에 한 화면.
5. **정교화.** inline 코멘트(특정 요소) · 텍스트 직접 편집 · 조절 슬라이더(spacing/color/layout) 로 라이브 수정 → "이 변경을 전체 디자인에 적용" 지시. 필요하면 Claude가 만든 custom 슬라이더로 메시 강도·grain 등 탐색.
6. **공유/검수.** 조직 링크로 공유, §9 수락 기준으로 검수.
7. **내보내기/핸드오프.** 확정되면 PPTX/PDF/Canva/HTML로 export 하거나, **handoff bundle**로 묶어 Claude Code에 전달(§10).

---

## 1. 제품 한 장 요약

- **무엇**: 사업자번호만 입력하면 사업자 정보를 가져와 표준화된 공공지원사업과 대조해 **지원 가능한 사업을 매칭하고 신청 코칭**까지 해주는 플랫폼.
- **누구**: 사업체를 가진 사업주·관련 직원.
- **플랫폼**: iOS · Android · Web (모바일 우선, 반응형).
- **유일한 철학**: **"쉽다 = 인지부하 최소화. 한 화면 = 한 결정."**
- **핵심 차별점**: 기존 서비스는 표준화되지 않은 공고 때문에 "공부해야 하는 영역"이었다. 우리는 직관적·명확한 인터페이스로 사용자가 진짜 집중할 곳에 집중하게 하고, 신청에 필요한 데이터를 회사 맞춤으로 제공한다.

## 2. 디자인 방향 (고정)

- **refined-minimal** — bold/maximalist 아님. 의도적이고 정교한 미니멀리즘.
- **탈-토스** — 과거 Toss 클론 방향에서 벗어나 더 미니멀·확장 가능하게. 차이는 *더 예쁜 요소*가 아니라 **더 단순한 정보 구조**(progressive disclosure)에서 온다.
- **세련됨은 텍스처로** — mesh 그라데이션 + grain + 소프트 글로우. 단, 장식이 아니라 깊이·위계·분위기 도구이며 **zoning으로 구역 분리**(§4).
- **부드럽고 세련된 인상** — 다층 쉐도우(잉크톤·2겹), 넉넉한 여백, 단일 브랜드 블루 + 민트 액센트.

## 3. 토큰 (요약 — 정본은 `design-tokens.json`)

| 범주 | 값 |
|---|---|
| Brand primary | `#3182f6` (정본, 전 레이어 배선됨) · pressed `#2272eb` |
| Signature accent | **mint `#2bd4a8`** (메시·성공 인접 강조 / 차별화 축) |
| Bg (light) | canvas `#ffffff` · lower `#f2f4f6` · surface `#ffffff` |
| Text | strong `#191f28` · primary `#000c1ecc` · tertiary `#00132b94` |
| Status | success `#03b26c` · warning `#ffc342` · danger `#f04452` |
| Shadow | 1 카드 / 2 팝오버 / 3 모달 — 잉크톤 2겹 |
| Radius | card·CTA `16` · input `14` · pill `999` |
| Type | Pretendard(한글 가독 우선). display 28 / title 20 / body 16 / caption 13 |
| Motion | ease `cubic-bezier(.22,1,.36,1)` · 진입 staggered 1회 |

다크 모드 토큰·메시·grain 변형 포함은 `design-tokens.json` 및 `globals.css`(TDS :root/.dark) 참조.

## 4. Zoning — 텍스처를 어디에 쓰는가 (가장 중요)

질감은 *모든 화면*이 아니라 **브랜드 순간에만**. 희소할수록 강하게 각인되고 "쉽다"와 충돌하지 않는다.

- **Brand zone** (mesh + grain `0.05` + 글로우 + 그라데이션 버튼): 온보딩 · 히어로/랜딩 · 빈 상태 · **매칭 성공 순간** · 주요 CTA · 마케팅.
- **Work zone** (거의 무지 + grain `0.02`, 가독성 최우선): 사업자번호 입력 · 매칭 결과 리스트 · 코칭 체크리스트 · 대시보드 · 내부/관리 콘솔.
- **시그니처 변주(차별화)**: 메시 hue = **블루+민트**, grain 입자 `180px`·`mix-blend: overlay` 일관. → "다크+보라 메시" 기본값으로 수렴 금지.

## 5. 기술 컨텍스트 (코드 연속성)

- **스택**: Next.js (App Router) · Tailwind v4 · `shadcn/ui` 소스 소유(`apps/web/src/components/ui`).
- **컴포넌트 규칙**: 새 UI는 shadcn primitive(Button/Card/Badge/Input/Select/Tabs/Alert/Switch/Skeleton/Field) 위에 구성. button/card/badge 등을 hand-roll 하지 않는다.
- **기존 라우트**(재디자인 대상): `/` 랜딩 · `/login` · `/dashboard` · `/roadmap` · `/grants/[grantId]` 신청 시트 · `/internal/live-match` · `/admin`.

## 6. 화면별 생성 프롬프트 (Claude Design에 그대로 사용)

**6-1. 첫 페이지 / 비로그인 진입 (web, Brand zone)**
```
비로그인 방문자가 첫 화면에서 로그인 없이 바로 사업자번호를 입력해 조회를 시작.
히어로 전체는 Brand zone: 블루+민트 라이트 메시 + grain 0.05 + 입력창 뒤 글로우.
화면의 유일한 주연 = 중앙의 흰 검색바(Work zone 요소). 사업자번호 000-00-00000 자동 포맷,
"지원사업 찾기" 그라데이션 CTA. 로그인은 우상단 보조 아웃라인 버튼으로만.
신뢰 신호(회원가입 없이 조회·암호화·30초)는 caption. 아래 "이렇게 쉬워요" 3단계는 무지 Work zone.
```

**6-2. 매칭 결과 (mobile + web, zoning 동시 노출)**
```
상단 Brand zone 헤더: mesh+grain+glow, 단일 핵심 메시지 "지원 가능한 사업 N건을 찾았어요"(success 톤)
+ 요약 stat(총 지원 가능액 / 마감 임박 / 최고 적합도).
아래 Work zone 시트(shadow-3, radius 24): 흰 카드 리스트(사업명·지원금·마감 D-뱃지·적합도 바).
마감 임박 warning 뱃지, 탭 시 shadow-2로 떠오름(220ms). 필터는 칩 1개로 접고 상세는 바텀시트로.
```

**6-3. 신청 코칭 / 준비 (Work zone)**
```
선택한 사업의 신청 준비 체크리스트. 각 항목 = 회사 정보로 자동 채운 값 + 부족분만 입력 요청.
완료율 진행바(brand). 완료 시 부드러운 성공 모션. 다음 액션 1개만 하단 고정. 질감 최소(grain 0.02).
```

**6-4. 대시보드 (로그인 사용자, Work zone)**
```
저장된 사업체 요약 + 신규 매칭 알림 + 진행 중 신청. 정보 밀도 있되 무지 배경, 강한 숫자 위계.
빈 상태(empty)만 Brand zone 텍스처로 환기.
```

## 7. 레퍼런스 에셋 (이미 제작됨)

- `prototype-web-landing.html` — 6-1 데스크톱 구현(메시·grain·자동 포맷·반응형). **톤 승인됨.**
- `prototype-matching.html` — 6-2 모바일 구현(zoning 동시 노출). **톤 승인됨.**
- `claude-design-guideline.md` — 토큰·zoning·안티패턴 상세.

→ Claude Design에 이 HTML들을 업로드/캡처 입력으로 주면 "실제 제품처럼" 보이는 출발점이 된다.

## 8. 금지 / 안티패턴

- '다크 + 보라 메시 + 글로우' 기본값 그대로 = generic AI 클리셰. 반드시 블루+민트 시그니처 변주.
- Work zone 화면에 질감 풀가동(가독성 저하). 흰 배경 위 보라 그라데이션.
- 한 화면에 결정 2개 이상, 강조색 3회 이상. 사용자에게 "지원사업 용어 학습" 요구.
- Inter/Roboto로 폰트 수렴(한글 가독 우선 Pretendard 고정).
- shadcn 대체 컴포넌트 hand-roll.

## 9. 수락 기준 (생성물 검수)

- [ ] Brand/Work zone이 명확히 구분되고, 작업 화면이 충분히 차분한가
- [ ] 메시가 블루+민트 시그니처인가(보라 클리셰 아님)
- [ ] 브랜드 블루 = `#3182f6`, mint = `#2bd4a8` 일치 / 다크 모드에서도 brand 유지
- [ ] 한 화면 = 한 결정 / 상세는 progressive disclosure
- [ ] shadcn primitive 기반 / radius·shadow·spacing 토큰 일치
- [ ] 한글 마이크로카피가 짧고 안심시키는 톤

## 10. 이후: Claude Code 핸드오프

Claude Design에서 확정되면 **handoff bundle**(디자인 의도 포함)을 패키징해 Claude Code에 단일 지시로 전달:
```
첨부 handoff bundle을 Next.js(App Router)+shadcn으로 구현. design-tokens.json을 단일 출처로,
토큰 하드코딩 금지. zoning(Brand/Work)·빈/오류/로딩 상태·다크 모드 포함.
RN(모바일)은 grain=타일 PNG, mesh=Skia 셰이더로 동일 토큰 공유.
```
