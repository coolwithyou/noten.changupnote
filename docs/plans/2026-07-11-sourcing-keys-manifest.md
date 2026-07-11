# 소싱 키 매니페스트 — dev/service-data 22필드 검증용

> 2026-07-11. 목적: `dev/service-data` 페이지에서 22축 소싱 전략을 검증하기 위해 **확보해야 하는 모든 외부 키/자격증명**을 한 곳에 나열. 키가 들어오는 대로 `.env.local`에 추가하면 해당 필드가 대기→라이브로 점등된다.
> 근거: 소싱 설계 `docs/plans/2026-07-11-matching-data-sourcing.md`, 차원 정의 `docs/plans/2026-07-11-matching-dimension-expansion.md`.
> env 로더: `apps/web/src/lib/server/loadMonorepoEnv.ts` — **`.env.local` 우선** → `.env`. 코어는 `process.env` 직접 read.

## 필드 상태 모델 (페이지가 키를 다루는 방식)

각 필드는 아래 상태로 렌더된다. **"키 누락 → 대기, 데이터 어긋남 → 실패"** 요구를 그대로 구현:

| 상태 | 조건 | 표시 |
|---|---|---|
| `self-declared` | Q&A 자가신고 (키 불필요) | 항상 가능 |
| `pending` | 소스 env **미설정** | 회색 "키 없음" + 계획 소스 라벨 |
| `live` / `cache` | 키 있음 + 호출 성공 + 값·스키마 정상 | 값 + 소스 배지 + confidence |
| `failed` | 키 있음이나 **호출 에러 / 빈 응답 / 스키마 불일치·파싱 실패** | 빨강 "실패" + 사유 |
| `n/a` | 법인 전용축인데 개인(또는 역) · 예약축 | 회색 "해당 없음" |

---

## A. 이미 설정됨 (라이브 — 확인만)

| 소스 → 필드 | env 변수 | 발급처 | 비용 |
|---|---|---|---|
| 팝빌 기업정보조회 → corp_name·region·biz_age·industry·size·target_type | `POPBILL_SECRET_KEY`(또는 `POPBILL_API_KEY`), `POPBILL_LINK_ID`, `POPBILL_CORP_NUM`, `POPBILL_CHECK_CORP_NUM`, `POPBILL_IS_TEST`/`POPBILL_ENVIRONMENT` | popbill.co.kr | 유료(건당) |
| NTS 국세청 사업자상태 → business_status | `CUNOTE_NTS_SERVICE_KEY` | data.go.kr(odcloud nts-businessman) | 무료 |
| SMPP 공공구매 → founder_trait(여성·장애인) | `CUNOTE_SMPP_SERVICE_KEY` | data.go.kr `B550598` | 무료 |
| apick biz_detail → employees·신용등급(dev 탐색) | `APICK_API_KEY`(또는 `APICK_AUTH_KEY`/`CL_AUTH_KEY`) | apick.app | 유료(dev 한도) |

→ 이 4개가 `.env.local`에 있는지만 확인. 없으면 여기부터 실패로 뜬다.

---

## B. 신규 · data.go.kr 무료 (활용신청만 — 가장 빠름, 최우선)

**data.go.kr는 계정당 인증키 1개.** 기존 `CUNOTE_NTS_SERVICE_KEY`와 **같은 키 문자열**을 아래 새 변수에 넣고, 각 데이터셋 **활용신청(대개 자동승인)**만 하면 된다. (기존 NTS/SMPP가 쓰는 인코딩/디코딩 키 형식과 동일하게.)

| 소스 → 필드 | env 변수(신규) | 데이터셋 ID | 조회키 | 유형 | 확보 |
|---|---|---|---|---|---|
| 근로복지공단 고용·산재 현황정보 → **employees**, **insured_workforce.성립여부** | `CUNOTE_KCOMWEL_SERVICE_KEY` | `15059256` | 사업자번호 `v_saeopjaDrno` ✓ | OpenAPI | 활용신청 |
| 금융위 기업재무정보 → **revenue·financial_health(법인)** ✅live | `CUNOTE_FSC_FINANCE_SERVICE_KEY` | `15043459` | **법인등록번호 `crno`** ⚠️(브리지=apick 법인번호, 팝빌 없음) | OpenAPI | 활용신청 |
| ~~금융위 개인사업자재무~~(익명집계셋 실측 반증) | — | `15108171` | 사업자번호 조회 불가 → 개인 재무는 CODEF | — | ❌ 미사용 |

**배치(키 불필요 — 파일 다운로드/스크래핑, 런타임 키 없음):**
| 소스 → 필드 | 데이터셋/URL | 비고 |
|---|---|---|
| 고용부 중대재해 사업장 → **sanction**(serious_accident_listed) | data.go.kr `15090150` (**fileData.do** CSV) | 사업자번호 없음(사업장명·소재지) → 상호 퍼지. `/openapi.do`는 404 |
| 조달청 부정당제재 → **sanction**(participation_restricted) | data.go.kr `15137996` (CSV) | **사업자번호 포함** → 정확 매칭. registry_index 배치 |
| 공개명단 certification(벤처·이노비즈·메인비즈·사회적기업·연구소) | `15084581`·`3033893`·`15090102`·KOITA | 상호+시도 퍼지. registry_index 배치 |
| 체불사업주 → **sanction**(wage_arrears_listed) | moel.go.kr 웹 | 스크래핑, 상호+대표자 퍼지 |
| TIPS 선정기업 → **investment.tips_backed** | jointips.or.kr 웹 | 스크래핑, 기업명 퍼지 |

---

## C. 신규 · CODEF (개인 매출·결격 — 데모 일 100건 무료)

