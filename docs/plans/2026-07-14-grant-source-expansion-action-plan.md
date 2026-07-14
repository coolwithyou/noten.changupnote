# 공고 원천 소스 확장 액션플랜

- 작성일: 2026-07-14
- 공식 문서·공개 엔드포인트 재확인일: 2026-07-14
- 목적: K-Startup·기업마당 다음 공고 원천을 안전하게 추가하기 위해, API 존재 여부·인증·요청/응답 계약·사용자 조치·도입 판정 순서를 한 문서로 고정한다.
- 선행 조사: [`2026-07-12-ir-search-리포-검토와-cunote-반영-제안.md`](../research/2026-07-12-ir-search-%EB%A6%AC%ED%8F%AC-%EA%B2%80%ED%86%A0%EC%99%80-cunote-%EB%B0%98%EC%98%81-%EC%A0%9C%EC%95%88.md)
- 기존 API spike: [`2026-07-12-additional-grant-api-probe.md`](../research/2026-07-12-additional-grant-api-probe.md)

## 결론

지금 사용자가 해야 할 일은 **공공데이터포털 활용신청 3건**과 **KOCCA Open API 신청 1건**이다. 새 비밀키를 채팅이나 문서에 전달할 필요는 없다.

1. 공공데이터포털에서 아래 3개 API를 활용신청한다.
   - `15157820` 중소벤처기업부_신규 지원사업 공고
   - `15074634` 과학기술정보통신부_사업공고
   - `15156853` 국고보조금 공모사업 상세
2. KOCCA 회원가입·로그인 후 `지원사업 Open API`를 신청한다.
3. 발급된 KOCCA 키만 `apps/web/.env.local`에 넣는다. 공공데이터포털 공용키는 이미 설정되어 있으므로 다시 발급하거나 교체하지 않는다.
4. 완료 후 키 자체가 아니라 아래 상태만 공유한다.
   - `data.go.kr 3건 활용승인 완료`
   - `KOCCA 지원사업 API 키 입력 완료`

2026-07-14 실측 결과, 공공데이터포털 공용키는 로컬에서 정상 인식되지만 위 3개 데이터셋은 아직 승인되지 않아 모두 `403 Forbidden`이다. 따라서 현재 막힌 지점은 **키 부재가 아니라 데이터셋별 활용승인**이다.

새 원천을 바로 운영 DB에 넣지는 않는다. 먼저 기존 K-Startup·기업마당의 전수수집 여부와 배치 영수증을 보강하고, 각 후보의 최근 90일 순증률·기업 대상 비율·마감/원문 품질을 측정한 뒤 `go/no-go`를 결정한다.

---

## 1. 사용자 액션 체크리스트

### 1.1 공공데이터포털: 기존 공용키로 활용신청 3건

공공데이터포털은 계정의 일반 인증키 하나를 여러 데이터셋에 공용으로 사용한다. 현재 `CUNOTE_DATA_GO_KR_SERVICE_KEY`가 이미 설정되어 있으므로 **새 키 발급이나 env 수정은 필요 없다.**

#### 신청 순서

