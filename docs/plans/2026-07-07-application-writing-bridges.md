# 지원서 작성 브리지 복구 — 구현 계획 (2026-07-07)

> **🟢 완료 (2026-07-07, 커밋 `cf9328c`)** — W-A/W-B/W-C 전 항목 구현·검증 완료.
> typecheck·`next build` 통과, 브라우저 재실측: 보강 입력 크래시 해소(숫자·콤보박스 모두 재매칭까지 왕복),
> 온보딩 4필드가 DB(name·region·industry, self_declared)에 저장, 티저 CTA→로그인→해당 공고 준비 시트 착지,
> 초안 공고가 신청 관리 "서류 준비"에 "매칭 밖 · 직접 준비" 배지로 편입, 답변 문서 간 공유·재생성 무변경 경고·
> DOCX 버튼·유의사항 상단 배치+앵커 칩·'지금 확인' 링크 확인. 부수 수정: 파이프라인 카드 time hydration(hourCycle h23).
> 잔여는 아래 "후속" 절 그대로.

> **근거**: `docs/ux-audits/2026-07-07-core-journey-walkthrough/README.md` (핵심 여정 실측 감사)
> **목표**: "매칭 → 내 회사 정보가 반영된 지원서 작성"으로 넘어가는 끊어진 다리 3개(프로필 파이프라인·공고 선택 맥락·가이드 결합)를 복구한다.
> **비범위(의도적)**: LLM 초안 생성(마스터 설계 Phase 5 — Phase 4 필드 공급 의존), 변환 파이프라인 프로덕션 배선([F2]/A7 — 사용자 액션 대기). 이 둘은 기존 트랙을 따른다.

## 워크스트림 (파일 소유권 기준 분할 — 병렬 위임)

### W-A. 매칭·온보딩·복귀 흐름
파일: `apps/web/src/features/matches/MatchesExperience.tsx`, `apps/web/src/features/onboarding/InitialCompanySetupPanel.tsx`, `apps/web/src/features/home/LandingExperience.tsx`, `apps/web/src/features/home/HomeExperience.tsx`

- **A1 (P0)** 크래시 수정: setState 업데이터 내부의 `event.currentTarget.value` 접근 제거 — 핸들러에서 값을 먼저 추출. 동일 패턴 저장소 전체 grep 후 일괄 수정
- **A2 (P0)** 온보딩 병합 전송: `buildCreateRequest`가 bizNo(10자리)와 수동 profile(회사명·지역·업종)을 **함께** 전송. 서버(`resolveTeaserCompanyProfile`)는 이미 병합 지원 — 클라이언트만 수정. FieldDescription 카피를 병합 의미에 맞게 조정
- **A3 (P0)** 선택 공고 이월: 티저 카드 "이 사업 신청 준비하기" → `saveAndContinue(grantId)` → callbackUrl에 `resumeGrant=<id>` 포함. 홈/랜딩 resume effect가 `resumeGrant`를 읽어 회사 생성 성공 후 `/grants/<id>`로 착지(없으면 기존 `/dashboard`)
- **A4 (P2)** 티저 헤드라인: eligible=0이고 conditional>0이면 "확인하면 열리는 사업 N건을 찾았어요"로 분기 — "0건" 자기모순 제거

### W-B. 신청 준비 시트·작성 워크스페이스
파일: `apps/web/src/features/apply-sheet/ApplySheetView.tsx`, `apps/web/src/features/apply-sheet/DocumentDraftWorkspace.tsx`, (`features/knowledge/GrantLessonGuide.tsx` id 부여 필요 시)

- **B1 (P1)** 추가 입력 문서 간 공유: `answerText`를 documentKey 키잉 → **label 전역 키잉**으로 변경 (기업명을 한 번 쓰면 신청서·사업계획서 모두 반영)
- **B2 (P1)** 작성 유의사항 재배치: `GrantLessonGuide`를 하단 → `ApplicationPrepSection` 위로 이동 + 워크스페이스 요약 옆 "작성 유의사항 N건" 앵커 칩
- **B3 (P2)** 섹션 재생성 정직화: 재생성 결과가 기존과 동일하면 warning 톤으로 "내용이 달라지지 않았습니다 — 추가 입력을 채우면 반영됩니다"
- **B4 (P2)** 피드백 유형 셀렉트가 원시 값("too_generic") 대신 한국어 라벨 표시
- **B5 (P1)** DOCX 다운로드 버튼 추가 (서버 `?format=docx` 이미 지원 — UI만. PDF는 한글 폰트 검증 전 보류)
- **B6 (P2)** 체크리스트 "지금 확인" 배지 → 실제 링크 (`ActionQueuePanel.actionHref` 패턴 준용: `#`/`/`/URL은 그대로, 그 외 `/dashboard#next-question`)

