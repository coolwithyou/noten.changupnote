# 매칭 신호 보강 계획 — 팝빌 표기 정리 + 데이터 소스 확장 (QA 아젠다)

> **🟡 진행 상황**: P0 완료 + P1 대부분 완료(갱신 정책·조건 0건 강등·KSIC 사전·업종 정규화·룰 1차 구조화).
> NTS 서비스키 설정·라이브 검증 완료(2026-07-05, 계속사업자 응답 확인). 남은 P1: kstartup 재정규화(백필) CLI 신설·실행,
> certification 구조화. P2 선행 액션: SMPP·벤처확인서 활용신청(아래 5장).
> 작성: 2026-07-05, QA 세션(dev.changupnote.com/matches?biz=8938100911) 아젠다 기반.
>
> **확정된 결정 (2026-07-05)**
> 1. 팝빌 캐시 TTL 30일 + 무료 국세청 상태조회를 하루 1회(KST 달력일 캐시, 같은 날 재조회는 캐시, 다음날 재호출) 수행. 휴폐업 감지 시 business_status만 즉시 갱신, 팝빌 재조회는 30일 주기 유지(과금 방지).
> 2. 조건 0건 공고는 '조건 확인 필요'(conditional)로 강등, 적합도는 미산정 `—` 표기 + 목록 하단 정렬.
> 3. 국세청 상태조회는 모든 조회 경로(비로그인 티저 포함)에 적용.

## 1. 배경 — QA 아젠다 2건

1. **'팝빌 연동' 배지 정리**: 매치 티저 페이지의 사업자 분석 카드 6장에 동일한 "팝빌 연동" 배지가 반복 노출. 정보량이 없고 내부 벤더명이 사용자에게 노출됨. 대신 "DB에 마지막으로 팝빌을 통해 확인된 갱신일"을 작게 표시하고, 오래되면 갱신이 필요함을 알 수 있어야 함.
2. **매칭 정교화를 위한 추가 신호 발굴**: 팝빌 외에 사업자번호 하나로 조회 가능한 정보, 또는 사용자에게 반드시 받아야 할 정보를 연구해 매칭 로직에 추가.

## 2. 현황 진단 (실측)

### 2-1. 기업 측 — 팝빌이 채우는 축 vs 매칭 엔진이 쓰는 축

팝빌 기업정보조회(`PopbillBizCheckInfo`)로 채워지는 프로필 축은 **14개 매칭 축 중 5개**뿐이다
(`packages/core/src/company/profile-from-popbill.ts`):

| 채워짐 (팝빌) | 비어 있음 (수집 필요) |
|---|---|
| region, biz_age, size, industry, business_status | **founder_age, certification, employees, revenue**, founder_trait, prior_award, ip, target_type |

### 2-2. 공고 측 — grant_criteria 차원별 분포 (2026-07-05 dev DB 실측)

| dimension | 건수 | 기업측 확보 | 공고측 구조화 |
|---|---:|---|---|
| biz_age | 29,350 | ✅ 팝빌 | ✅ |
| region | 14,211 | ✅ 팝빌 (광역 단위) | ✅ |
| industry | 11,285 | ⚠️ 팝빌 (코드+라벨 혼합) | ❌ **98.5%가 placeholder** (`{"note": "…확인 필요"}` 11,119건) |
| founder_age | 6,750 | ❌ 미수집 | ✅ ranges 구조화 완료 |
| size | 5,924 | ✅ 팝빌 | ✅ |
| other | 5,305 | — | — |
| certification | 2,992 | ❌ 미수집 | ❌ 대부분 placeholder |
| business_status | 256 | ✅ 팝빌 | ✅ |
| target_type | 208 | ⚠️ 일부 파생 | — |
| employees | 83 | ❌ 미수집 | ✅ |
| revenue | 57 | ❌ 미수집 | ✅ |
| ip / prior_award / founder_trait | 46 / 41 / 18 | ❌ 미수집 | — |

**핵심 발견 3가지:**

1. **founder_age가 최우선 수집 대상.** 미수집 축 중 압도적 1위(6,750건, required)이고 공고 측이 이미
   `{ranges: [{min, max}]}`로 구조화되어 있어, **대표자 연령만 받으면 즉시 매칭 판정에 반영**된다
   (`match.ts`가 이미 소비). 그런데 지금까지 앱 어디에도 입력 UI가 없었다 (서버 `update-profile-field.ts`는 지원).
