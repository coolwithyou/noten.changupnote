# 운영 지식 인제스천 — "보고서가 올 때마다 강해지는 지원서 에이전트" 평가·계획

작성일: 2026-07-05
트리거: 운영팀 보고 문서 「립스1,2 사업계획서(hwp)양식 중 어려워하는 포인트정리.pdf」(9p) — 앞으로 이런 인터뷰/피드백 문서가 계속 유입될 예정
관련 설계: 마스터 아키텍처 18장(지식 루프) · `docs/research/2026-07-02-hitl-loop-sota.md`

> **✅ v1 구현 완료 (2026-07-05, 같은 날 세션)** — §7 로드맵의 Step 0~2 구현·적용됨.
>
> - **스키마**: 0031 마이그레이션 (`knowledge_sources` + `review_lessons`, §6.1 확장 필드 포함) — Supabase 적용 완료
> - **저장 계층**: `apps/web/src/lib/server/knowledge/knowledgeRepo.ts` — 승격 가드(approved 전이는 sourceRefs 또는 goldenCaseRef 필수), `findConflictingLessons` scope 겹침 검출
> - **인제스천 CLI**: `pnpm ingest:knowledge -- --file <경로> [--program ...] [--write]` (dry-run 기본). PDF 페이지별 추출(`[page N]` 마커) → LLM 추출(기본 claude-opus-4-8, `ANTHROPIC_KNOWLEDGE_MODEL` override) → 서버측 화이트리스트 + **quote 실재 검증**(공백 정규화 부분 문자열) → proposed 적재. R2 프리픽스 `knowledge-sources/<sha12>/`
> - **lesson 인박스**: `/internal/review/lessons` (기존 검수 워크스페이스와 동일 인증 가드). 승인·수정 후 승인·기각(사유 필수)·철회, 승인 시 충돌 검출 409 → "그래도 승인(force)". 원문 인용 대조 블록이 검수의 중심
> - **파일럿 실측 (Step 0 목표 달성)**: 립스1,2 PDF 1건 → lesson 후보 23건 proposed (quote 검증 통과 100%, target 분포: guide 11·criteria 4·fill_value 4·field_interpretation 4·evaluation 1) + 비-lesson 5건(제품 피드백 "재무제표 PDF 자동 기입" 포함, `knowledge_sources.nonLessonItems`) + 승인 왕복 1건 검증. §3에서 예측한 5개 지식 유형 전부 포착됨
> - **잔여**: Step 3 주입 경로(Phase 5 fill planner/draft와 정렬), Step 4 효과 측정·FAQ 공개, Step 5 L2/L3, Step 6 게이트. 운영팀 보고서가 새로 오면 `pnpm ingest:knowledge`로 적재 → 인박스에서 검수
>
> **✅ 파일럿 검수 완료 (2026-07-06)** — 운영팀이 인박스에서 proposed 22건 검수 완료. 실DB 실측: **review_lessons 23건 전량 approved** (기각 0), 전부 staff_confirmed, target 분포 guide 9·field_interpretation 5·fill_value 4·criteria 3·evaluation 2. 루프의 사람 게이트가 실제로 작동함을 확인 — 다음은 Step 3(소비처 주입).
>
> **✅ Step 3 첫 슬라이스 — 지식의 첫 실소비처 (2026-07-06)** — 승인 lesson이 처음으로 제품에 흐름.
>
> - `lessonContext.ts`: `matchApprovedLessonsForGrant()` — 공고(title+agency)와 lesson scope의 보수적 매칭(program 별칭 사전 LIPS↔립스·TIPS↔팁스, NFKC 정규화 포함 검사, program/institution 축 필수), validFrom 시효 제외·reviewBy 경과 시 `needsReview` 플래그. **`buildLessonPromptBlock()`** — Phase 5 LLM 주입용 포맷터 선행(tier 우선순위 명시 헤더)
> - `/grants/[grantId]` 지원 준비 화면에 "작성 유의사항" 패널(`GrantLessonGuide`) — target 그룹(자격·전제→기입값·한도→필드 해석→작성 지침→심사 관점), evidenceTier 뱃지, "공고 원문 우선" 각주. 실패 시 null 폴백으로 페이지 무영향
> - 실측: LIPS/TIPS 키워드 매칭 공고 307건. 포스트팁스 공고에서 22/23 매칭(LIPS 전용 1건 정확히 제외 — 보수적 스코핑 검증), 합성 LIPS 공고 23/23, 수출바우처 negative 0건
> - **알려진 한계(후속)**: 포함 매칭이라 파생 프로그램(포스트팁스·글로벌팁스)도 매칭됨 — 자문 패널+각주로 v0 수용, 프로그램 감지 정밀화는 매칭 엔진 통합 시. 필드 레벨(fieldPattern) 주입은 Phase 5에서
>
> **✅ Step 3 둘째 슬라이스 — 작성 시점 필드 레벨 팁 (2026-07-06)** — fieldPattern 매칭의 첫 소비처.
>
> - `matchFieldLessonTips()`: 공고 레벨과 같은 1차 게이트(`passesGrantGate` 공유) 통과 후, fieldPattern 토큰(2자 미만 무시)이 입력 항목 라벨에 포함되면 매칭. 정렬: fill_value·field_interpretation 우선
> - 작성 워크스페이스(DocumentDraftWorkspace)의 "입력 필요" 질문 항목 + 서식 필드 테이블에 `FieldLessonTips` 인라인 팁(1건 즉시 노출, 2건+ 토글, tier 뱃지)
> - 실측: 매출액·총사업비 구성·한줄 소개·가점(3건 정렬)·자금 사용계획(5건 토글) 매칭 / 대표자 성명·소재지 등 negative 통과 / 비 LIPS/TIPS 공고 전면 차단. 리팩토링 후 공고 레벨 회귀 스모크 23/23
> - **알려진 한계**: ① 2자 토큰 포함 매칭이라 "현금영수증"류 라벨이 "현금/현물" lesson에 걸릴 수 있음(자문 패널 성격상 v0 수용, min-length·불용어 조정은 실사용 후) ② 현 DB에 grant_document_fields 0건이라 서식 테이블 팁은 필드 추출 파이프라인 가동 후 발현
>
> **✅ 지식 대시보드 v1 (2026-07-06)** — GUI만으로 전체 루프 운영 가능해짐.
>
> - `/internal/knowledge` — 축적 현황판: 지표 카드(누적/승인/검수 대기/재검토 임박), 12주 축적 추이, target·evidenceTier·program 분포, 원천 문서 목록, 비-lesson 항목(제품 피드백·FAQ 후보·예문) 탭, 재검토 임박 목록
> - **GUI 인제스천**: 대시보드에서 보고서 업로드(.pdf/.txt/.md, sha256 멱등) → [추출 실행](서버 라우트 `maxDuration=300`, 이중 클릭 방지) → 인박스 검수. CLI(`pnpm ingest:knowledge`)와 같은 추출 코어(`extraction.ts`로 공용화, CLI 회귀 확인)
> - 집계 계층 `knowledgeDashboardData.ts`, 추출 상태 전이 가드(registered→extracted는 lesson 적재 성공 후에만, 추출됨+lesson 존재 시 409)
>
> **✅ K1 — lesson 노출 텔레메트리 (2026-07-06, 커밋 b29007c)** — Step 4 효과 측정의 분모 확보.
>
> - `lesson_exposure_events` (0033): lessonId FK restrict·grantId plain uuid·surface('grant_panel'|'field_tip')·anchorLabel. 노출 1회 = 페이지 뷰 1회 raw 기록(중복 제거는 집계에서)
> - 공고 상세 렌더 시 매칭 결과에서 batch insert(await+try/catch — 실패는 warn, 페이지 무손상). 집계는 `getLessonExposureCounts` SQL group by(최근 30일+전체 동시, 전량 로드 금지)
> - 대시보드 `ExposurePanel`: **죽은 지식 경보(승인 후 30일 경과 & 노출 0)** + 최근 30일 노출 랭킹 + 소스 행 노출 합계 칩. 실측: 포스트팁스 공고 1뷰 = grant_panel 22 + field_tip 21 이벤트
>
> **✅ K2 — scope 어휘 정규화, fieldKey 축 (2026-07-06, 커밋 33daada)** — 문자열 포함 매칭을 Gate 1 표준 key 동등성으로 격상.
>
> - `fieldKeyDictionary.ts`: 기준서 §표준 key 사전 15개 스냅샷(정본은 기준서). `LessonScope.fieldKey` 축 추가(jsonb — 마이그레이션 불필요)
> - 추출 프롬프트 `ops_extract_v2`: 사전 주입 + fieldKey 제안(자유 발명 금지), 서버측 화이트리스트 검증(사전 밖 key는 축만 제거)
> - 매칭: 양쪽 다 fieldKey 보유 시 **동등성 단독 판정**(불일치 시 문자열 폴백 미하강 — 오탐 재유입 금지), 그 외 fieldPattern 폴백. "직원 수"↔"상시근로자 수" 미탐 해소. 유닛 테스트 `pnpm test:lesson-context`
> - 백필 `pnpm backfill:lesson-field-keys`(dry-run 기본): 대상 17건 → 3건 반영(매출액→revenue·직원 수→employee_count·사업비 구성→budget_table), 애매 14건 보수적 스킵
>
> **✅ K3 — 프로그램 별칭 사전 미매칭 경고 (2026-07-06, 커밋 94e6474)** — GUI 지식 유입 vs 코드 사전의 비대칭을 경고로 드러냄.
>
> - `isProgramCoveredByAliases`/`listUncoveredPrograms` (CLI 리포트·extract 라우트 summary·대시보드 공유). 소스 행+인박스 카드 "별칭 사전 미등록" 뱃지
> - K1 죽은 지식 경보에 사유 연결: 사전 미등록 / 매칭 공고 없음(공고 로드는 죽은 지식 존재 시에만) / 도달 경로 점검 필요
> - 문구 정정: "노출되지 않음"이 아니라 "표기 변형(한↔영) 매칭 불가, 리터럴 일치에만 의존"(미등록이어도 리터럴 일치는 가능). 합성 보고서(수출바우처)로 발현 실측 후 테스트 데이터 정리
> - **잔여(K4 후순위)**: reviewBy 경과 노출 강등, 수정-승인 시 curationNote 필수화, 검수 가이드 한 줄("의심스러우면 기각이 정상"), exemplar 소비(Phase 5 L2)·FAQ 공개(Phase 8)

