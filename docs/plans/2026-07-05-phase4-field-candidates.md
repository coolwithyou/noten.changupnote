# Phase 4 [F] — 필드 후보 스키마·저장 계층·Reconciliation 골격 (엔진 비종속부)

> 마스터 설계 19장 Phase 4 · §8.4~8.6 · 11장. **관문 아님** — 외부 대조 의무 없음 (Gate 2 측정·엔진 선정과 맞물리는 임계값 캘리브레이션은 범위 밖).
> 전제: Gate 2 측정([D])이 golden 검수를 기다리는 동안, **엔진 선택과 무관하게 확정 가능한 부분**만 먼저 깐다: 후보 타입 정본화, 후보 저장 계층, text parser 후보화, reconciliation 순수 골격, grant_document_fields 반영 경로. 이것이 완성되면 Gate 2에서 엔진이 선정되는 즉시 어댑터 출력→저장→reconcile→P3 뷰어 공급이 이어진다.

## 현황 (2026-07-05)

- Gate 2 인프라의 `NormalizedFieldCandidate`(`apps/web/src/lib/server/layout-eval/types.ts`)가 이미 §8.4 정합(0~1 bbox, kind 어휘, layout/text_parser layer, rotationDeg). 단 위치가 eval 전용 디렉터리라 프로덕션 정본이 아님.
- `grant_document_fields`에 position/visual_evidence/text_evidence/review_required 컬럼 존재(Phase 1 완비) — **마이그레이션 불필요**.
- `document_artifacts.kind`는 text 컬럼(DB enum 아님) — 후보 JSON용 kind 추가는 스키마 주석 갱신만.
- `extractGrantDocumentFields()`(packages/core)는 최종 결과 생성기 역할 — §8.5대로 "후보 evidence 생성기"로 역할 조정 필요(원함수 유지, 래퍼 방식).
- 웹앱 R2 `putObject` 있음(`r2ObjectStorage.ts`). 테스트 관례: `normalize.test.ts`(node:assert 픽스처, tsx 실행). verify 스크립트 선례: `verify-grant-document-draft-persistence.ts`.
- P3 뷰어(세션 6)는 grant_document_fields의 position을 읽어 오버레이함 — 본 트랙의 F5가 뷰어 필드 공급의 마지막 조각.
- **병렬 세션 dirty 파일 불가침 지속** (`git status` M/?? — features/components/app 페이지 다수).

## 설계 결정

- **F1. 후보 타입 정본화**: `packages/core/src/documents/field-candidates.ts` 신설 — `BBox`/`CandidateKind`/`CandidateLayer`/`NormalizedFieldCandidate`(+ `CandidateSet { engine, engineVersion, layer, extractedAt, candidates[] }`)를 canonical로. `layout-eval/types.ts`는 자체 정의를 제거하고 core에서 re-export (단일 원천 이동, 기존 import 경로 무파괴).
- **F2. Text parser 후보화 (§8.5)**: `packages/core/src/documents/field-candidate-text-parser.ts` — `extractGrantDocumentFields` 출력을 `NormalizedFieldCandidate[]`(layer=text_parser, bbox null, raw에 원 필드, textEvidence용 sourceSpan 보존)로 변환하는 순수 래퍼. 원함수 무변경.
- **F3. 후보 저장 계층**: `apps/web/src/lib/server/documents/fieldCandidateStore.ts` — `saveFieldCandidates({surfaceId, set})`: R2 `grant-convert/<source>/<sourceId>/field_candidates/<sha16>-<engine>.json` + `document_artifacts` 행(kind=`field_candidates`, metadata `{engine, engineVersion, layer, candidateCount}`), (surfaceId, kind, engine) 기준 앱측 멱등 upsert. `loadFieldCandidates(surfaceId)` → CandidateSet[]. schema.ts의 kind 주석에 `field_candidates` 추가.
- **F4. Reconciliation 골격 (§8.6)**: `packages/core/src/documents/field-reconciliation.ts` — 순수 함수 `reconcileFieldCandidates(sets, opts)` → `ReconciledField[]`(grant_document_fields 형상: fieldKey/label/fieldType/required/fillStrategy/confidence/position/visualEvidence/textEvidence/reviewRequired). 규칙: ① text+layout 동일 항목(라벨 정규화 매칭 + 같은 page) → high ② layout만 → medium ③ text만(위치 없음) → medium ④ 서명/직인/동의 kind → fillStrategy `manual` 강제 ⑤ layout 후보 간 중복은 bbox IoU로 병합 ⑥ 저신뢰 → reviewRequired. **임계값(IoU·라벨 유사도·신뢰도 컷)은 `RECONCILE_THRESHOLDS` 상수로 분리하고 "잠정 — Gate 2 측정 후 캘리브레이션" 주석 명기.** 픽스처 테스트 `field-reconciliation.test.ts`(node:assert, normalize.test.ts 관례) — 규칙 ①~⑥ 각 1케이스 이상.
- **F5. 반영 경로**: `apps/web/src/lib/server/documents/applyReconciledFields.ts` — reconciled → `grant_document_fields` upsert(surfaceId+fieldKey 기준, parserVersion=`reconcile-v0`), surface `extraction_status` → `fields_ready` 전이. 기존 legacy 조회(`grantDocumentFields.ts`)는 무변경(마스터 11장 백필 전략 3 — legacy 읽기 유지).
- **검증 스크립트**: `apps/web/src/lib/server/documents/verify-field-candidate-pipeline.ts` — 실DB·실R2 왕복: dev grant/surface 생성(`[DEV-SEED]` 관례) → 합성 layout 후보 + text parser 실후보(고정 마크다운 입력) save → load → reconcile → apply → **P3 뷰어 로더(`loadGrantDocumentPreview`)가 position 있는 필드를 반환하는지 assert** → 전량 cleanup. 기본 dry-run 아님(검증 스크립트 선례를 따라 실행형, 종료 시 자체 정리).

## 범위 밖 (Gate 2 측정·엔진 선정 이후)

- Vision LLM pass(§8.4 의미 해석), 엔진별 어댑터의 프로덕션 배선, 임계값 캘리브레이션, ingestion 스케줄러(pollConversions) 연동, confidence 합성(마스터 13장 — Gate 3 전), legacy 필드 경로 제거.

## 위임 스펙 (Opus)

- **수정 금지**: `git status` M/?? 파일 전부. 수정 허용(clean): `layout-eval/types.ts`(re-export 전환), `schema.ts`(kind 주석 1줄), 신규 파일 전부. `extractGrantDocumentFields`·`grantDocumentFields.ts`·기존 마이그레이션 무변경.
- **검증 증거**: ① core·web typecheck ② `field-reconciliation.test.ts` 전 케이스 통과 ③ 기존 `normalize.test.ts` 회귀 통과(re-export 무파괴 확인) ④ verify 스크립트 실DB·실R2 왕복 통과 + cleanup 0건 확인 ⑤ `next build` 통과. 커밋 금지(메인이 경로 명시 스테이징).

## 진행 로그

- 2026-07-05: plan 작성 (세션 7). 상태 재점검: B2 미완·approved 0·A7 미확인 → [F] 분기 확정.
