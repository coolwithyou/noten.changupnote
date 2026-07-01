# 지원사업 대형 아카이브 페이지 구현 계획

작성일: 2026-07-01

## 목적

정기 수집되는 전체 지원사업 공고를 한 화면에서 검색, 필터링, 일정 비교, 지원 준비로 연결하는 대형 아카이브 페이지를 만든다.

이 문서는 구현 중 중심을 잃지 않기 위한 기준 문서다. 구현이 진행될 때마다 `진행 현황`, `결정 로그`, `검증 로그`를 업데이트한다.

## 제품 목표

1. K-Startup, 기업마당 등에서 수집한 전체 공고를 출처, 기관, 이름, 접수 기간 기준으로 빠르게 찾을 수 있게 한다.
2. 기존 정규화 체계를 유지해 14개 신청 조건 축과 7개 혜택 분류를 분리된 필터로 제공한다.
3. 목록, 캘린더, 간트 뷰를 같은 검색 결과 위에서 전환한다.
4. 공고 상세, 저장, 지원 준비, 캘린더 추가, 원문/첨부 아카이브 확인으로 바로 이어지게 한다.
5. 데이터 품질 상태를 숨기지 않고 `needs_review`, `text_only`, 첨부 변환 상태, confidence를 운영 지표로 노출한다.

## 중심 원칙

- 아카이브는 추천/매칭 화면이 아니라 전체 공고 탐색 화면이다.
- `14개 축`은 공고 종류가 아니라 신청 조건 필터다.
- `7개 혜택`은 공고가 제공하는 지원 내용 필터다.
- 출처 API 카테고리, 혜택 taxonomy, 신청 조건 taxonomy, 제출서류 taxonomy를 섞지 않는다.
- 목록, 캘린더, 간트는 서로 다른 데이터가 아니라 같은 archive search projection의 표현 방식이다.
- 대량 데이터는 서버 검색, cursor pagination, 필요한 facet 집계로 처리한다.
- 첫 구현은 읽기 중심으로 끝까지 연결하고, 편집/운영자 검수 기능은 후속 단계로 둔다.

## 현재 기반

이미 존재하는 주요 계약:

- `grant_raw`: 원천 payload, 첨부, raw hash, 수집 상태
- `grants`: 정규화된 공고 메타, 상태, 접수 기간, 기관, source id, 빠른 필터용 field
- `grant_criteria`: 14개 신청 조건 축
- `grant_attachment_archives`: 첨부 보관 및 변환 상태
- 신청 파이프라인: 저장, 준비, 제출, 선정/탈락/보류 상태를 feedback과 draft 기반으로 구성
- 신청 캘린더: 개별 공고와 신청 보드 ICS export 기반

현재 gap:

- `Grant` contract에는 `benefits[]`가 있으나 현재 DB `grants` table에는 `benefits` 저장 컬럼이 없다.
- 대형 아카이브 전용 search API, facet API, page component가 없다.
- 캘린더/간트는 신청 파이프라인 중심이며 전체 공고 아카이브 projection은 없다.

## 정보 구조

### 경로

1차 후보:

- `/archive`

대안:

- `/grants/archive`

권장: `/archive`

이유: 공고 상세 `/grants/[grantId]`와 충돌하지 않고, 제품 안에서 "전체 아카이브"라는 별도 상위 surface로 인식된다.

### 화면 레이아웃

상단:

- 페이지 제목
- 전체 검색 input
- 저장된 필터/초기화
- 뷰 전환: `목록`, `캘린더`, `간트`

요약 지표:

- 전체 공고 수
- 현재 접수 중
- 마감 7일 이내
- 검수 필요
- 첨부 아카이브 있음

본문:

- 좌측 또는 상단 필터 패널
- 우측 결과 영역
- 모바일에서는 필터 drawer와 고정 뷰 전환 사용

## 필터 체계

### 1. 공고 메타 필터

