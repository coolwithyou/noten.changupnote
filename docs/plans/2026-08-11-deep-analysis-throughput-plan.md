# 딥분석·Kordoc 단건 처리 속도 개선 계획

> 작성일: 2026-08-11
> 상태: T0·T1·T4 일부 채택·구현, CP2 repair 게이트 실패(2026-08-13 00:58 KST 최종: 성공 10건 중 repair 7건). 현황 정본은 `docs/research/2026-08-13-딥분석-처리속도-트랙-리뷰-정리.md`.
> 범위: lab 구독(claude-cli) 경로의 단건·배치 처리 속도. 품질 게이트 계약(quality-graph·promote)은 절차로만 관통하고 완화하지 않는다.
> 비범위: 운영 API 경로 변경, 22축 매칭 규칙 변경, 수집 정책 변경.
> 근거 조사: 같은 날 오전 10건 배치(run-2026-08-11T015659.*) 실측 + 과거 run 데이터 마이닝 + 실코드 경로 A/B 마이크로벤치. 세부 수치는 §2.

## 1. 결론

10건 배치의 건당 평균 57분(최대 78.5분)은 단일 원인이 아니라 **호출당 지연 × 호출 수 × 슬롯 경합**의 곱이다. 검증 결과 각 인수는 독립적으로 줄일 수 있고, 서로 간섭하지 않는다.

- 호출당 지연: Kordoc 판정 호출의 지연은 사실상 전부 **출력 토큰 생성 시간**이다(40후보 opus 호출 91초 중 스폰+인증 5초, 출력 8.0k 토큰 생성 ≈ 86초). 검증된 레버는 **2단 effort 설계(T1: round 0 medium + 거절 임계 0.85 — 순효과 −20~30%, §2-3-3)**와 **출력 다이어트(T2)**다. 당초 유력해 보였던 sonnet 교체 단독은 A/B에서 **역효과로 반증**됐고(§2-3), 순수 effort 하향도 입력 필드 조용한 누락(low 4건·medium 3건)으로 **기각**됐다(§2-3-1~3).
- 호출 수: 배치 기준 공고당 평균 14.6회(Kordoc 12.8 + 딥 1.8). 재판정 통합(T3)과 첫 패스 repair 해소(T4)가 이 인수를 줄인다.
- 슬롯 경합: 전역 `claude -p` 4슬롯에 인플라이트 10건이 몰려 요청당 큐 대기가 실행 시간의 2~3배. 운용 변경(T0)만으로 즉시 줄어든다.

권장 실행 순서는 **T0(운용, 즉시) → T1(effort canary — 코드 소변경) → T4(계측+repair 해소) → T2(출력 다이어트) → T3·T5(구조 변경)**다. sonnet 교체(T1b)는 effort low와 결합할 때만 추가 이득(−24%)이 있고 채택 변경 절차가 필요하므로 선택 항목으로 뒤로 뺀다.

## 2. 검증된 사실 (2026-08-11)

### 2-1. 10건 배치 실측 (run-2026-08-11T015659.*, opus-5, claude-cli, bs40, 공고 인플라이트 10)

- 건당 wall 26.6~78.5분, 평균 ≈57분. 모든 run에서 Kordoc wall ≈ run 전체 wall(딥은 sidecar 병렬로 항상 먼저 종료).
- 총 `claude -p` 호출 146회 = Kordoc 128(primary 92 + 재판정 등 extra 36) + 딥 18(primary 10 + repair 8).
- 배치 wall 78.5분 × 4슬롯 = 314 슬롯-분 ÷ 146회 ≈ **호출당 실행 2.15분** — 무경합 canary(2.3분)와 일치. 4슬롯이 내내 포화였고, 개별 호출이 느려진 게 아니라 큐 대기가 건당 wall을 부풀렸다.
- 후보 폭발 사례: 936후보/문서(125015) → 27요청, 638후보(124870) → 22요청. claude-cli 경로는 후보 상한이 없다(`field-planner.ts:100`, candidateLimit null — 의도된 선택).
- 재판정(추가 라운드) 요청 36회가 다룬 후보 합계는 398개 — 40개 묶음으로 통합했다면 **10요청**이면 충분했다(요청 20% 절감 여지).
- 문서 순차 루프: 7첨부 공고(124921)는 판정 대상 문서 6개를 직렬 통과(42.7+15.0+9.2+5.8+3.5+2.1분 합산 = 78.3분).

### 2-2. 과거 run 마이닝

