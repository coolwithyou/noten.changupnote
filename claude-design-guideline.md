# 창업노트 — Claude Design 활용 가이드라인 & 디자인 시스템 v0.1

> 지원사업 매칭 플랫폼(iOS · Android · Web) / 핵심 철학: **"쉽다 = 인지부하 최소화"**
> 작성 기준: Claude Design (Anthropic Labs, 2026-04 출시 / 2026-06-17 디자인 시스템 import·코드 왕복 업데이트 반영)

---

## 0. 한 줄 요약

Claude Design에게 **매번 프롬프트로 교정하지 말고**, 아래 디자인 시스템 토큰을 **온보딩 단계에서 주입**해 방향을 고정한 뒤, **"refined-minimal"을 명시적으로 lock**하고 그라데이션·쉐도우를 *장식이 아니라 깊이·위계 도구*로만 쓰게 제약한다.

---

## 1. 전략 판단 — 왜 이렇게 접근하는가

### 1-1. 점검해야 할 전제: "세련된 그라데이션" 요청의 함정

Claude Design의 기본 엔진(`frontend-design` 스킬)은 **"generic AI slop을 피하라"**며 *BOLD·distinctive·maximalist* 방향을 강하게 권장하고, 명시적으로 **"흰 배경 위 보라색 그라데이션"을 진부한 안티패턴으로 금지**한다.

→ 따라서 "세련되게, 그라데이션 써줘" 같은 열린 프롬프트는 두 방향으로 실패한다:
- **과장**: 화려·장식적 방향으로 튀어 유틸리티의 명료함을 해친다.
- **위축**: 금지 규칙에 걸려 오히려 밋밋·무난해진다.

**해법**: 우리는 "BOLD"가 아니라 **"refined-minimal"이라는 명확한 컨셉을 선택**한다. 스킬 원문도 *"Bold maximalism and refined minimalism both work — the key is intentionality"*라고 명시한다. 즉 미니멀도 "의도적으로 정교하게" 실행하면 정답이다. 우리는 이 길을 택한다.

### 1-2. 질감(texture) 전략 — "AI 감성"을 구역으로 분리

지향하는 룩 = **mesh/aurora 그라데이션 + 노이즈(grain) 오버레이 + 소프트 글로우**. 이는 frontend-design 스킬이 *"gradient meshes, noise textures, grain overlays"*로 직접 권장하는 항목이라 Claude Design과 궁합이 좋다. 단 두 리스크를 관리한다:

1. **이 룩 자체가 AI 클리셰화**되었다 → 기본값을 그대로 쓰면 "generic AI aesthetic" 경고에 걸린다. 우리만의 변주(컬러 조합·grain 입자/blend·메시 형태 언어)를 정의해 차별화.
2. **가독성·"쉽다"와 충돌** → 작업 화면에서 배경이 살아있으면 명료함이 깎인다.

**해법: 구역 분리(zoning).** 질감은 *모든 화면*이 아니라 **브랜드 순간**에만 쓴다.

| 구역 | 질감 강도 | 적용 화면 |
|---|---|---|
| **Brand zone** | 풀가동 (mesh + grain + glow + 그라데이션 버튼) | 온보딩, 히어로/랜딩, 빈 상태, 매칭 **성공** 순간, 주요 CTA, 마케팅 |
| **Work zone** | 절제 (거의 무지 + grain ≤2% 미세) | 사업자번호 입력, 매칭 결과 리스트, 코칭 체크리스트 — 읽고 결정하는 화면 |

→ 질감이 희소하기 때문에 오히려 더 강하게 각인되고, "쉽다"와 싸우지 않는다.

쉐도우는 별개로, 위계 표현용 **부드러운 다층 쉐도우**(elevation 단계, §3-3)를 유지한다.

### 1-3. 토스보다 더 미니멀해지는 실질적 방법

