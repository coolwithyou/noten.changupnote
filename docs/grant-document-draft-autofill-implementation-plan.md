# 지원서류 초안 작성/자동채움 구현 계획

작성일: 2026-06-28

## 배경

지원사업 아카이브와 문서 taxonomy 정규화로 열린 공고의 제출서류를 `작성`, `발급`, `첨부`, `기타`로 구분할 수 있게 되었다. 현재 DB 기준 열린 공고 948건 중 576건에 제출서류가 정규화되어 있고, 작성형 문서가 있는 공고는 514건, 작성형 문서와 첨부 markdown 문맥이 함께 있는 공고는 305건이다.

이 계획은 이 기반 위에서 사용자가 지원 준비에 바로 들어갈 수 있도록 `필요 서류 목록화 -> AI 초안 작성 -> 필드 자동채움 -> export` 순서로 기능을 확장하는 것을 목표로 한다.

## 목표

1. 공고별 제출서류를 준비 행동 단위로 보여준다.
2. 작성형 문서의 초안을 회사 프로필과 공고/첨부 문맥으로 생성한다.
3. 첨부 양식의 문항/필드를 구조화해 자동채움 가능 영역과 사용자 확인 필요 영역을 나눈다.
4. 초안 생성 결과를 저장하고, 사용자가 수정/재생성/완료 처리할 수 있게 한다.
5. 원본 HWP 직접 편집은 후순위로 두고, 먼저 웹 기반 markdown/form 초안과 인쇄용 HTML export를 제공한다.

## 비범위

- 정부/기관 포털에 자동 제출하지 않는다.
- 사용자 확인 없이 서명, 동의, 서약을 완료 처리하지 않는다.
- 모든 HWP 원본 레이아웃을 1:1로 재생성하지 않는다.
- 법적/회계적 증빙 자체를 AI가 생성하지 않는다. 발급/첨부형 문서는 준비 안내와 체크리스트만 제공한다.

## 기능 단계

### Phase 1. 지원 준비 체크리스트

공고 상세 또는 매칭 상세에 `지원 준비` surface를 추가한다.

- `required_documents`를 preparation type 기준으로 그룹화한다.
  - `write`: AI 초안 작성 가능
  - `issue`: 발급 필요
  - `attach`: 파일 첨부 필요
  - `other`: 원문 확인 필요
- 문서별 상태를 관리한다.
  - `not_started`
  - `draft_ready`
  - `needs_user_input`
  - `reviewed`
  - `done`
- `source_attachment`, `source_span`, `confidence`를 노출해 왜 이 서류가 필요한지 추적 가능하게 한다.
- 회사 프로필에서 자동 복사 가능한 기본 정보와 부족한 입력 항목을 함께 보여준다.

### Phase 2. AI 초안 작성

작성형 문서(`write`)를 대상으로 markdown 초안을 생성한다.

우선 대상:

- `application_form`
- `business_plan`
- `proposal_or_intro`
- `estimate_budget`
- `performance_evidence`의 설명문
- `recommendation` 요청문

처리 방식:

1. 공고 컨텍스트를 구성한다.
   - 공고 제목, 기관, 접수 기간, 지원 내용, eligibility trace, 제출서류 taxonomy
   - R2 markdown 첨부 중 `source_attachment`가 연결된 본문
2. 회사 컨텍스트를 구성한다.
   - 회사명, 대표자, 소재지, 업력, 업종, 직원 수, 매출, 인증/IP, 실적
   - 사용자가 직접 입력한 제품/서비스 설명, 지원 목적, 예상 성과
3. 문서 유형별 prompt template을 선택한다.
4. 초안과 함께 `used_fields`, `missing_fields`, `assumptions`, `warnings`를 저장한다.
5. 사용자에게는 초안 본문과 확인 필요 항목을 함께 보여준다.

### Phase 3. 문항/필드 추출

첨부 markdown에서 신청서 양식의 문항과 빈칸을 구조화한다.

출력 schema 예:

```ts
interface GrantDocumentField {
  fieldKey: string;
  label: string;
  section: string | null;
  fieldType: "text" | "long_text" | "number" | "date" | "currency" | "checkbox" | "table" | "file" | "unknown";
  required: boolean;
  sourceSpan: string | null;
  sourceAttachment: string | null;
  mappedCompanyField: string | null;
  fillStrategy: "copy" | "summarize" | "generate" | "ask_user" | "manual";
  confidence: number;
}
```

추출 우선순위:

- 표 내부의 `항목/내용`, `구분/작성내용`, `세부내용` 패턴
- 번호 문항
- 빈칸, 괄호, 체크박스
- `사업계획`, `추진계획`, `예산`, `성과`, `실적` 등 서술형 섹션

