# 지식 루프 다음 세션 작업 큐 — K1~K4

작성일: 2026-07-06 (세션 9 말)
상위 문서: `docs/plans/2026-07-05-ops-knowledge-ingestion.md` (트랙 정본 — 상단 blockquote에 구현 이력 전부)
작업 방식: 메인 세션(Fable)이 오케스트레이션·검수·커밋, 구현은 **Opus 서브에이전트 위임** (세션 8~9 선례)

---

## 현재 좌표 (2026-07-06 기준)

- **구현 완료**: 인제스천(CLI `pnpm ingest:knowledge` + GUI `/internal/knowledge`) → lesson 인박스(`/internal/review/lessons`) → 소비처 2곳(공고 상세 "작성 유의사항" 패널 + 작성 워크스페이스 필드 인라인 팁)
- **데이터**: `review_lessons` 23건 전량 approved(립스/팁스, staff_confirmed), `knowledge_sources` 1건, 비-lesson 5건. LIPS/TIPS 키워드 매칭 공고 307건
- **핵심 파일**: `apps/web/src/lib/server/knowledge/` (knowledgeRepo·extraction·lessonContext·knowledgeDashboardData) / `features/knowledge/` (대시보드·GrantLessonGuide·FieldLessonTips) / 배선 `app/grants/[grantId]/page.tsx`
- **구조적 한계 평가(세션 9 말 합의)**: ① 노출·효과 텔레메트리 부재(측정 분모 없음, 죽은 지식 탐지 불가) ② scope 어휘 미정규화(문자열 포함 매칭 — "직원 수"가 "상시근로자 수"에 미탐) ③ 프로그램 별칭 사전 하드코딩(운영팀이 코드 변경 없이 새 프로그램 확장 불가). 이 순서가 작업 우선순위다

---

## K1. lesson 노출 텔레메트리 (최우선)

**왜**: Step 4(효과 측정)와 마스터 18.10 지표의 분모. "승인됐지만 노출 0인 죽은 지식" 탐지의 유일한 수단. K3의 의존성.

**무엇을**:
1. 신규 테이블 `lesson_exposure_events` (마이그레이션 1건): id, lessonId(FK→review_lessons, cascade 말고 set null 금지 — 삭제 없음 전제라 restrict/no action), grantId, surface text('grant_panel'|'field_tip'), anchorLabel text null(필드 팁의 라벨), companyId·userId nullable, createdAt. 인덱스 (lessonId, createdAt), (grantId)
2. 기록 지점: `app/grants/[grantId]/page.tsx`가 이미 서버에서 매칭 결과를 들고 있음 — 렌더 시점에 **fire-and-forget batch insert** (실패는 삼키고 warn 로그, 페이지 응답 지연 금지 — await하지 않거나 keepalive 패턴. 단순 await insert도 수십 ms라 v1 허용). 노출 1회 = 페이지 뷰 1회 기준(중복 제거 없이 raw 기록, 집계에서 처리)
3. (선택) 클라이언트 "펼침" 이벤트: FieldLessonTips/GrantLessonGuide 토글 시 소형 POST — v1에서 생략 가능, 시간 남으면
4. 대시보드 반영(`knowledgeDashboardData.ts` + UI): lesson별 최근 30일 노출 수, **"승인 후 30일 경과 & 노출 0" 목록**(죽은 지식 경보), 소스별 노출 합계

**완료 기준**: 마이그레이션 적용 + 공고 상세 1회 조회로 이벤트 행 실측 + 대시보드에 노출 지표 렌더 + typecheck. 실DB 검증 행은 정리(`conversion-dev` 관례 불필요 — 노출 이벤트는 실데이터로 남겨도 무해).

## K2. scope 어휘 정규화 — fieldKey 축 (중간)

**왜**: 문자열 포함 매칭은 규모에서 양방향(오탐·미탐) 누적 실패. Gate 1 표준 key 사전과 `grant_document_fields.fieldKey`가 이미 있어 key 동등성 매칭으로 격상 가능. Phase 4 필드 파이프라인 가동 전에 준비해두면 정확히 맞물림.

**무엇을**:
1. `LessonScope`에 `fieldKey?: string` 추가 (scope는 jsonb — **마이그레이션 불필요**. knowledgeRepo 타입 + `LESSON_SCOPE_AXES` + 인박스 scope 편집 폼에 축 추가)
2. 추출 프롬프트(extraction.ts): Gate 1 표준 key 사전(`docs/gate1-field-map-labeling-guide.md`) 요약을 주입해 fieldPattern과 함께 **fieldKey 제안**을 받게. 사전에 없는 필드는 fieldKey 생략(자유 발명 금지 — 화이트리스트 검증)
3. 매칭(lessonContext.ts): `matchFieldLessonTips` 입력에 라벨과 함께 fieldKey(있으면) 전달 — **fieldKey 동등성 우선, 문자열 포함은 폴백**. grant_document_fields 렌더 경로(ApplySheetView 서식 테이블)는 fieldKey 보유
4. 기존 23건 백필: 일괄 스크립트(dry-run 기본)로 fieldPattern→표준 key 사전 매핑 제안 → 출력 검토 후 --write. 애매하면 미기입(폴백 유지)

