# 지식 루프 · 품질 체계 최신 기술 대조 리서치

작성일: 2026-07-02
대상 설계: `docs/public-support-application-guide-master-architecture.md` 18장(지식 루프), 13장(품질 게이트), 8.7~8.8(자동채움·LLM draft)

> **범위/신뢰도 주의.** 이 문서는 2024~2026 공개 자료 기반이다. 벤더 블로그·마케팅 수치는 "출처가 벤더 자신"임을 명시하고, arXiv 프리프린트는 동료검증 전임을 전제로 인용한다. 검색 요약에서 나온 일부 arXiv ID는 실재 확인이 안 되어(미래 날짜 형식 등) 개별 인용에서 제외하거나 "미검증"으로 표기했다. 우리 설계에 대한 판정은 "이 근거로 이 정도까지 말할 수 있다" 수준으로만 적었다.

---

## 요약 (먼저 읽을 3가지)

1. **우리 "lesson 주입"은 2025년 연구에서 확립된 패러다임과 정확히 같은 계열이다** — "experiential memory / heuristic injection"(실패·성공에서 뽑은 휴리스틱을 관련성 스코어로 검색해 컨텍스트에 주입). 우리 설계의 차별점은 이 계열이 대개 자동 반영(agent가 스스로 휴리스틱 생성·주입)인 데 반해, 우리는 **사람 승격(큐레이션) 게이트 + golden case 필수 + scope 매칭**을 강제한다는 점이다. 이건 우리 도메인(공공 문서, 틀리면 신뢰 손상)에서 **유지해야 할 강점**이지, 뒤처진 설계가 아니다.

2. **평가 인프라는 "자체 테이블 유지 + 얇은 오픈소스 러너"가 2026년에도 스타트업 정답에 가깝다.** promptfoo는 2026-03 OpenAI에 인수되어(비-OpenAI 팀엔 중립성 리스크) golden set을 벤더에 종속시킬 이유가 약해졌다. 우리 `golden_set`/`eval_runs`가 이미 있으므로 **회귀 러너(CI 게이트)만 promptfoo로 얇게 붙이는 하이브리드**가 재고 없이 유지 가능한 지점이다.

3. **재고가 필요한 실측 근거가 하나 나왔다: 우리가 confidence를 어떻게 산출하는지 설계에 비어 있다.** 2025~2026 연구는 (a) structured JSON 출력에서 logprob이 0.999+로 포화해 신뢰도 신호로 무용, (b) **Claude는 애초에 logprob을 제공하지 않음**을 지적한다. 우리 스키마 곳곳의 `confidence: number`는 "무엇으로 계산하는가"가 정의돼야 하며, 현실적 답은 **self-consistency(다중 샘플 일치도) + evidence 정렬 여부 + judge/rubric 점수**의 조합이다.

---

## Q1. 교정→지식 축적 패턴의 최신 위치

### 발견

**(a) "Experiential memory / heuristic injection"이 우리 lesson 주입의 학술적 이름이다.**
2025년 다수 연구가 "과거 궤적을 반성(reflect)해 재사용 가능한 휴리스틱 풀을 만들고, 새 태스크마다 관련성 스코어로 top 후보를 컨텍스트에 주입"하는 구조를 제시한다. 이게 우리 `review_lessons.scope 매칭 → 프롬프트 주입`과 구조적으로 동일하다. 주목할 실측 주장: **실패에서 유도된 휴리스틱(negative constraint)이 성공 휴리스틱보다 대체로 더 효과적**이라는 보고 — 우리는 현재 "교정(주로 오류 수정)"을 lesson으로 남기므로 자연스럽게 이 결에 맞다.
- Agent Memory 서베이/논문 리스트: https://github.com/Shichun-Liu/Agent-Memory-Paper-List
- (프리프린트, 미검증 포함) Live-Evo / EvolveMem / Evo-Memory 계열 — self-evolving memory 벤치마킹. 개념 방향 참고용: https://arxiv.org/html/2511.20857v1