### W-C. 신청 관리 파이프라인
파일: `apps/web/src/lib/server/applications/pipeline.ts` (+ 최소 침습 범위에서 contracts·UI 사용처)

- **C1 (P1)** 모집합 확장: **초안 또는 피드백이 있는 공고는 현재 매칭 목록에 없어도(부적격이어도) 파이프라인에 포함**. grants 테이블에서 메타 조회해 아이템 구성, fitScore 등 매치 전용 값은 nullable 처리. "낮은 적합도여도 지원" 시나리오의 핵심 수정

## 후속-1: 초안 추가 입력의 회사 프로필 승격 (2026-07-07 완료)

> **🟢 완료** — 브라우저 실측: 서술 2건 입력 초안 생성 → other dimension DB 저장 → 리로드 후 질문 소멸("추가 입력 없음/프로필 충분", 입력 필요 3→1) → 자동채움에 "프로필" 배지 → **입력 없이 재생성해도 본문에 서술 반영**. core verify 3종·typecheck·`next build` 통과.
> ⚠️ 운영 노트: `@cunote/core`는 **dist export**라 core 수정 후 `pnpm --filter @cunote/core build` 해야 dev 서버·web build에 반영된다 (verify 스크립트는 tsx로 소스를 직접 실행하므로 빌드 없이도 통과해 착시 가능).

목표: 초안 생성 시 입력한 답변이 회사 프로필에 저장되어 ① 같은 질문이 다시 나오지 않고 ② 다른 서류·다른 공고 초안에 자동 반영되며 ③ 복붙 프로필에 나타난다.

- **저장 경로**: `createGrantDocumentDraft`/`regenerateGrantDocumentDraftSection` 성공 시 비치명(try/catch) 승격 훅.
  `resolveCompanyProfile` → 병합 → `saveCompanyProfile` (name·전체 dimension 재기록 방식이므로 반드시 전체 프로필로 병합 후 저장).
- **매핑** (answers는 label 키 — sheet.applicationPrep.missingProfileFields로 label→fieldKey 역매핑):
  - `company.name` → companies.name — **기존 값이 없을 때만**
  - `company.region` → region dimension — KOREA_REGION_OPTIONS 시도 prefix 매칭 성공 시에만, 기존 region 없을 때만 (confidence 0.6)
  - `company.industries` → industry dimension — 콤마/가운뎃점 분리 태그, 기존 값 없을 때만 (confidence 0.5)
  - `business.*` (제품/서비스 설명·이번 지원으로 달성할 목표·예산 항목과 산출근거·대표 실적 요약) → `other_conditions[fieldKey]`에 병합(항상 최신값으로 덮어씀, 길이 상한)
- **읽기 경로**:
  - `buildMissingFieldQuestionsForDocument`(core preparation): `company.other_conditions[fieldKey]`에 비어있지 않은 문자열이 있으면 해당 business.* 질문 생략
  - `buildProfileCopyFields`(core build-apply-sheet): other_conditions의 4개 narrative를 질문 label과 동일한 라벨로 push(source company_profile) → autofill이 자동 반영·질문 필터·복붙 프로필 노출까지 일관 동작
- **UI**: 답변과 함께 초안 생성 성공 시 "입력값은 회사 프로필에 저장돼 다음 서류에서 자동 반영됩니다" 안내 덧붙임

## 후속 (이번 범위 밖, 감사 문서 연동)

- ~~초안 추가 입력의 company_profiles 승격~~ → 위 후속-1로 착수
- C-8/C-9/C-11(자동채움 문항의 공고 메타 혼입, 복붙 프로필 명칭, 카운트 정합) — preparation 데이터 형상 재설계와 함께
- Phase 5 LLM 초안 배선 시 "AI 초안" 라벨/카피 재정렬
- 아카이브 기본 정렬·행 액션 가로 스크롤 문제(E-1), 마감 경과 status 갱신(E-2)

## 검증 (메인 세션)

1. `pnpm --filter @cunote/web typecheck` + `next build`
2. 브라우저 재실측: 매칭 입력(크래시 無·재매칭 동작) / 온보딩 전입력 → DB name·region·industries 반영 / resumeGrant 착지 / 신청 관리에 초안 공고 노출 / DOCX 다운로드 / 유의사항 위치
3. 커밋: 워크스트림 단위, 경로 명시 스테이징 (`git add -A` 금지)