- 키워드: 공고명, 기관명, 원문 일부
- 출처: `kstartup`, `bizinfo`, `bizinfo_event`
- 상태: `upcoming`, `open`, `closed`, `unknown`
- 주관기관: `agency_jurisdiction`
- 운영기관: `agency_operator`
- 접수 시작일 범위
- 접수 마감일 범위
- 마감 임박: 7일, 14일, 30일
- 원문 URL 유무

### 2. 출처 카테고리 필터

- `category_l1`
- `category_l2`

주의: 출처 API가 주는 원 카테고리이므로 혜택 분류나 신청 조건과 분리해서 표시한다.

### 3. 7개 혜택 필터

DB 저장 대상: `grants.benefits jsonb`

혜택 family:

- `funding`: 자금지원, 사업화 자금, 보조금, 바우처
- `loan`: 융자, 정책자금, 보증, 저리 대출
- `capability`: 교육, 멘토링, 컨설팅, 액셀러레이팅
- `space`: 입주, 창업공간, 장비, 시설
- `market`: 판로, 마케팅, 전시, 수출, 유통, 홍보
- `certification`: 인증 취득, 시험평가, 지식재산, 특허
- `network`: 투자자, 대기업, 기관 연계, 데모데이, 네트워크

필터 동작:

- 다중 선택
- 기본은 OR 검색
- 후속으로 `모두 포함` 옵션을 둘 수 있다.

목록 노출:

- 대표 혜택 badge 1-3개
- hover 또는 상세 expand에서 `label`, `source`, `confidence` 노출

### 4. 14개 신청 조건 필터

DB 기준: `grant_criteria.dimension`

축:

- `region`
- `biz_age`
- `industry`
- `size`
- `revenue`
- `employees`
- `founder_age`
- `founder_trait`
- `certification`
- `prior_award`
- `ip`
- `target_type`
- `business_status`
- `other`

MVP에서 먼저 구현할 축:

- `region`
- `biz_age`
- `industry`
- `certification`
- `target_type`

후속 확장 축:

- `size`
- `revenue`
- `employees`
- `founder_age`
- `founder_trait`
- `prior_award`
- `ip`
- `business_status`
- `other`

주의:

- 이 필터는 사용자의 회사 기준 자동 매칭 결과가 아니라 공고 자체가 요구하는 조건 필터다.
- "내 회사에 맞는 공고만"은 별도 토글로 두고, 기존 match result와 연결한다.

### 5. 제출서류/첨부 필터

- 제출서류 있음
- 작성형 문서 있음
- 발급형 문서 있음
- 첨부 아카이브 있음
- markdown 변환 완료
- 변환 실패

### 6. 데이터 품질 필터

- `overall_confidence` 구간
- `grant_criteria.needs_review`
- `operator=text_only`
- parser/model/prompt version
- 최근 수집일
- raw hash 변경 감지

## 데이터 계약

### Archive query

```ts
interface GrantArchiveQuery {
  q?: string;
  sources?: GrantSource[];
  statuses?: GrantStatus[];
  agencyJurisdictions?: string[];
  agencyOperators?: string[];
  categoryL1?: string[];
  categoryL2?: string[];
  benefitFamilies?: GrantBenefitFamily[];
  criterionFilters?: Array<{
    dimension: CriterionDimension;
    values?: string[];
    min?: number;
    max?: number;
    operator?: "any" | "all";
  }>;
  applyStartFrom?: string;
  applyStartTo?: string;
  applyEndFrom?: string;
  applyEndTo?: string;
  deadlineWithinDays?: number;
  hasRequiredDocuments?: boolean;
  hasDraftableDocuments?: boolean;
  hasArchivedAttachments?: boolean;
  attachmentConversionStatus?: "converted" | "skipped" | "failed";
  needsReview?: boolean;
  textOnly?: boolean;
  minConfidence?: number;
  view?: "list" | "calendar" | "gantt";
  sort?: "updated" | "deadline" | "start_date" | "title" | "confidence";
  cursor?: string;
  limit?: number;
}
```

### Archive item

