# Gate 1: 필드맵 정답 라벨링 기준서

작성일: 2026-07-02
상위 설계: `docs/public-support-application-guide-master-architecture.md` 17장 Gate 1
버전: golden_ver `field_map_v0`

## 목적

PoC 샘플 55개 문서(HWP/HWPX 30 + PDF 10 + DOCX 10 + 웹폼 5)의 필드맵 정답을 사람이 라벨링한다. 이 정답 없이는 Gate 2의 coverage/recall/agreement를 측정할 수 없다. 라벨은 기존 `golden_set` 테이블(kind `field_map` 추가)에 저장하며 Phase 8 품질 운영으로 그대로 승계된다.

라벨러 간 판정이 갈리면 측정 자체가 흔들리므로, 아래 기준을 먼저 합의하고 시작한다. 애매한 케이스는 이 문서의 "판정 규칙"에 추가하면서 진행한다 (기준서 자체도 버전 관리).

## 라벨 단위: 무엇을 필드 1개로 세는가

필드 = 신청자가 값을 하나 기입하거나 행동 하나를 해야 하는 최소 단위.

- 표의 "항목/작성내용" 구조: 작성내용 셀 1개 = 필드 1개
- 반복 행 표 (예: 연도별 매출 3개년): 셀마다 세지 않고 **표 전체를 `table` 필드 1개**로 라벨하고 `tableShape`에 행/열 구조를 기록
- 하나의 문장에 빈칸 2개 (예: "대표자 ___ (인) 연락처 ___"): 빈칸마다 필드 1개
- 체크박스 그룹 (예: 창업 형태 [ ]개인 [ ]법인): **그룹 = 필드 1개** (`checkbox`), 선택지는 `options`에 기록
- 순수 안내문/유의사항: 필드 아님. 단, "~를 첨부하시오" 지시는 `file` 필드로 셈
- 머리말의 공고번호/접수번호 등 기관 기입란: 필드로 세되 `applicantFills: false`

## 필드 속성 스키마

`golden_set.gold` (jsonb)에 문서 단위로 저장:

```json
{
  "docRef": "bizinfo:PBLN_000000000012345:사업계획서양식.hwp",
  "labeledBy": "reviewer@ba-ton.kr",
  "labeledAt": "2026-07-03",
  "pageCount": 8,
  "fields": [
    {
      "key": "company_name",
      "label": "기업명",
      "section": "신청기업 현황",
      "type": "text",
      "required": true,
      "applicantFills": true,
      "manual": false,
      "page": 1,
      "bbox": [0.12, 0.31, 0.45, 0.03],
      "notes": ""
    }
  ]
}
```

- `key`: 영문 스네이크케이스. 같은 의미면 문서가 달라도 같은 key를 쓴다 (기업명은 항상 `company_name`) — 자동채움 매핑 평가에 쓰인다. 표준 key 사전은 이 문서 하단에 유지
- `type`: `text | long_text | number | date | currency | checkbox | table | file | signature | stamp | unknown`
- `bbox`: `[x, y, width, height]` 페이지 크기 대비 0~1 상대좌표. 좌상단 원점. 라벨 도구가 없으면 220dpi 페이지 이미지에서 픽셀을 재서 환산한다. 위치 특정이 곤란하면 `page`만 기록하고 `bbox: null`
- `required`: 양식이 명시(별표, "필수")했거나 통념상 미기재 시 접수 불가인 항목만 true. 애매하면 false + notes

## manual 판정 (가장 중요한 라벨)

Gate 2의 "manual 분류 recall 99%" 기준의 분모다. 다음은 **무조건** `manual: true`:

- 서명란, (인)/날인, 직인
- 동의/서약/확약 문구에 대한 체크 또는 서명
- 증빙 파일 첨부 지시
- 신분증/통장 사본 등 개인정보 원본 요구

주의: "동의함 [ ]" 체크박스는 `type: checkbox`이면서 `manual: true`다. type과 manual은 독립 속성이다.

## type 판정 규칙

- 서술식 답을 여러 문장 요구하면 `long_text`, 한 줄 값이면 `text`
- 금액은 `currency`, 개수/인원은 `number`, 날짜/기간은 `date`
- "표에 기입"은 `table`, 첨부 지시는 `file`
- 판단 곤란은 `unknown` + notes (unknown 비율도 지표다 — 남발 금지)

## 웹폼 5개의 라벨

