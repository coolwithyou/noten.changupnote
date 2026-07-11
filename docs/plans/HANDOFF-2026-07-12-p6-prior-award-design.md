# HANDOFF 2026-07-12 — P6 audience 게이트 + prior_award 구조화 설계 (설계 전용, 구현 금지)

## 이 세션의 목표

공고매칭 차원 확장(14→22) 트랙에서 의도적으로 미착수/범위 제외된 두 후속 트랙의 **구현계획 설계**를 수립하고 리뷰까지 마치는 것. **구현은 착수하지 않는다** — 설계안 → 심층 리뷰(codex gpt-5.5 xhigh fast mode) → 반영 → 사용자 승인 후 별도 세션에서 구현.

산출물: `docs/plans/2026-07-12-audience-gate.md` + `docs/plans/2026-07-12-prior-award-structuring.md` (또는 통합 1건 — 두 트랙은 독립적이므로 분리 권장. 연구·검토 문서를 만들면 한글 파일명 `YYYY-MM-DD-한글제목.md`).

## 전제: 완결된 기반 (2026-07-11, 커밋 ceb426c~32c0ddc + Codex 패치)

- 22차원 계약·DB enum·결격 evaluator(known_flags 게이트)·프로필 파이프라인·rule-based 분해기·LLM 프롬프트 전부 가동 중. kstartup 29,429건 + bizinfo 1,477건 백필, match_state 146,984행 v3 재계산 완료.
- 단일 원천: `docs/plans/2026-07-11-matching-dimension-expansion.md` (특히 **§3 P6**과 **§6 C2**가 이 핸드오프의 출발점)
- 실측: `docs/research/2026-07-11-차원확장-백필-층화측정.md`, 27종 배제 조건 표: `docs/research/2026-07-11-공고매칭-14차원-확장-검토.md`

## 트랙 1 — P6 audience 상류 게이트

**문제**: 개인 대상 공고(재직자 교육, 심사역 양성, 포상, 청소년 대상 등)가 기업 매칭 우주에 섞여 있다. P4 홀드아웃에서 "만 13세 이상 국민" 류가 미구조화 잔여로 실측 확인됨. 현재는 criteria 레벨에서 걸러지길 기대하는 구조라 개인 공고가 needs_core_review/not_recommended로 새며 노이즈를 만든다.

**원안(계획 §3 P6, 골격만 있음)**: grants `audience` 컬럼(enum `company|individual|mixed|unknown`) + 룰(키워드) 분류기 + LLM 보조, unknown 현행 유지, 매칭 파이프라인에서 `individual` 제외(또는 별도 섹션).

**설계 세션에서 확정해야 할 것**:
1. 분류기 아키텍처 — 룰 시드(재직자/심사역/임직원/포상/교육/만 N세 키워드)와 LLM 보조의 경계, 정확도 측정용 골든 셋 구성(오분류 비용 비대칭: 기업 공고를 individual로 오분류하면 매칭 기회 상실 — false individual이 더 비쌈)
2. 분류 입력 소스 — 제목만으로 충분한가, 본문/신청자격 원문까지인가 (kstartup `aply_trgt_ctnt` 등 필드 활용)
3. 백필 전략 — grants 컬럼 단독 업데이트라 **criteria 재발행 불필요**(재정규화와 독립). kstartup 전량(29,429)·bizinfo(~1,959) 대상, LLM 보조 쓸 경우 비용 산정 필수(참고: bizinfo 1,477건 haiku 재추출 실측 ≈$5 미만)
4. 매칭 통합 지점 — `listActiveGrants`(drizzle.ts) 필터 vs 매칭 파이프라인 내 제외 vs UI 별도 섹션. match_state 재계산 필요 여부 포함
5. 마이그레이션 — 신규 PG enum 타입이라 BEFORE 제약 없음. `pnpm db:generate` → 검수 → migrate 관례(0041 전례)
6. mixed(기업+개인 혼합 공고) 처리 시맨틱

## 트랙 2 — prior_award 구조화 (C2 후속)