---

## 1. 요약 (결론 먼저)

1. **"학습해서 강화되는 에이전트"는 새로 발명할 것이 아니라, 마스터 설계 18장이 이미 절반을 설계해 놓았다.** 18장의 지식 루프(lesson 승격 → scope 매칭 주입 → eval 회귀 측정)가 정확히 이 요구의 골격이다. 첨부 PDF의 내용은 기존 `ReviewLesson` 모델(18.5)에 거의 1:1로 매핑된다 (§3의 매핑 표 참조).

2. **빠져 있는 것은 세 가지다.**
   - **(a) 제3의 유입 채널**: 18.3은 수요(사용자 질문)와 공급(리뷰어 순회) 두 갈래만 정의한다. "운영팀 보고 문서(인터뷰·피드백 정리)"라는 문서형 유입이 없다 → 본 계획의 핵심 신설부.
   - **(b) lesson 모델의 시효·출처 등급**: 인터뷰 지식은 "공식 규정"이 아니라 "담당자 구두 확인"이고, 지원사업은 연차/회차마다 조건이 바뀐다. 현 `ReviewLesson`에 유효기간·출처 신뢰 등급이 없다.
   - **(c) 주입 경로 구현**: `review_lessons`/`field_questions` 테이블과 프롬프트 주입은 Phase 8 미착수 상태다 (스키마에 `golden_set`/`eval_runs`만 존재).

