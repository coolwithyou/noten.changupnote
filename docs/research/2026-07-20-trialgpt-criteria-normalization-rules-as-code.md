# TrialGPT·조건 정규화·Rules as Code 관점의 창업노트 매칭 개선 연구

> 조사 기준일: 2026-07-20
>
> 성격: 실행 계획이 아닌 연구·설계 제안. 우선순위와 범위의 단일 기준은 `docs/plans/2026-07-13-matching-master-execution.md`다.
>
> 조사 범위: 현재 저장소 구현, 임상시험 자격 매칭 연구, 조건 정규화 연구, Rules as Code 정부·표준 자료, 2025~2026년 검색·근거 선택 연구.

## 0. 결론

**접근 가능성이 높고, 현재 창업노트는 이미 TrialGPT류 3단계 구조의 상당 부분을 갖고 있다.**

현재 제품 경로는 사실상 다음 구조다.

1. 활성 공고 우주를 만든다.
2. 공고별 조건을 `pass | fail | unknown`으로 판정한다.
3. 판정과 분리된 랭킹으로 노출 순서를 정한다.

따라서 큰 방향을 바꾸거나 LLM이 최종 자격을 직접 판단하게 할 이유는 없다. 개선 여지가 큰 부분은 다음 네 곳이다.

1. **평면 조건 목록을 논리 트리로 확장**: `(A AND B) OR C`, 예외, 기간, 기준일을 손실 없이 표현한다.
2. **공고와 회사 양쪽을 같은 개념 사전으로 정규화**: KSIC·인증·지원이력·기관명을 하나의 버전형 registry로 묶는다.
3. **후보 검색과 자격 판정을 분리**: BM25+임베딩 검색은 누락 없는 후보 확대·정렬에만 쓰고, 최종 판정은 현 결정론 엔진이 맡는다.
4. **unknown의 이유와 근거를 세분화**: 사용자에게 물어야 할 것, 운영자가 검수할 것, 아직 코드화할 수 없는 것을 구분한다.

가장 중요한 전제는 기존 마스터 결정과 같다. **22축을 늘리지 않고, LLM 직접 자격 판정을 도입하지 않으며, unknown을 임의로 통과시키지 않는다.** 외부 연구에서 가져올 것은 모델 자체보다 파이프라인 분해, 표현 구조, 근거 연결, 평가 방식이다.

---

## 1. 현재 창업노트와 TrialGPT의 대응 관계

### 1.1 현재 구현

| 단계 | 현재 구현 | 판정 |
|---|---|---|
| 조건 언어 | 22개 dimension, 7개 operator, required/preferred/exclusion (`packages/contracts/src/enums.ts:9-32`, `packages/contracts/src/index.ts:5-15`) | 원자 조건 어휘로는 충분하다 |
| 조건 정규화 | LLM 추출 + 결정론 backstop + 계약 검증 + 손실 없는 canonicalize (`packages/core/src/bizinfo/llm-criteria.ts:48-167`, `packages/core/src/bizinfo/deterministic-criteria.ts:7-79`, `packages/core/src/criteria/canonicalize.ts:12-18`) | 방향은 맞지만 개념 사전이 축별로 흩어져 있다 |
| 후보 우주 | 활성 상태·마감·중복 제거 후 전체 공고를 읽음 (`apps/web/src/lib/server/repositories/drizzle.ts:98-175`, `activeGrantFilter.ts:3-37`) | 현재 규모에서는 안전한 방식이다. 검색 recall 손실이 없다 |
| 조건별 판정 | criterion별 evaluator → hard fail이면 ineligible, unknown이면 conditional (`packages/core/src/matching/match.ts:61-108`) | TrialGPT의 criterion-level matching과 구조적으로 같다 |
| 최종 랭킹 | 신뢰 tier → eligibility → 추출 준비도 → relevance → priority 순 (`packages/core/src/use-cases/match-card.ts:408-470`) | 자격과 랭킹을 분리한 점이 특히 좋다 |
| 설명 | rule trace에 결과·공고 source span·회사 값을 기록 (`packages/contracts/src/index.ts:544-577`) | 근거 구조는 있으나 unknown 원인과 회사 evidence locator가 부족하다 |
| 추가 질문 | 여러 공고를 한 번에 해소하는 질문을 정보가치로 선택 (`packages/core/src/matching/question-planner.ts:67-190`) | 이미 능동적 feature acquisition에 가깝다 |