**(b) DSPy/GEPA류 프롬프트 최적화는 우리 L3(프롬프트/규칙 버전 개선)와 붙는 지점이다.**
GEPA는 스칼라 지표가 아니라 **자연어 피드백(무엇이 왜 틀렸는지)**으로 프롬프트를 반성적으로 진화시켜, RL(GRPO) 대비 최대 20% 향상 · rollout 35배 절감, MIPROv2 대비 10%+ 향상을 벤더/논문이 보고한다(ICLR 2026 발표 주장). 우리 lesson은 사실상 사람이 쓴 자연어 피드백이므로, **GEPA는 "lesson을 프롬프트 본문으로 자동 병합·정제하는 L3 단계의 후보 도구"**로 볼 수 있다.
- GEPA 논문: https://arxiv.org/abs/2507.19457
- DSPy GEPA 튜토리얼: https://dspy.ai/tutorials/gepa_ai_program/
- 프로덕션 적용기(Decagon): https://decagon.ai/blog/optimizing-gepa-for-production

**(c) Constitutional/rubric 방식과의 관계.**
Constitutional AI는 "원칙(rubric)을 자기비판·RL에 사용"하는 정렬 기법으로, **모델 가중치를 바꾸는** 접근이다. 우리 18.1의 "이건 가중치 학습이 아니라 지식 루프"라는 선언과 층위가 다르다. 다만 rubric 개념 자체는 우리 평가 에이전트(품질 채점)와 LLM-judge에 그대로 쓸 자산이다(Q3 참조).
- Constitutional AI: https://www.anthropic.com/research/constitutional-ai-harmlessness-from-ai-feedback
- Claude's Constitution: https://www.anthropic.com/news/claudes-constitution

### 대조표 (Q1)

| 설계 항목 | 판정 | 근거 |
|---|---|---|
| lesson = scope 달린 조건부 지침, 검색 주입 | **유지** | experiential memory / heuristic injection과 동형. 업계 표준 계열 |
| approved lesson만 주입(피드백 프롬프트 직행 금지) | **유지(강점)** | 자동-반영 memory 연구 대비 우리의 큐레이션 게이트는 도메인 안전성에서 우위. 논문들도 "노이즈 메모리 오염"을 위험으로 지목 |
| lesson은 golden case 동반 필수 | **유지(강점)** | 회귀 측정 가능성 확보. self-evolving memory 계열의 약점(효과 검증 부재)을 우리는 구조로 방어 |
| 전역 프롬프트 누적 금지, scope 매칭만 | **유지** | "메모리 무한 성장 → 컨텍스트 오염" 문제의 정석 대응 |
| L3(프롬프트/규칙 버전 개선)의 방법 미정 | **보강** | GEPA류 반성적 최적화를 L3의 구체 도구로 검토. lesson을 입력 피드백으로 사용 |
| 실패 유래 교정 우대 | **보강(선택)** | 실패 휴리스틱이 더 효과적이라는 보고 → lesson 우선순위/가중에 반영 여지 |

---

## Q2. 평가 인프라 생태계 (자체 테이블 vs 도구 채택)

### 발견

**2026년 지형:**
- **promptfoo**: 오픈소스·개발자 우선·로컬/CI 게이트에 강함. **2026-03-09 OpenAI가 인수**(총 조달 $23M, $86M 밸류에서). 비-OpenAI 스택 팀엔 중립성 리스크가 생겼다.
  - OpenAI 발표: https://openai.com/index/openai-to-acquire-promptfoo/ · TechCrunch: https://techcrunch.com/2026/03/09/openai-acquires-promptfoo-to-secure-its-ai-agents/
- **Braintrust**: 프로덕션 관측+실험을 통합한 "가장 완결형 단일 플랫폼"으로 평가됨(고객: Notion·Replit·Cloudflare·Ramp 등). *주의: 검색 요약에 나온 "$80M Series B / $800M 밸류(2026-02)"는 이번 조사에서 1차 출처로 재확인하지 못했다 — 미검증.*
  - 벤더 비교글(편향 있음, Braintrust 자체 게시): https://www.braintrust.dev/articles/best-prompt-evaluation-tools-2025
