# 매칭 데이터 소싱 아키텍처 — 사업자번호 기반 차원 충족 설계

> 2026-07-11. 상태: **설계 확정 · 구현 대기**. **매칭 14→22축 확장(구현팀) 흡수 완료.**
> 이 문서는 실행 계획이 아니라 **소싱 아키텍처의 단일 설계 참조**다. 매칭 차원이 더 늘어나도 같은 골격으로 소싱을 확장하도록 "확장 플레이북"(§7)을 중심에 둔다.
> 차원 정의 소유: 구현팀 `docs/plans/2026-07-11-matching-dimension-expansion.md`(14→22, 신규 8축). 이 필드들을 자가신고 너머로 채우는 소싱이 이 문서의 몫(확장 문서 §0가 "결격 외부 소싱은 소싱 트랙으로" 명시 이관).
> 근거: `docs/research/2026-07-11-codef-field-sourcing-scenario.md`, `docs/research/2026-07-10-company-data-matching-accuracy.md`, `docs/research/2026-07-10-bizno-enrichment-architecture.md`, `docs/research/nicebiz-api-specs/`.

---

## 1. Context — 왜 이 설계가 필요한가

**문제.** 방문자의 사업자등록번호만으로는 매칭 차원(현재 22개, `packages/contracts/src/index.ts`)을 채우지 못한다. 무동의로 안정 확보되는 건 5축뿐이고, 나머지는 자가신고(Q&A)→unknown→트러스트 게이트 강등으로 흐른다. 신규 8축(결격·재무·고용·투자)은 정확도의 최빈 게이트인 **배제(결격) 조건**을 담당하는데, 소싱 없이는 전부 자가신고에 의존한다. 매칭 정확도의 병목이 **데이터 소싱**에 있다.

**전제(이 문서의 위치).** 차원 정의·판정·온보딩은 매칭팀 소유. **그 차원을 사업자번호로 채우는 소싱은 이쪽 소유.** 두 팀의 접점은 `packages/contracts`. 매칭팀이 22축으로 확장했으니, 이 문서는 신규 8축의 소싱을 §7 플레이북으로 흡수해 완성한다.

**의도한 결과.** 무동의 baseline을 올려 더 많은 방문자가 L0에서 실점수를 보게 하고(→간편인증 전환 동기), 결격축을 자가신고 너머 공공/신용 소스로 채워 온보딩 부담을 줄이며, 새 차원이 또 추가돼도 커넥터 1개로 붙는 확장성을 유지한다.

**핵심 구조 사실(코드 확인 완료).** 무료 오버레이 삽입점은 `serviceData.ts:376-386`(SMPP 대칭 체이닝) 하나로 수렴 · `company_enrichment_cache`(`schema.ts:474-490`)는 provider/scope free-text+`expiresAt`이라 신규 소스 대부분 마이그레이션 불필요 · dimension별 저장은 현재 `self_declared`로 뭉갬(원천 추적은 캐시).

---

## 2. 핵심 멘탈 모델 — 축은 "데이터 접근 물리학"으로 두 층으로 갈린다

| 층 | 정의 | 마찰 | 예 |
|---|---|---|---|
| **A층 (조회형)** | 사업자번호만으로 공공/유료 조회 가능 | 0 | business_status, region, biz_age, industry, size, employees, certification, founder_trait, **법인 revenue·financial_health·tax_compliance·credit_status**, sanction(명단), insured_workforce(성립) |
| **B층 (증빙형)** | 본인 동의·증빙·자격증명 필요 | 높음 | **개인 revenue·결격**, founder_age, 정밀 employees, 법정확정 size/cert |

**핵심 통찰 2개.**
1. **CODEF(홈택스 간편인증)의 대체 불가능한 가치는 개인사업자 매출·결격**이다. 법인은 금융위(15043459, ✅실측 live)·NICE 무동의로 매출·재무·신용·체납까지 커버된다. 개인사업자 매출·재무·신용/체납은 공공/신용 DB에 없어 — **금융위 개인사업자재무(15108171)는 실측 결과 익명 집계 통계셋으로 판명(사업자번호 개별 조회 불가)** — 동의(간편인증) 외 길이 없다.
2. **결격축은 물리학이 반대다.** certification(opt-in)은 "보유"가 신호(positive-only). 결격(체납·제재)은 "부재"가 신호 — 소진적·권위 소스면 부재를 확정할 수 있다(§3.3 예외, §6′ 계약 조정).

