# 매칭 트랙 마스터 실행 문서 (단일 기준)

> 작성: 2026-07-13. **이 문서가 매칭 트랙의 우선순위·범위·완료 판정의 단일 기준이다.**
> 기존 문서와의 관계: `2026-07-12-matching-first-mission-implementation-plan.md`(게이트 지표 정의)와 `2026-07-13-first-mission-recovery-plan.md`(안전 불변식)는 상세 참조로 유지하되, **무엇을 먼저 하고 무엇을 하지 않는지는 이 문서가 우선한다.** 근거 조사는 `docs/research/2026-07-13-매칭시스템-현황평가.md`(18에이전트 조사 + 반박 검증 + Codex gpt-5.6-sol 리뷰)에 있다 — 그 문서는 수리 전 baseline 기록이며, 현재 상태는 본 문서 §6 결함 대장이 원천이다.

---

## 1. 이 작업의 실제 목적 (변하지 않는 기준)

**사업자번호 하나를 입력하면, 그 회사가 지금 지원할 수 있는 공공 지원사업을 정확히 골라 보여준다.**

성패 기준은 처음부터 두 가지였고 지금도 두 가지다:

1. **공고 분류** — 과거·현재 지원사업의 자격요건을 기계가 판정할 수 있게 분류·정제했는가.
2. **정확 매칭** — 사업자등록정보 + 외부 API + 자가입력으로 회사 필드를 채우면 정확한 판정이 나오는가.

지원서 작성 가이드(2번 피처)를 포함한 그 외 모든 것은 이 루프가 신뢰를 얻은 뒤의 이야기다. **이 문서에 없는 작업은 하지 않는다.** 새 작업이 필요해 보이면 먼저 이 문서를 갱신하고, 갱신할 수 없으면(목적에 연결되지 않으면) 그 작업은 버린다.

### 북극성 지표 (이것만 본다)

| 지표 | 현재 (2026-07-13 실측) | 4주 목표 |
|---|---|---|
| 검수된 정확도 수치 | **없음** (reviewed 0건) | 추출 recall 첫 실측 + holdout 판정 precision 첫 수치 |
| 사업자번호만 즉시판정률 | 39.09% | 실표본 30사에서 재실측·개선 확인 |
| recommendable율 / 질문 해소율 | 0.61% / 계측 없음(단발 0.74) | 유의미한 상승 실측 / 상시 계측 |

"구조화율 99.3%" 같은 존재 지표는 의사결정에 쓰지 않는다 (실질 판정가능률은 ~40%).

---

## 2. 조사로 확정된 결론 (요약 — 상세는 현황평가 문서)

- **성패 기준 1: 조건부 예.** 22축 체계는 근거 기반 설계로 재설계 불요. 부족한 것은 체계가 아니라 **검증 실측값**(사람 검수 정답 0건)과 소수의 값 무결성 결함.
- **성패 기준 2: 조건부 아니오.** 판정 엔진·계약·측정 하네스는 그릇으로 충분. 실사용 자동충전이 6축뿐(커넥터 9종 dev 격리)이고 병목은 전부 **실행 항목**(내부 계약 합의, 배선, 검수 노동)이지 설계 결함이 아니다.
- **방향: 유지.** 규칙 결정론 판정 + LLM은 추출에 한정 — 2026년 LLM 기준으로도, 해외 rules-as-code 정석 대조로도, 국내 경쟁 실측 대조로도 옳다. 경쟁 해자는 스키마(복제 가능, $4.6/1,477건)가 아니라 ①검수된 정답 데이터 ②소싱 배선 ③선정 결과 데이터다.

---

## 3. 설계 확정 사항 — 더 이상 논의하지 않는다

방향 상실을 막는 앵커. 아래는 **닫힌 결정**이며, 재론하려면 이 문서를 개정해야 한다.

