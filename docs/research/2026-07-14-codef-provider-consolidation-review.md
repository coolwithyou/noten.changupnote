# CODEF 중심 외부 기업정보 통합 검토

> 검토일: 2026-07-14 (Asia/Seoul)<br>
> 상태: 아키텍처 의사결정 제안 · 구현 전<br>
> 범위: 사업자등록번호를 기준으로 회사 매칭 프로필을 만드는 외부 데이터 경로<br>
> 제외: 지원사업 공고 수집(K-Startup·기업마당), 결제, OAuth, LLM 등 회사정보 인리치먼트가 아닌 연동

## 1. 결론

판정은 다음과 같다.

- **GO — CODEF를 로그인 후 `소유자 동의 기반 심화조회`의 대표 게이트웨이로 확대한다.** 홈택스 증명·매출·세무·재무, 일부 4대보험/근로복지공단, Work24 지급내역, 중소기업확인서를 한 계약·토큰·전송 계층 아래 묶을 수 있다.
- **NO-GO — 익명 랜딩부터 모든 외부 정보를 CODEF 하나로 즉시 교체하지 않는다.** 사업자번호만 입력된 랜딩에서 필요한 무인증 기본정보를 CODEF 사업자등록증명이 대체하지 못하며, 해당 상품은 간편인증/인증서와 추가인증이 필요하다.
- **NO-GO — 현재 CODEF 구현을 그대로 운영 매칭에 승격하지 않는다.** 제품 resolver가 CODEF를 의도적으로 비활성화하고 있고, VAT 엔드포인트·응답 정규화가 현재 공식 개발가이드와 어긋난다.
- **유지 — NTS 직접 상태조회, Popbill 익명 기본정보, SMPP, KISed, KIPRIS, 공개명단, OpenDART/FSC를 당분간 유지한다.** CODEF가 없거나, 범위가 다르거나, 무료 직접 API를 유료 중계로 바꾸는 실익이 작은 영역이다.

따라서 목표는 `모든 공급자 1개`가 아니라 아래의 **3개 데이터 면(data plane)** 이다.

```text
익명 공개 면       NTS + 공개/기존 캐시 + Popbill 조건부 폴백
소유자 동의 면     CODEF (홈택스 중심, 필요 시 보험·Work24·sminfo 확장)
공공·특수 면       KIPRIS + KISed + SMPP + OpenDART/FSC + 공개명단
```

이 구조는 사용자 마찰과 유료 호출을 랜딩에서 늘리지 않으면서, 실제 관리비가 큰 인증·세션·민감정보 경로를 CODEF 쪽으로 모은다.

## 2. 이번 검토에서 바로잡는 전제

사용자 관점에서는 Popbill이 첫 조회처럼 보이지만, **현재 cache miss의 실제 호출 순서에는 NTS 사전 게이트가 Popbill보다 앞선다.**

```text
사업자번호 입력
  → 브라우저 checksum 검증
  → POST /api/web/company-preview
  → 익명 사용 가능 캐시 조회
     · Popbill checkBizInfo
     · APICK bizDetail
     · KISed 창업기업확인
     · KIPRIS 권리정보
  → 필수 기본 프로필이 없으면 명시적 공개 조회
     · NTS 사업자등록상태 사전 게이트
     · Popbill checkBizInfo 유료 호출(영속 guard + single-flight)
     · SMPP 여성/장애인기업 확인서 보강
  → 캐시 재조립
  → 확인 모달
  → /matches?biz=...
```

근거 코드:

- 랜딩 요청: `apps/web/src/features/landing/use-biz-lookup.ts:40-45, 105-199`
- 익명 cache-only 정책: `apps/web/src/lib/server/productProfile/resolveProductCompanyProfile.ts:69-90, 190-199, 215-240`
- cache miss 후 공개 기본조회: `apps/web/src/lib/server/serviceData.ts:1330-1395`
- NTS → Popbill 순서와 과금 가드: `apps/web/src/lib/server/serviceData.ts:473-561, 887-930`
- SMPP 후처리: `apps/web/src/lib/server/serviceData.ts:992-1079`

### 2.1 제품 매칭과 dev 진단 경로는 다르다

현재 코드에는 공급자가 많아 보이지만 모두 운영 매칭에서 live 호출되는 것은 아니다.

| 경로 | 실제 동작 |
|---|---|
| 익명 랜딩/제품 매칭 | Popbill/APICK/KISed/KIPRIS **캐시만** 우선 소비. 기본 프로필이 없을 때만 NTS → Popbill → SMPP를 호출한다. |
| 소유 회사 읽기 | 사용자/회사에 저장된 프로필을 기본으로 사용한다. |
| dev 서비스데이터 진단 | Kcomwel, KIPRIS, FSC, OpenDART, NICE, CODEF 캐시, 공개명단, KISed를 병렬 실행/판독한다. 주석상 dev 전용이다. |
| CODEF | dev 오케스트레이터가 남긴 캐시를 수동 판독할 뿐이며, 제품 resolver에서는 현재 `disabled/fail_closed`다. |
| NICE | 데모/비계약 상태로 제품 resolver에서 `disabled/fail_closed`다. |