**트러스트 게이트 결합.** 무동의 A층을 올리면 더 많은 방문자가 L0에서 실점수를 본다 → 간편인증 동기 상승. 결격 3축은 매칭팀이 `CORE_GATE`에 넣지 않고 신규 reason code `disqualification_unconfirmed`로 "빠른 확인 CTA"에 묶었으므로(확장 문서 D3), 우리 소싱이 결격을 미리 채우면 그 CTA 노출 자체가 줄어든다.

---

## 3. 소싱 머신 — 재사용 골격 (확장의 심장)

원본 패턴 = SMPP 오버레이(`packages/core/src/smpp/`, `serviceData.ts:833-865`).

### 3.1 커넥터 (`packages/core/src/<source>/`, 순수 로직·fixture 테스트)
입력=사업자번호(+동의), 출력=정규화 필드. env 원본 `readPopbillEnvConfig`(`popbill/check-biz-info.ts:113`).

### 3.2 매핑 (`packages/core/src/company/profile-from-<source>.ts`)
응답 → `CompanyProfile`(`packages/contracts/src/index.ts`) 필드 + `confidence.<dimension>`. 새 필드가 필요하면 contracts 선행 변경(매칭팀 공동).

### 3.3 오버레이 체인 (`serviceData.ts:376-386`, fail-open)
순서: `base(팝빌+NTS) → SMPP → kcomwel(employees) → registry(cert/sanction 배치) → [법인] 금융위·NICE`.
- **불변식 — positive-only**: 응답 있을 때만 set, 부재를 known으로 단정 금지(원본 `serviceData.ts:847-849`). certification 축은 영구 positive-only(`:830`).
- **《신규》 예외 — known-on-absence (결격축)**: **소진적·권위 소스**(NICE 신용평가원 신용정보, 사업자번호 포함 조달청 부정당제재 CSV)는 부재가 정보다 → 해당 소스가 커버하는 플래그를 `known_flags`에 넣어 부재를 확정(pass 가능하게). **비소진적 명단**(체불 스크래핑·갱신지연)은 present만 신뢰, 부재는 known 처리 안 함(자가신고 보완). 이 예외가 매칭팀 C1 게이트와 맞물리는 계약은 §6′.

### 3.4 유료 소스 가드 (조건부 라이브)
NICE·apick 등은 **조건 충족 시에만**(법인 && 해당 축 unknown && 실제 게이트하는 공고 존재) 호출 + per-bizno 상한 + 캐시 가드 + in-flight dedup. 원본 `apickBizDetail.ts:69-90`.

### 3.5 캐시 (마이그레이션 없이 확장)
`company_enrichment_cache` provider/scope free-text → 신규 provider 무료 추가.

### 3.6 원천 표기
dev 모니터 `FieldSourceLabel`/`fieldSource()`(`devServiceDataMonitor.ts:273-284`, `ServiceDataMonitor.tsx:69,687`)에 배지 1줄. dimension별 DB provenance 원하면 소스 enum 확장(선택).

### 3.7 신뢰도 등급
확정(감사·국세청·신용원) 0.85~0.95 / 근사(구조코드·가입기준) 0.6~0.75 / 퍼지(상호매칭) 0.55 / 자가신고 0.6(source=self_declared).

---

## 4. 22축 ↔ 소스 매핑 (state of play)

> 새 차원이 또 추가되면 이 표에 행을 더하고 §7 절차로 배선한다. 층/소스/단계/confidence 4칸이 채워지면 준비 완료.