| # | 확정 | 금지되는 것 |
|---|---|---|
| D1 | **22축 유지. 축 추가 금지.** | text_only 잔존을 새 축으로 풀려는 시도 (축 1개 = evaluator+사전+질문+검수 부담의 곱) |
| D2 | **판정은 규칙 결정론. LLM 직접 판정 전환 금지.** | "LLM에게 공고+프로필 주고 판정시키자"류 제안 (비용 O(공고×회사×갱신), 결정론·rule_trace 상실) |
| D3 | **unknown 보존·false ineligible 최소화 원칙 유지.** | 추천 수를 늘리려고 unknown을 pass/fail로 확정하는 완화 |
| D4 | **LLM의 자리는 3곳뿐**: ①공고 추출(현행) ②골든셋 사전 라벨 ③conditional 해소 보조(후순위). | 그 외 위치에 LLM 삽입 |
| D5 | **검수는 "AI 사전라벨 + 창업자 단독 사람 reviewer"** (v3-annotations의 AI 차단은 reviewerId에만 적용 — 코드 수정 불요). holdout blind 유지, 일치 쌍 20% 표본 감사. | "검수자 2인 확보될 때까지 대기"라는 무기한 정지 |
| D6 | **검수 순서: 공고 criteria 먼저, pair는 그 다음.** 공고 검수는 골든셋 선행조건 + recommendable 해금의 이중 배당. | pair 500쌍부터 시작 |
| D7 | **베타 게이트 150~200쌍, 정식 게이트 500쌍.** 임계값(0.90/0.95/0.97)은 골든셋 실측 후 재산정. | 500쌍 완료 전 "정확하다" 무조건 주장 / 실측 없이 임계값 논쟁 |
| D8 | **평가 인프라는 완성 상태(20모듈). 신규 제작 금지.** | 새 평가 도구·새 리포트·새 하네스 만들기 |
| D9 | **결격 3축이 자가신고인 동안 "지원 가능성이 높음" 문구 게이트는 닫아둔다.** 포지셔닝은 "자동 검증"이 아니라 "구조화된 사전 점검". | 결격 자동 검증 마케팅 |

---

## 4. 동결 목록 — 하지 않을 것 (오버엔지니어링 방어선)

- **HWPX 채움·Gate 2/3 등 지원서 작성 기능 추가 투자** — 매칭 베타 게이트 통과까지 동결. (단, **변환 서버는 매칭 인프라로 재분류** — §5 WS-D)
- **CODEF D1 실측·NICE 계약** — 병렬 트랙으로만 유지(사용자 동반 필요). 4주 임계 경로에서 제외.
- **시군구 해상도·다사업장 표현** — 2단계. 공고 측 값 스키마 확장은 골든셋·소싱 승격 뒤.
- **선정 결과 데이터 트랙 / 임베딩·재공고 예측** — 백로그. 설계 가치는 확정(현황평가 §5.3)이나 지금 아님.
- **industry canonical 사전 전면 구축** — 2단계. 지금은 substring 오확정 차단(WS-A)까지만.
- **새 문서 생성** — 매칭 트랙의 계획·상태 갱신은 이 문서 하나에만 쓴다. 조사·리서치 산출물만 docs/research/에.

---

## 5. 실행 계획 — 4개 워크스트림

### WS-A. 신뢰 위생 (즉시, 합계 2~3일) — "테스트가 거짓말하지 않게"

| 항목 | 상태 |
|---|---|
| unlock_at_months 복원 + verify-service-usecases 신 계약 갱신 | ✅ 완료 (`ba3a290`, 2026-07-13) |
| region 방어 (라벨→코드 사전, 미해석 unknown 강등, exclusion 빈배열 unknown, parseRegion 폴백 제거, 프로필 서버 가드) — DB 오염 22건은 매칭 시점 canonicalize로 무해화됨 | ✅ 완료 (`ba3a290`, 2026-07-13) |
| **178229 정답 방향 확정 → v2/v3 게이트 단일화** | 🔶 사용자 결정 대기. 권고: golden pair를 2케이스로 분리 — as-extracted(needs_review=true) 기대값 conditional + reviewed 변형(needs_review=false) 기대값 ineligible. 진실 라벨을 보존하면서 defer 정책도 검증. 단일 게이트로 통합 후 v2 폐기 |
| asOf 관통: matchNormalizedGrant에 asOf 수용 → prior_award 판정의 시스템 시각 의존 제거 (Codex P1, 재현됨) | ⬜ |
| industry 양방향 substring 매칭 → 코드/사전 매칭만 확정, 라벨 substring은 unknown (Codex P1, exclusion 오확정 재현됨) | ⬜ |
| scalar evidence gate 순서: nationwide 등 회사 값 불필요 판정을 게이트보다 먼저 | ⬜ |
| **원자 커밋**: 매칭 리팩토링 + 이번 수정 + regions.ts + 골든셋·holdout manifest 전부 | ✅ 완료 (ba3a290 체크포인트, 2026-07-13 19:14 — 398파일에 본 세션 수정분·골든 manifest 포함 확인) |
| GitHub Actions 최소 CI: typecheck + 매칭 verify 계열 + test:matching-unit | ⬜ |
| (기존) tsx 별칭 환경 실패 2종(bizinfo-publish/ingestion-publish)에 --tsconfig 부여 | ✅ 완료 (`8346982`, 2026-07-13) |