```ts
interface GrantArchiveItem {
  grantId: string;
  source: GrantSource;
  sourceId: string;
  title: string;
  url: string | null;
  agencyJurisdiction: string | null;
  agencyOperator: string | null;
  categoryL1: string | null;
  categoryL2: string | null;
  applyStart: string | null;
  applyEnd: string | null;
  status: GrantStatus;
  dDay: number | null;
  supportAmountLabel: string | null;
  benefits: GrantBenefit[];
  conditionSummary: Array<{
    dimension: CriterionDimension;
    label: string;
    valueLabel: string;
    needsReview: boolean;
  }>;
  requiredDocumentCount: number;
  draftableDocumentCount: number;
  archivedAttachmentCount: number;
  convertedAttachmentCount: number;
  needsReviewCount: number;
  textOnlyCriteriaCount: number;
  overallConfidence: number;
  applicationStage: ApplicationStage | null;
  detailHref: string;
}
```

### Facet result

```ts
interface GrantArchiveFacets {
  sources: FacetCount[];
  statuses: FacetCount[];
  agencies: FacetCount[];
  categoryL1: FacetCount[];
  categoryL2: FacetCount[];
  benefitFamilies: FacetCount[];
  criterionDimensions: Array<{
    dimension: CriterionDimension;
    count: number;
    values: FacetCount[];
  }>;
}
```

## DB 변경 계획

### Phase DB-1. `grants.benefits`

목표:

- 정규화된 7개 혜택 분류를 공고 row에 저장한다.

변경:

- migration: `grants.benefits jsonb`
- Drizzle schema: `benefits: jsonb("benefits").$type<Array<Record<string, unknown>>>()`
- contracts mapping: `Grant.benefits`
- ingestion publish path에서 `benefits[]` 저장 확인
- service data/sample data에도 benefits 포함

검증:

- `pnpm verify:db-migrations`
- `pnpm typecheck`
- benefits가 없는 기존 row는 `[]` 또는 `null`을 안전하게 처리

### Phase DB-2. 검색 성능 인덱스

초기 구현에서 직접 column 필터에 필요한 인덱스를 먼저 추가한다.

추가 완료:

- `grants(source, status)`
- `grants(apply_end)`
- `grants(updated_at)`
- JSONB GIN index on `benefits`
- `grant_criteria(dimension, grant_id)`
- `grant_criteria(operator, grant_id)`

후보:

- `grants(category_l1)`
- `grants(category_l2)`
- GIN index on `f_regions`
- GIN index on `f_industries`
- GIN index on `f_sizes`
- GIN index on `f_founder_traits`
- GIN index on `f_required_certs`

주의:

- MVP에서 무리하게 모든 인덱스를 추가하지 않는다.
- 실제 쿼리와 row count를 본 뒤 추가한다.

## 서버 구현 계획

### Phase S-1. Archive search core

파일 후보:

- `apps/web/src/lib/server/archive/grantArchiveSearch.ts`
- `apps/web/src/lib/server/archive/grantArchiveFacets.ts`
- `apps/web/src/lib/server/archive/grantArchiveProjection.ts`
- `apps/web/src/lib/server/archive/verify-grant-archive-search.ts`

작업:

- query parser 작성
- Drizzle where builder 작성
- cursor pagination 작성
- `grants` 중심 projection 작성
- `grant_criteria` aggregate 작성
- attachment count aggregate 작성
- application stage overlay 연결

수용 기준:

- DB 없이 sample/fake data로 projection verifier 통과
- DB가 있을 때 list query가 limit/cursor를 지킨다.
- keyword, source, status, period, benefit family, 핵심 criterion filter가 함께 동작한다.

### Phase S-2. Web API

파일 후보:

- `apps/web/src/app/api/web/archive/route.ts`
- `apps/web/src/app/api/web/archive/facets/route.ts`

작업:

- `GET /api/web/archive`
- `GET /api/web/archive/facets`
- session/company access 정책 연결
- route policy 업데이트
- query param schema validation
- error response 표준화