- 요청당 wall p50: bs20 시절(08-05~10, 972요청) 1.13분 vs bs40(08-11 배치, 159요청) 3.06분. **묶음 2배 → 요청당 출력 2배 → 요청당 시간 2배** — 묶음 확대는 요청 수만 줄였고 총 생성 시간은 거의 그대로였다(이득은 큐 대기·오버헤드 절감분).
- 요청당 출력: bs20 ≈ 5.1k tok, bs40 ≈ 7.6k tok → **후보당 ≈ 190~255 tok**. 이 출력량(help_text ≤500자 + evidence ≤300자 + 라벨)이 곧 지연이다.
- repair 상수화의 기점은 **lab-deep-v11(08-09, 커밋 4124101)** — validated-primary(validator→repair 루프)가 lab 경로에 켜진 시점이다. v5~v10 81런 repair 0, v11 이후 87%가 repair ≥1, run당 출력 토큰 ~21k → ~40k(≈2배). repair는 22축 전체를 다시 생성하는 풀 패스다(`repair.ts:169-185`). 결정적 교정(span 표기·비매칭 criterion 제거)이 먼저 시도되지만(3ba7a8c), 출력 토큰 추이상 대부분 모델 repair까지 간다.
- 딥 1패스(opus-5, effort high) ≈ **3.5~4분**(Kordoc 재사용 canary 6466ad·3bacd4에서 역산). 배치에서 딥 18패스 ≈ 슬롯 풀의 20~23%.

### 2-3. 실코드 경로 A/B 마이크로벤치 (125015 실공고 kordoc-form 후보 40개, 동일 묶음, planRoundtripFields + buildClaudeCliFetch)

| 변형 | wall | 요청 | 출력 tok | 판정 분포 | 배치 opus 실측과 일치 |
|---|---:|---:|---:|---|---|
| opus-5 (현행, effort 미지정) | 91.3초 | 1 | 8,047 | input 32 / not_input 8 | 40/40 |
| sonnet-5 (effort 미지정) | 총 156.6초 (105.4 + 재판정 51.2) | 2 | 16,152 | input 32 / not_input 8 | 40/40 |
| opus-5 + effort low (단건) | 53.4초 | 1 | 4,515 | 40건 전부 판정(스키마 유효) | 미측정 — canary 필요 |
| sonnet-5 + effort low (단건) | 40.6초 | 1 | 3,896 | 40건 전부 판정(스키마 유효) | 미측정 — canary 필요 |

- 해석: ① 최종 판정은 4변형 모두 동일 구도(opus·sonnet 기본값은 40/40 일치 확정, low 2종은 판정 내용 대조 미실시). ② sonnet 기본값은 TPS는 더 높지만(≈108 vs 88 tok/s) 출력이 41% 더 장황하고 일부 후보를 0.75 미만 confidence로 남겨 **재판정 1라운드를 추가 유발** — 총시간이 opus보다 71% 나쁘다. ③ **effort low가 지배적 레버**: opus 유지 시 −42%(91.3→53.4초), 출력 토큰 −44%. ④ sonnet은 effort low 결합 시에만 opus-low 대비 −24% 추가.
- CLI 고정 오버헤드 바닥값: sonnet 3.3초, opus 5.0초(스폰+Keychain 인증+최소 생성). 호출당 지연의 95%+가 모델 생성이다 — 프로세스 스폰 최적화는 레버가 아니다.

### 2-3-1. T1 effort 품질 canary (2026-08-11 13:23, 3공고 × 전 묶음 8콜, opus + effort low)

08-11 배치의 확정 판정(기본 effort + 재판정 라운드 반영)을 기준으로, 같은 후보 전체를 effort low로 재판정해 후보 단위 대조했다. 프롬프트·스키마·0.75 수락 임계 동일 재현, 제품 코드 무수정.

| 공고 | 후보 | 판정 일치(확정 기준) | 내 uncertain | 배치 round-0 uncertain | wall(전 묶음) |
|---|---:|---:|---:|---:|---:|
| 125126 | 77 | 74/76 | 1 | 5 | 1.89분 |
| ks178559 | 51 | 50/51 | 0 | 2 | 1.30분 |
| 125139 | 136 | 133/134 | 2 | 3 | 3.27분 |
| **합계** | 264 | **257/261 (98.5%)** | 3 | 10 | 40후보 콜당 52~63초 |