| 차원 | 층 | 주 소스 | 상태 |
|---|---|---|---|
| business_status | A | NTS / 팝빌 | ✅ 구현 |
| region | A | 팝빌 주소 (→CODEF 확정) | ✅ |
| biz_age | A | 팝빌 개업일 (→CODEF) | ✅ |
| industry | A | 팝빌 업태/종목→KSIC | ✅ |
| size | A | 팝빌 corpScale (근사) | ✅ 근사 |
| target_type | A | 팝빌/CODEF 개인·법인 | ✅ |
| founder_trait | A | SMPP 여성/장애인 (성별 B) | ✅ 부분 |
| employees | A | 근로복지공단 고용·산재(상시근로자수) | 🟡 P1 설계 |
| certification | A | SMPP + 공개명단 배치 | 🟡 P2 설계 |
| revenue(법인) | A | 금융위 기업재무 `15043459`(**법인번호 키**·무료·✅live, 브리지=apick 법인번호) → NICE OCOV06 폴백 | 🟢 검증 |
| revenue(개인) | B | CODEF 부가세과세표준 (15108171은 익명집계셋 → 불가) | 🔴 스파이크 |
| founder_age | B | CODEF 간편인증 입력 | 🔴 자가신고 |
| **tax_compliance**(법인) | A | **NICE OCCD03/01**(공공정보 PB=체납) | 🟡 T3 설계 |
| tax_compliance(개인·관세·사회보험) | B/— | CODEF 납세증명 / 소스 불명 | 🔴 자가신고 |
| **credit_status**(법인) | A | **NICE OCCD03/06/01**(채무불이행·법정관리·부도·금융질서문란) | 🟡 T3 설계 |
| credit_status(압류·보증제한·개인) | —/B | OCCD 미커버 / 개인 DB 없음 | 🔴 자가신고 |
| **sanction** | A(배치) | 조달청 부정당제재 CSV(사업자번호) + 체불·중대재해 명단(상호 퍼지) | 🟡 T3 설계(부분) |
| sanction(부정수급 R&D) | — | IRIS 폐쇄형·부처 PDF | 🔴 자가신고 |
| **financial_health**(법인) | A | 금융위 기업재무 `15043459`(부채비율·자본총계·**자본금**·자산, ✅live·브리지 apick) | 🟢 검증 |
| financial_health(개인) | B | CODEF 재무제표 / 자가신고 (15108171 익명집계셋 → 불가) | 🔴 자가신고 |
| financial_health(이자보상배율) | A유료/B | NICE OCFN03 실측 / 자가신고 | 🔴 |
| **insured_workforce**(성립여부) | A | 근로복지공단 15059256 성립일 | 🟡 T3(P1 연계) |
| insured_workforce(피보험자수·감원) | B/— | CODEF 4대보험 명부(인증서) / 소스 없음 | 🔴 자가신고 |
| **investment**(TIPS) | A(배치) | jointips.or.kr 명단(기업명 퍼지) | 🟡 T3(부분) |
| investment(투자금·라운드) | — | 소스 없음 | 🔴 자가신고 |
| prior_award | B | 통합 API 없음 (매칭팀 후속 트랙) | 🔴 자가신고 |
| ip | B | KIPRIS Plus | 🔴 자가신고 |
| other | — | Q&A | 자유입력 |
| premises(예약) | B | 법인등기·건축물대장(NICE EG0950/EG1016) | ⬜ defer |
| export_performance(예약) | B | 무역협회·관세청 유니패스 | ⬜ defer |

---

## 5. Track 1 — 무동의 A층 기반 (기존 14축 · 우선순위 P1 ≫ P2 ≫ P3)

미러 원본: `smpp/check-certificates.ts` + `serviceData.ts:833-865`. 불변식 §3.3.

- **P1 employees** ← 근로복지공단 고용·산재(data.go.kr **15059256**, 키 사업자번호, 상시근로자수·성립일). 무료·라이브. 신규 `packages/core/src/kcomwel/`, `serviceData.ts` SMPP 뒤 체이닝, conf 0.7. **insured_workforce 성립여부도 이 소스가 겸함**(§6′). 마이그레이션 0.
- **P2 certification** ← 공개명단(벤처 15084581·이노비즈/메인비즈 3033893·사회적기업 15090102·연구소 KOITA). CSV에 사업자번호 없음 → 상호+시도 퍼지 배치. `CANONICAL_CERTS`(`certification/certs.ts:18-36`) 정규화 필수. conf 0.55. **신규 테이블 `registry_index`(=마이그레이션 1건, §6′에서 sanction·TIPS와 공용).** 여성/장애인은 SMPP 커버 → 제외.
- **P3 revenue(법인) — 개정**: 원래 NICE OCOV06(유료)였으나, **금융위 기업재무정보 V2(data.go.kr 15043459)가 매출·부채·자본·부채비율을 무료 반환**(`bizno-arch.md:38`) → **금융위 무료 우선, NICE OCOV06는 커버리지 폴백**. revenue와 financial_health(부채비율·자본잠식·**자본금** 포함)가 한 소스로 나온다 — **✅삼성전자 실측 live 확인**. 단 조회키가 법인등록번호 → **법인번호 브리지 필요(현재 apick만 제공, 팝빌 없음 → 브리지 소스가 별도 과제, §9)**. 개인사업자는 15108171이 익명 집계셋으로 판명(불가) → CODEF/자가신고.

---

## 6. Track 2 — CODEF 3대 가정 스파이크 (개인 매출·결격의 유일 경로)