- **LangSmith**: LangChain 스택 팀에 최적, 관측성 통합. 진입가 낮음($39/seat 주장, SOC2 Type II 포함 주장 — 벤더/3자 요약 기준).
- **OpenAI Evals**: 벤치마킹·재현성 중심, 러너로선 rigor 높으나 UX는 투박.
- 종합 비교(3자): https://arize.com/llm-evaluation-platforms-top-frameworks/ · https://inference.net/content/llm-evaluation-tools-comparison/

**실무 결론(한국 스타트업, 자체 golden set 이미 보유):**
golden set은 **제품의 해자**다. 정답 라벨(우리 Gate 1 자산)을 벤더 SaaS에 종속시키는 건 데이터 주권·비용·중립성(특히 promptfoo→OpenAI) 관점에서 불리하다. 우리가 이미 `golden_set`/`eval_runs`/`versions`를 갖고 있으므로 **"데이터는 우리 DB, 러너만 얇게 오픈소스"**가 합리적이다.

### 대조표 (Q2)

| 설계 항목 | 판정 | 근거 |
|---|---|---|
| golden set + eval_runs 자체 테이블 보유 | **유지** | golden set = 해자. 벤더 종속 회피. promptfoo의 OpenAI 인수로 중립성 리스크 부각 |
| 회귀 측정을 자체 구현으로 전부 부담 | **보강** | 러너·리포트·CI 게이트는 promptfoo(오픈소스, self-host) 얇게 도입해 개발 비용 절감. golden 데이터는 계속 우리 DB에 |
| L3 "eval_runs 회귀 없음"을 릴리스 게이트로 | **유지** | 업계 표준(pre-deployment eval gate)과 일치 |

**도입 후보:** promptfoo(self-hosted)를 CI에 붙여 `golden_set(kind=field_map)` → promptfoo test spec 어댑터만 작성. **비용 낮음**(오픈소스, 우리 데이터 export 어댑터 1개), **효과: 러너 재발명 회피 + 로컬 프롬프트 실험 루프 확보**. 단, 벤더 SaaS 대시보드/실험관리는 채택하지 않고 자체 유지 권장.

---

## Q3. LLM-as-judge와 자동 검수 (사람 검수 병목 완화)

### 발견 (실측 뉘앙스 중요)

- **단일 judge의 인간 일치도는 생각보다 낮다.** SOTA judge의 Fleiss' κ ≈ 0.3 수준 보고가 있는 반면, rubric 고정·도메인 한정 조건에서 Pearson 0.86~0.90 · Krippendorff α 0.87의 높은 값도 보고된다 → **"judge는 rubric·도메인·프로토콜 설계에 따라 신뢰도가 크게 갈린다"**가 실측 결론.
- **앙상블/배심(jury)이 로버스트니스를 올린다.** majority-vote·minority-veto, judge별 신뢰도 예측 후 가중(Jury-on-Demand), 회귀 기반 캘리브레이션 등이 개별 judge 편향을 보정.
- **편향 통제 실무:** 후보 순서 랜덤화, 이진 채점+설명 강제, judge 모델 선택이 positional bias에 가장 큰 영향.
- 출처: https://arxiv.org/pdf/2606.19544 (Reliability without Validity, 대규모 judge 평가 · 프리프린트) · https://galileo.ai/blog/llm-as-a-judge-vs-human-evaluation · rubric 방법론: https://medium.com/@adnanmasood/rubric-based-evals-llm-as-a-judge-methodologies-and-empirical-validation-in-domain-context-71936b989e80

**우리 교차 라벨링과의 정렬:** 우리 8.4~8.6의 **불일치 기반 리뷰 큐**(vision/text/layout이 어긋나면 reviewRequired)는 정확히 "disagreement-based prioritization"이다. 능동학습 연구가 **"모델들이 불일치하는 지점이 라벨 정보량이 가장 높다"**를 뒷받침한다. 한 산업 사례는 10만 중 1천만 라벨해도 전량 라벨과 유사 정확도 도달을 주장.
- disagreement sampling: https://www.emergentmind.com/topics/disagreement-based-sampling · LLM-in-the-loop AL 서베이: https://aclanthology.org/2025.acl-long.708.pdf