**완료 기준: `pnpm test` 그린 + CI가 PR마다 돈다.** `pnpm test`는 2026-07-13 통합 후보에서 그린이며, WS-A의 남은 완료 조건은 CI 배선이다. (verify:service-data 미종료 문제는 워치독으로 우회 유지)

### WS-B. 데이터 주입 (핵심 경로, 주 단위) — "정확도에 처음으로 숫자를 붙인다"

순서 고정 (D5·D6):

1. **소단위 검수 2건으로 게이트 즉시 개방**: audience 81건(~1일) → 컬럼 영속+매칭 필터 / prior_award 10건(수 시간) → L1 개방.
2. **공고 100건 criterion 검수** — 독립 LLM 사전라벨 → 창업자 확정. 대상: expanded seed 100건, 순서는 활성·노출 상위 → 최빈 차원(biz_age+region+industry=65%) → planExtractionImprovements 플래너. 추출 정확도 검증분은 **closed 아카이브에서 표집**(revision 불변 → stale 재검수 낭비 없음). 완료분은 reviewed-publication으로 운영 게시 → needs_review 해제 → match_state 재계산 + 층화 before/after 측정(07-11 백필 방법론 재사용).
3. **pair 90쌍**(dev 63 / blind holdout 27) → 첫 판정 정확도 수치(신뢰구간 명시).
4. 이후 베타 게이트 150~200쌍으로 확장.

**완료 기준: 추출 recall 실측 1개 + holdout 판정 precision 실측 1개가 존재한다.** 예상 노동: 창업자 풀타임 1.5~2주.

### WS-C. 충전 승격 (며칠) — "사업자번호 하나로"를 실서비스에서 참으로

1. **§6′-E 내부 계약 문서 확정 (0.5일)** — 외부 협상이 아니라 내부 합의다. 소스→커버 플래그 맵 + known-on-absence 예외 확정.
2. **positive-only 커넥터 3종 프로덕션 승격** (kcomwel employees · KIPRIS ip · 창업확인 certification) — 병합 경로는 이미 존재, 온디맨드 캐시 충전만 배선. 기능 플래그 뒤. 라이브 실측 완료된 축들이다.
3. 승격 직후 **STEP 3 실표본 30사 코호트 측정 실행** (하네스 완성 상태 — 실행만).
4. 조달청 부정당 CSV 전량본(사업자번호 포함) 재확보 → sanction 축 첫 실검증. 공공마이데이터 이용기관 **사전 문의 발송**(STEP 4A — CODEF 규제 리스크 헤지, 문의 자체는 반나절).

**완료 기준: 실표본 30사에서 축별 자동충전율 실측표가 존재하고, 자동충전이 6축 → 9축 내외로 확장된다.**

### WS-D. 체감 루프 (며칠) — "확인 필요 목록"을 "확정까지의 경로"로

