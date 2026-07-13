# 추가 기업지원사업 API 검증 — 2026-07-12

## 결론

현재 즉시 추가 가능한 순증 공급원은 없다.

- 과학기술정보통신부 사업공고 API는 R&D 순증 후보로 **go 후보**지만 현재 공공데이터포털 활용신청이 승인되지 않아 live probe가 `403 Forbidden`이다.
- 중소벤처기업부 신규 지원사업 공고 API는 기업마당 동일 원천이므로 새 공급원이 아니라 증분·수정 cursor 후보이다. 이용허락이 공공저작물 제3유형(출처표시·변경금지)이므로 조건 추출·정규화 결과의 재배포 범위를 별도 확인하기 전에는 ingestion을 교체하지 않는다.
- 국고보조금 공모사업 상세 API는 범위가 넓고 기업 신청 가능 audience 비율이 불명확하므로 MSIT 다음 probe 후보로 둔다.

## 1. 과학기술정보통신부 사업공고 API

공식 문서:

- <https://www.data.go.kr/data/15074634/openapi.do>
- endpoint: `GET https://apis.data.go.kr/1721000/msitannouncementinfo/businessAnnouncMentList`
- 필수 파라미터: `ServiceKey`, `pageNo`, `numOfRows`; JSON은 `returnType=json`
- 제공 필드: 제목, 상세 URL, 담당부서·담당자·연락처, 게시일, 첨부파일명·다운로드 URL
- 무료, 개발·운영 자동승인, 이용허락 제한 없음으로 안내됨

구현:

- `packages/core/src/msit/fetch.ts`: URL 생성, JSON 응답 계약, 단건/배열 items 호환, API error 처리, 전체 페이지 snapshot과 완주 여부
- `packages/core/src/msit/fetch.test.ts`: 정상/오류/키 인코딩/fetch mock/페이지 완주·절단 검증
- `packages/core/src/msit/coverage.ts`: 최근 90일 필터와 기존 활성 공고 대비 중복·순증 측정
- `packages/core/src/msit/coverage.test.ts`: 날짜 경계, 잘못된 날짜, 미래 날짜, exact/review/likely-unique 검증
- `scripts/spikes/msit-announcement-probe.ts`: 키 비노출 read-only probe와 승인 후 DB read-only 커버리지 비교

실행:

```bash
pnpm probe:msit-announcements
```

현재 결과:

```json
{
  "ok": false,
  "code": "api_utilization_approval_required",
  "message": "MSIT announcement request failed: 403 Forbidden (Forbidden)"
}
```

외부 조치 후 재실행한다. 성공 시 한 번의 실행으로 전체 페이지 수집과 최근 90일 기존 활성 공고 비교까지 수행한다.

판정 계약:

- `snapshotComplete=false`: 전체 공고를 받지 못했으므로 go/no-go 근거로 사용 금지
- `exact_title`: NFKC·문장부호 정규화 후 제목이 동일한 중복 후보
- `high_confidence`: 기존 dedup score 0.82 이상인 중복 후보
- `review`: score 0.60 이상 0.82 미만으로 사람 검토 필요
- `likely_unique`: score 0.60 미만
- `conservativeIncrementalCount`: `likely_unique`만 집계하며 review 후보는 순증으로 계산하지 않음
- 게시일 파싱 실패가 하나라도 있으면 `operationallyUsable=false`

승인 후에도 audience 비율과 실제 신청기간은 원문 검수가 필요하다. 이 측정과 검수 전에는 `GrantSource` enum이나 DB ingestion을 추가하지 않는다.

## 2. 중소벤처기업부 신규 지원사업 공고 API

공식 문서:

- <https://www.data.go.kr/data/15157820/openapi.do>
- endpoint family: `https://apis.data.go.kr/1421000/bizinfo`
- 기능: 해시태그·분야·공고ID·등록일·수정일 조건 조회
- 공고명, URL, ID, 소관·수행기관, 사업개요, 신청기간·대상·방법, 첨부·본문출력 파일을 제공
- 공식 설명상 데이터 원천은 기업마당
- 이용허락: 공공저작물 제3유형(출처표시·변경금지)

판정:

- 신규 공고 순증 소스로 취급하지 않는다.
- 현재 `BIZINFO_SERVICE_KEY` API에서 부족한 수정일 cursor와 증분 조회 안정성을 보완할 가능성이 있다.
- raw 원문 보존·출처표시·변경금지 조건과 파생 criteria 생성의 허용 범위를 확인한 뒤 adapter 교체 여부를 결정한다.

## 3. 국고보조금 공모사업 상세 API

공식 문서:

- <https://www.data.go.kr/data/15156853/openapi.do>
- endpoint family: `https://apis.data.go.kr/1051000/MoefOpenAPI2025`
- `T_OPD_ASBS_PBNS_UNITY`: 국고보조사업 공모 지원정보 종합
- 무료·자동승인·이용허락 제한 없음으로 안내됨

공식 Swagger에서 확인한 매칭 관련 필드:

- 필수 조회값: `serviceKey`, `pageNo`, `numOfRows`, `resultType`, `bsnsyear`
- 공고: `PBLANC_NM`, `PBLANC_BEGIN_DE`, `PBLANC_END_DE`, `PBLANC_UPDT_DT`
- 접수: `RCEPT_BEGIN_DE`, `RCEPT_END_DE`, `RCEPT_PD_DC`, `REQST_RCEPT_MTH_CN`
- 자격: `SPORT_TRGET_CN`, `EXCL_TRGET_CN`, `SPORT_CND_CN`
- 심사·서류: `SLCTN_STDR_DC`, `PRESENTN_PAPERS_GUIDANCE_CN`
- 기관·URL: `JRSD_NM`, `DLVPL_NM`, `PBLANC_POPUP_URL`, `BSNS_GUIDANCE_URL`

구현:

- `packages/core/src/moef/fetch.ts`: JSON 호출·응답 파싱, API 오류, 핵심 매칭 필드 계약
- `packages/core/src/moef/fetch.test.ts`: 단건 item, 숫자형 페이지 값, 키 인코딩, 입력 범위 검증
- `scripts/spikes/moef-subsidy-probe.ts`: 현재 사업연도 100건의 필드 커버리지와 표본을 출력하는 read-only probe

실행:

```bash
pnpm probe:moef-subsidies
```

현재 결과는 MSIT와 동일하게 해당 API 활용승인 전 `403 Forbidden / api_utilization_approval_required`다. adapter 단위 테스트와 코어 타입 빌드는 통과했다.

공모 범위가 기업지원 외 개인·비영리·지자체 등을 포함할 가능성이 높다. 활용승인 후 `SPORT_TRGET_CN`과 `EXCL_TRGET_CN` 표본을 우선 검수하고, 기업·mixed audience와 기존 공급원 대비 순증 공고 비율이 낮으면 ingestion하지 않는다.

## 안전 게이트

새 공급원 추가 전 필수:

1. 최근 90일 데이터 live probe 성공
2. 기존 두 소스와 exact/likely duplicate 측정
3. 기업·mixed audience 비율 측정
4. 신청기간과 원문·첨부 접근률 측정
5. 이용조건의 저장·변환·재배포 허용 확인
6. 순증 활성 공고가 유지비용을 정당화할 때만 source enum·DB migration·ingestion 추가