토스는 정보 밀도가 높고 카드·뱃지·일러스트가 많다. "더 미니멀"은 *요소를 더 예쁘게*가 아니라 **한 화면 = 한 결정**으로 줄이는 것. 매칭 결과조차 "지원 가능 N건"이라는 단일 메시지로 압축하고, 상세는 점진적 공개(progressive disclosure)로 미룬다. → 디자인보다 **정보 구조(IA)**가 미니멀리즘의 80%다.

---

## 2. Claude Design 작동 방식에 맞춘 운영 전략

Claude Design은 **온보딩 시 코드베이스/디자인 파일을 읽어 디자인 시스템을 자동 생성**하고, 이후 모든 프로젝트에 색·타이포·컴포넌트를 자동 적용한다. 또한 GitHub 레포·디자인 파일·업로드로 **디자인 시스템을 import**하면, Claude가 그 컴포넌트로 빌드하고 결과물을 시스템과 **대조·자동 교정**한다.

### 권장 워크플로우

1. **시스템 주입**: 아래 §3 토큰을 `design-tokens.json` 또는 `globals.css` 형태로 만들어 레포에 두고 Claude Design 온보딩에 연결한다. (빈손 프롬프트보다 일관성·토큰 효율 압도적)
2. **방향 lock**: §4 시스템 프롬프트를 프로젝트 지침으로 고정한다.
3. **화면 생성**: §5 화면별 프롬프트로 1차 버전 생성.
4. **정교화**: 인라인 코멘트 / 직접 편집 / 조절 슬라이더(spacing·color·layout)로 라이브 수정 → "이 변경을 전체에 적용" 지시.
5. **핸드오프**: 확정 디자인을 handoff bundle로 묶어 Claude Code에 단일 지시로 전달(§6).

---

## 3. 디자인 시스템 토큰 (멀티플랫폼 기준)

> 색상은 의미 기반 토큰(semantic)으로 정의해 iOS/Android/Web에 동일하게 매핑. RN/Flutter/Web 어디로 가든 토큰 이름이 계약(contract)이다.

### 3-1. Color

```css
:root {
  /* Neutral — 화면의 90%는 여기서 */
  --bg-base:        #FBFBFC;  /* 앱 배경 (순백 금지: 눈부심·평면감 완화) */
  --bg-surface:     #FFFFFF;  /* 카드/시트 */
  --bg-subtle:      #F4F5F7;  /* 입력 비활성, 구분 면 */
  --border-subtle:  #ECEEF1;
  --text-strong:    #15171A;  /* 제목 */
  --text-default:   #3A3F47;  /* 본문 */
  --text-muted:     #8A9099;  /* 보조 */

  /* Brand — 단 하나의 강조색 (CTA·핵심 강조 전용) */
  --brand:          #2E6BFF;  /* 신뢰감 있는 블루 (예시; §3-5 참고) */
  --brand-pressed:  #2356D6;
  --brand-tint:     #EAF1FF;  /* 강조색 배경 (선택 상태 등) */

  /* Semantic */
  --success:        #1FA971;  /* 지원 가능 */
  --warning:        #E5A100;  /* 마감 임박 */
  --danger:         #E5484D;  /* 지원 불가/오류 */
}
```

**규칙**: 한 화면에 강조색(`--brand`)은 1~2회만. 나머지는 전부 neutral. 강조가 흔해지면 "쉽다"가 무너진다.

### 3-2. Gradient & Texture (Brand zone vs Work zone)

**Work zone — 면 위계용 미세 그라데이션 (보일 듯 말 듯)**
```css
:root {
  --grad-surface: linear-gradient(180deg, #FFFFFF 0%, #FBFBFC 100%); /* 명도차 ≤6% */
}
```