### 대조표 (Q3)

| 설계 항목 | 판정 | 근거 |
|---|---|---|
| 불일치(vision/text/layout) → reviewRequired 우선순위 | **유지(강점)** | disagreement-based sampling과 정합. 검수 병목 완화의 정석 |
| 사람 검수 45문서 대기 병목 | **보강** | LLM-judge를 "1차 필터"로: 명백 합치(3경로 일치+evidence 정렬)는 auto, 불일치·저신뢰만 사람. judge는 rubric 고정+이진판정+순서랜덤화로 설계 |
| Gate 1에서 AI 사전라벨을 golden 승격 금지(순환성 회피, CLAUDE.md) | **유지(강점)** | judge/AI 라벨 신뢰도의 근본 한계(κ≈0.3 사례)를 우리 규칙이 이미 방어 |
| judge 단일 모델 사용 가정 | **보강(선택)** | 고위험 필드(자격·예산)엔 다중 모델 배심/minority-veto 검토 |

**도입 후보:** "auto-pass 판정기" = 3경로 합치 + evidenceRefs 존재 + rubric judge 통과 시 자동 라벨, 그 외 사람 큐. **비용: 중간**(judge 프롬프트+rubric 설계, judge용 소형 golden 필요). **효과: 사람 검수량을 불일치·저신뢰 케이스로 집중 → 45문서 대기 완화.** 단, **judge를 golden 승격에 쓰지 않는다**는 CLAUDE.md 원칙은 유지(judge는 트리아지, 정답은 사람).

---

## Q4. 구조화 추출의 신뢰도 기법 (우리 evidenceRefs 필수 정책과 대조)

### 발견 (설계에 직접 영향)

**(1) evidence grounding은 옳지만 "인용 붙였다≠근거로 썼다".**
2024~2026 연구는 **post-rationalization** 문제를 지적한다 — 모델이 표면적으로 관련된 근거를 붙이고 실제론 파라메트릭 지식으로 답을 만든다. 인용 기반 지표가 이걸 잘 못 잡는다. 함의: **evidenceRefs를 "제출"받는 것으로 끝내면 안 되고, 값이 근거 span에서 실제로 도출됐는지 검증(span-level 정렬)**해야 한다.
- RAG 서베이: https://arxiv.org/html/2507.18910v1 · 인용 강제 프롬프팅(의료): https://www.mdpi.com/2076-3417/16/6/3013

**(2) structured output + confidence의 함정 (가장 중요한 실측).**
- **JSON structured output에서는 logprob의 99.4~100%가 0.999+로 포화** → logprob 기반 confidence가 상수처럼 무의미해진다.
- **Claude는 logprob을 제공하지 않으며**, OpenAI reasoning 모델도 reasoning 활성 시 logprob을 숨긴다(2026-03 기준).
- 대안으로 검증된 방향: **self-consistency(다중 샘플 일치도)**, **verbalized uncertainty(모델이 말로 낸 확신도, 단 캘리브레이션 필요)**, atomic-fact 단위 검증(사실성 31~35% 개선 보고).
- 출처: https://aclanthology.org/2025.semeval-1.38.pdf (token-level self-consistency) · self-consistency detection: https://www.emergentmind.com/topics/self-consistency-based-hallucination-detection · verbalized uncertainty: (프리프린트) https://arxiv.org/pdf/2606.27023