1. [공공데이터포털](https://www.data.go.kr/)에 로그인한다.
2. 아래 링크를 차례로 열고 `활용신청`을 누른다.
3. 활용목적에는 실제 용도에 맞게 다음처럼 적는다.

   > 창업·중소기업 지원사업 공고의 수집, 중복 제거, 기업별 적합성 분석 및 맞춤 추천 기능 개발·운영 검증

4. 개발계정 자동승인 여부를 확인한다. `마이페이지 → Open API → 개발계정`에서 상태가 `승인`이어야 한다.
5. 아래 세 줄의 상태만 체크한다. 인증키 문자열은 복사해 공유하지 않는다.

| 순서 | API | 데이터셋 ID | 신청 링크 | 현재 상태 |
|---|---|---:|---|---|
| 1 | 중소벤처기업부 신규 지원사업 공고 | `15157820` | [공식 상세](https://www.data.go.kr/data/15157820/openapi.do) | ☐ 활용신청 ☐ 승인 |
| 2 | 과학기술정보통신부 사업공고 | `15074634` | [공식 상세](https://www.data.go.kr/data/15074634/openapi.do) | ☐ 활용신청 ☐ 승인 |
| 3 | 국고보조금 공모사업 상세 | `15156853` | [공식 상세](https://www.data.go.kr/data/15156853/openapi.do) | ☐ 활용신청 ☐ 승인 |

승인 직후에도 게이트웨이 반영까지 시간이 걸릴 수 있다. 승인 상태인데 probe가 `403`이면 키를 재발급하지 말고 30~60분 뒤 한 번 더 확인한다.

### 1.2 KOCCA: 별도 회원가입·Open API 신청

KOCCA는 공공데이터포털 공용키가 아니라 KOCCA가 발급하는 `serviceKey`를 사용한다.

#### 신청 순서

1. [KOCCA 회원 서비스](https://www.kocca.kr/)에서 회원가입·로그인한다.
2. [지원사업 Open API 안내](https://www.kocca.kr/kocca/subPage.do?menuNo=204796)를 연다.
3. 안내 페이지의 `Open API 신청`에서 **지원사업 API**를 신청한다.
4. [나의 Open API 조회](https://www.kocca.kr/kocca/api/userOpenApiRead.do?menuNo=204797)에서 발급 상태와 키를 확인한다.
5. 발급 키를 로컬의 `apps/web/.env.local`에만 넣는다.

```dotenv
# 신규 adapter가 읽을 예정인 변수명. 실제 값은 문서·채팅·커밋에 넣지 않는다.
CUNOTE_KOCCA_PIMS_SERVICE_KEY=<KOCCA 지원사업 serviceKey>
```

현재 코드는 이 변수를 아직 읽지 않는다. 미리 넣어도 되지만, 실제 연결은 KOCCA probe/adapter 구현 후 활성화된다.

선택 사항인 `금융지원정보 API`는 지원사업 API의 순증 결과를 먼저 본 뒤 신청한다. 별도 키가 발급되는 경우에만 다음 변수로 분리한다.

```dotenv
CUNOTE_KOCCA_FINANCE_SERVICE_KEY=<KOCCA 금융지원정보 serviceKey>
```

### 1.3 지금 가입하거나 토큰을 발급받지 않을 소스

| 소스 | 사용자 액션 | 이유 |
|---|---|---|
| NIPA | 없음 | 공개 목록 페이지 후보. 공식 공고 Open API는 확인되지 않음 |
| SMTECH | 없음 | 공개 목록 페이지 후보. 공식 공고 Open API는 확인되지 않음 |
| IRIS | 없음 | 공개 공고 화면은 있으나 공고 Open API는 확인되지 않음 |
| NTIS | 없음 | 공개 Open API 목록에서 사업·성과 API는 확인되지만 공고 API는 미확인 |
| NIA·IITP·지역 TP | 없음 | 1차 후보 성과 확인 후 조사할 후순위 |
| 보조금24 | 없음 | 로그인 기반 사용자 안내 서비스이며 서버 수집 원천으로 보지 않음 |

특히 IRIS의 `국가연구자번호 조회 API`는 공고 수집과 무관하므로 신청하지 않는다.

---

## 2. 원천별 판정표

| 우선순위 | 원천 | 공식 공고 API | 인증 | cunote에서의 역할 | 다음 판정 |
|---|---|---|---|---|---|
| P0 | 기업마당 v2 | 있음 | data.go.kr | 기존 `bizinfo`의 증분·수정일·풍부한 필드 보강 | 약관 확인 후 기존 adapter와 parity 비교 |
| P1 | MSIT | 있음 | data.go.kr | ICT/R&D 공고 순증 후보 | 승인 후 기존 probe 재실행 |
| P1 | KOCCA | 있음 | KOCCA 별도 키 | 콘텐츠·제작·콘텐츠 스타트업 순증 후보 | 키 발급 후 신규 probe 구현 |
| P1 | MOEF 국고보조금 | 있음 | data.go.kr | 범부처 보조사업의 기업 대상분 후보 | 승인 후 audience 표본 검수 |
| P2 | NIPA | 확인 못함 | 없음 | AI·SaaS·ICT 특화 공개 페이지 후보 | 최근 90일 dry-run |
| P2 | SMTECH | 확인 못함 | 없음 | 중소기업 R&D 전용 공고 후보 | 최근 90일 dry-run |
| P3 | IRIS | 확인 못함 | 없음 | 범부처 R&D 후보 | 브라우저 요청 재현·이용조건 확인 |
| P3 | NTIS | 공고 API 미확인 | 미정 | IRIS 대체/보완 후보 | 공개 공고 페이지와 Open API 재조사 |
| P4 | NIA·IITP·지역기관 | 미조사 | 미정 | 분야·지역 롱테일 | P1/P2 순증 결과 뒤 조사 |

### 2026-07-12 조사 문서에 대한 정정

- KOCCA는 HTML `POST /kocca/pims/list.do`를 크롤링할 필요가 없다. 2026-07-14 현재 **공식 지원사업 Open API**가 확인되었으므로 공식 API를 우선한다.
- 기업마당은 기존 레거시 API 외에 2026년 등록된 **신규 지원사업 공고 REST API**가 확인되었다. 이것은 신규 원천이 아니라 기존 `bizinfo` 수집의 안정성·필드 품질을 높일 교체 후보이다.
- MSIT·MOEF는 이미 타입 안전 fetch adapter와 read-only probe가 저장소에 있다. 지금 필요한 것은 개발이 아니라 데이터셋 활용승인과 live 결과 판정이다.

---

## 3. 공식 API 요청·응답 계약

### 3.1 기업마당 v2 — 중소벤처기업부 신규 지원사업 공고

#### 상태와 용도

- 공식 문서: [data.go.kr 15157820](https://www.data.go.kr/data/15157820/openapi.do)
- 등록/수정: 2026-03-25 등록, 2026-04-27 수정
- 방식: REST, JSON/XML, 무료
- 개발계정: 자동승인, 10,000회로 안내
- 데이터 범위: 당해 연도 공고
- 원천: 기업마당
- 라이선스 주의: 공공저작물 제3유형(출처표시·변경금지)으로 안내된다. raw 보존·출처표시와 별개로 정규화/조건 추출 결과의 제공 범위를 문의 후 확정한다.

#### 요청

```http
GET https://apis.data.go.kr/1421000/bizinfo/pblancBsnsService
```

| 파라미터 | 필수 | 값/형식 | 용도 |
|---|---|---|---|
| `serviceKey` | 예 | data.go.kr 일반 인증키 | 인증 |
| `dataType` | 아니오 | `JSON` 또는 `XML` | JSON 고정 권장 |
| `pageNo` | 아니오 | 정수 | 페이지 |
| `numOfRows` | 아니오 | 정수 | 페이지 크기 |
| `searchLclasId` | 아니오 | 분야 대분류 ID | 분야 필터 |
| `hashtags` | 아니오 | 문자열 | 해시태그 검색 |
| `pblancId` | 아니오 | 공고 ID | 단건/정확 조회 |
| `registDe` | 아니오 | 날짜 | 등록일 증분 후보 |
| `updtPnttm` | 아니오 | 일시 | 수정시점 증분 후보 |

예시:

```text
https://apis.data.go.kr/1421000/bizinfo/pblancBsnsService
  ?serviceKey=<인증키>
  &dataType=JSON
  &pageNo=1
  &numOfRows=100
```

#### 응답에서 사용할 값

응답은 일반적인 `response.header` / `response.body` 구조이며, `body.totalCount`, `body.pageNo`, `body.numOfRows`, `body.items.item[]`를 사용한다.

| 필드 | 정규화 대상 |
|---|---|
| `pblancId`, `pblancNm`, `pblancUrl` | source ID, 제목, 원문 URL |
| `jrsdInsttNm`, `excInsttNm` | 소관기관, 수행기관 |
| `bsnsSumryCn` | 사업개요/추출 입력 |
| `pldirSportRealmLclasCodeNm`, `hashtags` | 분야·태그 |
| `reqstBeginEndDe` | 신청기간 |
| `trgetNm` | 지원대상 |
| `reqstMthPapersCn` | 신청방법·제출서류 |
| `rceptEngnHmpgUrl` | 실제 접수 URL |
| `creatPnttm`, `updtPnttm` | 생성·수정 cursor |
| `flpthNm`, `fileNm`, `printFlpthNm`, `printFileNm` | 첨부·인쇄본 자산 |
| `refrncNm`, `inqireCo` | 문의처, 조회수/보조 정보 |

#### 도입 방식

- 새 `grant_source`를 만들지 않고 기존 `bizinfo`의 fetch adapter 교체/보완으로 다룬다.
- 레거시 `BIZINFO_SERVICE_KEY` 경로와 같은 `pblancId` 표본을 대조한다.
- `updtPnttm` 증분이 안정적으로 작동하는지 확인한 후에만 cursor를 전환한다.
- 변경금지 이용조건 문의가 해소되기 전에는 운영 수집을 교체하지 않는다.

문의 문안:

> 공고 원문과 출처를 변경 없이 보존·표시하면서, 응답 필드를 내부 표준 스키마로 매핑하고 지원대상 조건을 구조화하여 사용자에게 검색·매칭 결과를 제공하려 합니다. 공공저작물 제3유형의 변경금지 조건에서 이러한 정규화 및 파생 조건 제공이 허용되는지 확인 부탁드립니다.

### 3.2 과학기술정보통신부 사업공고(MSIT)

#### 상태와 구현

- 공식 문서: [data.go.kr 15074634](https://www.data.go.kr/data/15074634/openapi.do)
- REST, JSON/XML, 무료, 개발·운영 자동승인으로 안내
- adapter: `packages/core/src/msit/fetch.ts`
- 전체 snapshot·순증 측정: `packages/core/src/msit/coverage.ts`
- read-only probe: `scripts/spikes/msit-announcement-probe.ts`
- 2026-07-14 live 결과: `403 Forbidden / api_utilization_approval_required`

#### 요청

```http
GET https://apis.data.go.kr/1721000/msitannouncementinfo/businessAnnouncMentList
```

| 파라미터 | 필수 | 값/형식 |
|---|---|---|
| `ServiceKey` | 예 | data.go.kr 인증키. 대소문자 주의 |
| `pageNo` | 예 | 페이지 번호 |
| `numOfRows` | 예 | 페이지 크기 |
| `returnType` | 아니오 | JSON 사용 시 `json` |

#### 응답

| 필드 | 의미 |
|---|---|
| `resultCode`, `resultMsg` | 결과 코드·메시지 |
| `pageNo`, `numOfRows`, `totalCount` | 페이지 정보 |
| `subject`, `viewUrl` | 제목·상세 URL |
| `deptName` | 담당부서 |
| `managerName`, `managerTel` | 담당자·연락처 |
| `pressDt` | 게시일 |
| `fileName`, `fileUrl` | 첨부파일명·URL |

승인 후 실행:

```bash
pnpm probe:msit-announcements
```

성공 조건은 `ok=true`, `snapshotComplete=true`, 게시일 파싱 실패 0이다. `conservativeIncrementalCount`는 검토 없이 순증으로 볼 수 있는 수이며, `reviewRequiredCount`는 사람이 확인한다.

### 3.3 KOCCA 지원사업 Open API

#### 상태

- 공식 안내: [KOCCA 지원사업 Open API](https://www.kocca.kr/kocca/subPage.do?menuNo=204796)
- API 정보: [KOCCA Open API 정보](https://www.kocca.kr/kocca/subPage.do?menuNo=204795)
- 방식: REST GET, JSON, 무료, 실시간
- 인증: KOCCA 계정으로 활용신청 후 발급되는 `serviceKey`

#### 요청

```http
GET https://kocca.kr/api/pims/List.do
```

| 파라미터 | 필수 | 값/형식 |
|---|---|---|
| `serviceKey` | 예 | KOCCA 발급키 |
| `cate` | 아니오 | `1` 자유공모, `2` 지정공모, `3` 모집공고, `4` 마감공고 |
| `startDt` | 아니오 | `YYYYMMDD` |
| `endDt` | 아니오 | `YYYYMMDD` |
| `pageNo` | 아니오 | 기본 1 |
| `numOfRows` | 아니오 | 기본 10, 최대 100 |

공식 문서의 파라미터 표는 `startDt`/`endDt`지만 예시 URL에는 `viewStartDt`/`viewEndDt`가 보인다. 최초 probe에서 두 조합을 각각 호출해 실제 동작값을 영수증으로 남긴다.

#### 응답

최상위 `INFO` 아래에서 결과와 목록을 읽는 계약이다.

| 필드 | 의미 |
|---|---|
| `resultCode`, `resultMsg` | 결과 코드·메시지. 일부 공식 예시는 `resultMgs` 오타가 있음 |
| `pageNo`, `numOfRows`, `listCount` | 페이지와 전체 건수 |
| `list[].intcNoSeq` | 공고 식별자 |
| `list[].title` | 제목 |
| `list[].cate` | 공모 유형 |
| `list[].regDt` 또는 `regDate` | 등록일 |
| `list[].startDt`, `list[].endDt` | 접수기간 |
| `list[].link` | 원문 링크 |
| `list[].content` | 내용 |

주요 코드:

| 코드 | 의미 |
|---|---|
| `INFO-000` | 정상 |
| `ERROR-001` | 잘못된 파라미터 |
| `ERROR-002` | 필수 파라미터 누락 |
| `INFO-100` | 잘못된 키 |
| `ERROR-003` | 키 누락 |
| `INFO-200` | 검색 결과 없음 |

#### 구현할 probe

```bash
# 구현 예정 명령. 현재 package.json에는 아직 없음.
pnpm probe:kocca-programs
```

probe는 키를 출력하지 않고 다음만 출력해야 한다: HTTP/API 결과 코드, 요청 기간, 전체 건수, 완주 페이지 수, 최근 90일 건수, 기존 공고 중복 구간, 신청기간/원문/내용 필드 커버리지.

기존 조사 리포의 KOCCA HTML 크롤러는 fallback으로만 보존한다. KOCCA `robots.txt`가 일반 목록 경로를 제한하므로 공식 API를 우선하고 HTML 수집을 운영 경로로 만들지 않는다.

### 3.4 국고보조금 공모사업 상세(MOEF)

#### 상태와 구현

- 공식 문서: [data.go.kr 15156853](https://www.data.go.kr/data/15156853/openapi.do)
- adapter: `packages/core/src/moef/fetch.ts`
- read-only probe: `scripts/spikes/moef-subsidy-probe.ts`
- 2026-07-14 live 결과: `403 Forbidden / api_utilization_approval_required`

#### 요청

```http
GET https://apis.data.go.kr/1051000/MoefOpenAPI2025/T_OPD_ASBS_PBNS_UNITY
```

| 파라미터 | 필수 | 값/형식 |
|---|---|---|
| `serviceKey` | 예 | data.go.kr 인증키 |
| `pageNo` | 예 | 페이지 번호 |
| `numOfRows` | 예 | 최대 999로 adapter 제한 |
| `resultType` | 예 | `json` |
| `bsnsyear` | 예 | 사업연도, 예: `2026` |

#### 응답에서 사용할 값

| 묶음 | 필드 |
|---|---|
| 식별·기관 | `BSNSYEAR`, `DTLBZ_ID`, `DDTLBZ_ID`, `JRSD_NM`, `DLVPL_NM` |
| 공고 | `PBLANC_NM`, `PBLANC_BEGIN_DE`, `PBLANC_END_DE`, `PBLANC_UPDT_DT` |
| 접수 | `RCEPT_BEGIN_DE`, `RCEPT_END_DE`, `RCEPT_PD_DC`, `REQST_RCEPT_MTH_CN` |
| 자격 | `SPORT_TRGET_CN`, `EXCL_TRGET_CN`, `SPORT_CND_CN` |
| 지원·심사 | `SPORT_CN_DC`, `SLCTN_STDR_DC`, `PRESENTN_PAPERS_GUIDANCE_CN` |
| URL | `PBLANC_POPUP_URL`, `BSNS_GUIDANCE_URL` |

승인 후 실행:

```bash
pnpm probe:moef-subsidies
```

이 API는 개인·비영리·지자체 대상이 섞일 가능성이 크다. `SPORT_TRGET_CN`/`EXCL_TRGET_CN`을 표본 검수해 `company / mixed / individual / unknown` 비율을 낸 뒤, 기업 대상 순증 공고만으로 유지비용이 정당화될 때 도입한다.

---

## 4. 공식 Open API가 확인되지 않은 공개 페이지 후보

아래는 “API 없음”이 아니라 **2026-07-14 공식 공고 Open API를 확인하지 못함**으로 기록한다. 비공개 API를 억지로 우회하지 않고, 공개 목록과 브라우저가 정상적으로 호출하는 요청만 후보로 삼는다.

### 4.1 NIPA

- 공개 목록: `GET https://www.nipa.kr/home/2-2?curPage={N}`
- 인증/가입: 없음
- 목록 단위: 약 10건/페이지
- 안정 ID: 상세 링크 `/home/2-2/{id}`의 `{id}`
- 추출 후보: 제목, 분야 태그(`span.bw`), 등록일(`span.bco` 마지막 값), `신청기간 :` 텍스트, 상세 URL
- 안전 조건: 0건 파싱은 정상 종료로 보지 않고 사이트 변경/차단으로 실패 처리
- 도입 전 사용자 액션: 없음. 개발 측이 이용조건·robots 정책을 다시 확인하고 최근 90일 read-only 수집만 수행

### 4.2 SMTECH

- 공개 목록: `GET https://www.smtech.go.kr/front/ifg/no/notice02_list.do?pageIndex={N}`
- 인증/가입: 없음
- 안정 ID: 상세 URL의 `ancmId`
- 상세 후보: `notice02_detail.do?...ancmId=...`
- 정규화 주의: URL의 `;jsessionid=...` 제거, `~`가 포함된 셀에서 신청기간 파싱
- 도입 전 사용자 액션: 없음. 최근 90일을 기업마당과 대조하고, SMTECH에만 있는 활성 R&D 공고 비율을 측정

### 4.3 IRIS

- 공개 목록 화면: `GET https://www.iris.go.kr/contents/retrieveBsnsAncmListView.do`
- 상세 화면: `POST /contents/retrieveBsnsAncmView.do`
- 화면 JavaScript가 기대하는 목록 요청:
  - `POST /contents/retrieveBsnsAncmBtinSituListView.do`
  - form 필드 예: `pageIndex`, `bsnsAncmTap`, `bsnsYy`, `blngGovdSe`, `sorgnId`, `ancmTl`, `bsnsAncmTl`, `rcveDeFrom`, `rcveDeTo`, `rcvePldocTpSe`
  - JS 계약상 JSON이며 `paginationInfo.currentPageNo`, `totalRecordCount`, `totalPageCount`와 공고 배열을 렌더링
- 목록 항목 후보: `ancmId`, `bsnsYy`, `sorgnBsnsCd`, `bsnsAncmSn`, `dDay`, `rcveStrDt`, `rcveEndDt`, 공고명
- 2026-07-14 서버 단독 재현 결과: 같은 POST가 JSON이 아니라 HTML을 반환했다. 세션/추가 form 값/브라우저 요청 차이를 먼저 확인해야 한다.
- 사용자 액션: 없음. 공고 API가 확인되기 전에는 IRIS 회원가입이나 국가연구자번호 API 신청을 하지 않는다.

### 4.4 후순위 레지스트리

- NIA, IITP, 지역 테크노파크·경제진흥원, 지역 콘텐츠진흥원은 P1/P2 결과 뒤에 같은 절차로 조사한다.
- CCEI는 K-Startup 재게재 비율이 높고 JS 목록 비용이 있어 후순위로 둔다.
- 지역 소스는 전국 전수 추가보다 회사 프로필의 `region`과 맞는 2~3개 지역을 먼저 표본화한다.

---

## 5. 구현 순서

### Gate 0 — 기존 수집의 커버리지 정직성

새 source enum을 추가하기 전에 다음을 먼저 고친다.

현재 K-Startup cron 기본값은 `2페이지 × 100건`, 기업마당 cron 기본값은 `20건`이다. `source_cursor`도 `last_page`, `last_collected_at`만 저장해 전수수집 성공과 부분 실패를 구분하지 못한다.

필수 배치 영수증:

| 필드 | 의미 |
|---|---|
| `source` | 원천 |
| `run_id`, `started_at`, `finished_at` | 실행 식별·시간 |
| `status` | `succeeded / partial / failed / skipped` |
| `mode` | `full_snapshot / incremental` |
| `requested_pages`, `fetched_pages` | 요청·완주 페이지 |
| `fetched_count`, `parsed_count`, `published_count` | 단계별 건수 |
| `total_count_reported` | 원천이 보고한 전체 건수 |
| `complete` | 전수 snapshot 완주 여부 |
| `coverage_from`, `coverage_to` | 조회 기간 |
| `last_source_id`, `response_hash` | 재현·변경 감지 |
| `error_code`, `error_message` | 실패 이유. 비밀키·원문 응답 전체는 제외 |

`complete=true`인 전수 snapshot에서만 “직전에는 있었는데 이번에는 사라진 공고”를 조기마감/철회 후보로 판정한다.

완료 조건:

- 기존 두 원천의 전체 페이지 완주 여부가 숫자로 보인다.
- 일부 페이지만 성공한 실행이 성공으로 표시되지 않는다.
- 원천별 마지막 성공시각과 실패 이유를 확인할 수 있다.
- 새 source를 추가해도 기존 공고의 누락·중복이 늘지 않는 기준선이 있다.

### Gate 1 — 활용승인과 live probe

1. 사용자가 data.go.kr 3건을 승인받는다.
2. `pnpm probe:msit-announcements`를 재실행한다.
3. `pnpm probe:moef-subsidies`를 재실행한다.
4. 기업마당 v2 read-only probe를 구현·실행한다.
5. KOCCA 키가 준비되면 read-only probe를 구현·실행한다.

모든 probe는 DB에 쓰지 않고 키를 출력하지 않는다.

### Gate 2 — 최근 90일 calibration

각 원천에서 같은 기간을 뽑아 기존 K-Startup·기업마당 활성 공고와 비교한다.

필수 지표:

- fetch 전체 건수와 snapshot 완주 여부
- 최근 90일 건수와 현재 접수 가능 건수
- exact title 중복 수
- high-confidence 중복 수
- 사람 검토가 필요한 유사 공고 수
- 보수적 순증 공고 수
- `company / mixed / individual / unknown` audience 비율
- 제목·신청기간·마감시각·기관·원문 URL·문의처·첨부 필드 커버리지
- 원문/첨부 접근 성공률
- 잘못된 날짜와 0건 파싱 횟수
- 이용조건·출처표시·변환 허용 여부

go 조건:

- 전체 snapshot이 완주되거나, 공식 수정일 cursor로 누락 없는 증분 수집을 입증한다.
- 최근 90일의 실제 기업 대상 순증 활성 공고가 유지비용을 정당화한다.
- 신청기간과 원문 URL을 안정적으로 얻는다.
- 중복은 기존 `dedupLinkPublisher` 경로에서 병합할 수 있다.
- 이용조건이 raw 저장·정규화·검색/매칭 제공을 허용한다.

no-go/보류 조건:

- 대부분 기존 소스 중복이고 필드 보강 효과도 작다.
- audience가 불명확하거나 비기업 대상이 대부분이다.
- 페이지 구조 변경/차단 시 0건을 정상으로 오인할 위험이 크다.
- 약관·라이선스상 저장·변환·재배포 범위가 불명확하다.

### Gate 3 — adapter와 운영 인제스트

go가 난 원천만 다음 순서로 구현한다.

1. `packages/core/src/<source>/fetch.ts`: 요청, timeout, 응답 검증, 전체 페이지 완주
2. `normalize.ts`: 기존 `NormalizedGrant`로 매핑
3. `extraction-input.ts`: 상세/첨부의 조건 추출 입력
4. fetch·parse·normalize fixture 테스트
5. raw archive와 `rawHash` 변경 감지
6. 교차 소스 dedup 링크
7. criteria 재추출·revision invalidation
8. cron은 처음에 dry-run/수동 실행, 이후 운영 스케줄
9. source별 신선도·실패·부분수집 모니터링

`grantSourceEnum`은 schema뿐 아니라 평가·첨부·문서 추출·dedup·CLI의 하드코딩 목록에 넓게 연결되어 있다. calibration 전에 enum만 먼저 추가하지 않는다.

추천 도입 순서:

1. 기업마당 v2를 기존 `bizinfo` adapter 보강으로 검증
2. MSIT
3. KOCCA
4. MOEF 중 기업 대상 필터 통과분
5. NIPA와 SMTECH 중 순증률이 높은 쪽
6. IRIS/NTIS
7. NIA·IITP·회사 소재 지역기관

---

## 6. 승인 후 실행 영수증

사용자가 승인을 마치면 아래 순서로 진행한다. 개발 서버는 필요 없고 시작하지 않는다.

```bash
# 이미 구현됨 — DB write 없음
pnpm probe:msit-announcements
pnpm probe:moef-subsidies

# adapter 단위 계약
pnpm exec tsx packages/core/src/msit/fetch.test.ts
pnpm exec tsx packages/core/src/msit/coverage.test.ts
pnpm exec tsx packages/core/src/moef/fetch.test.ts
```

추가 구현 후 목표 명령:

```bash
pnpm probe:bizinfo-v2
pnpm probe:kocca-programs
pnpm probe:nipa-announcements
pnpm probe:smtech-announcements
pnpm report:grant-source-calibration -- --window-days=90
```

위 다섯 명령은 아직 존재하지 않으며, 명령 이름은 구현 계약이다. probe 결과는 `.artifacts/` 또는 지정된 보고 경로에 키·개인정보 없이 JSON으로 남긴다.

최종 보고 형식:

| 원천 | 승인/API 성공 | snapshot 완주 | 90일 공고 | 기업 대상 | 보수적 순증 | 결정 |
|---|---:|---:|---:|---:|---:|---|
| 기업마당 v2 |  |  |  |  |  | upgrade/hold |
| MSIT |  |  |  |  |  | go/hold/no-go |
| KOCCA |  |  |  |  |  | go/hold/no-go |
| MOEF |  |  |  |  |  | go/hold/no-go |
| NIPA |  |  |  |  |  | go/hold/no-go |
| SMTECH |  |  |  |  |  | go/hold/no-go |

---

## 7. 비밀키 취급 규칙

- 키는 `apps/web/.env.local`에만 넣고 커밋하지 않는다.
- 키 값을 채팅, 이슈, 문서, 스크린샷에 붙이지 않는다.
- 상태 공유는 `승인 완료`, `env 입력 완료`로만 한다.
- probe와 운영 로그는 요청 URL 전체를 남기지 않는다. query string에 키가 포함되기 때문이다.
- 오류 본문도 키가 반사될 가능성을 고려해 정제·길이 제한 후 기록한다.
- data.go.kr 키는 이미 percent-encoding된 값일 수 있으므로 adapter가 이중 인코딩하지 않게 한다.

---

## 8. 공식 근거 링크

- [KOCCA 지원사업 Open API 이용안내](https://www.kocca.kr/kocca/subPage.do?menuNo=204796)
- [KOCCA Open API 정보](https://www.kocca.kr/kocca/subPage.do?menuNo=204795)
- [중소벤처기업부 신규 지원사업 공고 API — data.go.kr 15157820](https://www.data.go.kr/data/15157820/openapi.do)
- [과학기술정보통신부 사업공고 API — data.go.kr 15074634](https://www.data.go.kr/data/15074634/openapi.do)
- [국고보조금 공모사업 상세 API — data.go.kr 15156853](https://www.data.go.kr/data/15156853/openapi.do)
- [NIPA 사업공고 공개 목록](https://www.nipa.kr/home/2-2?curPage=1)
- [SMTECH 사업공고 공개 목록](https://www.smtech.go.kr/front/ifg/no/notice02_list.do?pageIndex=1)
- [IRIS 사업공고 공개 목록](https://www.iris.go.kr/contents/retrieveBsnsAncmListView.do)
- [NTIS Open API](https://www.ntis.go.kr/rndopen/api/mng/apiMain.do)

---

## 9. 다음 사용자 응답

다음 네 항목만 확인해 주면 후속 작업을 바로 시작할 수 있다.

```text
[ ] data.go.kr 15157820 승인
[ ] data.go.kr 15074634 승인
[ ] data.go.kr 15156853 승인
[ ] KOCCA 지원사업 API 키를 apps/web/.env.local에 입력
```

키 값은 보내지 않는다. 체크 상태를 받은 다음에는 MSIT·MOEF live probe → 기업마당 v2·KOCCA adapter/probe → 90일 calibration 순으로 진행한다.