**Brand zone — mesh/aurora 그라데이션 (분위기·질감)**
```css
:root {
  /* 여러 radial을 겹쳐 만드는 메시. 라이트/다크 둘 다 가능 */
  --grad-mesh-light:
    radial-gradient(60% 50% at 20% 15%, #EAF1FF 0%, transparent 60%),
    radial-gradient(55% 45% at 85% 25%, #E6FBF1 0%, transparent 55%),
    radial-gradient(70% 60% at 50% 100%, #EEF0FF 0%, transparent 65%),
    var(--bg-base);
  --grad-mesh-dark:
    radial-gradient(60% 50% at 18% 12%, #1B2A5B 0%, transparent 60%),
    radial-gradient(55% 45% at 88% 22%, #123D34 0%, transparent 55%),
    radial-gradient(75% 65% at 50% 105%, #181C2E 0%, transparent 65%),
    #0D0F14;
  --glow-brand: radial-gradient(closest-side, rgba(46,107,255,0.35), transparent); /* 버튼/포커스 글로우 */
}
```

**Grain (노이즈 오버레이)** — SVG `feTurbulence`를 타일 PNG로 굽거나 인라인. blend·opacity로 입자만 얹는다.
```css
.grain::after {
  content:""; position:absolute; inset:0; pointer-events:none;
  background-image:url("/assets/grain.png");      /* 128~256px 타일, 모노크롬 */
  background-size:180px; mix-blend-mode:overlay;
  opacity:0.06;                                    /* Brand zone */
}
.grain--work::after { opacity:0.02; }              /* Work zone, 거의 안 보이게 */
```

**그라데이션 버튼 (Brand CTA)**
```css
.btn-brand {
  background:linear-gradient(180deg, #3D78FF 0%, #2E6BFF 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.25),  /* 상단 하이라이트 */
              0 6px 16px rgba(46,107,255,0.30);       /* 컬러 글로우 */
  border-radius:var(--r-pill);
}
.btn-brand::after { /* 위 .grain 규칙 재사용해 미세 질감 */ }
```

> 변주 포인트(차별화): 메시 hue 조합을 "블루+민트" 같은 우리 시그니처로 고정, grain 입자 크기(180px)와 `mix-blend-mode`를 일관되게 사용 → 남들의 "보라+다크" 기본값과 분리.

### 3-2b. 멀티플랫폼 질감 구현 메모

- **Web**: 위 CSS 그대로.
- **React Native**: CSS grain/mesh 불가 → grain은 **타일 PNG**(`<ImageBackground>` repeat), 메시는 미리 구운 이미지 또는 **Skia/Reanimated 셰이더**. Claude Design은 셰이더/3D("Frontier design")를 지원하므로 핸드오프 시 셰이더 코드까지 받을 수 있음.
- **성능**: 저사양 기기·다크모드에서 mesh+grain 동시 렌더는 비용↑. Work zone은 정적 이미지로, 애니메이션 메시는 Brand zone 한정.

### 3-3. Shadow (Elevation 단계)

```css
:root {
  --shadow-1: 0 1px 2px rgba(20,23,26,0.04), 0 1px 1px rgba(20,23,26,0.03);  /* 카드 */
  --shadow-2: 0 4px 12px rgba(20,23,26,0.06), 0 1px 3px rgba(20,23,26,0.04); /* 떠 있는 시트/팝오버 */
  --shadow-3: 0 12px 32px rgba(20,23,26,0.10), 0 4px 8px rgba(20,23,26,0.05);/* 모달/바텀시트 */
}
```
색은 검정이 아닌 **잉크 톤(20,23,26)** + 낮은 alpha로 부드럽게. 단일 강한 그림자 대신 **2겹**으로 자연스러운 깊이.

### 3-4. Type / Spacing / Radius / Motion