기존 전면 플랜 `docs/plans/2026-07-11-codef-l1-demo.md`에서 뒷단을 잘라내고 앞단(토큰→2-way→2상품 원시응답)만 남긴 얇은 검증.

**3대 가정**: ① 세션 SSO 다상품 1회 인증(상품2가 추가승인 없이 `CF-00000`인가) ② 정식 단가(코드 0줄, 견적) ③ 개인사업자(간이·면세) 부가세과세표준 매출 커버리지.
**얇게 만드는 통찰**: RSA 불필요 · 마이그레이션 0(캐시 재활용) · `normalize`/`companyProfiles` 미접촉(원시응답 반환).
**go/no-go**: ①∧③ GO ∧ ② 성립 → 전면 L1. ③(개인 매출) 붕괴 시 보류 기본값. 상세 §이전판 유지.
**결격 확장(신규)**: CODEF는 개인사업자 tax_compliance(납세증명·지방세납세증명)의 유일 A층 경로 후보 — 스파이크 GO 후 상품 추가로 확장(현 스파이크 범위 밖).

---

## 6′. Track 3 — 신규 8축 소싱 (14→22 확장 흡수)

**핵심: 신규 6 판정축은 대부분 이미 계획한 소스로 흡수된다.** 새로 필요한 건 NICE OCCD 계열(법인 결격 신용/체납)과 registry 배치의 sanction 확장뿐. 나머지는 kcomwel·금융위·자가신고로 수렴.

### 6′-A. 법인 재무·신용·체납 — NICE (+ 금융위 무료)  〔A층·법인·동의불요〕
법인 신용정보 조회는 동의불요(법제처 해석, `bizno-arch.md:58,152`). 전부 사업자번호 단일키. NICE는 유료(건당 과금) → §3.4 조건부 가드.

| 축 | 소스(스펙 확인) | 출력 필드 |
|---|---|---|
| **financial_health** | 금융위 재무 V2(무료) 우선 / NICE **OCOV06** | `dbtTtlFvl`(부채총계)·`fdsTtlFvl`(자본총계)·`aettamt`(자산) → **부채비율·자본잠식(완전) 파생**. revenue와 동시 확보 |
| **tax_compliance**(법인) | NICE **OCCD03**(`pbCnt` 공공정보=체납)·OCCD01 | 국세·지방세 체납 발생건수·상세 |
| **credit_status**(법인) | NICE **OCCD03**(`bbCnt` 채무불이행·`fdCnt` 금융질서문란)·**OCCD06**(법정관리/워크아웃/파산)·OCCD01(당좌정지=부도) | flags: loan_default, financial_misconduct, rehabilitation/court_receivership, bond_default |

- **미커버(→ 자가신고)**: 압류·보증제한(OCCD 필드 없음), 관세·사회보험 체납(소스 불명), 자본금·이자보상배율(OCOV06에 없음 — OCFN01/OCFN03·EG0950 자본금 `EG0950:238` 실측 필요, MVP는 자본잠식 완전·부채비율만).
- **개인사업자**: NICE·금융위에 개인 신용/체납/재무 없음(15108171은 익명 집계셋으로 실측 판명) → **개인 매출·재무는 CODEF/자가신고가 유일**.
- **단가 경보**: 대부분 공고가 결격을 게이트 → 법인 사용자마다 OCCD 3콜 + 재무 필요할 수 있음. 완화: financial_health를 금융위 무료로 offload · demand-driven 호출 · 알려진 법인 batch pre-enrich. **단가 견적이 T2 CODEF와 함께 unit-economics 게이트.**

### 6′-B. 고용 — kcomwel(P1 연계)  〔A층 무료〕
- **insured_workforce.employment_insurance_active** ← P1 근로복지공단 15059256 성립일로 A층 무료 근사.
- **주의(통합 불가)**: 피보험자수 ≠ 상시근로자수(산정 근거법 상이, `14차원:113`) → insured_count 정밀값은 P1으로 못 채움. **B층 CODEF 4대보험 사업장 가입자명부**(공동인증서, `codef-scenario:93-98`)만. 감원이력(no_layoff/months_since_last_layoff) → 소스 없음 → 자가신고.

### 6′-C. 공개 명단 배치 — registry_index 일반화  〔A층이나 실시간 API 아님〕
sanction·investment은 대부분 공개이나 **사업자번호 실시간 조회 API가 아니라 명단**이다(웹 확인). → **P2 `cert_registry_index`를 `registry_index`로 일반화**: `registry_type`(certification|sanction|investment) + `polarity` + optional `biz_no` 컬럼. 배치 다운로드·정규화·퍼지매처(상호+대표자/시도) 인프라를 공용, 매핑만 축별로.