웹폼은 bbox 대신 `stepIndex`(단계)와 `fieldLabel`(화면 표시 라벨)을 기록한다. 스크린샷을 페이지 이미지로 취급해 같은 스키마를 쓴다.

## 절차와 품질 관리

1. 라벨 도구: 1차는 스프레드시트(문서별 시트) 또는 JSON 직접 작성. 페이지 이미지는 Gate 0 스파이크 산출물(spike-out)의 썸네일/PDF를 사용
2. 문서당 예상 소요 20~40분. 55개 기준 1인 4~5일
3. 교차 검증: 전체의 20%(11개 문서)는 2인이 독립 라벨링 후 비교. 필드 매칭률 90% 미만이면 기준서를 보강하고 해당 유형을 재라벨
4. 논쟁 케이스는 이 문서 하단 "판정 사례집"에 기록 (질문-응답-전파 루프의 첫 lesson들이 된다)
5. 완료 후 `golden_set`에 적재: `kind='field_map'`, `ref=docRef`, `golden_ver='field_map_v0'`
   - 사전 작업: `golden_kind` enum에 `field_map` 추가 마이그레이션 (Phase 8 착수 시 또는 적재 직전)

## 표준 key 사전 (계속 추가)

| key | 의미 |
|---|---|
| company_name | 기업명/상호 |
| biz_reg_no | 사업자등록번호 |
| ceo_name | 대표자 성명 |
| founded_date | 설립일/개업일 |
| address | 소재지 |
| industry | 업종/업태 |
| employee_count | 상시 근로자 수 |
| revenue | 매출액 (기간은 notes에) |
| item_summary | 사업/아이템 개요 |
| exec_plan | 추진 계획 |
| expected_effect | 기대 효과 |
| budget_table | 사업비/예산 표 |
| budget_basis | 예산 산출근거 |
| rep_signature | 대표자 서명/날인 |
| consent_privacy | 개인정보 동의 |

## 판정 사례집 (라벨링 중 축적)

- (예시) "연락처(휴대폰)"와 "연락처(사무실)"가 별도 칸 -> 필드 2개, key는 `phone_mobile`, `phone_office`

파일럿(2026-07-02, 5개 문서 203필드, `spike-labels/pilot-report.md`)에서 확정한 규칙:

1. **민감 개인정보 직접 기입란은 manual** — 주민등록번호·신분증 번호 등을 직접 타이핑하는 칸은 사본 첨부가 아니어도 `manual: true`. 시스템은 민감정보를 자동채움하지도, 저장하지도 않는다.
2. **배타 서식의 반복 key와 매칭 단위** — 참여유형 택1로 서식이 물리적으로 복수 존재하면(예: 신청기업용/컨설팅기업용) 같은 key가 문서 내 반복될 수 있다. 정상이다. Gate 2 coverage/recall의 매칭 단위는 **필드 인스턴스(page+bbox 포함)**이며, key는 의미 매핑(자동채움) 평가에만 쓴다.
3. **계층형 체크박스는 대분류별로 그룹 분리** — "대분류 x 하위옵션" 구조는 대분류 1개 = `checkbox` 필드 1개로 라벨하고 하위옵션은 `options`에 기록한다. 문서 전체를 1개로 뭉치지 않는다 (자동채움 매핑 단위와 일치).

기타 사례집 후보(첨부목록 카운팅, 복합 셀, 표+체크+서명 혼재 셀 등)는 `spike-labels/pilot-report.md` 참조. 신규 표준 key 후보 목록도 같은 파일에 있으며 검수 후 위 사전에 승격한다.

배치 2(2026-07-02, 10문서 448필드, `spike-labels/batch2-report.md`)에서 확정한 규칙:

4. **문서 말미 서명행은 반드시 signature 필드로 라벨** — "신청인/대표자 ___ (인)" + 날짜 형태의 말미 서명행은 필드 없음 처리 금지. manual recall 99% 지표의 분모이므로 누락은 측정을 왜곡한다. (doc10 교정 대상)
5. **manual 판정은 고유식별정보에 한정** — 주민등록번호·여권번호·운전면허번호 등 고유식별정보 기입란만 `manual: true`. 생년월일·성명·연락처 같은 일반 개인정보는 manual=false (자동채움/ask_user 대상, 대표자 생년월일은 회사 프로필 보유 정보). (doc05 재분류 대상)
6. **표 필드 key는 `<의미>_table` 접미어** — 예: `budget_table`, `financial_status_table`. 계열 문서 간 같은 의미 표는 같은 key.
