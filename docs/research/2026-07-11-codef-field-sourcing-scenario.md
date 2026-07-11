# CODEF 기반 14개 매칭 필드 소싱 시나리오

> 2026-07-11 조사. 목적: 사업자등록번호 + 사용자 추가인증 조합으로 `packages/contracts` 14개 분류 차원을 채우는 API 이용 시나리오.
> 근거: developer.codef.io 공통가이드(REST API·커넥티드아이디·추가인증) + 상품별 개발가이드 실측.

## 0. CODEF 연동 공통 스펙 (실측 요약)

| 항목 | 내용 |
|---|---|
| 인증 | OAuth 2.0 client_credentials. `https://oauth.codef.io/oauth/token`, clientId/clientSecret Basic 인증. **accessToken 유효 7일** — DB 저장·재사용, 만료 시에만 재발급 |
| 응답 구조 | `{result: {code, message, transactionId}, data: {...}}`. 성공 `CF-00000` |
| 암호화 | 키관리의 `publicKey`로 RSA — 인증서 비밀번호, (선택) 주민번호 뒷자리(`identityEncYn=Y`) |
| 추가인증(2-way) | 1차 요청 → `CF-03002` + `data.continue2Way=true` → `method`(simpleAuth 등)·`jobIndex`·`threadIndex`·`jti`·`twoWayTimestamp` 보관 → 사용자 인증 완료 후 **1차 파라미터 + is2Way=true + twoWayInfo**로 재요청. 제한시간 기본 ~3분(간편인증 4분30초), **제한시간 내 동일계정 재요청 차단** |
| 간편인증 세션(SSO) | `id` 파라미터(사용자별 고유값)를 넣으면 **한 번의 간편인증 세션으로 다건 API 순차 처리** — 우리 시나리오의 핵심 레버리지 |
| 커넥티드아이디 | 계정정보(인증서/ID·PW)를 CODEF에 등록해 재사용하는 키. 홈택스 증명발급은 요청 시 인증정보 직접 전달 방식이라 필수 아님. 인증서 재사용(4대보험 등) 시 도입 검토 |
| 요금 | 데모 1개월 일 100건 무료 → 정식 건당 과금(별도 상담). 샌드박스는 추가인증 미지원 |

## 1. 시나리오 개요 — 4단계 점진 확보

```
[L0 비인증]      사업자번호만        → business_status (+기존 팝빌 유지)
[L1 간편인증 1회] 카카오/네이버/토스   → region, biz_age, industry, revenue,
                 (홈택스, 세션 SSO)     founder_age, founder_trait(성별), target_type
[L2 계정 연결]    sminfo ID/PW       → size, certification(소상공인·중소기업)
[L3 인증서(선택)] 사업장 공동인증서    → employees (정밀값)
[보조: 비인증 공공 API + 자가신고]    → certification 보강, prior_award, ip, other
```

사용자 여정: 사업자번호 입력(L0 즉시 표시) → "간편인증으로 자동 채우기" 버튼(L1, 인증 1번에 7개 차원) → 프로필 화면에서 나머지 승격 유도(L2/L3) → 잔여 필드 Q&A.

## 2. 단계별 상세

### L0. 비인증 — 사업자번호만 (즉시)

| API | 엔드포인트 | 확보 |
|---|---|---|
| CODEF 사업자등록상태(휴폐업) | 국세청, 비인증 | `business_status` (휴/폐업, 과세유형) |

- 기존 팝빌 휴폐업조회와 중복 — 팝빌 유지하고 CODEF는 L1 이후만 써도 됨 (벤더 정리 판단 사항)
- 팝빌 기업정보조회를 L0에 추가하면 L1 미동의 사용자도 상호·주소·업종·개업일 개략값 확보 (기존 가이드 문서 참조)

### L1. 홈택스 간편인증 1회 — 핵심 단계

입력 UI: 이름 + 생년월일(8자리) + 휴대폰번호 + 인증앱 선택(카카오/네이버/PASS/토스/삼성패스 등 11종) → 사용자가 앱에서 승인 → 폴링/재요청.

**호출 1: 사업자등록증명** `/v1/kr/public/nt/proof-issue/corporate-registration` (24시간 가능)

