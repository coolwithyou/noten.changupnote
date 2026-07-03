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

## v1.1 (2026-07-03 사용자 피드백 반영)

리뷰팀 첫 사용 피드백 5건 대응:

1. **bbox 드래그 재작도**: 이미지 위에서 드래그로 선택 필드의 bbox를 다시 그린다 (normalized 저장).
   기존 "수동 좌표 입력" 문구 제거. **bbox 교정 로드맵**: 리뷰어는 "어느 칸인지 구분되는 수준"까지만
   교정 → Gate 2 layout 엔진이 정밀 좌표 추출 → 엔진 확정 후 골든 bbox를 최근접 layout 셀에
   자동 스냅하는 일괄 교정 + 스냅 전후 확인 UI (Gate 2 이후 작업으로 등재: 매칭 규칙 IoU/중심점 정의,
   스냅 스크립트, 확인 화면)
2. **인앱 튜토리얼**: `/internal/review/guide` 페이지 (review-team-guide.md 내용을 화면으로) +
   상세 화면 상단 접이식 "검수 방법 요약" + 목록 화면 첫 진입 안내 배너. 상세 화면의 기준서
   placeholder 링크를 guide 페이지 링크로 교체
3. **용어 한국어화**: 체크박스 라벨을 한국어+원어 병기로 — required→"필수 (required)",
   applicantFills→"지원자가 작성 (applicantFills)", manual→"자필·서명 필요 (manual)".
   각각 hover 툴팁으로 한 줄 설명 + 필드 편집 영역 상단에 범례 1줄
4. **편의성**: 이미지 오버레이 박스 클릭 → 해당 필드 선택·스크롤 (역방향 연동),
   저장 안 된 변경이 있을 때 이탈 경고(beforeunload), 목록에서 "다음 미검수 문서" 이동 버튼,
   필드 key/label 검색 입력
5. **피드백 채널 (9.8 인박스의 씨앗)**: 필드별 **[보류]** 토글 — notes 앞에 `판정 보류: ` 접두어를
   구조화한 UI (보류 사유 입력). 문서별 **리뷰어 코멘트** 컬럼(`reviewer_comment`, 0028 마이그레이션) —
   운영자에게 남기는 메모. 목록 화면에 보류 필드 수·코멘트 유무 뱃지. 보류가 있는 문서는
   확정 버튼에 경고 표시(확정은 가능하되 "보류 n건이 있습니다" 확인 다이얼로그)

## v2 — 질문 기반 검수 모드 (2026-07-03 리뷰팀 피드백 2차)

> 배경: 리뷰어들이 필드 편집 화면에서 "뭘 해야 할지 모르겠다"는 피드백 다수.
> 원칙 전환: 리뷰어는 라벨 데이터 편집자가 아니라 **질문에 답하는 전문가**다.
> 이 패턴은 마스터 18.6 Field Question 모델·9.9 사용자 Q&A의 원형이며,
> 이후 사용자 가이드 UX("단순하고 명확하게")에도 그대로 적용된다.
> 결정(사용자 확정): 질문은 **사전 배치 생성**(LLM, 검수 전 1회) · **질문 모드 기본 + 전문 모드 토글 유지**.

### 데이터 모델 (0029)

```
field_map_review_questions
  id           uuid PK
  reviewDocId  uuid FK → field_map_review_docs (cascade)
  fieldIndex   integer NULL   -- null이면 문서/페이지 레벨 질문
  page         integer NULL
  kind         text: 'quick_confirm' | 'question' | 'missing_sweep'
  prompt       text           -- 쉬운 한국어 질문/요약 문구
  answerType   text: 'confirm' | 'yes_no_unsure' | 'choice' | 'short_text'
  options      jsonb NULL     -- choice 선택지 [{value,label}]
  applyMap     jsonb NULL     -- 답변값 → 라벨 패치 {"yes":{"manual":true},...} (결정적 반영)
  orderIndex   integer
  answer       jsonb NULL     -- {value, text?}
  answeredBy   text NULL / answeredAt timestamptz NULL
  createdAt/updatedAt
```

이 테이블이 마스터 18.6 Field Question의 씨앗 — 이후 사용자 질문도 같은 구조로 수렴.

### 질문 생성 배치 (`generate-review-questions.ts`)

- LLM(ANTHROPIC_API_KEY, claude-sonnet-5)이 문서별 labelJson+notes+기준서 규칙 요약을 입력으로
  질문 세트 생성. "확인 필요" 필드가 있는 페이지는 해당 페이지 이미지도 첨부(vision)
- 생성 원칙 (질문 선별이 핵심 — 전 속성 전수 질문 금지):
  - **애매 필드만 question**: notes에 "확인 필요"/추정 표현, type=unknown, 서명·도장 인접,
    겸용 셀, manual 판정 경계 사례. 질문은 한 카드에 하나의 판단만
    (예: "이 칸은 도장이나 서명처럼 사람이 직접 해야 하나요?" 예/아니오/모르겠음)
  - **나머지 필드는 quick_confirm**: 한 줄 요약("기업명 — 지원자가 쓰는 필수 텍스트 칸") + [맞음]/[수정]
  - **missing_sweep**: 페이지당 1개 ("이 페이지에 지원자가 써야 하는데 목록에 없는 칸이 있나요?")
- applyMap은 LLM이 제안하되 서버에서 스키마 검증(허용 키·값만). 검증 실패 질문은 버리고 로그
- 멱등: 답변된 질문 보존, `--regenerate`는 미답변만 재생성. `--docs doc01,doc02` 부분 실행,
  기본 dry-run/`--write`
- 배포 전 품질 검토: 3문서 샘플 생성 → 사람 검토 → 전체 45문서

### 질문 모드 UI (상세 화면 기본)

- 카드 흐름: 진행률("12/38") + **bbox 주변 확대 크롭**(CSS background-position 크롭,
  bbox 없으면 페이지 축소 전체) + 질문 + 답변 버튼/입력. 이전/다음 이동 가능
- 답변 즉시: applyMap 패치를 라벨에 반영(클라 상태) + answer API 저장.
  "모르겠음"은 해당 필드 [보류] 처리. quick_confirm의 [수정]은 그 필드의 미니 질문 3종
  (무엇 입력? / 필수? / 직접 서명?)으로 전개
- missing_sweep에서 "있다" → 해당 페이지로 이동해 상자 그리기 + "이 칸은 무엇을 입력하는
  칸인가요?" 한 줄 답 → 새 필드 생성 (key는 답변 기반 임시, 운영자가 전문 모드에서 정규화)
- 완료 화면: 답변 요약 + 보류 n건 + [검수 확정]
- **전문 모드 토글**: 기존 필드 편집 화면 그대로 (운영자·예외 케이스용). 질문 모드 답변이
  반영된 최신 라벨을 보여줌

### v2에서 하지 않는 것

- 실시간 LLM 호출 (사전 배치만)
- key 정규화 자동화 (운영자 전문 모드 몫)
- 사용자향 Q&A (이 구조의 다음 소비자 — Phase 8)

## 검증

- 임포트 dry-run/실행 → 45행 + R2 343키 확인
- 게이트: 비로그인/비admin 404, admin 통과
- 확정 E2E: 테스트 문서 1건 필드 수정 → 확정 → golden_set에 row 생성 + labeledBy 이메일 확인 → 확정 취소 → golden row 제거
- 기존 파일 파이프라인 회귀: load-golden-field-maps.ts dry-run 여전히 동작 (공용 가드 추출 후)