**(3) Contextual Retrieval (Anthropic, 2024-09, 1차 출처로 수치 확인).**
청크에 문서 맥락을 prepend해 임베딩/BM25 인덱싱 → **top-20 검색 실패율 49% 감소(5.7%→2.9%), 리랭킹 결합 시 67% 감소(→1.9%)**. lesson·FAQ·golden을 Tier 0가 검색 주입할 때(18.2), 청크가 맥락을 잃으면 "기관 X 양식 Y" 같은 scope 신호가 검색에서 탈락한다 → **lesson/FAQ 인덱싱에 Contextual Retrieval + BM25(정확 매칭: 기관명·양식명·필드 라벨) 하이브리드**가 직접 유효.
- 1차 출처: https://www.anthropic.com/engineering/contextual-retrieval

### 대조표 (Q4)

| 설계 항목 | 판정 | 근거 |
|---|---|---|
| evidenceRefs 필수, 근거 없으면 null(3.4) | **유지(강점)** | grounding 정석. 우리 "숫자/실적은 근거 없으면 null"은 post-rationalization 위험을 원천 차단 |
| evidenceRefs를 "제출"로 신뢰 | **보강** | 인용≠사용. 값↔근거 span 정렬 검증(validator)을 8.8 결과 validator에 추가 |
| 스키마 곳곳 `confidence: number` 산출법 미정 | **재고** | JSON 출력 logprob 포화 + Claude logprob 미제공 → confidence 정의 필요. self-consistency + evidence 정렬 + judge 점수 조합으로 규정 |
| Tier 0의 lesson/FAQ/golden 검색 주입(18.2) | **보강** | Contextual Retrieval + BM25 하이브리드로 scope 검색 실패율 감소(벤더 실측 49~67%) |
| 사용자에겐 숫자 대신 적합도 라벨(9.9) | **유지(강점)** | 캘리브레이션 안 된 숫자 confidence 노출 위험 회피. 연구도 verbalized uncertainty 캘리브레이션 난점 지적 |

**도입 후보 A — confidence 재정의:** 각 필드 draft에 대해 (i) 저온 다중 샘플 self-consistency, (ii) 값의 evidence span 정렬 통과 여부, (iii) rubric judge 점수를 결합한 **합성 confidence**를 정의하고, 이 값으로 13장 임계값/휴먼터치를 구동. **비용: 중간**(샘플 N배 호출↑, 정형 copy 필드는 제외해 비용 억제). **효과: "숫자가 있는데 의미가 없는" 상태 해소, 게이트 신뢰성↑.**

**도입 후보 B — 근거 정렬 validator:** value가 evidenceRefs의 span에서 도출 가능한지 결정론적/경량 LLM 검증. **비용: 낮~중**. **효과: post-rationalization 차단, hallucination report rate↓.**

---

## Q5. 유사 제품/도메인 사례 (grant/form-writing AI, 실패 포함)

### 발견

**해외 grant-writing AI 지형:**
- **Grantable**: RFP 업로드→구조화 응답, 서사 자동생성 특화(속도 강점).
- **Granter.ai / Granted**: "50만+ 성공 제안서 학습" 주장, autonomous agent 중심(DB·관리기능이 agent를 보조). — https://granter.ai/
- **Grantboost / Instrumentl**: 발견·관리 허브형 vs 작성형으로 포지션 분화.
- 3자 정리: https://www.instrumentl.com/blog/best-ai-for-grant-writing · https://clickup.com/blog/ai-tools-for-grant-writing/

**공개된 핵심 교훈(실패 신호 포함):**
1. **"제네릭 AI 문장은 심사자가 즉시 알아챈다."** 조직 고유의 목소리·현지 맥락·펀더 이해가 빠진 초안은 감점 요인. → 우리 3.4/3.5(근거 기반+휴먼 터치)와 8.7(evidence 요약/생성 분리)이 이 실패를 구조적으로 방어. **우리 강점 확인.**
2. **규제 리스크가 실재한다 — NIH 정책(1차 출처 확인).** 2025-07-17 NIH `NOT-OD-25-132`: **"AI가 상당 부분 작성한 지원서는 원본으로 간주하지 않아 심사 제외"**, PI당 연 6건 상한(2025-09-25 발효). 배경: 일부 PI가 AI로 한 라운드에 40건+ 제출. → **우리 포지셔닝("자동 제출 대행 아님, 작성 가이드/검토 가능한 초안")이 규제 방향과 정합.** 제품 카피·UX에서 "AI가 대신 써준다"가 아니라 "사용자가 자기 근거로 정확히 쓰도록 돕는다"를 유지해야 한다.
   - 1차: https://grants.nih.gov/grants/guide/notice-files/NOT-OD-25-132.html · https://grants.nih.gov/news-events/nih-extramural-nexus-news/2025/07/apply-responsibly-policy-on-ai-use-in-nih-research-applications-and-limiting-submissions-per-pi · 해설: https://www.science.org/content/article/fearful-ai-generated-grant-proposals-nih-limits-scientists-six-applications-year