### Phase 4. 자동채움

추출된 필드를 회사 데이터와 draft generator에 매핑한다.

필드 채움 전략:

- `copy`: 기업명, 대표자, 사업자등록번호, 소재지, 업종 등 정형값 복사
- `summarize`: 인증/IP, 실적, 제품 설명을 지정 길이로 요약
- `generate`: 지원동기, 추진계획, 기대효과 등 서술형 초안 생성
- `ask_user`: 현재 데이터로 채울 수 없는 항목을 질문으로 변환
- `manual`: 서명, 직인, 첨부파일, 기관별 특수 항목

자동채움 결과는 원본 파일을 바로 수정하지 않고, 먼저 `filled_fields`와 markdown preview로 저장한다.

### Phase 5. Export

초기 export:

- markdown
- 인쇄용 HTML

후속 export:

- PDF
- DOCX
- HWPX XML 기반 재생성 가능성 검토
- 원본 HWP 직접 쓰기는 별도 spike로 분리

## DB 변경안

### `grant_document_fields`

공고/첨부 단위로 추출한 문항과 필드를 저장한다.

- `id uuid primary key`
- `grant_id uuid references grants(id)`
- `source grant_source`
- `source_id text`
- `document_category text`
- `document_name text`
- `source_attachment text`
- `field_key text`
- `label text`
- `section text`
- `field_type text`
- `required boolean`
- `source_span text`
- `mapped_company_field text`
- `fill_strategy text`
- `confidence real`
- `parser_version text`
- `created_at timestamptz`
- `updated_at timestamptz`

인덱스:

- `(grant_id)`
- `(source, source_id)`
- `(source, source_id, source_attachment)`
- `(document_category)`

### `grant_document_drafts`

회사/공고/문서 단위 초안과 자동채움 결과를 저장한다.

- `id uuid primary key`
- `grant_id uuid references grants(id)`
- `company_id uuid references companies(id)`
- `user_id uuid references users(id)`
- `document_category text`
- `document_name text`
- `source_attachment text`
- `draft_markdown text`
- `filled_fields jsonb`
- `missing_fields jsonb`
- `used_profile_fields jsonb`
- `assumptions jsonb`
- `warnings jsonb`
- `status text`
- `model_ver text`
- `prompt_ver text`
- `parser_version text`
- `created_at timestamptz`
- `updated_at timestamptz`

상태:

- `draft`
- `needs_input`
- `reviewed`
- `exported`
- `archived`

인덱스:

- `(grant_id, company_id)`
- `(company_id, status)`
- `(user_id, updated_at)`

### `grant_document_draft_events`

초안 생성, 수정, 재생성, export 이벤트를 감사 로그로 저장한다.

- `id uuid primary key`
- `draft_id uuid references grant_document_drafts(id)`
- `actor_user_id uuid references users(id)`
- `event text`
- `payload jsonb`
- `created_at timestamptz`

## 계약/API 변경안

### Contracts

추가 DTO:

- `DocumentPreparationPlan`
- `DocumentDraft`
- `DocumentField`
- `DocumentAutofillResult`
- `MissingFieldQuestion`
- `DraftGenerationRequest`
- `DraftGenerationResult`

`ApplySheet.applicationPrep` 확장:

- `documentGroups`
- `draftableDocuments`
- `issuableDocuments`
- `attachableDocuments`
- `missingProfileFields`
- `draftCoverage`

### Server APIs

- `GET /api/grants/:grantId/preparation`
  - 체크리스트, 서류 그룹, 초안 가능 여부, 부족한 회사 정보 반환
- `POST /api/grants/:grantId/document-fields/extract`
  - 관리자/배치용. 첨부 markdown에서 필드 추출
- `POST /api/grants/:grantId/drafts`
  - 특정 문서 초안 생성
- `GET /api/document-drafts/:draftId`
  - 초안 조회
- `PATCH /api/document-drafts/:draftId`
  - 사용자 수정 저장, 상태 변경
- `POST /api/document-drafts/:draftId/regenerate`
  - 선택 영역 재생성
- `POST /api/document-drafts/:draftId/export`
  - markdown/인쇄용 HTML export

권한:

- `company_id` 기반 접근 제어를 적용한다.
- draft 생성/수정은 company owner/admin/member만 허용한다.
- viewer는 조회만 허용하거나 초기 MVP에서는 차단한다.

## Core 모듈 설계

### `packages/core/src/documents/field-extraction.ts`

역할:

- markdown/filename/source span에서 문항 후보 추출
- 문항 type 분류
- source span과 confidence 부여

검증:

- 표 기반 신청서
- 번호 문항 기반 사업계획서
- 첨부 파일명만 있는 경우 fallback
- 제출서류가 아닌 지원내용 섹션 false positive 방지

### `packages/core/src/documents/draft-context.ts`

역할:

- grant, company, criteria, required documents, source attachment markdown을 draft context로 정리
- 민감정보/불필요한 원문을 제거
- token budget에 맞춰 evidence chunk를 선택

### `packages/core/src/documents/autofill.ts`

역할:

- `GrantDocumentField`와 company profile 매핑
- `fill_strategy` 결정
- missing field question 생성

### `packages/core/src/documents/draft-generation.ts`

역할:

- 문서 category별 prompt template 선택
- LLM output schema 검증
- 초안 markdown, filled fields, missing fields, warnings 반환

문서별 template:

- 신청서: 정형 필드 중심
- 사업계획서: 문제, 솔루션, 시장, 추진계획, 예산, 성과
- 제안서/소개서: 회사/제품/차별성/협력 포인트
- 예산/산출내역: 항목별 산출근거
- 실적 설명: 매출/수출/납품/인증 근거

## UI 구현안

### 공고 상세 `지원 준비` 탭

구성:

- 상단 summary
  - AI 초안 가능 문서 수
  - 발급 필요 문서 수
  - 첨부 필요 문서 수
  - 사용자 입력 필요 항목 수
- 서류 그룹
  - AI 작성 가능
  - 발급 필요
  - 첨부 필요
  - 원문 확인
- 각 문서 row
  - 문서명
  - canonical name/category
  - 준비 방식
  - 연결 첨부
  - 상태
  - action button

### 초안 작성 화면

레이아웃:

- 좌측: 문서/문항 navigation
- 중앙: draft editor
- 우측: evidence/missing fields panel

기능:

- 전체 초안 생성
- 섹션별 재생성
- 회사 프로필 값 삽입
- missing field 질문에 답변
- 사용자 수정 저장
- export

### UX 원칙

- AI 결과는 `초안`으로만 표시한다.
- 지원 제출 전 사용자 확인이 필요하다는 상태를 명확히 둔다.
- 발급/첨부형 서류는 AI 작성 버튼을 노출하지 않는다.
- `source_span`과 `source_attachment`를 볼 수 있게 해 신뢰 근거를 제공한다.

## AI 안전장치

- LLM은 없는 사실을 만들어내지 않고 `missing_fields`로 돌려야 한다.
- 회사 프로필에 없는 숫자, 인증, 실적은 생성 금지한다.
- 증빙/발급 문서는 작성하지 않고 준비 안내만 생성한다.
- 서명/동의/서약은 사용자의 명시적 확인 전 완료 처리하지 않는다.
- draft마다 `used_profile_fields`, `assumptions`, `warnings`를 저장한다.
- 초안 본문에는 제출 전 검토가 필요한 항목을 마커로 남긴다.

## 배치/운영 흐름

1. 아카이브/정규화 배치가 `required_documents`와 attachment markdown을 갱신한다.
2. `extract:grant-document-fields` 배치가 열린 공고 중 작성형 문서가 있는 공고를 처리한다.
3. 사용자가 공고 상세에 진입하면 preparation API가 체크리스트를 구성한다.
4. 사용자가 초안 생성을 누르면 draft API가 최신 company profile과 field mapping을 사용한다.
5. 초안/수정/export 이벤트를 저장해 품질 개선과 funnel 분석에 쓴다.

새 CLI:

```bash
pnpm extract:grant-document-fields -- --status=open --limit=100
pnpm extract:grant-document-fields -- --status=open --limit=100 --write
pnpm verify:grant-document-fields
pnpm verify:grant-document-drafts
```

## 검증 게이트

```bash
pnpm typecheck
pnpm verify:openapi
pnpm verify:grant-document-taxonomy
pnpm verify:grant-document-fields
pnpm verify:grant-document-drafts
pnpm verify:service-usecases
pnpm verify:web-http
```

테스트 케이스:

- 사업계획서가 있는 공고에서 draftable document가 생성된다.
- 사업자등록증/법인등기부등본은 발급/첨부 안내로만 분류된다.
- 첨부 markdown의 지원내용 문구가 제출문서 필드로 오인되지 않는다.
- 회사 프로필에 없는 매출/인증/실적은 `missing_fields`로 반환된다.
- 사용자 권한이 없는 company draft는 조회/수정할 수 없다.
- draft 생성 후 같은 입력으로 재생성하면 deterministic metadata가 유지된다.