`runExternalConnectors`의 현재 병렬 구성은 `apps/web/src/lib/server/devServiceDataMonitor.ts:2438-2475`, 제품 정책의 CODEF/NICE 비활성화는 `apps/web/src/lib/server/productProfile/resolveProductCompanyProfile.ts:84-89`에 있다.

## 3. 현재 외부 회사정보 공급자 인벤토리

| 공급자/원천 | 현재 역할 | 현재 제품 영향 | CODEF 대체 판정 |
|---|---|---:|---|
| NTS/data.go.kr | 휴·폐업/과세유형, Popbill 과금 전 사전 게이트 | 운영 live | **기술적 대체 가능, 유지 권장**. CODEF `KR_PB_NT_001`이 같은 범주지만 무료 직접 경로를 유료/간접 경로로 바꿀 이유가 약하다. |
| Popbill | 상호·주소·개업일·업태/종목·상태 등 익명 기본정보 | 운영 핵심, cache miss live | **동의 후에는 대체 가능, 익명은 대체 불가**. 무인증 범용 기업상세가 CODEF 공개 카탈로그에서 확인되지 않았다. |
| SMPP | 여성기업·장애인기업 확인서 positive-only | 운영 live 보강 | **유지**. 2026-07-14 CODEF 공개 카탈로그 검색에서 대응 상품을 찾지 못했다. |
| APICK | 무인증 기업상세와 법인번호 브리지 | 제품은 fresh cache만, dev에서 live | **유지/재협상 대상**. CODEF 통신판매업 조회는 신고업체만 대상으로 하므로 범용 대체재가 아니다. |
| KISed | 창업기업확인서 | 제품은 fresh cache만, dev에서 live | **유지**. 대응 공개 상품을 찾지 못했다. |
| KIPRIS | 특허·실용신안·디자인·상표 | 제품은 fresh cache만, dev에서 live | **유지**. CODEF 카탈로그에 KIPRIS/지재권 대응 상품이 없다. |
| Kcomwel/data.go.kr | 상시근로자수·보험 성립 | dev/shadow | **부분 대체 가능**. CODEF에 관련 상품은 많지만 인증서·사업장관리번호·근로자 PII를 요구하는 상품이 있어 현재 무료 집계 API보다 운영이 단순해진다고 단정할 수 없다. |
| OpenDART/FSC | 법인 직원·재무·법인번호 브리지, 개인사업자 재무 분류 | dev/shadow | **유지 우선**. CODEF 홈택스 재무는 소유자 인증 후 보강값으로 사용하고 무료 공개값을 제거하지 않는다. |
| NICE | 재무·신용/체납·법정관리 데모 | dev/shadow, 제품 비활성 | **재무 일부 대체, 기업신용은 대체 불가**. 공개 카탈로그에서 기업 연체·채무불이행·신용등급 상품을 찾지 못했다. |
| 공개명단 `registry_index` | 인증, 조달 참여제한, TIPS 투자 이력 | dev/shadow | **유지**. CODEF 공개 카탈로그에 동등한 사업자번호 기반 제재/TIPS 상품이 없다. |
| CODEF | 사업자등록증명 + VAT + 인증 입력 파생값 | dev/passive cache, 제품 비활성 | **확장 대상**. 단, 소유자/동의 범위와 공식 계약을 먼저 바로잡아야 한다. |
| 사용자 답변/서류 | CODEF를 포함한 외부 API가 못 주는 사실 | 제품 매칭 | **대체 불가**. 지분, 투자 라운드, 일부 대표자 특성 등은 사용자 확인이 계속 필요하다. |

## 4. CODEF 공식 카탈로그 조사 결과

### 4.1 조사 범위와 방법

2026-07-14에 다음 CODEF 공식 소스를 직접 조회했다.