1. **4상태 UX 계약 구현** (first-mission plan §1.3 그대로): needs_profile_input("이 정보만 확인하면 판정 가능" + 질문 CTA)을 needs_core_review와 분리 렌더. "답변 1개로 확정되는 공고 N건" 노출. 유일한 실측(질문 1개 → 19건 중 14건 확정)이 이 루프의 가치를 이미 증명했다.
2. **변환 서버 재분류·가동**: Cloud Run 재배포 → 활성 공고 첨부 우선 일괄 변환 → LLM 재추출 → manifest 승격. 재추출 자동 트리거 여부 확인·배선. (활성 98% manifest partial의 최대 원인 = 첨부 미변환 2,787건)
3. **데이터 표면 정리 배치** (전부 deterministic, LLM 비용 0): f_industries v3 백필, publish:dedup 1회, stale open 469건 상태 전환, provider 식별자 단일화, founder_trait/ip 별칭 소사전.
4. conditional_resolution_rate / question_burden_p50 상시 계측 배선.

**완료 기준: recommendable율이 0.61%에서 유의미하게 상승했음을 층화 측정으로 보이고, 해소율이 상시 계측된다.**

### 주차 배치 (기준선)

- **W1**: WS-A 완주 + WS-B 1(소단위 검수 2건) + WS-C 1(§6′-E)
- **W2**: WS-C 2~3(승격+실측) + WS-B 2 착수(공고 검수) + WS-D 1(UX)
- **W3**: WS-B 2 완주(공고 100건 게시+재계산 측정) + WS-D 2~3(변환·배치)
- **W4**: WS-B 3(pair 90쌍 + holdout 첫 수치) → **"측정된 베타" 선언**

4주 후 도달하는 주장: *"노출 상위 공고 100건은 사람이 검수했고 추출 recall X%. holdout에서 판정 precision Y%. 실표본 30사에서 사업자번호만으로 Z/19축 자동충전."* — 무조건적 "정확하다"가 아니라 **측정된 정확도**. 그것이 현재 "수치 0개"와의 질적 차이이자 경쟁 방어 자산의 첫 축적이다.

---

## 6. 결함 대장 (현재 상태의 단일 원천 — 현황평가 §4 + Codex 리뷰 통합)

| 결함 | 심각도 | 상태 (2026-07-13) | 소속 |
|---|---|---|---|
| unlock_at_months 소실 → soon 버킷·해금 칩 사망, pnpm test 파손 | 긴급 | **resolved** (`ba3a290`, `pnpm test` 그린) | WS-A |
| region 값 오염(비코드 9 + '37'류 13, open 5+) → 전 회사 확정 탈락 | 긴급 | **resolved** (`ba3a290`; canonicalize가 매칭 시점 무해화, DB 원본 정정은 선택) | WS-A |
| region exclusion 빈배열 무성 pass | major | **resolved** (`ba3a290`) | WS-A |
| 프로필 답변 라벨이 code로 저장되는 오염 경로 | minor | **resolved** (`ba3a290`, 서버 400 가드) | WS-A |
| v2/v3 평가 게이트 상호 배타 (178229) | 긴급 | **decision-needed** (권고안 §5 WS-A) | WS-A |
| matchNormalizedGrant asOf 미수용 → prior_award 시각 의존 (Codex 재현) | P1 | unresolved | WS-A |
| industry substring 오확정 — exclusion이면 확정 탈락 (Codex 재현) | P1 | unresolved | WS-A |
| scalar evidence gate가 nationwide 판정보다 선행 → 불필요 conditional | P2 | unresolved | WS-A |
| 엔진이 untracked 파일 의존 → tracked만 커밋 시 빌드 파손 | P2 | **resolved** (ba3a290 원자 체크포인트) | WS-A |
| CI 부재 (골든셋·holdout manifest는 ba3a290으로 커밋 완료) | 긴급 | unresolved — CI만 잔존 | WS-A |
| reviewed 정답 0건 → 모든 정확도 게이트 측정 불능 | 긴급 | unresolved (**최대 병목**) | WS-B |
| audience 미영속·미적용 (개인 공고 0.33~2.2% 잔존) | major | unresolved (검수 81건이면 개방) | WS-B |
| prior_award 분해기 비활성 (최다 빈출 배제 유형 text_only 잔존) | major | unresolved (검수 10건이면 개방) | WS-B |
| 커넥터 9종 dev 격리 → 실사용 자동충전 6축 | 긴급 | unresolved | WS-C |
| 결격 3축 외부 소싱 0 (100% 자가신고; 오판정은 허위/오인 신고 시 한정) | major | unresolved (조달청 CSV + 마이데이터 문의) | WS-C |
| 실표본 충전율 미측정 (목표치는 전부 추정) | major | unresolved (하네스 완성, 실행만) | WS-C |
| needs_profile_input/needs_core_review UI 뭉뚱그림 → 해소 루프 매몰 | major | unresolved | WS-D |
| 첨부 미변환 2,787건 → 활성 98% manifest partial → recommendable 0.61% | 긴급 | unresolved | WS-D |
| f_industries 0% / dedup_links 0 / stale open 469 | minor | unresolved (배치 1회씩) | WS-D |
| route policy 검증기가 Next route group을 실제 URL로 해석하지 못하고 세션 API 3개를 누락 | major | **resolved** (`fed42d0`, 131 API/10 cron/10 보호 페이지 검증) | WS-A |
| tsx 별칭 환경 실패 2종 | minor | **resolved** (`8346982`) | WS-A |
| dev 하네스와 운영 DB 공유 | 점검 필요 | open question | — |