## 출시 순서

1. DB migration과 contracts 추가
2. field extraction core + verifier
3. preparation API 확장
4. 지원 준비 탭 UI
5. draft context/autofill core
6. 초안 생성 API
7. 초안 editor UI
8. draft 저장/재생성/export
9. 운영 지표/품질 로그
10. DOCX/PDF export 고도화

## 구현 메모

### 2026-06-29 현재 반영

- 공고 상세 `/grants/[grantId]`의 `지원서 준비` surface에 `DocumentDraftWorkspace`를 연결했다.
- 공고 상세 `지원서 준비` surface에 `write / issue / attach / other` 준비 방식 그룹을 전면 노출해 사용자가 작성할 문서, 발급할 증빙, 첨부할 파일, 원문 확인 항목을 먼저 구분할 수 있게 했다.
- 저장된 `grant_document_drafts`를 공고 상세 서버 컴포넌트에서 preload해 새로고침 후에도 기존 초안이 편집기에 복원된다.
- 같은 회사/공고/문서의 `초안 만들기/다시 생성`은 새 row를 계속 만들지 않고 최신 초안을 갱신하며 `regenerated` 이벤트를 남긴다.
- 화면은 변경된 `DESIGN.md` 기준으로 shadcn `Card`, `Button`, `Textarea`, `Empty`, semantic token만 사용한다. 신규 arbitrary hex/off-scale radius는 추가하지 않았다.
- 저장 DB UUID가 아닌 샘플 공고는 기존처럼 초안 저장을 차단하고, 패키지 Markdown export는 초안 없이 공고/서류 패키지를 생성한다.
- 문서별 `missingProfileFields`를 공고 상세 UI에서 추가 입력 질문으로 보여주고, 사용자가 입력한 답변을 기존 `DraftGenerationRequest.answers`로 보내 초안 본문과 누락 필드 계산에 반영한다.
- `extract:grant-document-fields`와 `verify:grant-document-fields`를 추가해 `grant_document_fields` 테이블을 채울 수 있는 deterministic 문항/필드 추출 경로를 연결했다.
- 공고 상세 초안 editor에 shadcn `Table` 기반 `자동채움 리뷰` 패널을 추가해 자동 반영된 필드, 사용자 추가 입력, 아직 입력이 필요한 필드를 문항 단위로 확인할 수 있게 했다.
- 새 UI는 변경된 `design-tokens.json`/`DESIGN.md`의 Work zone 기준에 맞춰 semantic token과 16px panel radius만 사용하고, 추가 texture/임의 hex를 넣지 않았다.
- `GET /api/web/document-drafts/[draftId]/download?format=html`을 추가해 저장된 초안을 인쇄/PDF 저장에 적합한 standalone HTML attachment로 내려받을 수 있게 했다. Markdown 본문은 escape 처리한 뒤 heading/list/table 중심으로 렌더한다.
- 초안 editor의 `자동채움 리뷰`를 `문항별 자동채움 편집`으로 확장해 사용자가 필드 값을 직접 수정하고 `grant_document_drafts.filled_fields`에 저장할 수 있게 했다.
- draft PATCH는 `filledFields`를 함께 받아 빈 값을 정리하고, 사용자가 채운 문항은 `missing_fields`에서 제거한다. Markdown/인쇄용 HTML/신청 패키지 export에도 저장된 자동채움 값 표를 포함한다.
- 새 편집 UI는 변경된 `DESIGN.md` 기준으로 shadcn `Field`, `Textarea`, `StatusBadge`, semantic token과 16/14px radius만 사용한다.
- `GET /api/web/grants/[grantId]/preparation`을 추가해 공고 상세 UI가 쓰는 `applicationPrep`, 저장 초안, 문항 필드 매핑, export URL을 동일한 projection으로 내려준다.
- 공고 상세 page도 같은 preparation loader를 사용해 UI/API의 준비 상태 drift를 줄였다.
- 인쇄용 HTML/DOCX export의 색/폰트/radius 값을 `design-tokens.json`에서 읽도록 정리했다. Word XML처럼 alpha 색을 직접 지원하지 않는 곳은 흰 배경 기준의 불투명 색으로 변환한다.
- `POST /api/web/document-drafts/[draftId]/feedback`을 추가해 초안별 사실 오류, 맥락 부족, 양식 불일치, 일반적 내용, 기타 피드백을 `grant_document_draft_events.event = quality_feedback`으로 저장한다.
- 공고 상세 초안 editor에 `초안 품질 피드백` 패널을 추가했다. 변경된 `DESIGN.md` 기준으로 shadcn `Select`, `Textarea`, `Button`, semantic token과 16/14px radius만 사용한다.
- 품질 피드백 payload에는 draft/model/prompt/parser version과 문서 category를 함께 남겨 hallucination report/manual correction count와 템플릿 개선 분석에 연결할 수 있게 했다.
- 초안 조회/수정/다운로드/피드백 API 모두 잘못된 draft id를 DB 쿼리 전에 `invalid_draft_id` 400으로 정규화한다. HTTP smoke에도 네 경로의 invalid boundary를 추가했다.
- `grant_document_drafts`와 `grant_document_draft_events(event=quality_feedback)`를 admin flywheel surface에 연결했다. 운영 콘솔에서 초안 저장 수, 품질 피드백 수, 최근 초안별 입력 필요/자동채움 수, 피드백 유형을 바로 볼 수 있다.
- `apps/web/src/lib/server/documents/grantDocumentDraftMetrics.ts`에 운영 지표 projection과 순수 summary builder를 추가했고, `pnpm verify:grant-document-draft-metrics`를 통합 `pnpm test`에 포함했다.
- `POST /api/web/document-drafts/[draftId]/regenerate`를 추가해 저장된 초안의 특정 `##` 섹션만 다시 생성할 수 있게 했다. 현재 draft markdown과 자동채움 편집값을 payload로 받아 다른 섹션의 사용자 편집을 보존하고, `grant_document_draft_events.event = section_regenerated`로 남긴다.
- 공고 상세 초안 editor에 `섹션별 다시 생성` 패널을 추가했다. 변경된 `DESIGN.md` 기준으로 shadcn `Select`, `Button`, semantic token, 16/14px radius만 사용하고 신규 off-palette 색상은 추가하지 않았다.
- `GET /api/web/document-drafts/[draftId]/download?format=pdf`를 추가해 저장된 초안을 PDF attachment로 내려받을 수 있게 했다. HTML/DOCX export와 같은 draft data를 사용하고, PDF 색상은 `design-tokens.json`의 semantic token에서만 읽는다.
- 초안 editor의 전면 액션은 MVP 필수인 `저장`, `검토 완료`, `Markdown`, `인쇄용 HTML`로 좁혔다. DOCX/PDF endpoint는 검증 가능한 후속 export 경로로 남기되, 핵심 지원 준비 UI에서는 원본 양식 자동채움처럼 오해되지 않게 노출하지 않는다.
- 초안 다운로드 API가 markdown/html/docx/pdf export 성공 경로에서 `grant_document_drafts.status = exported`와 `grant_document_draft_events.event = exported`를 기록하게 했다. export 이벤트에는 format, 이전 상태, 문서 category/key, 자동채움/누락 필드 수, model/prompt/parser version을 함께 남겨 운영 지표의 `draft exported` funnel과 품질 분석에 연결한다.