수용 기준:

- 인증 필요 페이지/API 정책이 명확하다.
- 잘못된 필터 값은 400으로 반환한다.
- 빈 결과는 정상 200과 빈 배열로 반환한다.

### Phase S-3. Calendar/Gantt projection

파일 후보:

- `apps/web/src/lib/server/archive/grantArchiveCalendar.ts`
- `apps/web/src/lib/server/archive/grantArchiveGantt.ts`

작업:

- 같은 archive search 결과를 calendar event로 변환
- 같은 archive search 결과를 gantt row/bar로 변환
- 접수 시작/마감일 없는 공고 처리 규칙 정의

수용 기준:

- 날짜 없는 공고가 캘린더/간트 UI를 깨지 않는다.
- view 전환 시 필터 결과 count가 일관된다.

## UI 구현 계획

### Phase U-1. Page shell

파일 후보:

- `apps/web/src/app/archive/page.tsx`
- `apps/web/src/features/archive/GrantArchivePageView.tsx`
- `apps/web/src/features/archive/GrantArchiveFilters.tsx`
- `apps/web/src/features/archive/GrantArchiveToolbar.tsx`

작업:

- `ServiceHeader`와 기존 SaaS shell 패턴 재사용
- 검색 input
- 뷰 전환 segmented control
- 요약 metric
- 필터 panel/drawer
- 결과 empty/loading/error 상태

수용 기준:

- desktop/mobile 모두 필터와 결과가 겹치지 않는다.
- 필터 초기화가 명확하다.
- URL query와 현재 필터 상태가 동기화된다.

### Phase U-2. 목록 뷰

파일 후보:

- `apps/web/src/features/archive/GrantArchiveListView.tsx`
- `apps/web/src/features/archive/GrantArchiveRow.tsx`

작업:

- 대량 목록 테이블/리스트
- D-day, 기간, source, agency, benefit badge, condition chip 표시
- 상세/저장/지원 준비/원문 버튼
- 더 보기 또는 cursor pagination

수용 기준:

- 한 row에서 공고명, 기관, 기간, 혜택, 주요 조건을 즉시 파악할 수 있다.
- 7개 혜택 badge와 14개 조건 chip이 시각적으로 섞이지 않는다.
- 제목이 길어도 레이아웃이 깨지지 않는다.

### Phase U-3. 캘린더 뷰

파일 후보:

- `apps/web/src/features/archive/GrantArchiveCalendarView.tsx`

작업:

- 월 단위 기본
- 마감일 event 우선 표시
- 시작일 event는 보조 표시
- event 클릭 시 상세 drawer 또는 상세 페이지 이동

수용 기준:

- 마감 임박 공고가 명확히 보인다.
- 같은 날짜에 공고가 많을 때 overflow 처리가 있다.

### Phase U-4. 간트 뷰

파일 후보:

- `apps/web/src/features/archive/GrantArchiveGanttView.tsx`

작업:

- 날짜 축
- 공고별 기간 bar
- source/status/benefit 기준 색상 규칙
- 그룹핑은 후속으로 `source`, `benefit`, `agency` 순서 검토

수용 기준:

- 접수 기간이 겹치는 공고를 비교할 수 있다.
- 기간 없는 공고는 별도 섹션 또는 제외 안내로 처리한다.

## 신청 파이프라인 연결

MVP:

- 공고 상세로 이동
- 저장 이벤트 기록
- 지원 준비 시작 버튼
- application stage badge 표시

후속:

- 아카이브에서 바로 담당자/리마인더 설정
- 필터: `내가 저장한 공고`, `준비 중`, `제출 완료`, `보류`
- 아카이브 조건으로 캘린더 구독 생성

주의:

- 전체 아카이브는 공용 데이터 탐색이고, application pipeline은 회사/사용자별 관리 상태다.
- UI에서 두 레이어를 badge/section으로 분리한다.

## 접근성/UX 기준