현재의 `GrantCriterion`은 `dimension + operator + value + kind`의 **평면 레코드**다 (`packages/contracts/src/index.ts:303-317`). matcher는 이 목록의 hard criterion을 사실상 AND로 결합한다. 이 구조는 단순 규칙에는 강하지만 다음 표현을 잃는다.

- `업력 7년 이내이면서 서울 소재, 또는 재창업기업`
- `A에 해당하되 B인 경우는 제외`
- `공고일 현재`, `신청일 기준`, `최근 3개년 중 2개년`
- 본점과 사업장 중 어느 주소를 사용할지
- 모호한 원문을 사람이 확정하기 전의 대안 해석

### 1.2 TrialGPT에서 그대로 가져올 부분과 가져오지 않을 부분

[TrialGPT](https://www.nature.com/articles/s41467-024-53081-z)는 ① 검색어 생성과 hybrid retrieval, ② 조건별 자연어 판정과 근거 문장 선택, ③ 조건 결과를 집계한 trial-level ranking으로 분해한다. 저자 보고 기준으로 전체 시험의 5.5%만 검토해 90% recall을 얻었고, criterion-level eligibility 정확도는 87.3%였다. NLM은 전문가 대비 screening 시간 42.6% 감소도 보고한다.

구조적 유사성은 크지만 그대로 복제하면 안 되는 차이도 크다.

| TrialGPT 요소 | 창업노트 적용 |
|---|---|
| retrieval → criterion matching → ranking 분리 | **채택**. 현재도 거의 같은 구조다 |
| lexical + semantic retrieval와 rank fusion | **조건부 채택**. 전체 판정 전 후보 정렬·비싼 처리 예산 배분에 사용한다 |
| 각 조건에 대한 근거 span | **강화 채택**. 공고 근거뿐 아니라 회사 데이터 근거도 연결한다 |
| `not enough information`과 `not applicable` 분리 | **채택**. 질문 가능 unknown과 코드화 불가를 분리한다 |
| LLM의 criterion-level 최종 판정 | **비채택**. 비용·재현성·이의제기·정책 변경 추적에서 현 결정론보다 불리하다 |
| 전체의 5~6%만 검색 후보로 사용 | **hard filter로는 비채택**. 지원 가능 공고 누락 비용이 크며 현재 전체 스캔이 가능하다 |

창업노트에서 TrialGPT의 가장 유용한 교훈은 "LLM이 더 잘 판단한다"가 아니라 **검색, 원자 조건 판정, 최종 랭킹의 실패를 서로 섞지 말라**는 것이다.

---

## 2. 외부 연구에서 얻는 설계 원칙

### 2.1 CriteriaMapper: 양쪽 데이터를 같은 개념 공간으로 보낸다

[CriteriaMapper](https://www.nature.com/articles/s41598-024-77447-x)는 임상시험 조건과 환자 EHR을 표준 용어 및 내부 knowledge base로 함께 정규화한 뒤 비교한다. 640개 조건 중 367개를 정규화했고, 보고된 매칭 F1은 0.94였다. 동시에 42.66%는 정규화하지 못했다. 이 실패 비율도 중요한 결과다.

창업노트에 대응시키면 다음과 같다.

- 공고의 `벤처기업`, `벤처 확인기업`, `벤처기업확인서 보유`
- 회사 프로필의 인증 코드와 외부 API 응답
- matcher가 비교하는 canonical value

세 층이 같은 `concept_id`를 가리켜야 한다. 현재도 KSIC 계층 (`packages/core/src/industry/ksic.ts`), 인증 alias (`packages/core/src/certification/certs.ts`), 과거 지원사업 alias (`packages/core/src/prior-award/canonical.ts`)가 있으나 축별 구현으로 흩어져 있다.

CriteriaMapper식 registry의 최소 필드는 다음이면 충분하다.

```ts
type MatchConcept = {
  conceptId: string;
  domain: "industry" | "certification" | "prior_award" | "agency";
  canonicalLabel: string;
  aliases: string[];
  broader?: string[];
  narrower?: string[];
  externalCodes?: Array<{ system: string; code: string }>;
  validFrom?: string;
  validTo?: string;
  source: string;
  reviewStatus: "draft" | "reviewed" | "deprecated";
};
```

정규화 순서는 `코드/정확 alias → 계층 규칙 → fuzzy/embedding 후보 생성 → 제한된 LLM disambiguation → unresolved`가 적합하다. 2026년 BioNLP의 [CENT](https://aclanthology.org/volumes/2026.bionlp-1/)도 semantic candidate matching과 LLM disambiguation의 결합이 각 단독 방식보다 낫다고 보고한다. 여기서 LLM은 개념 후보 중 하나를 고르거나 abstain할 뿐, 자격을 판정하지 않는다.

### 2.2 Chia·Criteria2Query: 평면 DSL보다 AST/DAG가 원문 충실도가 높다

[Chia corpus](https://pmc.ncbi.nlm.nih.gov/articles/PMC7452886/)는 12,409개 임상시험 조건을 41,487개 entity와 25,017개 relation으로 주석하고, 각 조건을 Boolean logic으로 변환할 수 있는 DAG로 표현했다. [Criteria2Query 3.0](https://pmc.ncbi.nlm.nih.gov/articles/PMC11129920/)도 자연어 조건을 곧바로 SQL로 던지지 않고 concept extraction, query generation, reasoning을 분리한다.

창업노트에서는 22축이 틀린 것이 아니라 **22축 원자 조건을 결합하는 상위 논리 계층이 비어 있다.** 다음 정도의 작은 AST면 대부분의 복합 조건을 표현할 수 있다.

```ts
type RuleNode =
  | { type: "all"; children: RuleNode[] }
  | { type: "any"; children: RuleNode[] }
  | { type: "not"; child: RuleNode }
  | { type: "predicate"; criterionId: string };

type RuleSetV2 = {
  root: RuleNode;
  criteria: GrantCriterion[];
  effectiveFrom?: string;
  effectiveTo?: string;
  referenceDate: "announcement" | "application" | "custom";
  sourceRevision: string;
  reviewStatus: "draft" | "reviewed";
};
```

도입 시 원칙은 다음과 같다.

- 현재 `GrantCriterion`과 22축 evaluator를 폐기하지 않는다. AST의 leaf로 재사용한다.
- 단순 AND 규칙은 현 포맷과 양방향 compile할 수 있게 한다.
- v2를 전체 공고에 즉시 적용하지 않고, 실제 복합 조건 20~30건으로 표현 가능성과 reviewer 시간을 먼저 측정한다.
- 표현하지 못한 조건을 억지로 구조화하지 않고 `uncomputable_rule`로 남긴다.

### 2.3 최신 검색 연구: semantic similarity만으로는 자격 매칭이 되지 않는다

[TrialMatchAI](https://www.nature.com/articles/s41467-026-70509-w)는 BM25와 k-nearest-neighbor 검색을 합친 후보 생성 뒤 criterion-level reranking과 eligibility 모델을 둔다. [FACTrial](https://aclanthology.org/2026.acl-long.874/)은 일반적 semantic similarity가 다요인 자격 판정을 놓친다는 문제에서 출발해, 서로 헷갈리지만 한 조건 때문에 탈락하는 near-miss negative를 학습에 사용한다.

2026년 PMLR의 [clinical trial eligibility matching 연구](https://proceedings.mlr.press/v297/leon-tramontini26a.html)는 모델·ranker 선택보다 기록 chunking, 자격 조건의 복잡도, **abstention 처리**가 결과에 더 큰 영향을 줄 수 있음을 보였다.

창업노트에 주는 함의는 명확하다.

1. 임베딩 모델 교체보다 조건 구조와 근거 완전성을 먼저 개선한다.
2. 검색 score를 eligibility score로 해석하지 않는다.
3. 검색기를 학습한다면 `거의 맞지만 한 조건에서 탈락하는 공고`를 hard negative로 쓴다.
4. abstention은 실패가 아니라 안전 동작으로 측정한다.

### 2.4 Rules as Code: 코드화는 파서가 아니라 정책 생명주기다

호주 정부의 [Rules as Code 구현 경험](https://www.govcms.gov.au/news-events/news/turning-policy-logic-insights-implementing-rules-code-0)은 정책을 코드로 옮기는 과정 자체가 원문의 모호성과 누락을 드러내며, 정책 담당자·도메인 전문가·개발자가 지속적으로 함께 검토해야 한다고 정리한다. [GovCMS RaC 가이드](https://www.govcms.gov.au/dxp/rules-code-rac)는 원문과 코드 규칙을 함께 유지하고, 구조화 질문·의사코드·테스트를 거쳐 구현하는 흐름을 제안한다.

[OECD Rules as Code 보고서](https://oecd-opsi.org/wp-content/uploads/2022/03/rac-wp.pdf)는 규칙의 기계소비 가능 버전을 자연어와 함께 제공하는 방식, text-code isomorphism, 추적성·책임성·이의제기 가능성을 강조한다. [OpenFisca](https://openfisca.org/doc/)도 변수·수식·파라미터·테스트를 분리하지만, 인간 판단을 자동화하거나 법령을 자동으로 정확히 파싱하는 도구는 아니라고 명시한다.

창업노트의 최소 rule package는 다음을 함께 가져야 한다.

- 원문과 source revision
- 사람이 읽는 한 문장 규칙
- executable AST와 canonical concepts
- 효력 기간과 판정 기준일
- 경계값·예외·반례를 포함한 테스트 사례
- 작성자·검수자·검수 상태
- 자동 판정 불가 시 manual review 이유
- 사용자 설명과 이의제기 시 되짚을 수 있는 trace fingerprint

DMN의 decision table/decision requirement graph와 LegalRuleML의 시간·관할·부정·출처 메타데이터는 **체크리스트로만** 참고할 가치가 있다. 지금 전체 표준이나 XML 스택으로 이관하는 것은 구현 부담이 이득보다 크다.

---

## 3. 개선안

### 3.1 P0 — 판정 재현성과 unknown 이유부터 고친다

#### A. `asOf`를 판정 전체에 관통시킨다

현재 `matchNormalizedGrant`는 `asOf`를 받지 않고 (`packages/core/src/matching/match.ts:111-119`), `buildTeaser`는 랭킹에만 `asOf`를 전달한다. 과거 지원이력·업력·기간 조건은 실행한 날에 따라 결과가 달라질 수 있다.

최소 수정 방향:

- 모든 matcher entry point가 명시적 `asOf`를 받는다.
- rule trace에 `asOf`, source revision, evaluator version, input evidence fingerprint를 남긴다.
- 같은 입력·같은 revision·같은 `asOf`는 항상 같은 결과를 내는 회귀 테스트를 둔다.

이는 새로운 기능이 아니라 Rules as Code가 요구하는 재현성 보강이다. 기존 마스터 WS-A에도 이미 미완료 항목으로 잡혀 있다.

#### B. atomic outcome reason을 추가한다

외부 API는 기존처럼 `eligible | conditional | ineligible`를 유지하되, 각 criterion의 `unknown`을 다음처럼 세분화한다.

| reason | 다음 행동 |
|---|---|
| `missing_company_fact` | 사용자 질문 또는 외부 데이터 충전 |
| `unreviewed_rule` | 공고 criterion 검수 큐 |
| `uncomputable_rule` | 수동 확인 또는 DSL 개선 후보 |
| `not_applicable` | 집계에서 별도 처리, 사용자에게 질문하지 않음 |
| `conflicting_evidence` | 최신성·출처 우선순위 검토 |
| `stale_evidence` | 데이터 재조회 |

현재 review gate는 집계 뒤 `needs_core_review`와 `needs_profile_input`을 구분하지만 (`packages/core/src/matching/match.ts:1304-1429`), atomic trace에서는 모두 `unknown`이다. 이 세분화는 question planner의 오질문과 운영 검수 큐 혼합을 동시에 줄인다.

### 3.2 P1 — Concept Registry v0를 만든다

새 지식 그래프나 별도 벡터 DB가 아니라, 현재 흩어진 KSIC·인증·과거사업·기관 사전을 하나의 versioned contract로 묶는다.

우선순위:

1. 현재 공고에서 빈도가 높거나 실제 오판정이 확인된 alias
2. 회사 API 응답과 공고 표현이 다른 concept
3. 상하위 관계가 판정에 필요한 KSIC·지역·인증
4. 과거 지원사업명처럼 연도·운영기관·약칭 변형이 많은 concept

자동 확정은 고정밀 경로만 허용한다. fuzzy/embedding/LLM 결과는 confidence가 아니라 **후보와 근거**를 남기고, 기준 미달이면 unknown으로 보낸다.

### 3.3 P2 — RuleSetV2를 복합 조건에만 shadow 적용한다

평면 criterion을 전면 교체하지 않는다. reviewed 공고에서 복합 논리·예외·시간 조건이 있는 20~30건을 골라 다음을 비교한다.

- 원문의 논리 구조를 손실 없이 표현했는가
- 현 matcher와 결과가 다른 경계 사례가 무엇인가
- reviewer가 현 포맷보다 빠르고 정확하게 검수하는가
- round-trip 시 source span과 원문 대응이 유지되는가
- 끝내 코드화할 수 없는 조건의 비율은 얼마인가

검증 뒤 단순 규칙은 현 포맷, 복합 규칙만 v2를 저장하는 공존 모델도 가능하다.

### 3.4 P3 — Hybrid retrieval은 shadow mode로만 시작한다

현재 `listActiveGrants`는 상태·마감·중복을 제거한 뒤 최근 갱신순으로 읽고, 전체 활성 우주를 matcher에 넣는다. 이 방식은 비효율적일 수 있지만 **검색기가 지원 가능 공고를 누락시키지 않는다는 안전성**이 있다.

검색 도입 조건은 규모나 비싼 처리 비용이 실제 병목일 때다. 그때도 다음처럼 도입한다.

```text
결정론 필터(status/deadline/dedup/reviewed audience)
  -> BM25 후보 ∪ dense 후보 ∪ canonical code 직접 hit
  -> reciprocal-rank fusion
  -> 현 criterion matcher
  -> 현 trust/eligibility/relevance/priority ranking
  -> 검색 누락 안전 표본 + full-scan fallback
```

처음에는 사용자 결과에 반영하지 않고 full scan을 oracle로 삼아 shadow 평가한다. `eligible/recommendable Recall@K`가 검증되지 않은 검색 결과를 hard exclusion에 쓰지 않는다.

### 3.5 P4 — 랭킹과 질문을 결과 데이터로 보정한다

현재 랭킹 report는 score 분포와 top 결과를 보지만 (`apps/web/src/lib/server/matches/report-match-ranking.ts:44-78`), 사람이 판단한 top-k 품질 지표는 없다. 반면 feedback에는 `wrong_high`, `wrong_low`, `applied`, `selected`, `rejected`가 이미 있다 (`apps/web/src/lib/server/matches/matchFeedback.ts:24-53`).

라벨이 쌓이면 다음 순서가 적합하다.

1. 현 가중치의 NDCG@10, Recall@20, MRR을 측정한다.
2. source·지역·사업 유형별 노출 편향과 false omission을 본다.
3. 해석 가능한 선형/단조 가중치를 먼저 보정한다.
4. 충분한 reviewed outcome이 생긴 뒤에만 learning-to-rank를 검토한다.

질문 planner는 이미 `영향받는 공고 수 + conditional 해소 수 - 사용자 노력`을 근사한다. 다음 단계는 실제 응답률과 답변 분포를 써서 `expected state change / effort`로 바꾸는 것이다. 온라인 bandit보다 먼저 replay 평가로 false-ineligible 위험과 질문 피로를 확인해야 한다.

---

## 4. 제안 실험

기존 마스터의 reviewed label 병목을 우회하지 않는다. 아래 실험은 새 범용 평가 인프라를 만들자는 제안이 아니라, 기존 reviewed packet·feedback·matching evaluator에 추가할 **연구 프로토콜**이다.

| 실험 | 표본 | 비교 | 핵심 지표 | 제안 통과 기준 |
|---|---:|---|---|---|
| E1 concept normalization | 공고 criterion 100건 + 대응 회사 값 | 현 축별 alias vs registry v0 | exact/hierarchical mapping precision·recall, abstention, reviewer 수정률 | auto-accept precision 0.98 이상, 나머지 abstain/review |
| E2 RuleSetV2 | 복합 조건 20~30건 | flat list vs AST | 논리 동등성, 경계 사례 통과율, unsupported 비율, 검수 시간 | gold case 100% 재현, silent coercion 0건 |
| E3 retrieval shadow | reviewed 회사-profile × active+archive 공고 | full scan vs BM25/dense/RRF | eligible·recommendable Recall@K, missed hard hit, latency | reviewed set에서 누락 0건을 우선 요구; 미달 시 full scan 유지 |
| E4 ranking | reviewer가 등급화한 top-k | 현 ranking vs hybrid feature | NDCG@10, Recall@20, MRR, source별 exposure | eligibility 순서 불변 + baseline 유의 개선 |
| E5 adaptive questions | golden/replay session | 현 heuristic vs expected value | 질문당 conditional 해소, 응답률, p50 질문 수 | 현 quality gate를 해치지 않고 해소율 개선 |

표본 크기가 작을 때는 단일 점수보다 오류 목록과 신뢰구간을 함께 본다. 특히 retrieval의 `누락 0건`은 성능 증명의 끝이 아니라 production hard filter로 쓰기 위한 최소 안전 조건이다.

---

## 5. 가치·비용·시점 판단

| 제안 | 기대 가치 | 구현 비용 | 주요 위험 | 지금 할지 |
|---|---|---|---|---|
| `asOf` 관통 + trace fingerprint | 높음 | 낮음 | entry point 누락 | **즉시** |
| atomic unknown reason | 높음 | 중간 | 계약·UI 영향 | **설계 후 조기 적용** |
| Concept Registry v0 | 높음 | 중간 | 검수 데이터 부족 | **reviewed 100건과 함께** |
| RuleSetV2 shadow | 중~높음 | 중간 | 과설계 | **복합 20~30건 한정** |
| hybrid retrieval shadow | 현재 중간, 규모 증가 시 높음 | 중간 | eligible 누락 | **병목 실측 후** |
| learn-to-rank | 잠재적으로 높음 | 높음 | outcome 편향·설명력 저하 | **라벨 축적 후** |
| OpenFisca/DMN/LegalRuleML 전면 이관 | 낮음 | 매우 높음 | 표준 적응 비용 | **하지 않음** |
| LLM 최종 자격 판정 | 단기 데모 가치는 있음 | 운영 비용·위험 높음 | 비결정성·이의제기 불가 | **하지 않음** |

### 권고 실행 순서

1. 기존 마스터의 사람 검수 100건을 진행하면서 concept alias와 복합 논리 사례를 함께 태깅한다.
2. `asOf`와 atomic unknown reason을 먼저 보강한다.
3. 그 100건에서 Concept Registry v0와 RuleSetV2 20~30건을 만든다.
4. 전체 스캔을 oracle로 hybrid retrieval을 shadow 평가한다.
5. top-k reviewed/feedback 데이터가 충분해진 뒤 랭킹과 질문 가중치를 보정한다.

이 순서의 장점은 외부 연구를 이유로 새 플랫폼을 먼저 만드는 일을 막고, 현재 가장 부족한 **검수된 정답 데이터**가 모든 개선의 입력이 되게 한다는 점이다.

---

## 6. 명시적 비목표

- 22개 dimension 추가·재설계
- LLM을 hard eligibility judge로 사용
- embedding score로 공고를 확정 탈락
- OpenFisca, DMN, LegalRuleML 전체 도입
- graph database 선행 도입
- reviewed label 없이 retrieval/ranking 성능을 자기평가
- 기존 평가 체계를 대체하는 새 범용 evaluation platform 구축

---

## 7. 참고 자료

### 임상시험 검색·매칭

- [TrialGPT: Matching Patients to Clinical Trials with Large Language Models, Nature Communications 2024](https://www.nature.com/articles/s41467-024-53081-z)
- [NLM TrialGPT 소개와 평가 요약](https://www.ncbi.nlm.nih.gov/research/trialgpt/about/)
- [TrialMatchAI, Nature Communications 2026](https://www.nature.com/articles/s41467-026-70509-w)
- [FACTrial, ACL 2026](https://aclanthology.org/2026.acl-long.874/)
- [Clinical trial eligibility matching: choice of language model, criteria complexity and record chunking, PMLR 2026](https://proceedings.mlr.press/v297/leon-tramontini26a.html)

### 조건 정규화·구조화

- [CriteriaMapper, Scientific Reports 2024](https://www.nature.com/articles/s41598-024-77447-x)
- [Chia: A large annotated corpus of clinical trial eligibility criteria, 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7452886/)
- [Criteria2Query 3.0, 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11129920/)
- [Criteria2Query 2.0, 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC9196697/)
- [CENT: Concept Extraction and Normalization Tool, BioNLP 2026 proceedings](https://aclanthology.org/volumes/2026.bionlp-1/)

### Rules as Code·의사결정 표준

- [Australian GovCMS — Turning policy into logic: insights from implementing Rules as Code, 2026](https://www.govcms.gov.au/news-events/news/turning-policy-logic-insights-implementing-rules-code-0)
- [Australian GovCMS — Rules as Code](https://www.govcms.gov.au/dxp/rules-code-rac)
- [OECD OPSI — Cracking the Code: Rulemaking for humans and machines](https://oecd-opsi.org/wp-content/uploads/2022/03/rac-wp.pdf)
- [OpenFisca documentation](https://openfisca.org/doc/)
- [OMG Decision Model and Notation overview](https://www.omg.org/intro/DMN.pdf)
- [OASIS LegalRuleML Core Specification 1.0](https://www.oasis-open.org/2021/09/08/legalruleml-core-specification-v1-0-oasis-standard-published/)

---

## 최종 판정

**TrialGPT류 접근은 창업노트에 적용 가능하다. 다만 가져올 대상은 LLM 판정기가 아니라 3단계 분해, criterion-level evidence, abstention, retrieval 평가다.**

창업노트의 다음 기술적 도약은 더 큰 모델이 아니라 다음 식에 가깝다.

```text
22축 원자 조건
+ 검수된 공통 concept registry
+ 시간·예외를 보존하는 작은 rule AST
+ 이유가 있는 3값 판정
+ 누락을 측정하는 retrieval/ranking 평가
= 설명 가능하고 확장 가능한 지원사업 매칭
```

현재 골격을 유지한 채 충분히 점진적으로 도입할 수 있으며, 가장 먼저 투자할 것은 모델이 아니라 reviewed criteria와 경계 사례다.