3. **강화학습(RL)·파인튜닝은 현 단계에 부적합하다. 컨텍스트 기반 지식 루프가 이 문제 클래스의 2026년 정답이다.** 근거는 §5. 18.8의 단계표(L1~L4)를 유지하되, L4(SFT)와 RL의 **발동 조건을 명문화**한다 (§7 Step 6).

4. **즉시 실행 가능한 첫 걸음**: 이 PDF 하나로 파일럿 — 스키마 작업 전에 고성능 LLM으로 lesson 후보를 추출하고 사람이 검수해서, 문서 1건에서 몇 건의 고품질 lesson이 나오는지 실측한다 (§7 Step 0). 예상 산출: lesson 후보 30~50건 + 제품 백로그 1건(재무제표 PDF 자동 기입) + FAQ 후보 다수.

---

## 2. 질문의 재정식화 — "강화되는 에이전트"의 실체

"에이전트 형태일지 아닐지 모르겠다"는 질문에 대한 답: **강화되는 것은 에이전트(모델)가 아니라 지식 레이어다.**

- 마스터 18.7이 이미 규정한 구조: `평가 에이전트`·`작성 도우미`·`응답 에이전트(Tier 0)`는 **같은 지식 레이어**(`golden_set` + `review_lessons` + 검증 Q&A + `versions`)를 소비하는 세 파이프라인이다.
- "보고서가 올 때마다 강해진다" = 보고서 → lesson 후보 추출 → 사람 승격 → **다음 지원서 분석부터 scope 매칭으로 자동 주입**. 모델 가중치는 그대로이고, 모델에게 주는 컨텍스트가 누적적으로 좋아진다.
- 이 방식의 장점은 우리 도메인에서 결정적이다: **감사 가능성**(모든 지침에 출처·인용이 달림), **즉시성**(승격 즉시 발효, 재훈련 없음), **철회 가능성**(공고 조건이 바뀌면 lesson retire), **모델 교체 내성**(Claude 버전이 바뀌어도 지식은 그대로).