- 속도: 콜당 52~63초 — 기본 effort 실측(91초·배치 평균 2.15분) 대비 **−40% 내외**, 벤치(53.4초)와 일치.
- uncertain은 오히려 감소(10→3) — 재판정 라운드 유발도 늘지 않는다.
- **불일치 4건 전수 원문 판정: 4건 모두 배치(기본 effort)가 옳았다.** `(휴대전화) (e-mail)` 연락처 기입 칸 2건, 확약서 서명란(대표자명) 1건, ※지시문 치환형 기타 칸 1건 — 전부 실제 입력 필드를 effort low가 `not_input conf 0.8`로 **조용히 거절**했다(0.75 임계 초과라 재판정에도 안 넘어감).
- 판정: effort low는 속도 −40%에 **입력 필드 재현율 ~3% 손실**(수락 기준 ~130건 중 4건 누락)의 트레이드오프. 누락 유형이 "안내문이 든 비어있지 않은 셀"에 집중 — 사용자에겐 빠른 작성에서 해당 필드가 빠지는 형태로 나타난다(문서 직접 편집으로 보완 가능하나 품질 회귀).
- 후속: 동일 canary를 effort **medium**으로 재실행해 4건 회복 여부와 속도를 확인 — 결과 아래 §2-3-2.

### 2-3-2. effort medium canary (2026-08-11 13:35, 동일 3공고 8콜)

| 공고 | 판정 일치 | 내 uncertain | wall(전 묶음) | 불일치 |
|---|---:|---:|---:|---|
| 125126 | 74/76 | 1 | 2.27분 | 대표자연락처 ×2 (`not_input` conf 0.78 — low와 동일 누락) |
| ks178559 | **51/51** | 0 | 1.67분 | 없음 (low의 기업명 누락 회복) |
| 125139 | 134/135 | 1 | 4.01분 | 종업원 수 (`not_input` conf 0.75 — 신규 누락, 기 타는 회복) |
| **합계** | **259/262 (98.9%)** | 2 | 콜당 60~68초 (기본 대비 −30%) | 누락 3건 |

### 2-3-3. 종합 판정 — 순수 effort 하향은 불가, "2단 effort + 거절 임계 0.85" 설계로 전환

- low(98.5%, −40%)든 medium(98.9%, −30%)이든 **실제 입력 필드를 거절 conf 0.75~0.80으로 조용히 놓친다**(재판정으로도 안 넘어감). 빠른 작성에서 필드가 소리 없이 빠지는 회귀라 순수 effort 하향은 기본값으로 채택 불가.
- 누락이 전부 거절 conf [0.75, 0.85) 경계 구간에 몰림 → **저효율 라운드의 거절 수락 임계만 0.85로 상향**하면 이 구간이 uncertain으로 떨어져 재판정(기본 effort)에서 회복된다.
- 부하 추정(기본 effort 분포, 3공고 264후보): 거절 conf<0.85는 31/170(18%) → 임계 0.85 적용 시 재판정행 +12~17%p ≈ **요청 +10~15%**. 저효율 라운드 −30~40%와 결합하면 순효과는 여전히 **Kordoc 총 시간 −20~30%**.
- 확정 설계(T1 최종형): **round 0 = effort medium + ACCEPT_REJECTION_CONFIDENCE 0.85, 재판정 라운드 = effort 미지정(기본) + 임계 0.75(현행)**. 수락(input) 임계는 0.75 유지(관측된 실패 모드가 거짓 거절뿐이므로).
- 잔여 검증(배선 후 CP1에서): 저효율 라운드의 실제 confidence 분포 히스토그램을 summary에 기록해 재판정 부하 실측(기본 effort 분포로 추정한 18%가 저효율에서 커질 수 있음). 3공고 canary 재실행으로 누락 0건 확인 후 기본값 전환.

### 2-3-4. 실파이프라인 재canary — 통과, 기본값 전환 (2026-08-11 17:26)

T1 배선 완료 직후 같은 3공고를 실제 경로(lab:roundtrip:smoke → 2단 effort medium)로 재분석해 08-11 배치 기준과 대조했다.

| 공고 | 판정 일치 | 입력 필드 손실 | 잔여 uncertain | 요청 | Kordoc 시간(기준→새) |
|---|---:|---:|---:|---:|---:|
| 125126 | 76/77 | **0** | 0 | 3→3 | 26.6분→1.84분 |
| ks178559 | 51/51 | **0** | 0 | 3→3 | 30.8분→1.35분 |
| 125139 | 136/136 | **0** | 0 | 5→6 (+1 재판정 라운드) | 34.5분→4.15분 |