---

## 7. 중단 규칙 (이 문서 자체의 오버엔지니어링 방지)

1. **이 문서에 없는 작업이 이틀 이상 걸리게 되면 중단한다.** 필요하면 이 문서를 먼저 개정하고, 목적(§1)에 연결되지 않으면 버린다.
2. **새 결함을 발견하면 §6 대장에 한 줄 추가가 기본 대응이다.** 즉시 수리는 WS-A 성격(테스트 신뢰·확정 탈락 유발)일 때만.
3. **리뷰·조사 라운드는 여기서 종료한다.** 다음 외부 대조(CALIBRATION)는 W4 "측정된 베타" 시점에 1회.
4. 세션 재개 시 읽는 순서: 이 문서 §5·§6 → (필요시) 현황평가 문서 → (필요시) 개별 plan.

---

## 8. 문서 지도 (지위 정리)

| 문서 | 지위 |
|---|---|
| **본 문서** | 매칭 트랙 우선순위·범위·완료 판정의 단일 기준 |
| docs/research/2026-07-13-매칭시스템-현황평가.md | 수리 전 baseline 조사 기록 (근거·수치 원천) |
| 2026-07-12-matching-first-mission-implementation-plan.md | 게이트 지표 정의·구현 이력 참조 |
| 2026-07-13-first-mission-recovery-plan.md | 안전 불변식·기준선 수치 참조 |
| 2026-07-11-matching-data-sourcing.md + 사업자번호-우선-자동채움-실행가이드 | WS-C 상세 절차 참조 |
| 마스터 아키텍처 문서 | 제품 비전·지원서 트랙 참조 — 매칭 관련 서술은 stale, 본 문서가 우선 (개정은 백로그) |

---

## 9. `main` 통합 준비 영수증 (2026-07-13)

- 통합 후보: `codex/first-mission-gates-20260713` (`8346982` 까지 제품·검증 변경 포함, 본 영수증은 docs-only 후속 커밋)
- 통과: frozen lockfile, `pnpm test`, `pnpm test:matching-unit`, `pnpm verify:first-mission-recovery`, `pnpm test:prior-award-integration`, `pnpm verify:db-migrations`, `pnpm build:web`, `pnpm build:admin`, `git diff --check main...HEAD`
- 확인: `0044`·`0045` 마이그레이션에 파괴적 데이터 삭제 구문 없음; `0045`는 RLS enable/force/policy 포함
- 비차단 경고: web production build의 Turbopack NFT 범위 경고 1건 (`archiveKStartupCore.ts` import trace). build는 성공했으며 통합 후 WS-A 성능·패키징 점검으로 이관
- 외부 대기: 운영 DB 마이그레이션 적용, 사용자 실행 서버 브라우저 smoke, live provider/30사 표본, reviewed 정답셋, `origin/main` push
- 해석 제한: 로컬 회귀·빌드가 그린이라는 뜻이지 실사업자 정확도나 운영 배포 완료를 의미하지 않는다.