**문제**: 27종 표의 #8(동일과제 참여 중)·#10(중복입주)·#13(프로그램 수료 이력)·#20(타부처 중복지원)이 구조화 불가로 other text_only 잔존 중. 현행 `evaluateListCriterion`은 문자열 exact-match라 회사 `prior_awards`와 표기가 조금만 달라도 false pass — 그래서 **3중 방어층으로 구조화를 의도적으로 차단**해 둔 상태다:
- `packages/core/src/disqualification/extract.ts` — 분해기 패턴에서 의도적 제외
- `packages/core/src/bizinfo/llm-criteria.ts` `normalizeCriterionRow` — `prior_award && kind==="exclusion"` → other/text_only 강등
- `packages/core/src/bizinfo/criteria-contract.ts` `detectStructuringViolations` — backstop 검출

**설계 세션에서 확정해야 할 것**:
1. **수혜 이력 프로필 구조** — 사업명·주관기관·연도·상태(`participating|completed|graduated`) 구조화. 결격 축에서 검증된 `known` 게이트 패턴 필수(미질의 이력의 false pass 차단 — C1과 동일한 문제 구조)
2. **grant 자기참조 시맨틱** — "동일 사업 기수혜 제외"는 criterion 값이 특정 사업명이 아니라 **매칭 대상 공고 자신**을 가리킨다. CriterionValue에 self-reference 표현(예: `{scope:"self"}`)을 신설해야 함 — 이것이 C2 리뷰가 지적한 "현행 계약으로 표현 불가" 지점
3. **사업명 canonical 정규화** — 같은 사업의 연차·기수 변형("2026년 초기창업패키지" vs "초기창업패키지 (예비)") 매칭 전략. grants 테이블 자체와의 조인 가능성(수혜 이력을 자유 텍스트가 아니라 grant 참조로 저장하는 안)
4. **evaluator 시맨틱** — 참여 중(동시 수행 금지) vs 수혜 완료(재지원 금지) vs 수료(우대/배제 양방향) 구분. 기간 조건("최근 3년 내") 포함
5. **방어층 해제 순서** — 계약·evaluator·프로필·문항이 전부 준비되기 전에 3중 방어층을 풀면 안 됨. 해제 시점을 Phase 계획에 명시할 것 (기존 방어층 테스트: `llm-criteria-normalize.test.ts` 12건, `extract.test.ts` C2 케이스)
6. 온보딩 문항 — 수혜 이력 입력은 결격 체크리스트보다 부담이 크다(자유 입력). 저부담 설계(최근 N건, 주요 사업 자동완성 등) 검토
7. #10(중복입주)·#20(타부처 중복지원)이 prior_award 하나로 표현되는지, 별도 값 구조가 필요한지

## 작업 체계 (이 세션에 적용)

- 설계 초안은 Opus 서브에이전트 위임 가능, 메인은 검수. **심층 설계 리뷰는 codex gpt-5.5 xhigh(fast mode)** — 차원 확장에서 자체 리뷰가 놓친 Critical 1+Major 4를 잡아낸 전례(사용자 지시로 표준화됨)
- 증거 수집(코드 인용·DB 실측)은 Explore 에이전트 병렬 활용, 코드 인용은 재검증
- DB는 `.env`의 **운영 Supabase** — 읽기 전용 쿼리만. 실측 표본이 필요하면 psql은 URL의 `?` 뒤 파라미터 제거
- 워킹트리에 병렬 세션 산출물 가능성 상존 — `git add -A` 금지, 명시 스테이징, add와 commit은 한 호출에
- 리뷰 반영 기록은 계획 문서 안에 §로 남길 것 (차원 확장 계획 §6 형식 참조)

## 검증 체크리스트 (설계 세션 완료 조건)

- [ ] 계획 문서 2건(또는 통합 1건)에 Phase·파일 단위 작업 목록·완료 기준·리스크 표 포함
- [ ] codex 리뷰 수행 + 발견 전건 반영 기록
- [ ] P6: 오분류 비용 비대칭을 반영한 분류 임계 정책 + 백필 비용 산정 포함
- [ ] prior_award: 자기참조 계약 표현 + 방어층 해제 순서 명시
- [ ] 커밋(설계 문서만, 명시 스테이징) — 구현 파일 변경 0

## 신규 세션 트리거 문장

> docs/plans/HANDOFF-2026-07-12-p6-prior-award-design.md 읽고 P6 audience 게이트와 prior_award 구조화 두 트랙의 구현계획 설계를 진행해줘. 설계 초안은 Opus에 위임하고 심층 리뷰는 codex gpt-5.5 xhigh fast mode로, 구현은 착수하지 마.