- **전환 조건(입력 필드 손실 0건) 충족.** 순수 low/medium이 놓치던 경계 후보가 0.85 게이트→기본 effort 재판정으로 전부 회복됐고 잔여 uncertain 0.
- 유일한 diff 1건은 손실이 아니라 추가 수락(125126 "지원분야" conf 0.78 → input). 편집 필드가 하나 더 열리는 방향의 양성 드리프트로 판정 — input 임계는 불변이므로 위험 bounded, 추이만 관찰.
- 기준 시간(26~34분)은 10건 경합 포함이라 과장 — 요청당 비교로 medium ≈50~60초 vs 기본 91초(**−35%**), 재판정 부하는 +1요청/3공고(≈+9%)로 §2-3-3 추정(+10~15%) 안쪽.
- provenance 확인: 새 run에 `requestedEffort: "medium"`·summary `effort` 기록, transport claude-cli.
- 조치: runbook 표준 env에 `APPLICATION_ROUNDTRIP_EFFORT=medium` 등재(기본값 전환 — 코드 기본은 null 유지, env로만 켬).

### 2-4. 제도적 제약 (개선안이 관통해야 하는 계약)

- `APPLICATION_ROUNDTRIP_ADOPTED_MODEL = "claude-opus-5"`(application-roundtrip-contract.ts:12)이 품질 그래프 채택 검증(quality-graph.ts:239)과 릴리스 타입(application-precompute-release.ts:31)에 결속 — **Kordoc 모델 변경은 채택 변경 절차다.**
- Kordoc 재사용(reuse.ts)은 원본 SHA·엔진버전·transport·모델 완전 일치 요구 — 모델을 바꾸면 기존 opus 산출물 재결속 불가(1회성 재분석 비용 발생).
- 08-04 계획 §2.1 불변식: "Kordoc 내부 문서는 순차 파싱 유지, 판정 호출 동시성 최대 1~2" — 문서 병렬화(T5)는 이 조항의 개정안으로 제출한다.
- held-review repair의 roundtrip 재실행 기본 모델도 opus(`held-review-repair-cli.ts:85`, AI_ADJUDICATION_DEFAULT_MODEL).

## 3. 개선안

### T0. 운용 변경 (코드 무변경 · 즉시 · 무리스크)

1. **배치 인플라이트를 4로**: `pnpm lab:batch -- --concurrency=4 ...` (현행 10). 총 처리량은 전역 4슬롯이 상한이라 동일하고, 건당 완료 시간은 ~3배 단축된다(빨리 끝난 건부터 검수 레인에 넘어가 파이프라인 전체 리드타임도 준다).
2. **(조건부) 전역 CLI 상한 상향**: `ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY=6~8`. Max 2계정 여유(2026-08-03 확인)가 근거. 상향 시 배치 인플라이트도 6~8로 동반 상향 가능. 단 runbook의 "근거 있는 상향만" 조항에 따라 1회 배치에서 세션 한도 소진·throttling 미발생을 확인하고 유지한다.
3. **타임아웃 900_000 유지**: 요청 타이머가 큐 대기를 포함하므로(`field-planner.ts:405-430`) 인플라이트를 낮추기 전에는 절대 기본값(540s)으로 되돌리지 않는다. 이번 배치 요청 wall 최대 ≈14분 — 540s였다면 대량 request_timeout → 재판정 폭증 악순환.

예상 효과: 건당 wall 57분 → **~25분**(처리량 불변, 리드타임만 개선). 상한 8 동반 시 배치 전체 wall ≈ 314슬롯분/8 ≈ **40분**, 건당 ~15~20분.

### T1. Kordoc 판정 호출에 effort 명시 (opus 유지 · 코드 소변경 · canary 필수)

- 근거: §2-3 A/B — opus + effort low가 −42%(91.3 → 53.4초), 출력 −44%. 모델·채택 상수·재사용 계약을 전혀 건드리지 않아 게이트 마찰이 최소다.
- 변경: `field-planner.ts` requestBody에 `output_config.effort` 추가 + planner 옵션으로 effort 노출(transport는 이미 `--effort` 매핑 지원, `claude-cli-transport.ts:282`). 기본값은 canary 결과로 결정(§2-3-1·2-3-2 — low는 재현율 손실 확인, medium 결과 대기).
- 배선 스펙(codex 착지 후 적용, ~30줄):
  1. `RoundtripFieldPlannerRuntimeConfig`에 `effort: "low"|"medium"|"high"|null` 추가. 해석: 명시 옵션 → env `APPLICATION_ROUNDTRIP_EFFORT` → null(현행 미지정 보존). env 오타는 transport 스위치처럼 fail-fast.
  2. `requestFieldDecisions` requestBody에 `...(effort ? { output_config: { effort } } : {})`.
  3. provenance: `RoundtripFieldPlanningSummary`·`ApplicationRoundtripRun`에 additive `effort` 기록. reuse 판정(reuse.ts)의 계약 비교에 effort 포함(undefined↔null 동치 정규화 — 과거 산출물 재결속 보존).
  4. 주의: env를 설정한 채 held-review repair 재결속을 돌리면 effort 불일치로 재사용이 막힌다 — canary env는 canary 명령에만 지정.