## 운영 지표

- preparation tab view count
- document checklist completion rate
- draft generation count
- draft accepted/revised/exported count
- missing field question count
- hallucination report/manual correction count
- document category별 draft success rate
- source attachment markdown 기반 draft 비율

## 리스크와 대응

- 첨부 markdown 품질 편차
  - 대응: source span 기반 evidence 표시, confidence 낮은 필드는 사용자 확인으로 넘긴다.
- AI가 없는 실적을 생성할 위험
  - 대응: 숫자/인증/실적은 company profile 또는 사용자 입력이 없으면 생성 금지한다.
- HWP 원본 자동채움 난이도
  - 대응: MVP는 웹/markdown/인쇄용 HTML export로 제한하고 DOCX/PDF는 provider 확정 이후 붙인다.
- 개인정보/민감정보 과다 전송
  - 대응: draft context builder에서 문서 유형별 필요한 필드만 선택한다.
- 사용자에게 자동 제출처럼 보일 위험
  - 대응: copy와 상태명을 `초안`, `검토 필요`, `준비 완료`로 제한한다.

## MVP 정의

MVP 완료 조건:

- 열린 공고 중 작성형 문서가 있는 공고에서 `지원 준비` 탭이 보인다.
- 서류가 AI 작성 가능/발급 필요/첨부 필요/원문 확인으로 나뉜다.
- 신청서/사업계획서/제안서 유형 초안을 생성하고 저장할 수 있다.
- 회사 프로필에서 채운 값과 사용자 입력 필요 값을 구분해 보여준다.
- 사용자가 초안을 수정하고 상태를 `reviewed`로 바꿀 수 있다.
- 최소 markdown export와 인쇄용 HTML export를 제공한다.

MVP 이후:

- PDF export
- HWPX 재생성 spike
