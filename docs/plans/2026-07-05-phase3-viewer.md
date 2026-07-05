# Phase 3 — 사용자용 문서 Preview Viewer (v1)

> 마스터 설계 19장 Phase 3 · 기능 9.3(Preview Viewer)/9.4(Field Inspector) · §8.4 좌표계 규칙 준수.
> 관문 아님 — 외부 대조 의무 없음. P4(Vision/Text Reconciliation)와 병행 설계: **P3는 preview/좌표계/선택/inspector 골격**, 필드 공급은 P4 몫.

## 목적

내부 리뷰어 워크스페이스(`/internal/review/[docId]`)에서 검증된 페이지 이미지 + bbox 오버레이 + 클릭 선택 패턴을 **사용자용**으로 일반화한다. 사용자가 지원사업 문서(HWP→변환 산출물)를 페이지 이미지로 보고, 필드 위치를 오버레이로 확인하고, 필드를 클릭해 상세(inspector)를 보는 골격을 만든다.

## 현황 (2026-07-05 조사 결과)

- `grant_application_surfaces`(grantId FK)·`document_artifacts`(kind=page_image, metadata `{width,height,dpi}`)·`grant_document_fields`(position jsonb `{page, bbox(0~1)}`) 스키마는 Phase 1~2에서 완비. **단 프로덕션 DB에 세 테이블 모두 0건** (conversion E2E가 A7 대기 중이라 ingestion 미가동).
- 리뷰어 뷰어의 좌표계는 0~1 정규화 `[x,y,w,h]`(top-left), CSS `%` 포지셔닝, 줌은 컨테이너 width 배율 — §8.4와 일치. 이 로직은 전부 `ReviewDetailView.tsx` 인라인이라 재사용하려면 신규 유틸로 추출해야 함.
- 이미지 서빙은 R2 스트리밍 프록시(`/internal/review/api/page-image/[...key]`) + admin 게이트 + key 소유 검증. 사용자용은 별도 프록시가 필요.
- `loadGrantPreparation`의 `formFields`는 position/visualEvidence를 SELECT하지 않음 — 사용자에게 bbox가 내려간 적 없음.
- **병렬 세션 주의**: `apps/web/src/features/*`, `apps/web/src/components/*`, 일부 `app/*/page.tsx`가 워킹트리에서 수정 중. **이 파일들은 수정 금지.** `apps/web/src/lib/**`, `apps/web/src/app/api/**`, `packages/core/**`는 clean.

## 설계 결정

1. **라우트**: `/grants/[grantId]/preview` 신규 (서버 컴포넌트). 인증은 기존 `/grants/[grantId]/page.tsx`와 동일하게 `requireCompanyAccess()` + 실패 시 `redirectOnAuthRequired()`. 쿼리 `?surface=<surfaceId>`로 문서 선택, 미지정 시 page_image가 있는 첫 surface.
2. **이미지 프록시**: `apps/web/src/app/api/web/grants/[grantId]/page-image/[...key]/route.ts` 신규. `requireCompanyAccess()` + **DB 소유 검증**(storageKey가 해당 grant의 surface에 속한 document_artifacts 행에 존재) + `grant-convert/` 프리픽스 검증. `r2ObjectStorage`로 스트리밍, `Cache-Control: private, max-age=3600`. (리뷰어 프록시 패턴 차용 — 코드 복사 아닌 신규 작성)
3. **서버 로더**: `apps/web/src/lib/server/documents/documentPreview.ts` 신규. grantId → surfaces + page_image artifacts(page 순, metadata의 width/height/dpi 포함) + fields(`grant_document_fields`에서 position 포함 직접 SELECT — 기존 `grantDocumentFields.ts`는 건드리지 않음. surfaceId 일치 우선, fallback grantId 전체). DTO: `GrantDocumentPreview { grant, surfaces[], pages[], fields[] }`.
4. **좌표계 공용 유틸**: `apps/web/src/lib/documents/bbox.ts` 신규 (클라이언트 안전 순수 함수). `NormalizedBox {x,y,width,height}`(0~1, top-left — §8.4), `clamp01`, `parsePositionBbox(position)`(배열 `[x,y,w,h]`·객체 형태 모두 수용, 범위 밖이면 null), CSS % 변환 헬퍼. 리뷰어 라벨(`bbox: [x,y,w,h]`)과 `VisionFieldCandidate`(`{x,y,width,height}`) 양쪽에서 수렴 가능한 단일 타입.
5. **클라이언트 뷰**: `apps/web/src/features/document-viewer/` 신규 디렉터리.
   - `DocumentPreviewView.tsx`: 페이지 내비게이션, 줌(0.5~3, 0.25 단위, 컨테이너 width 배율), bbox 오버레이(% 포지셔닝, 선택 시 `border-primary` 강조), 오버레이 클릭 ↔ 필드 리스트 선택 양방향 동기화(scrollIntoView), 상태 필터 없음(v1).
   - `FieldInspectorPanel.tsx`: 선택 필드의 label·section·documentName·fieldType·required·fillStrategy·confidence·sourceSpan(원문)·복사 버튼. position 없는 필드는 리스트 전용 + "위치 미확인" 뱃지 (P4 전까지 대부분이 이 상태 — 정상).
   - shadcn/ui는 `@/components/ui/*` 기존 컴포넌트만 import (병렬 세션이 만드는 신규 ui 파일 의존 금지).