| 명단 | 소스·키 | 판정 |
|---|---|---|
| 부정당업자(참여제한) | 조달청 부정당제재 CSV(data.go.kr **15137996**) — **사업자번호·법인번호 포함** | ✅ 확인. 정확 매칭. 소진적 → known-on-absence |
| 체불사업주 | 고용부 명단 웹(moel.go.kr, 사업자번호 없음·상호+대표자+주소) | 부분. 스크래핑·퍼지. present-only |
| 중대재해 사업장 | data.go.kr **15090150**(상호 키, OpenAPI 있으나 사업자번호 없음) | 부분. 퍼지. present-only |
| 부정수급 R&D | IRIS 폐쇄형(대중 조회 불가)·보조금 부처 PDF | 🔴 자가신고 |
| **investment.TIPS** | jointips.or.kr 팀 목록(기업명, API 없음) | 부분. 스크래핑·퍼지. present-only |

- sanction present → flags 세팅 conf 0.9. 투자금·라운드 → 자가신고.

### 6′-D. 예약 2축 (defer)
premises: 법인등기(NICE EG0950)·건축물대장. export_performance: 무역협회·관세청 유니패스(B층). 매칭팀이 판정 활성화하면 §7로 흡수.

### 6′-E. 계약 조정 (매칭팀과 — 착수 전 합의 필수)
1. **known_flags 이중 경로**: 매칭팀 C1은 문항→플래그로 `known_flags`를 채운다. **우리 외부 소싱이 flags+known_flags를 채우는 제2 경로**가 된다. → 확장 문서 §2.3의 "문항→플래그 커버 맵"과 대칭인 **"소스→커버 플래그 맵"을 공유 계약으로 추가**. 소스가 커버하는 flag만 known, 나머지는 문항이 커버(완전성 테스트는 두 경로 합집합 기준).
2. **positive-only 예외 승인(§3.3)**: 소진적 소스(NICE 신용·부정당업자 CSV)만 known-on-absence 허용. 비소진적 명단은 present-only. 매칭팀 evaluator가 known_flags를 신뢰하므로, 어떤 소스를 소진적으로 볼지 합의 필요.
3. **드리즐 저장**: 확장 문서 M3(`drizzle.ts` 신규 6축 직렬화)와 우리 소싱 write 경로가 같은 `{flags, known_flags, exceptions}` 구조를 쓰는지 정합.
4. **confidence 정책**: 자가신고 0.6 vs 소싱 0.85~0.9 — 매칭 메시지 원천 표기.

---

## 7. 확장 플레이북 — 새 차원이 또 추가되면

1. **층 판정(§2)**: A층(사업자번호 조회) / B층(동의·증빙). 명단형이면 실시간 API인지 배치인지도 판정.
2. **소스 발굴**: A층 → data.go.kr / NICE BizAPI 27종(`nicebiz-api-specs/_index.json`) / 공개명단. B층 → CODEF / 자격증명 / 자가신고.
3. **커넥터(§3.1)** → 4. **contracts 계약(§3.2, 매칭팀 공동)** → 5. **오버레이 배선(§3.3/3.4)** → 6. **캐시(§3.5, 대개 마이그레이션 0)** → 7. **원천 배지(§3.6)** → 8. **트러스트 게이트·known_flags 협의(§6′-E)** → 9. **검증**.
- **결격형 축이면 §6′-E 계약 조정(known_flags·positive-only 예외)을 반드시 포함.**

---

## 8. 실행 순서 · 선행작업 · 마이그레이션 (구현 착수 시)

| 시점 | 트랙 | 작업 |
|---|---|---|
| 착수 즉시(외부 의존 없음) | T2 | CODEF 코어 C1(fixture) — Opus 위임 |
| | T1-P1 | kcomwel employees(+insured_workforce 성립) 배선 |
| 사람 선행(리드타임 김) | — | ① codef.io 데모 가입 ② CODEF·**NICE 단가 견적**(OCCD 3콜+재무 포함 산정) ③ data.go.kr 활용신청(15059256·15043459 금융위·15137996 조달청·15090150 중대재해) ④ 실계정 3종 |
| 키 확보 후 | T1-P1 / T2 | employees E2E / CODEF 스파이크 → go/no-go |
| 중기 | T1-P2 + T3-C | **registry_index 일반화**(마이그레이션 1건) — certification·sanction·TIPS 배치 공용 |
| NICE 계약 후 | T1-P3 / T3-A | 법인 재무(금융위 무료 우선) + 결격 신용/체납(NICE OCCD) |
| 매칭팀 합의 후 | T3-E | known_flags 소스맵·positive-only 예외 계약 |