**완료 기준**: 신규 추출분에 fieldKey 포함(테스트 텍스트로 확인) + 매칭 우선순위 유닛 수준 검증(fieldKey 일치 시 문자열 미탐 케이스 — "직원 수"↔"상시근로자 수" 시나리오 통과) + 백필 dry-run 리포트 + typecheck.

## K3. 프로그램 사전 미매칭 경고 (K1 이후)

**왜**: 지식은 GUI로 들어오는데 매칭 사전(`PROGRAM_ALIAS_GROUPS`)은 코드로 들어오는 비대칭 — 새 프로그램 보고서가 조용히 매칭 0으로 잠든다.

**무엇을** (v1 — 사전 DB화는 매칭 엔진 통합 시로 미룸):
1. 인제스천 완료 시(CLI 리포트 + extract 라우트 summary) 추출된 scope.program 값들이 별칭 사전에 커버되는지 검사 → 미커버 값은 경고로 표시
2. 대시보드 소스 행 + lesson 인박스 카드에 "매칭 사전에 없는 프로그램 — 노출되지 않음" 뱃지
3. K1의 "노출 0" 지표와 연결(경보 목록에 사유 표기: 사전 미커버 vs 매칭 공고 없음)

**완료 기준**: 합성 보고서(예: program "수출바우처")로 경고 발현 실측 + typecheck.

## K4. 후순위 모음 (여유 시 / 조건 충족 시)

- **reviewBy 경과 정책**: 경과 lesson 노출 강등(말미 배치·기본 접힘) + 인박스에 "재검토 완료 — 기한 갱신" 액션. 현 데이터 기한 2027-07이라 급하지 않음
- **수정-인용 정합**: 인박스 "수정 후 승인" 시 instruction이 원문 인용과 어긋나도 시스템이 모름 — 수정 승인 시 curationNote 필수화 + 경고 문구 정도의 경량 대응
- **검수 문화**: 파일럿 전량 승인은 게이트 형식화 위험 신호 — 운영팀 가이드에 "의심스러우면 기각이 정상" 명시 (문서 한 줄)
- **exemplar 소비**: `nonLessonItems`의 예문은 Phase 5 L2(exemplar bank)에서. FAQ 후보 2건의 검증 Q&A 공개는 Phase 8에서
- **Phase 5 주입**: `buildLessonPromptBlock()`은 이미 대기 중 — fill planner/LLM draft 구현 시 처음부터 포함

---

## 작업 규칙 (세션 8~9에서 확립 — 반드시 준수)

1. **병렬 세션**: 시작 시 `git status --porcelain` — M/?? 파일 수정 금지. 서브에이전트 스펙에 매번 명시
2. **git**: `git add <명시 경로> && git commit`을 **한 Bash 호출로** (스테이징 방치 시 병렬 커밋에 쓸려감 — 세션 9 실증). 커밋 직후 `git show --stat HEAD`로 내 파일만 들어갔는지 확인. push는 사용자 확인 또는 세션 관례에 따라
3. **마이그레이션**: `pnpm db:generate` → SQL 육안 검토(신규 객체만) → `pnpm db:migrate`. `db:push` 금지
4. **검증 후 완료 선언**: `pnpm --filter @cunote/web typecheck` + 실DB 실측(읽기 전용 스크립트는 apps/web 하위에 생성 후 삭제). LLM 호출 테스트는 `ANTHROPIC_KNOWLEDGE_MODEL=claude-haiku-4-5`로 비용 최소화
5. **서브에이전트 검수**: 위임 후 핵심 diff(경합 파일·가드·상태 전이)는 오케스트레이터가 직접 정독. 리팩토링이 기존 경로를 건드리면 회귀 스모크 직접 실행 (세션 9 말: 공고 레벨 23/23 스모크 선례)
6. env: 정본은 `.env`(DATABASE_URL·ANTHROPIC_API_KEY·R2_*), 시크릿 값 출력 금지

## 다음 세션 트리거 문장 (제안)

전체 진행:

> 지식 루프 다음 슬라이스 진행해줘. `docs/plans/2026-07-06-knowledge-loop-next-session.md` 읽고 K1(노출 텔레메트리)부터 순서대로. 구현은 Opus 서브에이전트에 위임하고 검수·커밋은 네가 해.

개별 항목만:

> `docs/plans/2026-07-06-knowledge-loop-next-session.md`의 K2만 진행해줘.

참고: 이 트랙과 무관하게 프로젝트 임계경로는 여전히 **리뷰팀 45문서 검수(B1·B2)** — 지식 트랙 작업과 병행 가능하며 서로 블로킹하지 않는다.