---

## 3. 첨부 보고서 분석 — 지식 유형 분해와 기존 모델 매핑

PDF(9p)를 실제로 분해하면 5가지 지식 유형이 나오며, 전부 기존 모델에 자리가 있다:

| # | 지식 유형 | PDF 실례 | lesson `target` | scope 예시 | 비고 |
|---|---|---|---|---|---|
| 1 | **자격·전제조건 사실** | 소상공인확인서는 4대보험 4명 이하만 당일 발급(건설업 9명), 창업기업확인서 최장 10일 소요 / **개인사업자는 운용사 투자 선행 조건 탓에 사실상 신청 불가** | `criteria` / `classification` | `{program: "LIPS/TIPS"}` | 매칭·추천 엔진에도 영향 (자격 필터) |
| 2 | **프로그램 플레이북** | 가점 상한 5점, 비수도권 이전 2점 + 내일채움공제 1점 + 퇴직연금 1점 + 이노비즈 1점 조합이 최저비용, 가점 0점이 50%+ | `guide` / `evaluation` | `{program: "LIPS/TIPS"}` | 전략 지식 — 준비 탭·추천 근거로 노출 가치 큼 |
| 3 | **필드 해석 규칙** | 매출액 = 손익계산서 표기 매출액(통장입금액·부가세 포함 금액 금지) / 차입금 = 단기+유동성장기+장기+사채+대표자·주주 차입금, 매입채무·미지급금·선수금 등 제외 / 인원 = 4대보험 가입 기준 | `field_interpretation` | `{formTemplateId, fieldPattern: /매출|차입금|인원/}` | 자동채움·fill planner에 직결. **가장 가치 높은 유형** |
| 4 | **작성 지침(하네스)** | "LLM에 반드시 넣어야 할 하네스" 01~07: 투자금·융자금·사업화자금 혼용 금지, 왜→사용처 순서, 금액-산출물 연결, 인건비 비중 주의, 상환 가능성 제시(립스1) 등 | `guide` / `evaluation` | `{formTemplateId: LIPS 사업계획서, fieldPattern: /자금.*계획/}` | draft 프롬프트 주입 + 평가 에이전트 채점 rubric 양쪽에 사용 |
| 5 | **수치 한도 규칙** | 프리립스 최대 1억(설립 1년 미만), 립스2 최대 2억(투자액 3배와 2억 중 작은 값), 립스1 융자 5배 최대 5억 / 정부지원금 ≤70%, 자기부담 현금 ≥10%, 현물 ≤20% | `fill_value` / `criteria` | `{program, fieldPattern: /사업비|지원금/}` | 결정론적 검증 규칙으로도 변환 가능 (validator) |

lesson이 아닌 것도 섞여 있고, 추출 패스가 분류해서 다른 경로로 보내야 한다:

- **제품 기능 요청**: "재무상태표 3개년치 PDF 업로드하면 자동 기입해주면 완전 편함"(p4) → 제품 백로그. lesson 아님.
- **FAQ 후보**: 현금/현물 구분(p9), 이종 업태·업종 의미(p2) → 검증 Q&A(9.9) 공개 후보.
- **golden case 후보**: 좋은/나쁜 작성 예시(p6~7의 예문들) → L2 exemplar bank(18.8) 소재.

**핵심 관찰**: 운영팀이 이미 "LLM에 반드시 넣어야 할 하네스"라는 표현을 쓴다(p5). 조직이 자연스럽게 lesson 단위로 지식을 생산하고 있다 — 파이프라인만 만들면 된다.

---

## 4. 현재 코드베이스 평가

**있는 것 (재사용 자산):**