**마이그레이션**: 필수 **1건**(`registry_index`, cert+sanction+TIPS 공용). NICE·금융위·kcomwel·CODEF는 캐시 free-text 재활용으로 불필요. `pnpm db:generate`→`db:migrate` 순서, generate에 기존 객체 재생성 섞이면 제거(0018~0025 전례).

**작업체계(CLAUDE.md)**: 구현 대량작업 Opus 위임, 메인(Fable) 검수. git 쓰기 전 stale-lock 처리. 관문 착수 전 `docs/research/CALIBRATION-TEMPLATE.md` 대조.

---

## 9. 미해결 · 추가 리서치 필요

**확인된 사실(이번 확정)**: NICE OCCD03/06/01·OCOV06 스펙 실재+필드 확인(법인·사업자번호·동의불요·유료) · 금융위 재무 V2 무료로 법인 부채비율·자본잠식 커버 · 조달청 부정당제재 CSV에 사업자번호 포함(15137996) · 중대재해 15090150·체불 웹·TIPS 웹은 상호 퍼지 · 상시근로자수≠피보험자수.

**추가 리서치·실측 필요**:
- **단가**: NICE OCCD 3콜+재무 건당 × 법인 사용자 비율 → unit economics(T2 CODEF 단가와 세트). 법인 결격이 near-universal 게이트라 비용 민감.
- **NICE 실측**: OCCD06 회생 개별 코드, OCFN03 이자보상배율 항목명, OCOV06 금액 단위. (자본금은 금융위 15043459가 무료 반환 → NICE 불요)
- **《Phase 2 실측》 법인번호 브리지 과제**: 금융위 법인재무(15043459, ✅live)는 **법인등록번호 키**인데, 사업자번호→법인번호 소스가 현재 **apick(유료·dev 한도)뿐**(팝빌 미제공). 법인재무를 넓게 켜려면 무료/저비용 법인번호 소스(NICE EG0950 등기 등)가 별도 과제.
- **《Phase 2 실측》 kcomwel(15059256) 502**: 게이트웨이가 근로복지공단 백엔드 502 반환(장애 추정). 파서는 fixture 검증, 라이브는 백엔드 복구 후 재스모크.
- **《Phase 2 실측》 금융위 개인사업자재무(15108171) 반증**: 익명 집계 통계셋 확정(사업자번호 개별 조회 불가) → 개인 매출·재무는 CODEF/자가신고로 확정.
- **명단 소스 미확정**: 관세·사회보험 체납, 압류·보증제한, R&D 참여제한(폐쇄형 확인 → 자가신고 확정), 보조금 부정수급 통합 API(부처 PDF만), 감원이력, 투자금·라운드 → 전부 자가신고 상한.
- **개인사업자 결격**: CODEF 납세증명 상품 추가(스파이크 GO 후).
- **계약**: §6′-E known_flags 소스맵·positive-only 예외를 매칭팀과 합의.
- dimension별 DB provenance(소스 enum 확장) — 현재 self_declared 뭉갬으로 무해, MVP 보류.

## 문서 지도
- 차원 확장(소유): `docs/plans/2026-07-11-matching-dimension-expansion.md`
- 근거 리서치: `docs/research/2026-07-11-codef-field-sourcing-scenario.md`, `docs/research/2026-07-10-company-data-matching-accuracy.md`, `docs/research/2026-07-10-bizno-enrichment-architecture.md`, `docs/research/nicebiz-api-specs/`(OCCD01/03/06·OCOV06·OCFN01/03·EG0950)
- 전면 CODEF L1: `docs/plans/2026-07-11-codef-l1-demo.md` · 선행 enrichment: `docs/plans/2026-07-05-matching-data-enrichment.md`
- 매칭 SSOT: `packages/contracts/src/index.ts` · `packages/core/src/matching/match.ts`
- 무대·대칭 원본: `apps/web/src/features/dev/ServiceDataMonitor.tsx`, `apps/web/src/lib/server/serviceData.ts`, `packages/core/src/{smpp,popbill}/`, `apps/web/src/lib/server/apickBizDetail.ts`