2. **industry는 기업 측이 아니라 공고 측이 병목.** 11,285건 중 98.5%가 미추출 placeholder라서,
   기업 업종 데이터를 아무리 정교화해도 현재는 판정이 unknown으로 끝난다. certification도 동일 패턴.
3. **조건 0건 공고의 적합도 100% 표기 문제.** QA 스크린샷의 "[광주] 식품진흥기금 융자(조건 0·충족 0 → 100%)"가
   서울 기업에 1순위 노출. 조건이 하나도 추출되지 않은 공고는 만점이 아니라 "조건 확인 필요"로 다뤄야 한다.
   (region 조건 자체가 추출 안 된 사례 — 위 2번의 실사용 증상)

## 3. 데이터 소스 리서치 결과

사업자번호(10자리) 하나로 조회 가능 여부를 기준으로 정리. 모두 2026-07-05 확인.

| # | 소스 | 얻는 것 (매칭 축) | 사업자번호 단독 조회 | 비용 | 비고 |
|---|---|---|---|---|---|
| S1 | 팝빌 기업정보조회 (현행) | region, biz_age, size, industry(주업종코드), business_status | ✅ | 유료/건 | 캐시 TTL 기본 90일 |
| S2 | [국세청 사업자등록 상태조회 API](https://www.data.go.kr/data/15081808/openapi.do) | 휴폐업·과세유형(일반/간이/면세)·폐업일 | ✅ (100건/회, 100만건/일) | 무료 | 팝빌과 중복이지만 **무료 신선도 체크**(휴폐업 감지)용으로 최적 |
| S3 | [업종코드↔11차 KSIC 연계표](https://teht.hometax.go.kr/doc/rn/a/a/%EC%97%85%EC%A2%85%EC%BD%94%EB%93%9C-%ED%91%9C%EC%A4%80%EC%82%B0%EC%97%85%EB%B6%84%EB%A5%98%20%EC%97%B0%EA%B3%84%ED%91%9C_%ED%99%88%ED%83%9D%EC%8A%A4%20%EA%B2%8C%EC%8B%9C.xlsx) | 국세청 업종코드(6자리) → KSIC(5자리) 매핑 | — (정적 테이블) | 무료 | 팝빌 industryCode를 표준 분류로 정규화. API 아닌 로컬 테이블 |
| S4 | [SMPP 공공구매종합정보망 인증서 API](https://www.data.go.kr/data/15062581/openapi.do) | **여성기업확인서·장애인기업확인서** 상세(유효기간 포함) → certification, founder_trait | ✅ (`bsnmNo` 필수 파라미터, 확인함) | 무료 | 사업자번호만으로 확인서 보유 자동 검증 |
| S5 | [중기부 벤처기업확인서 API](https://www.data.go.kr/data/15106235/openapi.do) + [벤처기업명단](https://www.data.go.kr/data/15084581/fileData.do) | 벤처확인 여부·유효기간 → certification | ⚠️ LINK형(smes.go.kr/dbCnrs), 활용가이드로 파라미터 확정 필요 | 무료 | 명단 파일데이터는 확실한 폴백 |
| S6 | [국민연금 가입 사업장 내역](https://www.data.go.kr/data/3046071/openapi.do) | 가입자수(≈상시근로자)·월 고지금액 → employees 추정 | ⚠️ 사업자번호 앞 6자리+상호 매칭 | 무료 | 월간 파일데이터. 법인 3인↑/개인 10인↑만 포함 → 추정치로만 사용 |
| S7 | 사용자 입력 (자가신고) | founder_age, revenue, employees 확정값, prior_award, ip, founder_trait 세부 | — | — | 조회 불가 축. 아래 우선순위로 최소한만 요청 |
| S8 | (장기) NICE/KED 유료 API, KIPRIS(출원인명 검색), 사회적기업 목록 | 매출·재무, 특허, 사회적기업 | ⚠️ | 유료/제약 | 결제·정확도 이슈로 보류 |

**사용자에게 받아야 할 정보의 우선순위 (실측 조건 수 기준):**

1. **대표자 연령(생년)** — 6,750건. 청년(만 39세 이하) 필터가 공고 대부분의 핵심 관문. *이번 세션에 입력 UI 추가.*
2. **보유 인증·확인서** — 2,992건. S4·S5로 상당 부분 자동화 가능하므로 "입력 + 자동 검증" 병행.
3. **상시근로자 수** — 83건. 기존 입력 필드 존재, 티저에 노출만 추가.
4. **연 매출** — 57건. 동일. (소상공인 판별 등 파생 가치가 조건 수보다 큼)
5. 기수혜 이력·IP·대표자 특성 — 롱테일. 기존 설정 패널로 충분.

> 개인정보 유의: 대표자 연령(생년)은 개인정보다. 최소수집 원칙에 따라 생년월일 전체가 아닌 **연령(또는 출생연도)만** 받고, 수집 목적(공고 자격 판정)을 라벨에 명시한다.

## 4. 단계별 계획

### P0 — 이번 세션 반영 (완료)

- [x] **아젠다 1**: 카드별 '팝빌 연동' 배지 제거. 섹션 헤더에 `국세청·팝빌 정보 확인일 YYYY. M. D.` 소형 표기
  (30일 초과 시 `(N일 전)` 병기). 데이터는 기존 `CompanyEvidence.checkedAt` 사용 — 스키마 변경 없음.
  (`MatchesExperience.tsx`)
- [x] **정보 충족도 정직화**: evidence 필드에 대표자 연령·보유 인증·상시근로자·연 매출 4축 추가.
  티저의 "6/6 확정"이 "6/10 확정"으로 바뀌고, 미확보 축은 미입력 카드(입력하기 → 결과 저장 플로우)로 노출.
  (`serviceData.ts:buildCompanyEvidenceFields`)
- [x] **대표자 연령 입력 필드**: 대시보드 수기 프로필 패널에 추가. `founder_age` 뮤테이션은 기존 서버 로직 재사용.
  (`CompanySettingsPanel.tsx`)

### P1 — 공고 측 조건 구조화 + 업종 정규화 (최우선 후속)

기업 데이터를 늘리기 전에 공고 측 병목부터 풀어야 투자 대비 효과가 난다.

- [x] **KSIC 사전 + 기업 측 업종 정규화** (2026-07-05 구현): 실측 결과 팝빌 `industryCode`는 국세청 6자리
  업종코드가 아니라 **KSIC 계열 5자리**(예: 58222)로 판명 → S3 연계표 대신 KSIC 사전(대분류 21 + 중분류 77,
  prefix 축약 해석)으로 피벗. `CompanyProfile.industry_codes` 추가, industries는 라벨 전용으로 분리,
  구형 캐시는 읽기 시점 마이그레이션. (`core/industry/ksic.ts`, `profile-from-popbill.ts`, `serviceData.ts`)
- [x] **industry 매칭 평가 확장** (2026-07-05): 기존 매처가 `value.tags`만 읽어 구조화 166건 중 165건이
  평가되지 않던 잠복 버그 발견·수정. 신규 `evaluateIndustry`가 `codes`(KSIC prefix 매칭)·`industries`·`labels`·`tags`
  4형식 모두 지원. (`match.ts`)
- [x] **industry 룰 1차 구조화** (2026-07-05): 전업종("업종 제한 없음" 등) 감지 시 placeholder 미생성 +
  명시 업종 8룰(소프트웨어·정보통신·음식점·관광숙박·제조·건설·도소매·농림어업 → KSIC 코드, confidence 0.6,
  needs_review 유지). 검수에서 제외대상 역전·우대 문맥 오탈락 결함을 발견해 신청대상 텍스트 한정 +
  문장 단위 문맥 가드(`제외|불가|우대|가점|가산`)로 수정 완료. (`kstartup/normalize.ts`)
- [x] **kstartup 재정규화(백필) 완료** (2026-07-06 실행): CLI 신설(`ingestion/renormalize-kstartup-cli.ts`,
  dry-run 기본·--execute·--limit·--dump). 1차 dry-run에서 룰 구조화 오탐 다수 발견(불릿 제외나열·"전 분야 환영" 등,
  stale dist로 가드 미컴파일 상태였음도 발견) → 정밀도 라운드: 긍정 템플릿 + 세그먼트 윈도 가드 + 나열 필터로 재설계,
  구조화 후보 전수 육안 분류 **정밀도 98.5%** 달성 후 실행. 최종 반영: 전업종 placeholder 제거 343건,
  룰 구조화(KSIC codes) 136건, 잔존 placeholder 10,211건(kstartup), 실패 0, 비-industry 축 Δ0, 커서 보존.
  실행 후 `match:states:refresh --write` 완료. dev 서버 티저 API로 엔드투엔드 검증(evidence 10필드·checkedAt·
  라벨 전용 업종·강등 정렬) 확인. 잔여 오탐 2건은 needs_review=true로 식별됨(175437 유형)
- [ ] bizinfo placeholder 429건: LLM 재추출 필요(비용 발생) — 규모 작아 후순위. 구조화 166건은 매칭 평가기
  수정으로 재추출 없이 이미 평가에 반영됨
- [ ] certification placeholder 구조화 (Gate 1 패턴 2단계: AI 사전추출 → 검수)
- [x] **조건 0건 공고의 적합도 강등** (2026-07-05 구현): `matchGrantCriteria` criteria 0건 →
  conditional·fit 0·`criteria_extracted:false` + unknown chip, `compareMatch`에서 하단 정렬,
  티저 UI 적합도 `—` 표기. (`match.ts`, `match-card.ts`, contracts 3파일, `MatchesExperience.tsx`)
- [x] **갱신 정책** (2026-07-05 결정·구현): TTL 기본 30일(`DEFAULT_ENRICHMENT_CACHE_TTL_HOURS = 24*30`) +
  팝빌 캐시 히트 시 국세청 상태조회 일 1회(KST 자정 만료, enrichment_cache provider="nts"/scope="status").
  휴·폐업(b_stt_cd 02/03) 감지 시 business_status만 confidence 0.9로 즉시 갱신, 팝빌 재조회 없음.
  `CUNOTE_NTS_SERVICE_KEY` 미설정 시 조용히 skip. (`core/nts/check-business-status.ts`, `serviceData.ts`)

### P2 — 무료 공공 API 자동 보강 (사업자번호 하나로)

- [ ] S4 SMPP: 티저/보강 시 여성기업·장애인기업 확인서 자동 조회 → certs·traits 채움 (confidence 0.9, 공적 확인서)
- [ ] S5 벤처확인서: 활용신청 후 파라미터 확정, 벤처기업 여부 자동 채움. 폴백으로 명단 파일 월간 적재
- [x] S2 국세청 상태조회: 배치 대신 조회 시점 일일 캐시로 P1에서 선반영 완료 (위 갱신 정책 항목)
- [ ] enrichment_cache provider 확장: `nts` 완료, `smpp`·`venture` 남음

### P3 — 추정·증빙 고도화

- [ ] S6 국민연금 파일데이터 월간 적재 → employees 추정치(±표기, confidence 낮게)
- [ ] 온보딩에서 대표자 연령 수집 시점 앞당기기 (티저 직후 1문항)
- [ ] 증빙 업로드(부가세 과세표준증명 등) 기반 revenue 확정, 유료 데이터(S8) 검토

## 5. 다음 세션 착수 가이드 (P2 + certification 구조화)

### 5-1. 사용자 직접 실행 (착수 전 선행 — 순서대로)

1. **SMPP 활용신청 (data.go.kr)** — 실존·스펙 검증 완료 (2026-07-06):
   [공공구매종합정보망 인증서 정보 제공 서비스](https://www.data.go.kr/data/15062581/openapi.do) → 우측 [활용신청].
   공식 기술문서(첨부 docx)로 확정한 오퍼레이션:
   - `getFnrssList` 여성기업확인 상세조회 / `getDspsnList` 장애인기업확인 상세조회 / `getDPrductList` 직접생산확인
   - 공통 파라미터: `ServiceKey` + `bsnmNo`(사업자번호 10자리) + `stdrDate`(기준일자) — 유무·인증일자·유효기간 응답
   - 라이브 게이트웨이 프로브로 실존 확인: 두 오퍼레이션 모두 미신청 키에 403(가짜 경로는 404 "API not found")
2. **벤처·이노비즈·메인비즈확인서 API 신청 (중소벤처24 자체 채널 — data.go.kr 아님!)**:
   data.go.kr의 [벤처기업확인서](https://www.data.go.kr/data/15106235/openapi.do)·[이노비즈확인서](https://www.data.go.kr/data/15106236/openapi.do)는 LINK 게시물일 뿐, 실제 신청은
   **[중소벤처24 Open API](https://www.smes.go.kr/main/dbCnrs)에서 기업회원 가입 후 자체 신청 양식**(신청자 정보·시스템명·선택 API·용도)으로 진행.
   증명(확인)서 정보 API로 벤처기업·이노비즈·메인비즈확인서 3종 제공. ⚠️ 임의 사업자번호 조회 허용 범위(동의 필요 여부)는
   승인 후 API 가이드로 확인 필요 — 제약이 크면 폴백: [벤처기업명단 파일데이터](https://www.data.go.kr/data/15084581/fileData.do)(신청 불요) 월간 적재.
   문의: 044-300-0990 / smeshelp@tipa.or.kr
3. **서비스키 env 등록**: SMPP는 공공데이터포털 인증키(계정 공용 — NTS 키와 동일 값일 가능성 높음)를 `CUNOTE_SMPP_SERVICE_KEY=`로,
   중소벤처24는 발급 방식 확인 후 `CUNOTE_SMES_API_KEY=`로 루트 `.env`에 추가
3. **(권장) QA 팀 공지**: 강등 로직으로 티저 헤더가 "eligible 0건"으로 보일 수 있음 — 회귀 아님(2026-07-06 반영분)

### 5-2. 작업 순서 (위임 계획)

| 순서 | 작업 | 선행 의존 | 요점 |
|---|---|---|---|
| ① | **certification 룰 1차 구조화** | **없음 — 즉시 착수 가능** | 인증 조건은 업종보다 정형적(벤처기업·이노비즈·메인비즈·기업부설연구소·ISO·여성기업·사회적기업 등 enum 매칭)이라 룰 정밀도 기대 높음. 인증 enum 사전 신설 → normalize 룰(업종과 동일한 긍정 템플릿+가드 패턴) → 재정규화 CLI를 dimension 일반화해 dry-run→검수→실행. kstartup은 LLM 불필요, bizinfo 429건만 LLM 재추출 대상(후순위) |
| ② | **SMPP 자동 보강** | 활용신청 승인 + 키 | enrichment provider `smpp` 추가(NTS 패턴 재사용): 사업자번호로 여성기업·장애인기업 확인서 조회 → `certs`/`traits` 자동 채움(공적 확인서라 confidence 0.9), 캐시 TTL은 확인서 유효기간(`validPdEndDe`) 기반 |
| ③ | **벤처·이노비즈·메인비즈 자동 보강** | 중소벤처24 API 승인 + 가이드 확보 | 가이드로 스펙·조회 허용 범위 확정 후 ②와 동일 패턴. 스펙 부적합·동의 제약 시 폴백: [벤처기업명단 파일데이터](https://www.data.go.kr/data/15084581/fileData.do) 월간 적재 |
| ④ | **엔드투엔드 검증** | ①~③ | dev 서버 티저로 확인서 보유 사업자 실측 + evidence '보유 인증' 자동 확정 확인 |

### 5-3. 착수 시 주의

- 재정규화 CLI 일반화 시 기존 kstartup industry 경로 회귀 금지 (dry-run 통계 diff로 확인)
- 인증 룰도 오탐 required가 하드 탈락을 만들므로 업종과 동일 원칙: 애매하면 placeholder 유지, 구조화 채택분 전수 분류로 정밀도 95%+ 확인 후 실행
- needs_review 오탐 2건(다분야 나열 유형)은 certification 라운드의 dry-run에서 함께 정정 검토

## 6. 리스크·의존성

- **S2 국세청 상태조회 서비스키 필요 (즉시 액션)**: 공공데이터포털에서
  [사업자등록정보 진위확인 및 상태조회](https://www.data.go.kr/data/15081808/openapi.do) 활용신청 →
  발급 키를 `CUNOTE_NTS_SERVICE_KEY`로 설정. 키가 없으면 NTS 체크는 조용히 skip(무해)되지만 일일 휴폐업 감지가 동작하지 않음
- S4·S5는 공공데이터포털 **활용신청 승인** 필요 (자동승인 여부 신청 시 확인)
- S5는 LINK형 API — 실제 스펙은 활용가이드(hwp) 확인 후 확정
- P2의 무료 API도 장애·스로틀 존재 → 팝빌과 동일하게 enrichment_cache 필수 경유
- founder_age 등 개인정보 축은 동의 스코프(`basic_info`)에 수집 항목 고지 문구 추가 검토 (PIPA)