간편인증 2-way. 사용자 보유 데모키 있으면 즉시.

| env 변수 | 발급처 | 비고 |
|---|---|---|
| `CODEF_CLIENT_ID` | codef.io | |
| `CODEF_CLIENT_SECRET` | codef.io | |
| `CODEF_PUBLIC_KEY` | codef.io 키관리 | RSA(간편인증 경로는 선택) |
| `CODEF_ENVIRONMENT` | `demo`\|`production` | → `development.codef.io`/`api.codef.io` |

- **상품 신청(데모)**: 사업자등록증명, 부가세과세표준증명 (스파이크). 이후 확장: 납세증명(tax_compliance 개인), 표준재무제표(financial_health 개인), 4대보험 명부(insured_count 정밀).
- **Unlocks**: revenue(개인), founder_age(간편인증 입력), tax_compliance(개인), insured_workforce.insured_count(정밀).
- 데모는 추가인증 지원, **샌드박스는 추가인증 미지원**. 실계정(법인1·일반과세 개인1·간이/면세 개인1) 필요.

---

## D. 신규 · NICE BizAPI (법인 결격·재무 — 데모 테스트앱 / 유료 계약)

BizAPI OpenGate. 헤더 인증.

| env 변수 | 발급처 | 비고 |
|---|---|---|
| `NICE_BIZ_CLIENT_APP_KEY` | nicebizline.com | App Key → 인증 헤더로 매핑(정확한 헤더명은 OpenGate 문서 확인) |
| `NICE_BIZ_CLIENT_SECRET` | nicebizline.com | Secret Key |
| `NICE_BIZ_ENVIRONMENT`(선택) | `demo`\|`production` | 게이트웨이 `api.nicebizline.com/api/opengate` |

- **Unlocks(스펙 확인됨)**: tax_compliance(법인) **OCCD03/OCCD01**, credit_status(법인) **OCCD03/OCCD06/OCCD01**, revenue/financial 폴백 **OCOV06**, 자본금 **EG0950**, 이자보상배율 **OCFN03**.
- **데모 테스트앱 = 고정 응답**(스펙 IF3121·EG1016 주석: "테스트 앱 호출 시 고정 응답, 실제는 계약 후"). → **필드 구조·파싱 검증엔 되지만 실데이터는 계약 후**. 페이지에선 데모키로 `live`(단, 값이 고정 샘플임을 배지로 구분) → 계약 후 실값.
- 법인 신용정보는 동의불요(법제처). 유료 견적제(건당) — 단가 문의 병행.

---

## E. 키 불필요 (자가신고 — Q&A로 지금 검증)

압류·보증제한(credit_status), 관세·사회보험 체납(tax_compliance), 부정수급·보조금위반(sanction), 투자금·라운드(investment), 감원이력(insured_workforce), prior_award, ip, founder_trait(청년·시니어), certification(중소·소상공인·창업 확인서 자가), target_type(예비창업), other. → 소스 없음/폐쇄형이라 Q&A가 상한.

## F. 후속·예약
KIPRIS Plus(ip) `KIPRIS_SERVICE_KEY` — 후속. premises·export_performance — 예약(defer).

---

## `.env.local` 추가 블록 (템플릿)

```dotenv
# --- 신규 data.go.kr (기존 CUNOTE_NTS_SERVICE_KEY와 같은 키 재사용 가능, 데이터셋만 활용신청) ---
CUNOTE_KCOMWEL_SERVICE_KEY=            # 15059256 고용·산재 현황 → employees, insured 성립 (키=사업자번호)
CUNOTE_FSC_FINANCE_SERVICE_KEY=        # 15043459 법인재무(키=법인번호, ✅live·브리지 apick). 15108171 개인재무는 익명집계셋 → 미사용
# 중대재해(15090150)는 파일데이터 → 런타임 키 없음, Phase 2 배치

# --- CODEF (개인 매출·결격, 데모 무료) ---
CODEF_CLIENT_ID=
CODEF_CLIENT_SECRET=
CODEF_PUBLIC_KEY=
CODEF_ENVIRONMENT=demo

# --- NICE BizAPI (법인 결격·재무, 데모 테스트앱→계약) ---
NICE_BIZ_CLIENT_APP_KEY=
NICE_BIZ_CLIENT_SECRET=
NICE_BIZ_ENVIRONMENT=demo
```

## 확보 우선순위 (ROI 순)

1. **data.go.kr 활용신청 3건**(무료·자동승인급, 기존 키 재사용) → employees·법인 매출·재무건전성·중대재해 즉시 점등. **가장 빠른 커버리지 확대.**
2. **CODEF 데모키**(보유분 있으면 즉시) → 개인 매출·결격 스파이크 3대 가정 검증.
3. **NICE 데모 테스트앱** → 법인 결격 필드 구조·파싱 검증(고정응답). 실데이터·단가는 계약 후.
4. 배치(부정당업자 CSV·공개명단·체불·TIPS)는 키 불필요 — 배치 파이프라인 구축 사안.

## 문서 지도
- 소싱 설계(22축 매핑·트랙): `docs/plans/2026-07-11-matching-data-sourcing.md`
- 차원 정의: `docs/plans/2026-07-11-matching-dimension-expansion.md`
- CODEF 전면: `docs/plans/2026-07-11-codef-l1-demo.md` · 근거: `docs/research/2026-07-11-codef-field-sourcing-scenario.md`, `docs/research/nicebiz-api-specs/`
- 무대: `apps/web/src/app/dev/service-data/page.tsx`, `apps/web/src/features/dev/ServiceDataMonitor.tsx`, `apps/web/src/lib/server/serviceData.ts`