```css
:root {
  /* Type — 한글 가독 우선. 본문은 시스템 한글 폰트, 숫자/영문 강조에 1개 디스플레이 */
  --font-body: "Pretendard", -apple-system, "SF Pro", "Roboto", sans-serif;
  --fs-display: 28px/1.25;  --fw-display: 700;
  --fs-title:   20px/1.35;  --fw-title:   600;
  --fs-body:    16px/1.55;  --fw-body:    400;
  --fs-caption: 13px/1.45;  --fw-caption: 400;

  /* Spacing — 4pt grid */
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:24px; --sp-6:32px; --sp-8:48px;

  /* Radius — 부드러움의 핵심 */
  --r-sm:10px; --r-md:16px; --r-lg:24px; --r-pill:999px;

  /* Motion — 빠르고 절제 */
  --ease: cubic-bezier(0.22, 1, 0.36, 1);  /* ease-out 강조 */
  --dur-fast:140ms; --dur-base:220ms;
}
```

### 3-5. 강조색은 검증 후 확정

`#2E6BFF`는 예시다. "신뢰(공공·금융 인접)"가 톤이면 블루 계열이 안전하지만, 경쟁군과 차별화하려면 **딥 그린/틸** 같은 단색도 후보. Claude Design에서 3~4안을 동시 생성해 비교 결정 권장.

---

## 4. Claude Design 시스템 프롬프트 (프로젝트 지침으로 고정)

> 그대로 복사해 프로젝트 인스트럭션/온보딩에 넣는다.

```
[제품] 창업노트 — 사업자번호만 입력하면 지원 가능한 공공지원사업을 매칭·코칭해주는 플랫폼.
[플랫폼] iOS · Android · Web (반응형, 모바일 우선)
[유일한 디자인 원칙] "쉽다" = 인지부하 최소화. 한 화면 = 한 결정.

[미적 방향 — 고정]
- Refined-minimal. BOLD/maximalist 아님. 의도적이고 정교한 미니멀리즘으로 실행.
- 첨부된 design-tokens(또는 globals.css)를 단일 출처로 사용. 토큰 밖의 색/폰트/그림자 생성 금지.

[질감·그라데이션 규칙 — 구역 분리]
- Brand zone(온보딩·히어로·빈 상태·매칭 성공·주요 CTA): mesh/aurora 그라데이션 + grain(opacity ~0.06) + 소프트 글로우 풀가동. 버튼은 그라데이션 + 상단 inset 하이라이트 + 컬러 글로우.
- Work zone(입력·결과 리스트·코칭): 거의 무지 + grain ≤0.02. 배경이 가독성을 방해하면 안 됨.
- 시그니처 변주 고정: 메시 hue는 블루+민트 조합, grain 입자 180px·mix-blend overlay로 일관. '다크+보라' 기본값으로 수렴 금지.
- 쉐도우는 elevation 단계(shadow-1/2/3)로만. 잉크톤 + 낮은 alpha, 2겹.
- 강조색(brand)은 Work zone에서 한 화면에 1~2회.

[금지]
- '다크 + 보라 메시 + 글로우'의 기본값 그대로 = generic AI 클리셰. 반드시 시그니처 변주 적용.
- 흰 배경 위 보라색 그라데이션.
- Work zone 화면에 질감 풀가동(가독성 저하).
- Inter/Roboto/Arial 등 평범한 폰트로의 수렴(본문은 Pretendard, 한글 가독 우선).
- 정보 밀도 과잉. 모든 상세는 progressive disclosure로 미룬다.

[레이아웃]
- 4pt 그리드, 넉넉한 여백. 카드는 radius 16~24, shadow-1.
- 바텀시트/모달은 shadow-3. 모바일에서 주요 액션은 하단 고정.

[톤 앤 보이스]
- 전문용어 최소화. "지원사업"의 복잡성을 사용자에게 떠넘기지 않는다.
- 마이크로카피는 짧고 안심시키는 문장. (예: "사업자번호만 넣으면 끝이에요")
```

---

## 5. 핵심 화면별 프롬프트 예시