> 한국 공공 지원사업엔 아직 NIH급 명문 규정이 공개적으로 확인되진 않았으나(이번 조사 범위 밖), **동일 방향의 규범 리스크가 언제든 생길 수 있다**는 전제로 설계하는 게 안전하다.

### 대조표 (Q5)

| 설계 항목 | 판정 | 근거 |
|---|---|---|
| "자동 제출 대행 아님 / 작성 가이드"(2·15·21장) | **유지(강점)** | NIH 등 규제 방향과 정합. AI 전면작성 리스크 회피 |
| evidence 없는 서사 생성 금지(3.4) | **유지(강점)** | "제네릭 AI 문장 감점" 실패 사례를 구조로 방어 |
| 제출 전 검토 필수 명시(15장) | **유지** | 규제·신뢰 양면에서 정합 |
| "AI가 써준다" 뉘앙스 카피 위험 | **보강** | 마케팅 문구를 규제 안전 방향(사용자 주도·검토 가능)으로 명시 관리 |

---

## 종합: 우리 설계에서 재고가 필요한 지점 (우선순위)

1. **[재고] confidence 산출 정의가 비어 있다.** 스키마 전반의 `confidence: number`가 무엇으로 계산되는지 없음. JSON structured output에서 logprob은 포화(0.999+)·Claude는 logprob 미제공이라, **self-consistency + evidence 정렬 + rubric judge의 합성 confidence**로 규정 필요. 이게 13장 임계값·휴먼터치·9.9 적합도 라벨의 신뢰 근거를 지탱한다. (근거: SemEval 2025 token self-consistency, structured output logprob 포화 보고)

2. **[보강] evidenceRefs를 "제출"에서 "검증"으로.** 인용≠사용(post-rationalization). 8.8 validator에 **값↔근거 span 정렬 검사**를 추가. 우리 grounding 정책의 실효를 담보. (근거: RAG 서베이·인용강제 연구)

3. **[보강] lesson/FAQ/golden 검색 주입에 Contextual Retrieval + BM25 하이브리드.** scope 신호(기관·양식·필드 라벨)는 정확 매칭이 중요 → 순수 임베딩만으론 탈락. Anthropic 실측 검색 실패율 49~67% 감소. Tier 0 즉답 품질·repeat-error rate에 직접 영향.

나머지(lesson 승격 게이트, golden 필수, 자체 eval 테이블, 불일치 기반 검수 우선순위, "작성 가이드" 포지셔닝)는 **최신 연구·규제 방향과 정합하는 강점**으로, 유지 권장. 도구는 promptfoo(self-host 러너)만 얇게 붙이고 golden 데이터는 우리 DB에 두는 하이브리드가 재고 없이 유지 가능한 선택이다.

### 불확실성 명시
- Braintrust 최신 라운드/밸류 수치는 미검증(1차 출처 미확인).
- 다수 arXiv 프리프린트는 동료검증 전 · 일부 검색요약 ID는 실재 미확인이라 개념 방향 참고로만 사용, 수치 단정 회피.
- GEPA·Contextual Retrieval의 향상 수치는 각각 논문/벤더 자체 실험 기준 — 우리 도메인(HWP 양식·한국어 공공문서) 재현은 별도 측정 필요.
- 한국 공공 지원사업의 AI 작성 규제는 이번 조사에서 확정 자료 미발견(범위 밖).