| 출력 필드 | 채워지는 차원 |
|---|---|
| `resUserAddr` 주소 | `region` (→ 주소 정규화·법정동코드 매핑 필요) |
| `resOpenDate` 개업일 | `biz_age` (개월 계산) |
| `resBusinessTypes`/`resBusinessItems`/`resBusinessTypeCode` | `industry` (→ KSIC 매핑. resBusinessTypeCode는 "데이터 보장 불가" 명시 — 업태/종목 텍스트 기반 매핑을 주 경로로) |
| `resBusinessmanType` 사업자종류(법인/개인) | `target_type` |
| `resUserIdentiyNo` 주민(법인)번호 | `founder_age`·`founder_trait(성별)` 보조 |
| `resJointRepresentativeNm` 공동사업자 | 공동대표 여부 |

- **founder_age는 간편인증 입력값(생년월일 8자리)에서 이미 확보** — 주민번호 뒷자리는 `isIdentityViewYN="0"`으로 비공개 처리해 개인정보 최소화 권장
- 성별: 주민번호 7번째 자리가 필요하므로 마스킹 시 미확보 → 간편인증 UI에서 성별 1탭 입력 추가가 가장 깔끔 (주민번호 수집 회피)
- `usePurposes`/`submitTargets` 필수 — "99:기타" 등 정책 결정 필요

**호출 2 (같은 세션, id로 SSO): 부가세과세표준증명** `/v1/kr/public/nt/proof-issue/additional-taxstandard`

- `revenue` (과세표준 = 매출 근사, 간이·개인 포함 커버리지 최광)

**호출 3 (같은 세션, 선택): 재무제표** `/v1/kr/public/nt/proof-issue/standard-financial-statements`

- 표준손익계산서 `resIncomeStatement`에서 매출액 항목 파싱 → `revenue` 확정값 (복식부기 기업)
- 제약: **08:00~22:00만 가능**, `startDate`(법인 yyyyMM / 개인 yyyy) 필요, 과다 호출 시 대상기관 IP 차단 경고 명시 → 사용자 트리거 단건 호출로만, 배치 금지

시퀀스 (2-way 상태머신):
```
1차 POST(호출1 파라미터+id) ─ CF-03002 수신 ─ UI "카카오톡에서 인증 승인" 안내
사용자 승인 → 2차 POST(1차 파라미터 + simpleAuth:"1" + is2Way + twoWayInfo) → 출력부
→ 같은 id로 호출2 1차 POST → (세션 유지 시 추가인증 생략/간소화) → 출력부
→ 호출3 …
실패 처리: 미승인 상태 simpleAuth:"1" 3회 → CF-12872, 세션 타임아웃 4분30초 → 처음부터
```

### L2. sminfo 계정 연결 — 규모·확인서

**중소기업확인서 조회** `/v1/kr/etc/ci/small-business-certificate/inquiry` (기관 0023, **아이디/비밀번호만 지원**)

| 출력 | 차원 |
|---|---|
| `resKind` 소기업(소상공인)/소기업/중기업 | `size` + `certification`(소상공인확인서) |
| `resStartDate`/`resEndDate` 유효기간 | 만료 알림 |

- 조회범위 발급일 기준 최대 15개월 → "미발급"이 아니라 "최근 발급 이력 없음"으로 저장
- sminfo 계정 없는 기업 대비: `size`는 L1 매출 + employees + 업종 기준으로 로직 판정(중소기업기본법 기준) 가능 — sminfo는 확정, 로직은 추정으로 신뢰도 구분

### L3. 사업장 공동인증서 — 고용 정밀값 (선택 티어)

**4대보험정보연계센터 사업장 가입자명부** `/v1/kr/public/pp/4insure/business-establishment-subscribers` (기관 0003)

- 입력: 사업장 공동인증서(der/key 또는 pfx) + RSA 암호화 비밀번호. 추가인증은 아이디 목록 중 index 선택형
- 출력: 보험별(국민연금/건강/산재/고용) 가입자 명부 → **가입자 수 카운트 = `employees` 정밀값**
- 제약: 가입자 300인 초과 사업장 처리오류, 4대기관 모두 발급불가 시 CF-12003 — 60초 대기 후 부분 데이터 가능성 처리 필요
- UX 마찰(인증서 파일)이 커서 **기본값은 국민연금 공공 API(무료·부분매칭)로 추정하고, 정밀값 필요 기업만 L3 승격** 권장
- 인증서 재사용이 필요하면 커넥티드아이디로 등록(계정등록→CID 발급→이후 인증서 재전송 불필요) + CODEF 인증서 관리 팝업/전송 서비스 활용

### 보조 소스 (CODEF 외, 비인증)