- **canary 완료(§2-3-1~3): 순수 effort 하향은 기각, 2단 설계로 확정.** round 0 = medium + 거절 임계 0.85, 재판정 = 기본 effort + 임계 0.75. 근거와 부하 추정은 §2-3-3.
- 예상 효과: Kordoc 총 시간 −20~30%(요청 +10~15% 포함 순효과). T2와 곱으로 작용.

### T1b. (선택) sonnet-5 교체 — effort low와 결합할 때만

- 근거: sonnet 기본값 단독은 **역효과 확정**(§2-3 ②). sonnet-low는 opus-low 대비 −24%(53.4 → 40.6초) 추가 이득.
- 전제·비용: `APPLICATION_ROUNDTRIP_ADOPTED_MODEL`(계약)·quality-graph 채택 검증·release 타입·`AI_ADJUDICATION_DEFAULT_MODEL` 동반 수정 + 기존 opus Kordoc 산출물 재결속 전면 무효(공고당 1회 재분석 비용). T1 안정화 후 이득(−24%)이 이 마찰을 정당화할 때만 진행.

### T2. 판정 출력 다이어트 (스키마·프롬프트 변경)

- 근거: 호출 지연 ≈ 출력 토큰(§2-2, §2-3). 후보당 190~255 tok의 대부분이 help_text(≤500자)·evidence(≤300자)·suggested_label.
- 변경: ① `help_text`는 `is_user_input=true`일 때만 요구(거절 후보는 빈 문자열 허용 — helperText는 lab UI 입력 필드 설명에만 소비되고 승격 경로 무소비 확인). ② evidence 캡 300→120자, help_text 캡 500→200자. ③ suggested_label은 제안이 라벨과 다를 때만.
- 예상 효과: 출력 40~55% 절감 → 호출당 시간 동비율 단축. T1과 곱으로 작용.
- 리스크: 프롬프트 계약 변경이므로 재판정 라운드 빈도 변화 관찰 필요. adjudicationStatus partial 비율이 늘면 롤백.

### T3. 재판정 라운드 공고 수준 통합

- 근거: extra 36요청이 다룬 후보 합 398개 → 통합 시 10요청(§2-1). 현행은 문서 단위로 라운드가 돌아 1~9개짜리 미니 묶음이 풀 호출을 소비.
- 변경: planRoundtripFields의 재판정 루프를 문서 내부에서 공고 수준(runApplicationRoundtripAnalysis)으로 승격해, 문서 전체의 uncertain 후보를 모아 40개 묶음으로 재판정. MAX_ADJUDICATION_ROUNDS=2 유지.
- 예상 효과: Kordoc 요청 ~20% 절감.
- 전제: 08-04 계획 §2.1 개정(문서 간 판정 호출 공유) — T5와 함께 개정안 1건으로 제출.

### T4. 첫 패스 validator 실패 상수화 해소 (딥 레인)

- 근거: v11 이후 87% repair ≥1, repair는 22축 풀 재생성(§2-2). 공고당 딥 2패스가 기본값이 된 상태.
- 1단계(계측): LabRun에 패스별 `validatorIssueCodes`·`durationMs`를 additive로 기록(현재 primaryRepairCount만 존재, contract.ts:218). 다음 배치 1회로 최빈 실패 코드 확보.
- 2단계(해소): 최빈 코드별로 ① 결정적 교정 확장(모델 호출 전 해결 — evidence span·matching scope 전례) ② 첫 패스 프롬프트에 해당 계약 명시(현행 repair 지시문 `repair.ts:176-183`의 규칙을 첫 패스 시스템 프롬프트로 승격) 중 저렴한 쪽을 적용.
- 목표: model-repair 발생률 87% → **20% 미만**. 딥 레인 슬롯 소비 ~40% 절감 + run당 출력 토큰 ~36k → ~22k.

### T5. 문서 간 판정 병렬화 + 동시성 설정화 (08-04 §2.1 개정안)

- 현행: 첨부 순차 루프(`application-roundtrip/analyze.ts:140-141`) + `candidateConcurrency: 2` 하드코딩(`analysis-lab/analyze.ts:286`).
- 개정 논거: §2.1의 제한 목적(파서 순간 부하·Max 폭주 방지)은 이제 전역 CLI 스케줄러가 담당한다. 파싱은 순차 유지(파서 부하 논거 존중)하되, **판정 호출만** 공고 수준 큐로 합쳐 공고당 동시 2~4를 설정값으로 노출.
- 예상 효과: 다첨부 공고(124921형)의 직렬 합산 제거. 단건 모드에서 유휴 슬롯 활용(현행 단건은 4슬롯 중 Kordoc 2 + 딥 1만 사용).