| 자산 | 위치 | 본 계획에서의 역할 |
|---|---|---|
| `golden_set` / `eval_runs` 테이블 | `apps/web/src/lib/server/db/schema.ts` | lesson 효과의 회귀 측정 기반 |
| 리뷰어 워크스페이스 v1/v2 (`/internal/review`) | 세션 3~4 구축, 질문 카드 UX 검증됨 | **lesson 인박스를 신규 슬라이스로 추가할 자리** |
| 검수 확정=golden 승격 플로우 + 순환성 가드 | `promote-field-map-golden.ts` 등 | "사람 승격 게이트" 선례 — lesson 승격도 동형 |
| R2 + `document_artifacts` 저장 계층 | Phase 2/4 | 보고서 원본(불변) 보관 |
| LLM 배치 생성 선례 | `generate-review-questions.ts` (45문서 1,965문항) | 추출 패스 구현의 직접 참고 코드 |
| form_templates (구조 해시 재사용) | Phase 1 | lesson scope의 핵심 축 |

**없는 것:**

- `review_lessons` / `field_questions` 테이블 (18.5/18.6은 설계만 존재)
- lesson 검색·프롬프트 주입 경로 (Phase 8 전체 미착수)
- LLM draft 자체가 미구현 — 현재 draft는 deterministic fallback(`packages/core/src/documents/draft-generation.ts`)뿐. **즉, lesson을 주입할 소비처(Phase 5)가 아직 없다** → 로드맵에서 주입 경로는 Phase 5와 함께 성숙시킨다.

**설계 갭 (18장 대비 신규 식별):**

1. 유입 채널에 "운영 보고 문서"가 없음 (18.3은 질문/순회 2갈래) → §6에서 §18.11로 신설 제안.
2. `ReviewLesson`에 **시효 메타데이터 없음** — 지원사업은 회차마다 조건 변동(예: 가점 항목·한도 변경). `validFrom`/`reviewBy`/`programRound` 필요.
3. **출처 신뢰 등급 없음** — "공고문 명시" vs "담당자 구두 확인" vs "운영팀 추정"은 신뢰도가 다르다. 인터뷰 지식은 대부분 2번째 등급이며, 전문(傳聞) 오류 가능성을 시스템이 표현할 수 있어야 한다.

---

## 5. 기술 접근 평가 — RL·파인튜닝 vs 지식 루프

### 5.1 왜 지금 RL/파인튜닝이 아닌가

