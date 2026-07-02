# 리뷰어 워크스페이스 v1 — 필드맵 검수 (마스터 9.8의 첫 슬라이스)

> 결정 (2026-07-03, 사용자 확정): 상시 운영 페이지로 구축. v1 범위는 필드맵 검수 전용.
> 위치는 apps/web `/internal/review`, dev(dev.changupnote.com) 먼저 공개.
> 9.8의 인박스·Q&A·lesson은 후속 슬라이스 — 이 v1의 모델·라우트 구조는 그 확장을 막지 않아야 한다.

## 목적

- 비개발자 리뷰어가 브라우저만으로 Gate 1 필드맵 라벨 45문서(향후 계속 증가)를 검수·확정한다
- 검수 확정이 곧 golden 승격이다 (별도 적재 단계 없음 — "답변하는 행위 자체가 지식 생성" 원칙의 검수판)
- 파일 기반(spike-labels/)은 **임포트 소스**로 강등되고, 정본은 DB가 된다

## 데이터 모델 (schema.ts 추가)

```
field_map_review_docs
  id            uuid PK
  docRef        text UNIQUE          -- 라벨 JSON의 docRef 그대로
  docId         text                 -- "doc01" 같은 짧은 식별자 (파일명 유래)
  sourceFilename text
  pageCount     integer
  labelJson     jsonb                -- 라벨 JSON 전체 (fields 포함). 편집 대상
  labeledBy     text                 -- 원 라벨러 (opus-prelabel 등)
  labeledAt     text
  reviewStatus  enum('pending','in_review','approved')
  reviewedBy    text                 -- 검수자 이메일 (세션에서)
  reviewedAt    timestamptz
  correctionNotes text               -- REVIEW-QUEUE 유래 문서별 소급 교정·주의 항목
  pageImageKeys jsonb                -- R2 키 배열 (페이지 순)
  createdAt/updatedAt timestamptz
```

- 필드 단위 정규화는 하지 않는다. 편집은 labelJson.fields 통째 저장 (Gate 2는 golden_set만 읽으므로 이중 소비자 없음)
- enum·테이블 추가는 `db:generate` → `db:migrate` 절차 준수 (CLAUDE.md)

## 임포트 스크립트

`apps/web/src/lib/server/db/import-review-docs.ts` (load-golden-field-maps.ts 관례: 기본 dry-run, `--write`)

- `spike-labels/doc*.json` → field_map_review_docs upsert (docRef 기준, 이미 approved인 행은 건드리지 않음)
- `spike-labels/pages/docNN-*.png` → R2 업로드 (키 `label-review/pages/docNN-PP.png`, 존재하면 스킵) → pageImageKeys 기록
- REVIEW-QUEUE.md의 문서별 교정 항목(소급 교정 4건 + 배치3·4 추가 교정)을 correctionNotes로 주입 (하드코딩 맵 허용 — 1회성 시드)

## 라우트·화면 (/internal/review)

접근 게이트 (v1): next-auth 세션 이메일이 `admin_users`(status=active)에 존재해야 함.
서버 컴포넌트/route handler 양쪽 모두에서 검사 (이미지 프록시 포함). 미인가 시 404.

1. **목록** `/internal/review`
   - 문서 목록: docId, 파일명, 필드 수, reviewStatus, 검수자, correctionNotes 유무 뱃지
   - 진행률 요약 (approved n/45), 필터(상태별)
2. **검수 상세** `/internal/review/[docId]`
   - 좌: 페이지 이미지 뷰어 (페이지 이동, 확대/축소, 선택 필드 bbox 오버레이 강조 + 해당 페이지 전체 필드 bbox 옅게 표시)
   - 우: 필드 목록 (page·section 그룹). 필드 클릭 ↔ 오버레이 하이라이트 상호 연동
   - 필드 편집: key/label/type/required/applicantFills/manual/notes 인라인 수정, 필드 추가·삭제
   - bbox 수정: 이미지 위 드래그로 다시 그리기 (normalized 좌표 저장). 구현 부담 크면 v1.1로 미뤄도 됨 — 검수 우선순위상 bbox는 셋째 (누락 필드 > 오분류 > bbox)
   - correctionNotes와 기준서 링크를 상단 고정 표시
   - 저장(초안) 버튼 → labelJson 갱신, reviewStatus='in_review'
3. **검수 확정** (상세 화면의 확정 버튼)
   - 확인 다이얼로그 → reviewStatus='approved', reviewedBy=세션 이메일, labelJson.labeledBy도 검수자 이메일로 갱신 (파일 파이프라인 규약과 일치)
   - **동시에 golden_set upsert**: kind='field_map', ref=docRef, gold=labelJson, goldenVer='field_map_v0', curatedBy는 이메일→users 조회(없으면 null)
   - 순환성 가드 재사용: load-golden-field-maps.ts의 AI 라벨러 거부 + 이메일 요구 로직을 공용 모듈로 추출해 양쪽에서 사용
   - 확정 취소(승격 롤백 포함)도 지원 — 오확정 복구 경로 필요

이미지 서빙: `/internal/review/api/page-image/[...key]` — 게이트 검사 후 R2 GetObject 스트리밍 (public 버킷 불필요).

## v1에서 하지 않는 것

- 인박스·SLA·질문 회신·lesson (9.8 후속 슬라이스)
- 필드 단위 이력/감사 로그 (updatedAt으로 충분, 필요 시 후속)
- 웹폼 샘플 라벨링 화면 (라벨 생성 도구가 아니라 검수 도구 — 신규 라벨링은 별도)

## 검증

- 임포트 dry-run/실행 → 45행 + R2 343키 확인
- 게이트: 비로그인/비admin 404, admin 통과
- 확정 E2E: 테스트 문서 1건 필드 수정 → 확정 → golden_set에 row 생성 + labeledBy 이메일 확인 → 확정 취소 → golden row 제거
- 기존 파일 파이프라인 회귀: load-golden-field-maps.ts dry-run 여전히 동작 (공용 가드 추출 후)