### T6. (선택) 딥 effort medium canary

- DEEP_ANALYSIS_EFFORT_LEVELS = ["medium","high"]. 현행 lab은 high 고정(`deep-analysis/extractor.ts:96-98`).
- 단건 A/B(같은 공고, medium vs high)로 패스당 3.5~4분의 단축 폭과 validator 실패율 변화를 측정 후 판단. 품질 우선 원칙상 T4 완료 후에만 검토.

## 4. 종합 효과 모델 (검증 수치 기반 추정)

호출당 시간은 출력 토큰에 비례(§2-2·§2-3)하므로 Kordoc 호출당 추정: effort low 0.9분 → 출력 다이어트 결합 시 ~0.6분(출력 4.5k → ~2.5k). 딥 패스는 3.7분(T6 미적용) 유지 가정.

| 시나리오 | 건당 호출 수 | Kordoc 호출당 | 슬롯 | 10건 배치 wall | 단건 fresh |
|---|---:|---:|---:|---:|---:|
| 현행 | 14.6 | 2.15분 | 4 | ~79분 (건당 평균 57분) | 17~21분 |
| T0만(기본 상한 4 유지) | 14.6 | 2.15분 | 4 | 처리량 불변, 실측 72분(건당 평균 24.5분) | 17~21분 |
| T0+조건부 전역 상한 8 | 14.6 | 2.15분 | 8 | ~40분(미검증) | 15~20분(미검증) |
| T0+T1+T2(상한 8 가정) | 14.6 | ~0.6분 | 8 | ~18~22분 | ~8~10분 |
| 전체(T0~T5, T4 포함, 상한 8 가정) | ~10.4 (Kordoc 10.2 + 딥 1.1패스) | ~0.6분 | 8 | **~14분** | **~4~5분** |
| 전체(T0~T5, T4 포함, 현재 상한 4) | ~10.4 (Kordoc 10.2 + 딥 1.1패스) | ~0.6분 | 4 | **~26~28분** | **~4~5분** |

전체 적용 후에는 딥 1패스(3.7분)가 단건 시간의 지배 항으로 남는다 — 그때 T6(딥 effort medium canary)의 우선순위가 올라간다.

### 4-2. 검증 배치 실측 (2026-08-11 저녁, 아침 동일 10건 v13 재분석 — T0+T1+codex 9f66186 동시 적용)

- 결과: 성공 9 · 딥 실패 1(125015 — repair 2회 뒤에도 `unresolved_axis` 잔존, 936후보 공고). 배치 wall 72분(오전 79분 — 처리량은 4슬롯 포화로 유사).
- **건당 wall 평균 24.5분(오전 57분, −57%) · 최대 37.2분(78.5분, −53%)** — T0(인플라이트 4)의 예측이 실측으로 확정.
- **repair는 v13에서도 상수(성공 9런 전부 ≥1)** — `primaryPasses` 계측 첫 수확: 첫 패스 실패 주범은 **`unresolved_axis`(9/9 전원)**, 부성분 `semantic_misattribution`(4) · `evidence_not_grounded`(2) · `canonical_contract_invalid`(1). 딥 패스가 첫 5.8~10.9분 + repair 3.3~8.7분으로 이제 단건 시간의 지배 항 — T4 2단계(첫 패스에서 22축 종결 강제 또는 무조건 축의 결정적 종결)가 최우선 후속.
- Kordoc 재판정 부하: 요청 128→133(+3.9%) — §2-3-3 추정(+10~15%)보다 양호.
- 판정 드리프트(22문서, 기준=오전 v12 확정): 일치 3,080/3,218(95.7%). 입력 손실 90 중 **63건(70%)이 124870의 638후보 메뉴형 양식 1개 문서에 집중**(해당 문서 제외 손실률 ~1.0%), 125015(936후보)는 99.1% 일치. 이 배치는 2단 effort와 codex의 editable-regions 변경이 동시 적용돼 드리프트의 단독 귀속은 불가능하다. 또한 이것은 Kordoc 필드 판정 문제라 딥분석 criteria·빈 축만 보는 lab:ai-review→lab:ai-audit로 정오를 판정할 수 없다. 대형 메뉴형 양식은 별도 field-level Kordoc canary가 필요하다.

### 4-3. CP2 검증 배치 실측 (2026-08-13 00:19~00:58 KST, v14 첫 규모 검증 10건)