- 필터 control은 checkbox, toggle, select, date input처럼 기대 가능한 입력 컴포넌트를 쓴다.
- 긴 공고명과 긴 기관명은 줄바꿈/ellipsis 규칙을 정한다.
- 필터 badge는 삭제 버튼을 포함한다.
- 캘린더/간트는 목록 대체가 아니라 일정 관점의 보조 뷰다.
- 모바일에서는 목록 뷰를 기본으로 하고 캘린더/간트는 가로 스크롤이 아닌 요약형으로 낮춘다.
- 색상만으로 상태를 구분하지 않는다.

## 구현 단계 체크리스트

### 0. 문서와 기준 확정

- [x] 아카이브 페이지 목표 정의
- [x] 14개 신청 조건 축과 7개 혜택 분류의 역할 분리
- [x] 목록/캘린더/간트 공통 projection 방향 정의
- [x] 최종 route 확정
- [x] MVP 필터 범위 확정

### 1. 데이터 저장 보강

- [x] `grants.benefits` migration 추가
- [x] Drizzle schema 업데이트
- [x] contracts/repository mapping 확인
- [x] ingestion publish path benefits 저장 확인
- [x] sample/service data benefits 반영
- [x] DB migration verifier 통과

### 2. Archive search core

- [x] archive query type 작성
- [x] query param parser 작성
- [x] Drizzle where builder 작성
- [x] list projection 작성
- [x] criteria aggregate 작성
- [x] attachment aggregate 작성
- [x] application stage overlay 작성
- [x] verifier 작성

### 3. Archive API

- [x] `GET /api/web/archive`
- [x] `GET /api/web/archive/facets`
- [x] route policy 업데이트
- [x] error handling
- [x] pagination/cursor 응답
- [x] API verifier 또는 route-level test

### 4. Archive page shell

- [x] `/archive` page 생성
- [x] page loader 연결
- [x] toolbar/search/filter shell
- [x] facet count 표시
- [x] 기관/카테고리 facet filter
- [x] URL query sync
- [x] loading/error/empty 상태
- [x] responsive layout

### 5. 목록 뷰

- [x] row/card component
- [x] benefit badge
- [x] criterion chip
- [x] status/D-day/date display
- [x] action buttons
- [x] pagination/load more

### 6. 캘린더 뷰

- [x] calendar projection
- [x] month view
- [x] event overflow
- [x] detail navigation
- [x] date-less item handling

### 7. 간트 뷰

- [x] gantt projection
- [x] date axis
- [x] row/bar rendering
- [x] color/status legend
- [x] date-less item handling

### 8. QA와 검증

- [x] `pnpm --filter @cunote/web typecheck`
- [x] 관련 verifier
- [x] route policy verifier
- [x] browser QA: desktop
- [x] browser QA: mobile
- [x] 긴 제목/기관명 QA
- [x] 빈 결과 QA
- [x] 대량 결과 pagination QA

## MVP 범위

반드시 포함:

- `/archive` page
- 목록 뷰
- keyword/source/status/date 필터
- 7개 혜택 필터
- 14개 신청 조건 축 전체 텍스트 필터
- 기관/카테고리 facet 필터
- 공고 상세 링크
- 저장/지원 준비 연결
- attachment/document 품질 badge

MVP에서 제외:

- 고급 그룹핑 간트
- 조건별 saved search
- CSV export
- 운영자 검수 action
- 아카이브 조건별 calendar subscription
- 14개 축별 구조화 operator UI

## 검증 명령

개발 서버는 사용자가 직접 띄운다. 구현 중 Codex는 명시 요청이 없으면 장기 실행 dev server를 시작하지 않는다.

예상 검증:

```bash
pnpm verify:db-migrations
pnpm --filter @cunote/web typecheck
pnpm verify:route-policy
pnpm verify:grant-archive-search
pnpm verify:grant-archive-api
pnpm verify:grant-archive-ui
```