- [CODEF API 상품 목록](https://codef.io/service/list?keyword=&type=A&category1=&category2=%5B%5D&sort=default&pageIndex=1&pageSize=15)
- [분류별 공개 카탈로그 JSON](https://codef.io/products/classified)
- [실서비스 개발가이드 메뉴 목록](https://admin.codef.io/dev-guide-menu/api-menu-list?mode=real)
- 상품별 `menu-detail`, `api-input-param`, `api-output-param`의 `mode=real`
- [공개 가격표 JSON](https://codef.io/price/getPriceInfo)

당일 공개 카탈로그는 **총 406개**, 그중 **공공 282개**였다. 이는 “관련 상품명이 있다”는 확인용 숫자이며, 창업노트 계정에서 해당 상품을 계약·호출할 수 있다는 뜻은 아니다.

### 4.2 우선 검토할 CODEF 상품군

| 목적 | 공식 코드/상품 | 핵심 출력 | 인증·운영 마찰 | 판정 |
|---|---|---|---|---|
| 휴·폐업 | `KR_PB_NT_001` 사업자등록상태 | 상태, 과세유형, 폐업일 | 사업자번호 목록, 추가인증 없음 | NTS 대체 가능하지만 **직접 NTS 유지**, CODEF 장애 폴백 후보 |
| 대량 상태 갱신 | `KR_PB_NT_078` 대용량 휴폐업 | 위와 동일 | 목록 입력 | 계약 단가가 유리할 때만 배치 후보 |
| 기본 회사정보 | `KR_PB_NT_013` 사업자등록 증명 | 상호, 주소, 개업일, 업태/종목, 법인/개인, 대표/공동대표 | 홈택스 로그인 + 간편인증/인증서 + 추가인증 | **소유자 동의 경로 핵심**. 익명 Popbill 대체재 아님 |
| 통신판매업체 보조 | `KR_PB_FT_005` 통신판매사업자 조회 | 상호, 대표자, 주소, 법인 여부, 신고상태 | 사업자번호만 | 무인증이지만 통신판매 신고업체만 해당. APICK/Popbill 범용 대체 불가 |
| 과세 매출 | `KR_PB_NT_014` 부가세과세표준증명 | `resIncomeTotalAmt`, 과세/면세 금액, 기간 | 홈택스 로그인 + 추가인증 | **도입 1순위**, VAT 과세 사업자용 |
| 면세 매출 | `KR_PB_NT_015` 면세사업자 수입금액증명 | `resEarningsAmt`, 귀속기간 | 홈택스 로그인 + 추가인증 | `NT_014`의 필수 보완. 미도입 시 면세사업자 revenue 공백 |
| 회계 재무 | `KR_PB_NT_012` 재무제표, `NT_031/032` 대차대조표/손익계산서 | 재무표·손익표 문서/구조, 귀속연도 | 홈택스 로그인/인증; 신고 이력 필요 | 법인/복식부기 대상 `financial_health` 보강. 파서 실측 필수 |
| 법인 신고 매출/규모 | `KR_PB_NT_029` 법인세 신고서, `NT_060` 중소기업 기준검토표 | 수입금액, 업종, 중소기업 적합/매출표 | 홈택스 로그인/인증 | size/revenue 보완 후보, 2차 도입 |
| 세무 적격 | `KR_PB_NT_083` 납세증명서, `NT_069` 납부·환급·고지·체납 | 납세상태, 체납 목록 | 홈택스 로그인/간편인증 또는 인증서 | `tax_compliance` 핵심 후보 |
| 지방세/4대보험 적격 | `KR_PB_MW_019/029`, `KR_PB_PP_028` | 지방세 납세, 4대보험 체납/완납 | 정부24/보험 인증·인증서 | tax/insurance known flags 확대. 별도 인증 UX 필요 |
| 고용 인원 | `KR_PB_PP_038` 가입자명부, `KR_PB_CW_003/019` | 가입/근로자 목록, 재직상태 | 사업장 인증서, 관리번호; 근로자 PII 포함 가능 | **선택 기능**. 집계값만 저장하고 원문/명부는 기본 저장 금지 |
| 고용지원 수혜 | `KR_PB_CW_002`, `KR_PB_WK_001` 지원금 지급내역 | 지급상태·금액·인원 | 사업장 인증서, 관리번호/기간 | `prior_award` 중 고용지원금 부분만 보강 |
| 기업 규모/확인서 | `KR_ETC_CI_003` 중소기업확인서 조회 | 종류, 유효기간, KSIC, 법인번호 | sminfo ID/PW | size/certification 확정 보강. 별도 계정 연결 단계로 분리 |
| 회생·파산 | `KR_PB_CK_004/005` | 사건/공고/채무자 | 지역·이름 검색, 사업자번호 exact key 아님 | `credit_status` 보조만. 동명이인 오탐 방지 매칭 필요 |
| 법인등기 | `KR_PB_CK_003` 법인등기부등본 | 검색/등기사항/원문 | 전화·비밀번호·결제수단 등 별도 흐름 | 매칭 기본축보다 서류 기능에 적합 |

공식 상세 예시:

- [사업자등록상태 상세](https://admin.codef.io/dev-guide-menu/menu-detail/KR_PB_NT_001?mode=real)
- [사업자등록증명 상세](https://admin.codef.io/dev-guide-menu/menu-detail/KR_PB_NT_013?mode=real)
- [부가세과세표준증명 상세](https://admin.codef.io/dev-guide-menu/menu-detail/KR_PB_NT_014?mode=real)
- [부가세과세표준 출력항목](https://admin.codef.io/dev-guide-menu/api-output-param/KR_PB_NT_014?mode=real)
- [재무제표 상세](https://admin.codef.io/dev-guide-menu/menu-detail/KR_PB_NT_012?mode=real)
- [납세증명서 상세](https://admin.codef.io/dev-guide-menu/menu-detail/KR_PB_NT_083?mode=real)
- [4대보험 가입자명부 상세](https://admin.codef.io/dev-guide-menu/menu-detail/KR_PB_PP_038?mode=real)
- [중소기업확인서 상세](https://admin.codef.io/dev-guide-menu/menu-detail/KR_ETC_CI_003?mode=real)

### 4.3 공개 카탈로그에서 확인하지 못한 영역

다음 키워드는 2026-07-14 공개 상품 검색에서 0건이었다. 비공개/제휴 상품이 존재할 수 있으므로 “CODEF에 절대 없다”가 아니라 **영업의 서면 확인 전에는 계획 가용성으로 계산하지 않는다.**

- 특허, KIPRIS, 창업기업, 여성기업, 장애인기업
- 벤처, 이노비즈, 메인비즈, TIPS
- 부정당/제재, 기업신용, 채무불이행, 워크아웃, 신용등급
- DART, 금융위원회 기업재무

반대로 `중소기업확인서`는 `KR_ETC_CI_003` 1건이 확인됐다. 과거 소개서나 기존 내부 문서의 상품명보다 현재 `mode=real` 카탈로그를 우선한다.

## 5. 19개 매칭 축별 CODEF 커버리지

여기서 `강`은 **소유자 인증/계정 연결이 완료된 회사에서 주 원천이 될 수 있음**, `부분`은 일부 하위 필드·일부 기업만 가능, `없음`은 공개 카탈로그에서 실용적인 대응 상품을 확인하지 못했다는 뜻이다.

| 매칭 축 | CODEF | 근거 상품/데이터 | 최종 소싱 판정 |
|---|---|---|---|
| `region` | 강 | `NT_013` 사업장 주소 | 동의 후 CODEF 우선. 익명은 Popbill/APICK 캐시 유지 |
| `biz_age` | 강 | `NT_013.resOpenDate` | 동의 후 CODEF 우선 |
| `industry` | 부분~강 | `NT_013` 업태·종목·업종코드, `CI_003` KSIC | 텍스트→KSIC 정규화가 남는다. 단일 CODEF 호출로 끝나지 않음 |
| `size` | 부분 | `CI_003.resKind`, `NT_060` 기준검토표 | 확인서/신고 보유 회사만 확정. 매출·인원 파생과 병행 |
| `revenue` | 강 | `NT_014` 과세, `NT_015` 면세, `NT_029/032` 회계 | 과세표준과 회계 매출의 의미·기간을 분리 저장 |
| `employees` | 부분 | `PP_038`, `CW_003/019` 명부/재직 | 가입자 수≠항상 종업원 수. 인증서/PII 마찰이 큼 |
| `founder_age` | 없음 | 현재 값은 간편인증 **입력 생년월일에서 파생** | CODEF 기관 응답으로 표기하지 말고 `auth_supplied/user_verified`로 유지 |
| `founder_trait` | 없음 | 현재 성별은 UI 입력 | 성별≠여성기업 인증. SMPP/사용자 확인 유지 |
| `certification` | 부분 | `CI_003` 중소기업확인서 | 창업·여성·장애인·벤처 등은 KISed/SMPP/명단 유지 |
| `prior_award` | 부분 | `CW_002`, `WK_001` 고용지원금 | K-Startup/기업마당 등 전체 정부지원 수혜 이력은 아님 |
| `ip` | 없음 | 대응 상품 미확인 | KIPRIS 유지 |
| `target_type` | 부분~강 | `NT_013` 법인/개인, `CI_003` 기업종류 | 법적 형태는 강함. 지원사업 applicant tag 전체는 별도 |
| `business_status` | 강 | `NT_001` 상태·과세유형·폐업일 | 직접 NTS를 주 경로로 유지하고 CODEF는 폴백/통합 옵션 |
| `tax_compliance` | 부분~강 | `NT_083/069`, `MW_019/029`, `PP_028` | 국세·지방세·4대보험을 묶을 수 있으나 상품별 인증이 다름 |
| `credit_status` | 부분 | `CK_004/005` 회생·파산 | NICE급 기업 연체/채무불이행/신용등급 대체 불가. 이름검색 오탐 위험 |
| `sanction` | 없음 | 조달 참여제한 대응 상품 미확인 | 공개명단 인덱스 유지 |
| `financial_health` | 부분~강 | `NT_012/029/031/032` | 신고 기업은 강함. 표 파싱·귀속연도·무신고 의미 검증 필요 |
| `insured_workforce` | 부분 | `PP_038`, `CW_010/011/019` | 가입·취득/상실로 일부 파생 가능. 원문 PII 최소화 필요 |
| `investment` | 없음 | TIPS/투자금/라운드 대응 상품 미확인 | 공개명단 + 사용자 확인 유지 |

**요약:** 19축 중 CODEF만으로 안정적으로 닫을 수 있는 것은 기본정보·매출·상태와 일부 세무/재무다. 인증·IP·제재·투자·전체 수혜이력까지 CODEF 하나로 닫는 계획은 현재 카탈로그 근거로 성립하지 않는다.

## 6. CODEF가 줄이는 관리 포인트와 줄이지 못하는 것

### 6.1 실제로 줄어드는 것

- CODEF OAuth client/token 발급·갱신 계층
- 공통 요청/응답 envelope와 거래 ID 관측
- 2-way 추가인증 상태머신과 타임아웃 처리
- 기관별 API 접속, 일부 계약/정산 창구
- 민감 인증 입력의 암호화·전송 정책을 한 경계로 집중
- 상품별 원천 데이터를 `CompanyProfileFieldUpdate`로 변환하는 공통 provenance 파이프라인

### 6.2 CODEF를 써도 남는 것

- 국세청, 4대보험, 근로복지공단, Work24, sminfo의 **서로 다른 로그인/인증서/계정 전제**
- 상품별 요청/응답 스키마와 기간 규칙
- 과세표준, 회계 매출, 가입자 수, 종업원 수처럼 의미가 다른 값의 정규화
- 기관 점검/오류 코드/빈 응답의 의미
- 사용자의 동의 범위, 철회, 보존기간, 회사 소유권
- KIPRIS·SMPP·KISed·공개명단 등 CODEF 밖의 커넥터

즉, CODEF는 **전송·계약·인증 오케스트레이션을 통합**하지만, 데이터 의미와 제품별 정책까지 없애 주는 단일 스키마는 아니다. `generic CODEF normalizer` 하나를 만들기보다 **공통 transport + 상품별 typed adapter**가 안전하다.

## 7. 현재 CODEF 구현의 전환 차단 이슈

### Blocker 1 — 제품 resolver에서 CODEF가 의도적으로 비활성화되어 있다

`codef_hometax`와 `codef_insurance`는 현재 `disabled`, `fail_closed`다. 주석상 이유는 `bizNo-global/shared cache`가 안전한 동의 소유자와 버전을 갖지 않기 때문이다.

운영 승격 전 저장 단위를 최소한 다음처럼 바꿔야 한다.

```text
company_id
consent_id + consent_version + consent_scope
requesting_user_id 또는 verified_owner_subject
provider=codef
upstream_institution=nts|kcomwel|work24|sminfo|...
product_code
period_start/period_end
fetched_at/expires_at
canonical_payload_hash
revoked_at 또는 visibility_scope
```

공유 가능한 공개 사실과 소유자 동의 데이터는 같은 cache row로 섞지 않는다.

### Blocker 2 — VAT 공식 엔드포인트가 현재 코드와 다르다

| 위치 | 값 |
|---|---|
| 현재 코드 | `/v1/kr/public/nt/proof-issue/additional-taxstandard` |
| 2026-07-14 공식 실서비스 가이드 | `/v1/kr/public/nt/proof-issue/additional-tax-standard` |

현재 상수는 `packages/core/src/codef/products/vat-base-certificate.ts:16-17`에 있다. 과거 내부 CODEF 문서 여러 개도 구형 경로를 반복하므로, 구현 시 코드·테스트·기존 문서를 함께 정정해야 한다.

### Blocker 3 — VAT 공식 금액 필드가 정규화 후보에 없다

공식 `KR_PB_NT_014` 출력은 과세 총금액을 `resIncomeTotalAmt`로 제공한다. 현재 정규화 후보는 `resTaxStandard`, `resTaxbaseTotAmt`, `resTaxBase`, `resSupplyAmount`, `resAmount`이고, 테스트도 합성 `resTaxStandardList`를 사용한다.

그 결과 공식 성공 응답을 받아도 `revenue=null`로 끝날 수 있다. 실제 단건/다건 응답 모양과 반복부를 live fixture로 고정해야 한다.

### Blocker 4 — 면세사업자 경로가 없다

현재 오케스트레이터는 사업자등록증명과 `NT_014`만 연속 호출한다. 면세사업자는 `NT_015.resEarningsAmt` 경로가 필요하다. `NT_014` 빈 응답을 곧바로 “매출 없음”으로 해석하면 false negative다.

### Blocker 5 — 인증 입력 파생값과 기관 사실이 섞여 있다

현재 dev CODEF 캐시 커넥터는 7축을 채운다고 설명하지만 `founder_age`와 `founder_trait`는 CODEF 기관 응답이 아니라 생년월일/성별 입력 파생값이다. `sourceKind: auth_supplied` 표시는 일부 되어 있으나 provider는 여전히 `codef`다.

- `founder_age`: `user_verified_auth` 또는 동등한 provenance로 분리
- `founder_trait`: 사용자 입력으로 유지
- `여성`: `여성기업 인증`과 절대 동일시하지 않음

## 8. 권장 목표 아키텍처

### 8.1 익명 공개 면 — 현재 UX 유지

```text
checksum
  → fresh public cache
  → NTS 직접 상태조회
  → Popbill 기본정보 조건부 폴백
  → SMPP 보강
  → 공개 캐시 재조립
```

정책:

- CODEF `NT_001`은 NTS 장애 폴백 또는 가격/쿼터 비교용 shadow만 허용한다.
- `NT_013` 같은 인증 상품을 랜딩 조회에 끼우지 않는다.
- cache miss가 곧 유료 호출이 되지 않도록 기존 영속 guard, client rate, daily budget을 유지한다.
- CODEF 영업이 무인증 범용 기업상세 상품을 서면 제공하고 수록률·가격이 Popbill보다 낫다고 입증할 때만 Popbill 교체를 다시 검토한다.

### 8.2 소유자 동의 면 — CODEF 기본 번들

사용자가 회사를 생성하고 홈택스 동의를 한 뒤 실행한다.

```text
1. NT_013 사업자등록증명
2. 과세유형/응답에 따라 NT_014 또는 NT_015
3. 필요 회사만 NT_012/029/031/032 재무
4. 지원사업 배제조건이 실제로 요구할 때 NT_083/069
```

원칙:

- 같은 `id` 세션 재사용은 **동일 기관·동일 로그인 계정에서 공식적으로 확인한 상품 조합에만** 적용한다.
- “인증 1회로 모든 CODEF 상품”을 전제하지 않는다.
- 각 상품 결과에 `product_code`, upstream 기관, 조회기간을 보존한다.
- 원문 PDF/XML은 기본 `originDataYN=0`; 매칭에 필요한 canonical facts만 저장한다.
- 과세 매출과 회계 매출을 한 필드에 무조건 덮어쓰지 않고 의미·귀속기간과 함께 우선순위를 정한다.

### 8.3 선택 계정/인증서 면 — 별도 UX

다음은 홈택스 간편인증 화면에 억지로 합치지 않는다.

- sminfo ID/PW → `CI_003`
- 사업장 공동인증서 → `PP_038`, `CW_*`, `WK_001`
- 법인등기 발급 계정/결제 → `CK_003`

각 연결은 사용자가 얻는 필드와 필요한 자격증명을 먼저 보여 주는 별도 단계로 둔다. 근로자 명부는 서버에 원문을 남기지 않고 요청 내 집계 후 폐기하는 방식을 우선 검토한다.

### 8.4 공공·특수 면 — 제거하지 않음

- KIPRIS: `ip`
- KISed/SMPP/인증 명단: `certification`, `founder_trait`의 공식 인증
- 공개명단: `sanction`, `investment.tips_backed`
- OpenDART/FSC: 공개 법인 재무·직원 및 CODEF 유료 호출 전 보강
- 사용자 답변/업로드: 투자금·라운드, 지분, CODEF 공백

## 9. 공급자별 최종 조치

| 공급자 | 지금 | CODEF pilot 후 | 제거 조건 |
|---|---|---|---|
| NTS 직접 | 유지 | 주 경로 유지, CODEF shadow/failover | CODEF가 총비용·SLA·정확성에서 명확히 우위이고 무료 직접 API 운영 부담이 더 클 때만 |
| Popbill | 유지 | 익명 기본정보 전용으로 축소 가능 | CODEF 또는 다른 계약 상품이 **무인증 범용 상세**를 같은/더 나은 수록률로 제공하고 shadow parity 통과 |
| APICK | cache-only 유지 | 법인번호 브리지/익명 보완 유지 | 대체 상품의 개인·비공시 법인 수록률 및 필드 parity 확인 |
| SMPP | 유지 | 유지 | 여성/장애인기업 exact 상품이 CODEF에 계약 가능하고 absence semantics까지 동일할 때 |
| KISed | 유지 | 유지 | 창업기업확인서 exact 대체 상품 확인 시 |
| KIPRIS | 유지 | 유지 | 지재권 종류·상태·건수 동등 상품 확인 시 |
| Kcomwel direct | dev/shadow 유지 | 무료 집계는 유지, 소유자 정밀조회만 CODEF | CODEF 정밀값이 실제 매칭에 필요하고 인증서 UX·비용·PII 정책을 통과 |
| DART/FSC | 유지 | 무료 우선 + CODEF 동의값 우선순위 | 제거 권장하지 않음. 서로 다른 커버리지/시점의 보완 관계 |
| NICE demo | 제품 비활성 유지 | 재무만 CODEF로 대체 가능; 신용 필요성 별도 결정 | 기업 신용 기능을 포기하거나 동등한 계약 원천 확보 |
| registry index | 유지 | 유지 | CODEF exact 제재/TIPS 상품 확인 시 |

## 10. 단계별 실행 계획

### Phase 0 — 계약·정합성 게이트

1. CODEF 영업에 상품 코드 단위로 정식 이용 가능 여부와 단가를 서면 확인한다.
2. 응답 캐싱/보존기간, 재사용, 원문 저장, 재제공 범위를 계약서에 확정한다.
3. VAT 경로와 `resIncomeTotalAmt` parser를 공식 실서비스 스펙으로 고친다.
4. `NT_015` 면세 경로를 추가한다.
5. CODEF 관측값 저장을 company/consent/version scoped로 바꾼다.
6. 과거 `CF-00003` 상품 미신청 상태가 정식/현재 계정에서 해소됐는지 확인한다.

**종료 기준:** 공식 상품 권한, 가격, 캐시 정책, 개인정보 위수탁, 수정된 typed fixture가 모두 존재한다.

### Phase 1 — 홈택스 기본 번들 shadow

대상: `NT_013 + NT_014 + NT_015`, 필요 시 `NT_001` 비교.

- 개인 과세, 개인 면세, 법인, 신규/무신고, 휴·폐업 cohort를 분리한다.
- 기존 Popbill/NTS 값과 CODEF 값을 함께 수집하되 사용자 노출 우선순위는 바꾸지 않는다.
- 회사/사업자번호 교차오염 0건, 기간 정규화, 빈 응답 의미를 검증한다.
- `founder_age/trait`은 CODEF 기관 사실에서 분리한다.

**종료 기준:** 필드별 truth table과 mismatch 사유가 설명 가능하고, 운영 로그에 PII가 남지 않는다.

### Phase 2 — 매출·세무·재무 승격

대상: `NT_012/029/031/032/060/083/069` 중 실제 매칭 필드에 필요한 최소 세트.

- 과세표준 매출, 면세 수입금액, 회계 매출을 별도 observation으로 저장한다.
- 신고연도·결산월·연결/별도 구분 없이 최신 숫자로 덮어쓰지 않는다.
- `tax_compliance.known_flags`는 실제 조회한 범위만 채운다.
- 빈 문서/무신고/권한 없음/기관 장애를 서로 다른 상태로 보존한다.

**종료 기준:** revenue/financial/tax 하위 필드의 기간·원천·완전성이 UI와 matcher에서 추적 가능하다.

### Phase 3 — 선택 인증 확장

대상: `CI_003`, `PP_038` 또는 필요한 `CW_*`, `CW_002/WK_001`.

- sminfo와 사업장 인증서는 별도 consent scope로 둔다.
- 근로자 PII 원문 미저장을 기본으로 하고 집계값만 보존한다.
- 지원금 지급내역은 `prior_award` 전체가 아니라 `known_program_types`의 한 subset으로 기록한다.

**종료 기준:** 별도 자격증명 연결의 이탈률·지원 부담이 얻는 매칭 개선보다 작다.

### Phase 4 — 공급자별 cutover

- big-bang 전환 금지
- 필드/코호트별 feature flag
- shadow → limited cohort → 전량 순서
- 소스 제거 전 최소 한 캐시 TTL 동안 rollback 가능 상태 유지
- Popbill/APICK/NTS 제거는 별도 의사결정으로 남김

## 11. 승인 게이트와 관측 지표

| 구분 | 필수 기준 |
|---|---|
| 정확성 | 잘못된 회사에 값이 귀속된 사례 0건. 공식 기간/금액 fixture 계약 테스트 통과 |
| 동의 | company·사용자·consent version 기준으로 조회/노출/철회가 재현 가능 |
| 개인정보 | 생년월일·전화·주민번호·인증서 비밀번호·토큰 로그 0건, 명부 원문 기본 미저장 |
| 커버리지 | 제거하려는 기존 공급자가 채우던 cohort/필드보다 낮아지지 않음 |
| 의미 | `no_data`, `not_filed`, `not_covered`, `not_authorized`, `provider_error`를 구분 |
| 비용 | 성공 회사 1곳당 총비용으로 비교. API 1건 단가만 비교하지 않음 |
| UX | 익명 랜딩 지연·인증 단계 증가 없음. 추가인증은 회사 생성 후 명시적 사용자가 시작 |
| 운영 | transaction ID, product code, upstream institution, latency, result code, cache hit를 관측 |
| 롤백 | 기존 소스 우선순위로 즉시 되돌릴 feature flag와 캐시 보존 |

## 12. 가격 검토 방법

공개 가격 API에는 공공(`PB`) 표준 구간표가 있지만, 이 값만으로 후보 상품의 실제 과금액·기본료·추가단가·실패 과금을 확정할 수 없다. 따라서 문서에 “CODEF가 더 싸다”는 결론을 쓰지 않는다.

견적은 아래 단위로 받아야 한다.

```text
완료 회사 1곳당 비용
= 상태조회
+ 사업자등록증명
+ 과세/면세 분기 상품
+ 재무 조회 확률 × 재무 상품
+ 세무 적격 조회 확률 × 관련 상품
+ 인증 실패·빈 응답·재시도 과금
+ 월 기본료/최소 약정/부가 상품료의 배분
```

필수 영업 질문:

1. 상품 코드별 정식 사용 가능 여부, 월 기본료, 최소 약정, 건당/구간 단가
2. 2-way 미완료, timeout, `no data`, 기관 장애, 상품 미신청 건의 과금
3. 같은 `id`의 상품 간 세션 재사용 범위와 과금 단위
4. canonical 값/원문 PDF·XML의 저장 허용 여부와 보존기간
5. 회사 내부 매칭에 재사용 가능한지, 사용자 철회 시 삭제 의무
6. sandbox와 production의 필드/추가인증 차이
7. 기관별 점검시간, rate limit, SLA, 장애 공지
8. 개인정보 처리위수탁, 재위탁자, 국내/국외 처리 위치
9. 사업자번호만으로 범용 상호·개업일·업태/종목을 주는 비공개 계약 상품 존재 여부
10. 공개 카탈로그에 없는 KIPRIS·창업/여성/장애인기업·벤처·제재·TIPS·기업신용 상품의 실제 계약 가능 여부

## 13. 구현 시 변경 지점

이번 검토는 코드를 수정하지 않지만, 승인 후 예상 변경 지점은 다음과 같다.

| 목적 | 위치 |
|---|---|
| VAT 공식 path/parser/fixture 수정 | `packages/core/src/codef/products/vat-base-certificate.ts`, `packages/core/src/codef/codef.test.ts` |
| 면세·재무·세무 typed product adapter | `packages/core/src/codef/products/` |
| 상품별 순차/분기 오케스트레이션 | `apps/web/src/lib/server/codef/orchestrator.ts` |
| owner/consent scoped 저장 | `apps/web/src/lib/server/codef/session-store.ts` 및 repository/schema |
| 제품 source policy 승격 | `apps/web/src/lib/server/productProfile/resolveProductCompanyProfile.ts` |
| 필드 우선순위와 provenance | `packages/core/src/company/evidence-priority.ts`, `devServiceDataMonitor.ts`의 제품화 대상 경계 |
| 익명 랜딩 유지/비회귀 | `apps/web/src/lib/server/serviceData.ts`, `loadProductCompanyPreview` 테스트 |
| 19축 계약 parity | `packages/core/src/autofill/profile-field-spec.ts` 기반 verify |

## 14. 최종 의사결정 제안

### 승인할 것

- CODEF를 홈택스 소유자 동의 데이터의 표준 게이트웨이로 확장하는 pilot
- `NT_013 + NT_014 + NT_015`를 첫 번들로 실측
- company/consent scoped 저장과 product-specific typed adapter
- 이후 세무/재무, sminfo, 보험을 가치가 검증된 순서로 추가

### 승인하지 않을 것

- CODEF를 익명 랜딩 첫 호출로 넣는 변경
- Popbill/NTS/SMPP/APICK/KISed/KIPRIS/DART/FSC/registry의 선제 제거
- 공개 카탈로그에 없는 상품을 영업 확인 없이 계획 커버리지로 계산
- 현재 VAT path/parser와 bizNo-global CODEF cache를 그대로 운영 승격
- 인증 입력 성별을 여성기업 인증으로, 가입자 수를 종업원 수로, 과세표준을 회계 매출로 무조건 등치

**한 줄 결정:** CODEF는 창업노트의 “모든 기업정보 단일 공급자”가 아니라, “소유자 동의가 필요한 기업정보의 단일 오케스트레이션 경계”로 도입하는 것이 관리 포인트와 위험을 함께 줄이는 최적안이다.

## 부록 A. 현재 코드 근거 요약

- 운영 19축: `packages/core/src/autofill/profile-field-spec.ts:77-138`
- 익명 허용 캐시: `apps/web/src/lib/server/productProfile/resolveProductCompanyProfile.ts:190-199`
- CODEF/NICE 제품 비활성: 같은 파일 `84-89`
- dev 외부 커넥터 병렬 구성: `apps/web/src/lib/server/devServiceDataMonitor.ts:2438-2475`
- 현재 CODEF passive cache 7축: 같은 파일 `4048-4187`
- APICK/KISed/KIPRIS cache-only 제품 승격: `apps/web/src/lib/server/teaser/cachedProfileEnrichment.ts:5-29, 75-167`
- Popbill/NTS/SMPP 운영 흐름: `apps/web/src/lib/server/serviceData.ts:76-103, 466-561, 845-930, 992-1079`
- 현재 CODEF VAT path/parser: `packages/core/src/codef/products/vat-base-certificate.ts:16-54`

## 부록 B. 판정의 유효기간

CODEF 상품·가격·인증 조건은 변경될 수 있다. 이 문서의 카탈로그 판정은 **2026-07-14 공개 실서비스 목록** 기준이다. 구현 착수일에 `mode=real` 상품 상세와 계약 계정의 신청 상태를 다시 확인한다.