| 차원 | 소스 |
|---|---|
| `certification` 벤처/이노비즈/메인비즈 | 공공데이터포털 명단·중소벤처24 API (배치 적재) |
| `certification` 창업기업확인서 | 창업진흥원 발급기업정보 조회 API (무료·자동승인, 사업자번호 파라미터 지원 여부 활용신청 후 확정) |
| `ip` 특허/실용신안 | CODEF에 없음 → KIPRIS Plus API(특허청), 출원인명 기반 검색 + 자가확인 |
| `prior_award` 기수혜 | API 없음 → 자가신고 + (장기) K-Startup 이력 크롤·수기 DB |
| `founder_trait` 여성기업/장애인기업 | 여성기업확인서(wbiz)·장애인기업확인서 명단, 성별은 L1에서 |
| `other` | Q&A 자유입력 |

## 3. 14개 차원 최종 매핑

| 차원 | 주 소스 | 단계 | 폴백 |
|---|---|---|---|
| region | 사업자등록증명 주소 | L1 | 팝빌(L0) |
| biz_age | 〃 개업일 | L1 | 팝빌 설립일(L0) |
| industry | 〃 업태/종목 →KSIC | L1 | 팝빌 산업코드(L0) |
| size | 중소기업확인서 | L2 | 매출+고용+업종 로직판정(L1) |
| revenue | 부가세과세표준·재무제표 | L1 | 신평사 추정치 / 자가신고 |
| employees | 4대보험 가입자명부 | L3 | 국민연금 공공API(부분매칭) |
| founder_age | 간편인증 입력 생년월일 | L1 | 자가신고 |
| founder_trait | 성별 1탭 입력 + 확인서 명단 | L1+공공 | 자가신고 |
| certification | sminfo + 창업진흥원 + 벤처/이노비즈 명단 | L2+공공 | 자가신고 |
| prior_award | — | — | 자가신고 (장기: 수기 DB) |
| ip | KIPRIS | 공공 | 자가신고 |
| target_type | 사업자등록증명 사업자종류 | L1 | 팝빌 개인/법인(L0) |
| business_status | 팝빌(기존) / CODEF 휴폐업 | L0 | — |
| other | — | — | Q&A |

**커버리지: 14개 중 API 확보 11개(L0~L3+공공), 자가신고 잔존 3개(prior_award, ip 일부, other).** 간편인증 1회로 7개 차원이 국세청 확정값으로 채워지는 게 핵심.

## 4. 개발 계획 골격

1. **Phase A — CODEF 코어 모듈** (토큰 매니저 7일 캐시, RSA 유틸, 2-way 상태머신 + `id` 세션 관리, 에러코드 맵 CF-03002/12003/12872). 데모버전(일 100건 무료)으로 검증
2. **Phase B — L1 플로우**: 간편인증 UI(이름·생년월일·전화·인증앱·성별) → 사업자등록증명+부가세과세표준 2연속 호출 → 필드 병합(원천=국세청, 신뢰도 95%+) → 기존 매칭 필드 테이블에 라이브/캐시 구분 기록
3. **Phase C — L2/보조**: sminfo 연결(자격증명 보관 정책 결정 필요), 창업진흥원·벤처 명단 배치, 발급가능성 판정 엔진(창업기업 7년/소상공인 기준)
4. **Phase D — L3(선택)**: 커넥티드아이디 + 인증서 업로드 → 4대보험 명부
5. **검증 게이트**: 데모 키로 실기업 3~5곳(개인/법인/간이 혼합) E2E, 재무제표 08~22시 제약·비복식부기 기업의 빈 응답 케이스 확인

## 5. 리스크·미해결

- **정식버전 단가 비공개** — 견적 문의 필수 (일부 증빙 API는 건당 수백 원대로 알려짐, 미확인)
- 스크래핑 태생 리스크: 홈택스 개편 시 일시 장애, IP 차단 경고(재무제표) → 사용자 트리거 단건 원칙
- 자격증명 취급: 간편인증은 무저장(휘발), sminfo ID/PW·인증서는 저장 시 암호화·동의 설계 필요 (개인정보·신용정보 검토)
- 간편인증 세션 SSO로 몇 개 상품까지 연속 호출 가능한지 문서에 상한 없음 → 데모에서 실측
- 창업진흥원 API 사업자번호 검색 지원 여부 미확정
- 개인(비사업자) 발급 불가 — 예비창업자는 L1 진입 불가 → biz_age "예비창업" 분기는 자가신고 경로 유지