`verify:grant-archive-search`는 `apps/web/src/lib/server/archive/verify-grant-archive-search.ts`로 추가했다.
`verify:grant-archive-api`는 service/sample benefits, archive runtime loader shape, invalid query parser를 확인한다.
`verify:grant-archive-ui`는 서버 렌더 기준으로 긴 제목/기관명, 14개 축 필터, 빈 결과, 캘린더/간트 markup을 확인한다.

## 결정 로그

| 날짜 | 결정 | 이유 | 영향 |
| --- | --- | --- | --- |
| 2026-07-01 | 14개 축은 신청 조건 필터로 둔다. | 기존 `grant_criteria.dimension`의 의미가 eligibility 조건이기 때문이다. | UI에서 `신청 조건` 그룹으로 분리한다. |
| 2026-07-01 | 7개 혜택 분류를 핵심 필터로 포함한다. | 사용자는 공고를 "무엇을 받을 수 있는가" 기준으로도 탐색해야 한다. | `grants.benefits` 저장 보강이 필요하다. |
| 2026-07-01 | 목록/캘린더/간트는 같은 archive search projection을 공유한다. | view별로 다른 쿼리를 만들면 count와 필터 상태가 drift된다. | 서버 projection을 먼저 고정한다. |
| 2026-07-01 | 7개 혜택은 우선 `grants.benefits jsonb`로 저장한다. | 기존 `Grant` contract와 ingestion publish path에 가장 작게 연결할 수 있다. | 향후 통계/성능 요구가 커지면 `grant_benefits` table을 검토한다. |
| 2026-07-01 | `/api/web/archive`는 session route로 시작한다. | 사용자별 저장/지원 준비 상태 overlay와 연결될 예정이기 때문이다. | 공개 아카이브가 필요하면 별도 public projection을 둔다. |
| 2026-07-01 | `/archive`를 1차 제품 route로 확정한다. | 공고 상세 `/grants/[grantId]`와 충돌하지 않고 상위 탐색 surface로 보인다. | 헤더 navigation과 session route policy에 추가했다. |
| 2026-07-01 | facet은 `/api/web/archive/facets` 별도 API로 둔다. | 목록 결과 payload를 키우지 않고, 필터 UI 고도화 시 독립적으로 재호출할 수 있다. | 같은 query parser와 projection facet builder를 공유한다. |
| 2026-07-01 | 캘린더/간트도 같은 projection 위에서 MVP 뷰로 구현한다. | 목록과 count/filter 상태를 공유하면서도 일정 관점의 탐색이 바로 필요하기 때문이다. | 월간 캘린더, event overflow, 날짜축 간트, 기간 없는 공고 섹션까지 1차 구현에 포함했다. |

## 진행 현황

| 단계 | 상태 | 메모 |
| --- | --- | --- |
| 문서화 | 완료 | 구현 체크리스트, 결정 로그, 검증 로그를 현재 구현 상태 기준으로 업데이트 |
| DB 보강 | 완료 | `grants.benefits` migration/schema/publisher/repository 연결, 검색 인덱스, sample/service benefits 보강 완료 |
| 서버 검색 | 완료 | archive projection, query parser, DB where builder, criteria/attachment aggregate, application stage overlay, facet builder, verifier 추가 완료 |
| Archive API | 완료 | `GET /api/web/archive`, `GET /api/web/archive/facets`, route policy, error handling, 서버 독립 API verifier 완료 |
| UI shell | 완료 | `/archive` page, filter shell, 14개 조건 축, 기관/카테고리 facet count, URL query sync, responsive CSS 추가 |
| 목록 뷰 | 완료 | list table, benefit badge, condition chip, material badge, 저장/상세/지원 준비/원문 actions, pagination 추가 |
| 캘린더 뷰 | 완료 | 마감일 기준 월간 calendar grid, event overflow, 날짜 없는 공고 영역 추가 |
| 간트 뷰 | 완료 | 접수 기간 기준 date axis, 상대 위치 bar, 상태 legend, 날짜 없는 공고 영역 추가 |
| QA | 완료 | typecheck/route/verifier/HTTP 200, desktop/mobile browser QA와 캡처 확인 완료 |