- 성공 10/10 · window-exhausted·timeout 0 · 배치 wall 38.03분 · **건당 wall 평균 12.23분**(4.33~25.63분) — 08-11 검증 배치(24.5분)에서 재반감. 명목 비용 $23.81(구독 실지출 0).
- Kordoc provenance: 새 roundtrip 산출물 9/9 `requestedEffort: "medium"`·claude-cli(첨부 없음 1건 해당 없음).
- **repair율 70%(7/10: 0회 3 · 1회 5 · 2회 2) → CP2 게이트(<20%) 실패.** v14 효과는 실재하나(무repair 0/9→3/10) 게이트에 크게 미달. 첫 패스 issue: `unresolved_axis` 29(5개 런 — 이 중 20건이 175783 1건에 집중, 계측 상한 20 도달) · `semantic_misattribution` 2 · `canonical_contract_invalid` 1.
- **repair 회귀 관측**: 120145는 첫 패스 issue가 semantic 1건뿐이었으나 repair(22축 풀 재생성)가 `axis_criterion_mismatch` 13건을 신규 유발해 2차 repair를 지불 — repair 국소화(실패 축만 재생성) 검토의 직접 근거. CP2-b 정적 재현 대상에 포함할 것.
- 의미 강제 확인: 10런 220축의 최종 상태는 condition_found 71 · inspected_no_condition 149 · **ambiguous·input_missing 0** — 진짜 판단불가·입력결핍도 validator 계약이 inspected_no_condition으로 눌러 닫는다. v15 수정안에서 프롬프트 정합(잔존 지시 규칙 3곳 개정)만으로 갈지 validator 계약 개정(comment 근거 있는 unresolved 허용)까지 갈지의 판단 근거. 참고: 확인 루프(confirmations)는 축 상태를 소비하지 않아 축 종결 강화와 무간섭(confirmations.ts 확인).
- 잔존 unresolved_axis의 편중: 축 단위 산발(4런 1~5건)과 입력 결핍 공고 단위 대량 헤징(175783형)이 다른 문제다 — 정적 재현 시 두 유형을 분리해 다룰 것.
- 125015(0aa42679)는 코호트 순서 편향으로 이번 10건에 미선정(리뷰 문서 §6-①) — 타깃 실행은 원인 수정·승인 전 보류(§5 CP2-b).

## 4-1. 실행 현황·협업 분담 (2026-08-11 13시대)

같은 워크트리의 codex 세션이 겹치는 축을 미커밋으로 구현 중이다(git status 실측). 충돌 방지를 위해 분담을 다음과 같이 확정한다.

| 항목 | 담당 | 상태 |
|---|---|---|
| T0 운용값 (runbook 반영: 배치 conc 10→4 권장·근거) | 이 세션 | ✅ `docs/explainers/구독모델로-딥분석-돌리는-법.md` 반영 완료 |
| 스케줄러 키별 공정성(schedulerKey — 공고 간 기아 방지, P2 보강) | codex 세션 | ✅ `9f66186` 커밋·테스트 완료 |
| T5 동시성 부분(candidateConcurrency 하드코딩 2 → 설정화) | 후속 트랙 | ⏸ 미구현 — `9f66186`은 2-way 제한을 보존·명시화함 |
| T4 구조 validator·matching-scope 확장 | codex 세션 | ✅ `9f66186` 커밋·테스트 완료. 프롬프트 v14는 `85c210d`, CP2에서 불충분 판정 |
| T1 effort 품질 canary(low·medium 각 3공고 8콜, 판정 일치 검증) | 이 세션 | ✅ 완료 — 순수 하향 기각, **2단 설계 확정**(§2-3-3) |
| T1 배선(2단 effort + 거절 임계 0.85 + env + provenance) | 이 세션(서브에이전트) | ✅ 구현·재canary 통과·**기본값 전환 완료**(17:26 — 손실 0건, §2-3-4. runbook env 등재) |
| T4 계측(LabRun에 validator issue 코드·패스별 시간) | 이 세션(서브에이전트) | ✅ 구현 완료(17:25 — `LabRun.primaryPasses` additive, validated-primary·batch-runner 테스트 통과). 다음 배치 1회로 최빈 issue 코드 표 수집 가능 |

## 5. 실행 체크포인트