6. **진입 링크 없음(v1)**: `ApplySheetView.tsx` 등 dirty 파일에 링크를 못 넣으므로 직접 URL로만 접근. 병렬 세션 머지 후 소과제로 링크 추가.
7. **시드 스크립트**: `apps/web/src/lib/server/db/seed-preview-demo.ts` + `pnpm seed:preview-demo` (기본 dry-run, `--write`/`--cleanup`). DB가 0건이므로 뷰어 검증용 데이터를 만든다:
   - dev 전용 grant 행 신설(제목 `[DEV-SEED] Phase 3 뷰어 검증`) → surface 1건 → `field_map_review_docs.pageImageKeys`에서 실존 페이지 이미지 3장을 골라 R2 CopyObject로 `grant-convert/dev-seed/<sha16>-p00N.png`에 복사 → `document_artifacts` 3행(kind=page_image, metadata `{width,height,dpi:220}` — width/height는 PNG IHDR 8바이트 파싱) → `grant_document_fields` 6행(4건은 해당 review doc의 실제 라벨 bbox를 position으로, 2건은 position null).
   - `--cleanup`: grant 행 삭제(cascade로 surface/artifacts/fields 정리) + R2 `grant-convert/dev-seed/` 오브젝트 삭제. **검증 행 삭제 관례 준수.**
8. **검증**: ① `apps/web` typecheck·`next build` 통과 ② 시드 `--write` 후 dev 서버(mock auth 가능 여부 확인 — `CUNOTE_AUTH_MODE=mock`)로 `/grants/<id>/preview` 200 + 프록시 200(PNG) + **타 grantId로 같은 key 접근 시 차단** 확인 ③ 시드 상태 유지한 채 보고(시각 확인은 메인 세션 몫) → 메인 검수 후 `--cleanup`.

## v1에서 하지 않는 것

- PDF.js/벡터 렌더 (페이지 이미지로 충분 — Gate 0 확정 렌더러 체인의 산출물 사용)
- 필드 값 수정·저장·검토완료 (9.4 후반부 — P5 Draft 연동 시)
- 자동채움 값·근거·해설 표시 (P5), 질문하기/이의 제기 (18장 지식 루프)
- annotated export (P6), 웹폼 가이드 (P7)
- ApplySheetView 진입 링크 (병렬 세션 머지 후)
- 실 conversion 파이프라인 E2E (A7 대기 — 완료 시 실 artifact로 재검증)

## 위임 스펙 (Opus 서브에이전트)

- **수정 금지**: `git status --short`의 M/?? 파일 전부 (병렬 세션 작업물). 구현은 100% 신규 파일 + `apps/web/package.json` scripts 1줄 추가만 예외 (충돌 시 보고).
- **신규 파일**: 설계 결정 1~5, 7의 경로 그대로.
- **참조(읽기 전용)**: `ReviewDetailView.tsx`(좌표·오버레이·줌 패턴), `internal/review/api/page-image/[...key]/route.ts`(프록시 패턴), `grantPreparation.ts`·`preparation/route.ts`(인증·로더 패턴), `r2ObjectStorage.ts`, `load-golden-field-maps.ts`(시드 스크립트 관례 — dry-run 기본).
- **검증 증거**: typecheck·build 로그, 시드 dry-run/write 출력, 스모크 HTTP 상태코드(정상 200·교차 grant 차단·비인증 리다이렉트), 커밋은 하지 말 것(메인 세션이 경로 명시 스테이징으로 커밋).

## 진행 로그

- 2026-07-05: plan 작성 (세션 6). 구현 위임 → 검증 → 커밋 예정.