| 판단 축 | 평가 |
|---|---|
| **지식의 성격** | PDF의 내용은 사실·규칙(자격요건, 한도, 필드 해석)이고 **회차마다 바뀐다**. 업계 합의는 "fine-tuning is for form, not facts" — 주 단위로 바뀔 수 있는 지식을 가중치에 굽는 것은 stale 지식을 지우기 어렵게 만들 뿐이다 ([BigData Boutique, 2026](https://bigdataboutique.com/blog/fine-tuning-llms-when-rag-isnt-enough)) |
| **데이터 규모** | SFT/DPO는 검증된 교정 수천 건이 필요. 현재 golden 0건(검수 대기), 보고서 1건. 18.8 L4의 "수천 건 누적 후" 조건이 정확히 맞다 |
| **훈련 대상 부재** | 우리는 API 모델(Claude)을 쓴다. RL(GRPO/RLVR)은 자체 호스팅 가능한 오픈 모델에만 적용 가능 — 훈련할 가중치 자체가 없다. RLVR이 유의미해지는 시점은 "비용 절감을 위해 소형 자체 모델로 특정 패스(예: 필드 분류)를 이관"하는 결정 이후이며, 그때 우리 `golden_set`이 verifiable reward 소스가 된다 |
| **감사 가능성** | 공공 문서 도메인에서 "왜 이렇게 안내했나"에 출처로 답해야 한다. 컨텍스트 주입은 lesson id + 원문 인용이 남고, 가중치 학습은 남지 않는다 |
| **운영 부담** | 파인튜닝 채택 시 12개월 기준 훈련비의 3~5배 수명주기 비용을 잡으라는 것이 실무 권고 — 현 팀 규모에 비경제적 |

### 5.2 컨텍스트 기반 지속 개선이 SOTA와 정합하다는 근거

- **ACE (Agentic Context Engineering, [arXiv:2510.04618](https://arxiv.org/abs/2510.04618))**: 컨텍스트를 "진화하는 플레이북"으로 취급해 생성→반성→**큐레이션**의 증분 업데이트로 축적. 파인튜닝 없이 agents +10.6%, finance +8.6%, 소형 오픈 모델로 AppWorld 리더보드 1위급 프로덕션 에이전트와 대등. 우리 lesson 구조(증분 추가, 전역 프롬프트 누적 금지, scope 매칭)는 ACE가 지적하는 두 실패 모드 — **brevity bias**(요약하다 도메인 디테일 소실)와 **context collapse**(반복 재작성으로 지식 붕괴) — 를 구조적으로 회피하는 같은 계열이다.
- **기존 리서치 재확인**: `docs/research/2026-07-02-hitl-loop-sota.md` Q1 — lesson 주입은 "experiential memory / heuristic injection" 계열이며, 우리의 **사람 승격 게이트 + golden case 필수**는 자동 반영 계열 대비 도메인 안전성 강점.
- **2026년 실무 권장 순서**: Prompt → RAG(지식 주입) → Fine-tune(형식/스타일) → Distill(비용). 우리는 현재 1~2단계를 완성하는 것이 옳은 좌표다.

### 5.3 그래서 "강화"의 실체는 (18.8 재확인 + 보강)

| 단계 | 방법 | 본 계획에서의 위치 |
|---|---|---|
| L1 | lesson 검색 주입 | **본 계획의 중심** — 운영 보고서가 L1의 새 공급원 |
| L2 | exemplar bank (우수 작성 예시 재사용) | PDF의 예문들(p6~7)이 첫 소재 |
| L3 | 프롬프트/규칙 버전 개선 + eval 게이트 | lesson이 특정 scope에 5건+ 쌓이면 프롬프트 본문으로 병합 검토 (GEPA류 반성적 최적화 후보) |
| L4 | SFT/DPO 파인튜닝 | **발동 조건 명문화** (§7 Step 6) — 그 전까지 착수 금지 |
| (L5) | RL(RLVR/GRPO) | 자체 호스팅 모델 도입 결정 이후에만. `golden_set`+`eval_runs`가 그대로 reward/벤치마크가 되므로 **지금 지식 루프를 잘 쌓는 것이 곧 미래 RL의 준비**이기도 하다 |

---

## 6. 목표 아키텍처 — 제3 유입 채널 (마스터 §18.11 신설 제안)

```txt
[공급 주도 2 — 운영 보고 문서 (신설)]
운영팀이 보고서 업로드 (인터뷰 정리, 사용자 피드백 문서, 공고 해설)
  -> knowledge_sources에 불변 원본 등록 (R2 + 메타데이터)
  -> 추출 패스: 고성능 LLM이 항목 단위로 분해·분류
       lesson 후보 | FAQ 후보 | exemplar 후보 | 제품 피드백 | 잡음
     각 후보에 target/scope/instruction/rationale + 출처(페이지·원문 인용) + 시효 추정
  -> lesson 인박스 (리뷰어 워크스페이스 신규 슬라이스)
       운영자/리뷰어가 승인·수정·기각. 기존 lesson과 충돌 검출
  -> 승격: review_lessons(approved) — 이후는 기존 18.3 공통 파이프라인과 동일
  -> 적용: scope 매칭 주입 (fill planner / draft / 평가 / Tier 0)
  -> 검증: eval_runs 회귀 + repeat-error rate + 사용자 수정률 변화
```

**기존 원칙은 전부 유지한다**: 피드백의 프롬프트 직행 금지(추출 결과도 "후보"일 뿐, 승격 게이트 통과 전에는 주입 안 됨), 전역 프롬프트 누적 금지, 충돌 검출, lesson 적용의 evidenceRefs 기록.

### 6.1 스키마 확장

```ts
// 신규: 지식 원천 문서 (불변)
interface KnowledgeSource {
  id: string;
  kind: "ops_interview" | "user_feedback_report" | "official_announcement" | "program_faq";
  title: string;
  r2Key: string;                    // 원본 파일 (PDF 등)
  extractedTextKey: string | null;  // 추출 텍스트 캐시
  programHint: string | null;       // 예: "LIPS/TIPS"
  institutionHint: string | null;
  sourceDate: string;               // 문서 작성 시점 (시효 계산 기준)
  uploadedBy: string;
  status: "registered" | "extracted" | "curated";
  extractionRunId: string | null;   // versions 연계 (프롬프트 버전 추적)
}

// ReviewLesson(18.5) 확장 필드
interface ReviewLessonExt {
  // ... 기존 18.5 필드 유지 ...
  sourceKind: "reviewer_correction" | "field_question" | "ops_report";  // 유입 채널
  evidenceTier: "official_document" | "staff_confirmed" | "ops_inference";
    // 공고문·규정 명시 / 담당자 구두 확인(인터뷰) / 운영팀 추정
  sourceRefs: { sourceId: string; page: number | null; quote: string }[];  // 원문 인용 필수
  programRound: string | null;      // 예: "2026 LIPS 2차"
  validFrom: string;
  reviewBy: string | null;          // 이 날짜 이후 재검토 필요 (회차 갱신 주기 기반)
}
```

시효 운영 규칙: `reviewBy` 도래 lesson은 자동 retire가 아니라 **재검토 큐**에 올린다(다음 회차 공고문과 대조). `evidenceTier: staff_confirmed` lesson이 이후 공고문과 충돌하면 공고문이 이긴다 — 주입 시 tier를 프롬프트에 함께 표기해 모델이 확신 수준을 구분하게 한다.

### 6.2 추출 패스 설계

- 모델: Claude 최상위 모델(현 Fable/Opus). 구조화 출력으로 후보 배열 생성. `generate-review-questions.ts`의 배치 패턴 재사용.
- 프롬프트 핵심 규칙:
  - 항목당 **원문 인용(quote) 필수** — 인용 없는 후보는 생성 금지 (3.4 원칙의 추출판)
  - lesson / FAQ / exemplar / 제품 피드백 / 잡음 5분류
  - scope는 보수적으로: 문서에서 확인되는 범위만 (LIPS 문서에서 "모든 지원사업"으로 일반화 금지)
  - 시효 추정: 수치·조건 항목은 `reviewBy`를 다음 회차 예상 시점으로 제안
- 추출 프롬프트도 `versions`로 버전 관리, 추출 품질은 파일럿(Step 0)의 사람 검수 통과율로 측정.

### 6.3 주입 설계 (Phase 8과 공유)

- **소규모 단계(lesson <200건)**: 임베딩 불필요. scope 필드(program/institution/formTemplateId/fieldPattern) SQL 매칭 + 조건 텍스트를 프롬프트에 주입. 과공학 금지.
- **성장 단계**: contextual retrieval + BM25 하이브리드 (기존 리서치 Q4 결론, 핸드오프 남음 목록에 이미 등재).
- 주입 위치: ① fill planner(필드 해석·수치 한도) ② draft 프롬프트(작성 하네스) ③ 평가 에이전트 rubric(감점 패턴) ④ Tier 0 응답(전 유형). draft 결과의 `evidenceRefs`에 적용 lesson id 기록(18.5 기존 규칙).

---

## 7. 로드맵

현재 임계경로(리뷰팀 45문서 검수 → Gate 1 golden → Gate 2 측정)와 **독립적으로 병행 가능**하다. Step 0~1은 임계경로를 전혀 건드리지 않는다.

### Step 0. 파일럿 (세션 1개, 스키마 작업 없음) ← 즉시 착수 가능

- 이 PDF 1건으로 추출 패스 프롬프트를 시제작 → lesson 후보 추출 → 사람(운영팀/리뷰어) 검수
- 산출: ① 검수 통과 lesson 목록(마크다운, 임시 정본) ② 추출 프롬프트 v0 ③ **실측치**: 문서 1건당 고품질 lesson 수, 검수 통과율, 유형 분포
- 이 실측이 Step 1 이후의 투자 규모를 결정한다 (관문 의례의 축소판)

### Step 1. 스키마 + 인제스천 경로 (마이그레이션 1건)

- `knowledge_sources` + `review_lessons`(18.5 + §6.1 확장) 테이블
- 업로드 CLI 또는 admin 업로드 → R2 보관 → 추출 배치 스크립트 (`pnpm ingest:knowledge -- --source <file>` 형태, dry-run 기본 — 기존 스크립트 관례 준수)
- Step 0의 파일럿 lesson들을 첫 데이터로 임포트

### Step 2. lesson 인박스 (리뷰어 워크스페이스 슬라이스)

- `/internal/review`에 lesson 후보 검수 화면: 승인/수정/기각, 충돌 검출(같은 scope 다른 지침), 원문 인용 대조 뷰
- 질문 카드 UX 선례(v2) 재사용. 승격 가드는 golden 승격 가드(순환성 방지) 패턴 동형

### Step 3. 주입 경로 (Phase 5 Draft·Phase 8과 정렬)

- Phase 5의 fill planner / LLM draft 구현 시 **처음부터 lesson 주입 슬롯을 포함**해 설계 (소비처와 공급이 함께 성숙)
- scope SQL 매칭 → 프롬프트 주입 → evidenceRefs 기록
- 수치 한도형 lesson(유형 5)은 결정론적 validator로도 병렬 변환 (hallucination validator와 연계)

### Step 4. 측정·공개 루프

- lesson 적용 전/후 eval_runs 비교 (golden set 대상 — Gate 1 검수 완료가 전제)
- repeat-error rate, lesson별 적용 횟수·사용자 수정률 (18.10 지표 그대로)
- FAQ 후보의 검증 Q&A 공개 (9.9)

### Step 5. L2·L3 가동

- exemplar bank: 보고서의 우수 예문 + 검수 통과 draft를 few-shot 소재로
- 특정 scope에 lesson 5건+ 누적 시 프롬프트 본문 병합 검토 (GEPA류, eval 게이트 필수)

### Step 6. L4/RL 게이트 (착수 금지 조건의 명문화)

아래 **전부** 충족 전에는 파인튜닝/RL에 착수하지 않는다:

1. 검증된 교정(golden case 동반) **3,000건+** 누적
2. eval 인프라가 자동 회귀 게이트로 상시 가동 중
3. L1~L3로 해소되지 않는 **구조적 실패 패턴**이 eval에서 반복 확인됨 (예: 주입해도 무시되는 형식 준수 실패 — "facts가 아니라 form"의 문제일 때만 파인튜닝이 정답)
4. (RL의 경우) 자체 호스팅 모델 도입이 비용상 결정된 상태

---

## 8. 리스크와 방어 원칙

| 리스크 | 방어 |
|---|---|
| 인터뷰 지식의 전문(傳聞) 오류 — 담당자 개인 견해가 규정처럼 굳음 | `evidenceTier: staff_confirmed`로 명시, 주입 시 tier 표기, 공식 문서와 충돌 시 공식 우선. 고위험 항목(자격 배제 등)은 Tier 2 외부 검증 경로로 |
| 회차 변경으로 lesson stale (가점·한도 변동) | `reviewBy` 재검토 큐 + 다음 회차 공고문 대조 의례 |
| 지식 오염 (추출 오류가 대량 유입) | 승격 게이트 유지 — 추출 결과는 항상 후보. 원문 인용 없는 후보 생성 금지. 추출 프롬프트 버전별 검수 통과율 추적 |
| 스코프 과일반화 (LIPS 지식이 전 사업에 주입) | 추출 시 보수적 scope 규칙 + 충돌 검출 + scope 없는 lesson 승격 불가 |
| 보고서 내 민감정보 (기업 실명·재무 수치) | 원본은 internal R2 프리픽스, lesson 승격 시 인용문에서 특정 기업 식별정보 제거를 검수 항목에 포함 |
| "AI가 대신 써준다" 규제 리스크 (기존 리서치 Q5, NIH 선례) | 하네스형 lesson도 "사용자가 자기 근거로 정확히 쓰도록 돕는" 가이드 형태로 노출 — 기존 포지셔닝 유지 |

---

## 9. 성공 지표

- **인제스천**: 보고서 1건당 승격 lesson 수 / 추출 후보의 검수 통과율(추출 품질) / 업로드→승격 리드타임
- **효과**: lesson 적용 scope의 eval 점수 변화(전/후), repeat-error rate, 해당 필드 사용자 수정률 변화
- **커버리지**: 활성 lesson의 program/양식 커버리지, `reviewBy` 초과 lesson 비율(신선도)
- 기존 18.10 지표 체계에 통합

---

## 10. 참고 자료

- [ACE — Agentic Context Engineering (arXiv:2510.04618)](https://arxiv.org/abs/2510.04618) · [OpenReview](https://openreview.net/forum?id=eC4ygDs02R) — 컨텍스트 진화 기반 자기개선, 파인튜닝 대비 우위 실측
- [Fine-Tuning LLMs in 2026: When RAG Isn't Enough (BigData Boutique)](https://bigdataboutique.com/blog/fine-tuning-llms-when-rag-isnt-enough) — "form, not facts" / Prompt→RAG→FT→Distill 순서 / 수명주기 비용
- [Fine-tuning with RAG for Improving LLM Learning of New Skills (arXiv:2510.01375)](https://arxiv.org/abs/2510.01375)
- 사내: `docs/research/2026-07-02-hitl-loop-sota.md` (experiential memory 정합성, contextual retrieval, confidence 산출, LLM-judge, 규제)
- 마스터 아키텍처 18장 (지식 루프) · 18.8 (강화 단계)