1. **CP0 (즉시)**: 다음 배치부터 T0 운용값 적용. 측정: 건당 wall 중앙값, 요청 wall 최대치(900s 마진), 세션 한도 신호.
2. **CP1**: ✅ 완료(08-11 저녁, §4-2). 검증 배치 실측 — 건당 −57%, 재판정 부하 +3.9%, `unresolved_axis`가 repair 주범으로 확정.
   - 품질 게이트(08-12): **Fable 검수 9/9 완료** — criterion 130건 중 correct 124 · needs_edit 6, 실패·원문 드리프트 0. **Sonnet 감사 8/9 완료** — 판정 26항목 중 일치 25 · 불일치 1 · unsure 0, 감사 7건 전 항목 확정(게이트 편입 가능). 잔여: 불일치 1항목 사람 판정, 감사 실패 1건(용인시 — 타임아웃 후 일시 DB 오류, 재시도 대상), needs_edit 6건은 held-review repair 흐름 입력.
   - 품질 게이트의 범위는 딥분석 criteria·빈 축까지다. Kordoc 필드 드리프트는 이 게이트로 무해성을 입증할 수 없으며 별도 field-level canary가 필요하다.
3. **CP1-b (T4 2단계, 08-12)**: `unresolved_axis` 원인 = 프롬프트(ambiguous/input_missing 허용·지시)와 validator(무조건 실패) 간 계약 충돌. repair 지시문의 축 종결 규율을 첫 패스 시스템 프롬프트로 승격(extractor.ts axis 섹션), **프롬프트 v13→v14**. validator 계약 불변.
   - canary(08-12 밤, 2/3 완주 — 3번째 125015는 로컬 중단으로 미완): **178559 repair 0·첫 패스 issue 0**(v11 이후 최초의 무repair 런, v13에선 repair 1), 125126은 repair 1 유지(첫 패스 unresolved_axis 4 잔존). 표본 2로는 방향 확인까지 — **규모 판정은 CP2(다음 정례 배치 repair율 <20%)**로 위임. 125015는 `--retry-errors`로 자격을 획득할 뿐 limit 선정에 자동 편입되지 않는다.
   - 부수 발견: batch.ts 실행 경로가 `withApplicationRoundtrip: true`를 **무조건 강제**한다(08-04 형제 실행 불변식 — `--with-application-roundtrip` 플래그는 사실상 장식). 따라서 **모든 lab:batch 호출에 `APPLICATION_ROUNDTRIP_EFFORT=medium` env가 필수 동반** — 누락 시 Kordoc이 기본 effort로 실행돼 창·시간을 낭비한다(이 canary에서 실측). runbook 반영 필요.
4. **CP2**: ❌ 실패(08-13 00:58 KST 최종). v14 성공 10건 중 repair 7건(70%), 첫 패스 `unresolved_axis` 29건·`semantic_misattribution` 2건·`canonical_contract_invalid` 1건. 속도는 평균 12.23분·최대 25.63분·배치 wall 38.03분으로 통과.
5. **CP2-b**: 자동 추가 실행 전 잔존 첫 패스 issue를 정적 재현하고 v15 수정안·페이크 transport 회귀 테스트를 만든다. 00:58에 시작됐다가 런 미저장으로 종료된 125015 시도는 재시도하지 않고, 수정·검증·실행 승인 후에만 명시 타깃으로 재현성을 확인한다.
6. **CP3**: CP2-b 통과 전에 시작하지 않는다. 통과 후 T2+T3+T5 구현(계약·엔진 버전 bump, §2.1 개정) → 신규 3건 + 기존 1건 재분석으로 품질 그래프 전 노드 passed 확인.
7. **CP4**: 층화·버전된 코호트에서 확대 배치로 종합 효과를 실측한다. `<20%`를 모집단 주장으로 쓰려면 단측 95% 상한 기준의 순차 표본 규칙(무repair 최소 14건, repair 1건이면 최소 22건)을 사전 고정한다.

## 6. 리스크·미결

- T1의 effort low 판정 품질은 미검증(벤치는 스키마 유효·전건 판정까지만 확인) — canary 통과 전 기본값 변경 금지. 회귀 시 medium 폴백.
- T1b 채택 변경 시 기존 opus Kordoc 재사용 전면 무효(1회성). 승격 대기 run이 있으면 전환 시점을 승격 후로 조정.
- T2는 프롬프트 계약 변경 → uncertain 비율 변동 가능. canary에서 adjudication 라운드 수·unresolved 잔여를 현행 대비로 관찰.
- 전역 상한 8은 Max 윈도 소진을 앞당긴다 — window-exhausted fail-closed 경로(기존)가 안전판이나, 장시간 배치는 윈도 리셋 시각을 피해서 시작.
- 재판정 통합(T3)은 문서 경계를 넘는 후보 묶음이므로 candidate_id 충돌 방지(현행 fieldInstanceId는 문서 내 유일 — 공고 수준 유일성 확인 필요).