### 5-1. 진입 / 사업자번호 입력 (제품의 첫인상 = "쉽다"의 증명)
```
온보딩 후 첫 화면. 화면 중앙에 사업자번호 입력 단 하나만. 보조 설명 1줄.
부드러운 surface 그라데이션 배경(grad-surface), 입력 필드는 radius-md·shadow-1.
"조회하기" CTA는 brand 색 pill 버튼, 하단 고정.
입력 외 모든 요소 제거. 신뢰 신호(개인정보 안전 문구)는 caption으로 작게.
상태: 빈 값 / 입력 중 / 유효성 오류(danger) / 조회 로딩(스켈레톤).
```

### 5-2. 매칭 결과 (한 줄 메시지로 압축 → 점진 공개)
```
상단에 단일 핵심 메시지: "지원 가능한 사업 N건을 찾았어요". success 톤.
그 아래 카드 리스트(각 카드 = 사업명, 지원금 규모, 마감일 뱃지, 적합도).
마감 임박은 warning 뱃지. 카드는 shadow-1, 탭 시 shadow-2로 살짝 떠오르는 모션(220ms, ease).
필터/정렬은 접어두고 칩 하나로만 노출. 상세 정보는 카드 탭 후 바텀시트(shadow-3)에서.
```

### 5-3. 코칭 / 신청 준비 (맞춤 데이터 제공)
```
선택한 사업의 '신청 준비' 화면. 체크리스트형 진행(준비 서류·자격요건·필요 데이터).
각 항목 = 우리가 회사 정보로 자동 채운 값 + 부족분만 사용자 입력 요청.
완료율 진행바(brand). 완료 시 부드러운 성공 모션. 다음 액션 1개만 하단 고정.
```

---

## 6. Claude Code 핸드오프

디자인 확정 후 Claude Design의 **handoff bundle**(디자인 의도 포함)을 Claude Code에 전달한다. 단일 지시 예:
```
첨부된 창업노트 매칭결과 화면 handoff bundle을 React Native(Expo) + 웹 공유 컴포넌트로 구현.
design-tokens.json을 단일 출처로, 토큰 하드코딩 금지. 바텀시트·스켈레톤·빈/오류 상태 포함.
```
→ 토큰을 RN/Web이 공유하므로 3개 플랫폼이 자동으로 시각적 일관성을 갖는다.

---

## 7. 안티패턴 체크리스트 (리뷰 시 확인)

- [ ] Work zone 화면에 질감이 강하다 → grain ≤0.02, 배경 무지화
- [ ] 메시·grain이 '다크+보라' 기본값 그대로 → 시그니처 변주(블루+민트, 입자 일관) 적용
- [ ] 질감이 모든 화면에 깔려 희소성 상실 → Brand zone에만 집중
- [ ] 한 화면에 강조색 3회 이상 → neutral로 환원
- [ ] 카드/뱃지/아이콘 과밀 → 점진 공개로 분리
- [ ] 사용자에게 "지원사업 용어 학습"을 요구 → 마이크로카피로 번역
- [ ] 한 화면에 결정이 2개 이상 → 분리하거나 우선순위 1개만 강조
- [ ] 폰트가 Inter/Roboto로 수렴 → Pretendard 등 한글 가독 폰트 고정

---

## 8. 다음 단계 제안

1. **강조색 확정**: Claude Design에서 블루 / 딥그린 / 틸 3안 동시 생성 → 비교 결정.
2. **토큰 파일화**: 위 §3을 `design-tokens.json` + `globals.css`로 만들어 레포에 커밋 → 온보딩 연결.
3. **3개 핵심 화면 프로토타입**: §5 프롬프트로 입력→결과→코칭 흐름 먼저 검증.

원하시면 이 가이드라인을 바탕으로 (a) `design-tokens.json` 실제 파일을 만들어 드리거나, (b) Claude Design에 바로 붙일 강조색 3안 비교용 프롬프트 세트를 짜드리겠습니다. 어느 쪽부터 갈까요?