## 검증 로그

| 날짜 | 항목 | 결과 | 메모 |
| --- | --- | --- | --- |
| 2026-07-01 | 계획 문서 작성 | 완료 | 구현 전 기준 문서 |
| 2026-07-01 | `pnpm verify:grant-archive-search` | 통과 | 혜택/상태/조건/품질/pagination verifier |
| 2026-07-01 | `pnpm verify:db-migrations` | 통과 | `0024_grant_benefits.sql` 포함 확인 |
| 2026-07-01 | `pnpm --filter @cunote/web typecheck` | 통과 | archive core/API/schema 연결 타입 확인 |
| 2026-07-01 | `pnpm verify:route-policy` | 통과 | `GET /api/web/archive` session route 등록 확인 |
| 2026-07-01 | `curl -I http://127.0.0.1:4010/archive` | 통과 | 실행 중인 서버에서 200 OK 확인 |
| 2026-07-01 | `curl /archive?benefit=funding&criterion.region=서울&limit=20` | 통과 | 필터 URL이 archive HTML과 결과를 반환 |
| 2026-07-01 | `pnpm --filter @cunote/web typecheck` | 통과 | `/archive` page/list view와 지원 준비 anchor 연결 후 재확인 |
| 2026-07-01 | `pnpm --filter @cunote/web typecheck` | 통과 | archive 저장 버튼과 application stage overlay 연결 후 재확인 |
| 2026-07-01 | `curl /archive?limit=5` | 통과 | 저장/상세/지원 준비/원문 액션이 archive HTML/RSC payload에 포함됨 |
| 2026-07-01 | `pnpm verify:grant-archive-search` | 통과 | facet count/selected state verifier 추가 후 재확인 |
| 2026-07-01 | `pnpm verify:route-policy` | 통과 | `GET /api/web/archive/facets` session route 등록 확인 |
| 2026-07-01 | `pnpm verify:db-migrations` | 통과 | benefits column과 archive 검색 인덱스 migration 확인 |
| 2026-07-01 | `pnpm --filter @cunote/web typecheck` | 통과 | facet API, DB where builder, Drizzle schema index 타입 확인 |
| 2026-07-01 | `curl /api/web/archive/facets?benefit=funding&status=open&criterion.region=서울&limit=20` | 통과 | 실행 중인 4010 서버에서 facet JSON 200 OK 확인 |
| 2026-07-01 | `curl /api/web/archive?benefit=funding&status=open&criterion.region=서울&limit=5` | 통과 | 실행 중인 4010 서버에서 archive API JSON 200 OK 확인 |
| 2026-07-01 | `curl /api/web/archive?benefit=funding&status=open&criterion.region=서울&limit=1` | 통과 | date-only 정규화 후 `applyEnd`와 `dDay` 숫자 응답 확인 |
| 2026-07-01 | `curl /archive?benefit=funding&status=open&criterion.region=서울&limit=5` | 통과 | 서버 HTML에 facet count UI와 D-day 표시 포함 확인 |
| 2026-07-01 | `pnpm --filter @cunote/web typecheck` | 통과 | 월간 캘린더/간트 축 helper와 서버 컴포넌트 타입 확인 |
| 2026-07-01 | `curl /archive?view=calendar&benefit=funding&status=open&criterion.region=서울&limit=20` | 통과 | 서버 HTML에 `archive-calendar-grid`, calendar event, 월간 header 포함 확인 |
| 2026-07-01 | `curl /archive?view=gantt&benefit=funding&status=open&criterion.region=서울&limit=20` | 통과 | 서버 HTML에 `archive-gantt-table`, axis, bar, legend 포함 확인 |
| 2026-07-01 | `pnpm verify:grant-archive-search` | 통과 | 캘린더/간트 UI 변경 후 archive projection verifier 재확인 |
| 2026-07-01 | `pnpm --filter @cunote/web typecheck` | 통과 | 14개 조건 축 UI와 기관/카테고리 facet filter 타입 확인 |
| 2026-07-01 | `curl /archive?limit=20` | 통과 | 서버 HTML에 14개 신청 조건 축 라벨과 기관/분야 facet 필터 포함 확인 |
| 2026-07-01 | `curl /archive?criterion.ip=특허&criterion.revenue=10억&agencyJurisdiction=서울특별시&limit=20` | 통과 | 14개 축 query와 기관 facet query가 페이지에 유지되는지 확인 |
| 2026-07-01 | `pnpm verify:grant-archive-search` | 통과 | 14개 축 UI 변경 후 archive projection verifier 재확인 |
| 2026-07-01 | `pnpm --filter @cunote/web typecheck` | 통과 | service/sample benefits 보강과 archive API verifier 타입 확인 |
| 2026-07-01 | `pnpm verify:grant-archive-api` | 통과 | service sample benefits, runtime benefit filter, facet shape, invalid query parser 확인 |
| 2026-07-01 | `pnpm verify:grant-archive-search` | 통과 | service/API verifier 추가 후 archive projection verifier 재확인 |
| 2026-07-01 | `pnpm verify:grant-archive-ui` | 통과 | 긴 제목/기관명, 14개 축 필터, 빈 결과, 캘린더/간트, 날짜 없는 공고 서버 렌더 확인 |
| 2026-07-01 | `pnpm --filter @cunote/web typecheck` | 통과 | archive UI verifier 추가 후 타입 확인 |
| 2026-07-01 | 인앱 브라우저 연결 확인 | 대체 완료 | 현재 세션에서 in-app browser target은 없어서 `agent-browser` CLI로 실제 브라우저 QA 수행 |
| 2026-07-01 | `agent-browser` desktop 목록 QA | 통과 | `docs/qa/archive-browser/archive-list-desktop.png`, 긴 목록/필터/액션 표시 확인 |
| 2026-07-01 | `agent-browser` mobile 목록 QA | 통과 | `docs/qa/archive-browser/archive-list-mobile.png`, 모바일 폭에서 필터와 목록이 순차 배치됨 |
| 2026-07-01 | `agent-browser` mobile 캘린더 QA | 통과 | `archive-calendar-grid` 1개, `archive-calendar-event` 4개 확인, `docs/qa/archive-browser/archive-calendar-mobile.png` 저장 |
| 2026-07-01 | `agent-browser` mobile 간트 QA | 통과 | `archive-gantt-table` 1개, `archive-gantt-bar` 5개, `archive-gantt-legend` 1개 확인, `docs/qa/archive-browser/archive-gantt-mobile.png` 저장 |
| 2026-07-01 | `agent-browser` desktop 캘린더 QA | 통과 | `docs/qa/archive-browser/archive-calendar-desktop.png`, 월간 grid와 event overflow 표시 확인 |
| 2026-07-01 | `agent-browser` desktop 간트 QA | 통과 | `archive-gantt-table` 1개, `archive-gantt-bar` 5개, `archive-gantt-legend` 1개 확인, `docs/qa/archive-browser/archive-gantt-desktop.png` 저장 |
| 2026-07-01 | `agent-browser console` | 통과 | 현재 `/archive?view=gantt...` reload 후 console에는 React DevTools/HMR 안내만 남음 |

## 열린 질문

1. 아카이브 페이지를 로그인 사용자 전용으로 유지할지, 일부 공개할지.
2. 캘린더/간트의 완성형에서 마감일 없는 공고를 별도 목록으로 둘지, 뷰에서 제외할지.
3. "내 회사 기준 적합한 공고만" 토글을 MVP에 포함할지.
4. `benefits` 통계/성능 요구가 커질 때 `grant_benefits` table로 분리할 기준을 어디에 둘지.

## 후속 확장

- saved search
- 필터 조건별 이메일/앱 알림
- CSV/Markdown export
- 아카이브 조건 기반 calendar subscription
- 기관별/혜택별 통계 대시보드
- 운영자 검수 queue와 직접 연결
- 공고 변경 이력 비교
