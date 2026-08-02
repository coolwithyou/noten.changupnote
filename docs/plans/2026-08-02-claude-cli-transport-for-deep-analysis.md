# Claude CLI Transport — 로컬 딥분석을 Max 구독으로 실행

> **🟡 진행 상황 (2026-08-02)**
> - Phase 0 (드레스 리허설 실측) **완료** — 실제 22축 스키마로 `--json-schema` 프로브 통과, 하류 정규화 8/8 spanVerified. 본 문서 §3에 실측 기록.
> - 문서 적대 검증 **완료·반영** — 팩트체크 40항목 대조 4건 정정(단방향 의존 주장 철회 등) + 레드팀 10건 반영(윈도 소진 batch 분기 §5#6, stdin EPIPE 프로토콜, 합성 400 오진 회피, AbortError 명세, roundtrip 레인 제외 등).
> - **열린 결정 2건 사용자 확정(2026-08-02)** — ① 초기 전환 범위 = 추출 + **ai-audit** (ai-review·confirmations는 API 유지) ② lab CLI 레인 모델 = **claude-opus-5** (구독 한도 넉넉 — 다운시프트 불요). §9에 결정 기록.
> - Phase 1~5 미착수. 다음 착수는 Phase 1(transport 모듈).

- 타당성 검토 정본: `docs/research/2026-08-02-구독모델-딥분석-실행-타당성-검토.md`
- 결정 사항: **Anthropic 모델만 사용, Codex 레인 제외.** 운영 allowlist(`DEEP_ANALYSIS_PRIMARY_MODELS`)는 불변. **lab CLI 레인의 운용 모델은 `claude-opus-5`** — 코드 계약 검증 완료: `assertDeepAnalysisModelEffort`(contracts deep-analysis.ts:314-321)는 effort 호환만 검사하고 opus-5는 `DEEP_ANALYSIS_EFFORT_MODELS` 포함(effort high 유효), primary allowlist 검사(`assertDeepAnalysisModelPair`)는 운영 worker policy에서만 발화, `costPolicy.ts:36`에 opus-5 가격($5/$25) 등재로 costUsd·비용 게이트 정상 작동, 순환 가드 무충돌(추출 opus-5 ≠ 감사 sonnet-5 ≠ 검수 fable-5). 즉 `ANALYSIS_LAB_MODEL=claude-opus-5`는 코드 무수정으로 유효하다.

## 1. 목표 / 비목표

**목표**

- 로컬 dev 환경에서 `lab:batch`·`lab:smoke` 등 대량 딥분석을 **Claude Max 구독(claude CLI OAuth)** 으로 실행해 API 토큰 지출 없이 동일 로직·동일 스키마로 공고 필드를 채운다.
- 운영(API 토큰) 경로는 **바이트 하나 바뀌지 않는다**. 스위치가 없으면(기본) 지금과 완전히 동일하게 동작한다.
- 추출·정규화·span 검증·게이트·승격 로직 무수정 — 전송층(fetch)만 교체한다.

**비목표**

- Codex/GPT 계열 백엔드 (allowlist·가격표·캘리브레이션 결속으로 기각 — 타당성 검토 §4)
- 운영 worker(`deep-analysis:worker`)·Cloud Run 경로의 구독 전환 (약관상 불가, 설계상 배제)
- **application-roundtrip 레인 전환 제외**: `analysis-lab/application-roundtrip/analyze.ts:172` → `field-planner.ts:151`의 자체 Anthropic fetch는 본 계획 범위 밖(API 유지). `ANALYSIS_LAB_TRANSPORT=claude-cli` 상태에서 `lab:roundtrip:smoke`를 돌리면 여전히 API 토큰이 지출됨을 운용자가 인지할 것
- 모델·프롬프트·스키마 변경 (promptVersion `lab-deep-v5` 유지)
- 프로덕션 서빙 경로에 대한 어떤 변경

## 2. 설계 원칙

1. **주입은 기존 심(seam)으로만.** `runDeepGrantAnalysis`(`deep-analysis/extractor.ts:93`)와 `callAnthropicToolModel`(`analysis-lab/ai-review.ts:502`)은 이미 `fetchImpl?: typeof fetch`를 받는다. 신규 코드는 이 파라미터에 넣을 **fetch 호환 shim** 하나와 배선뿐이다.
2. **스위치는 lab 진입점에서만 해석.** 신규 모듈은 `analysis-lab/` 디렉터리에 두고, env `ANALYSIS_LAB_TRANSPORT`는 lab 진입점에서만 읽는다 — `analyze.ts`, 사이드카 CLI 3곳, 그리고 batch/smoke의 fail-fast 선검증(§5 #6). 주의: deep-analysis↔analysis-lab 의존은 이미 **양방향**이다(deep-analysis의 promotion.ts:9·14, promotion-release-cli.ts, analysisLayerRebuild.ts 등 6개 파일이 analysis-lab을 import) — "디렉터리 규약" 같은 것은 없다. 다만 **운영 worker 사슬(worker-cli → workerLoop → processor → extractor)에는 analysis-lab import가 0건**이며, 운영 격리는 규약이 아니라 §6-3의 rg 검증(transport 모듈 import처가 lab 진입점뿐 + worker 사슬 무접촉)으로 커밋마다 증명한다.
3. **응답 불신 원칙 재사용.** shim은 "Anthropic Messages API 모양의 응답"을 재조립해서 돌려줄 뿐, 검증은 기존 `normalizeCriteria`/`verifySpan`/`validateAiReviewPayload`가 그대로 수행한다.
4. **provenance 명시.** 구독 경유 런은 `LabRun.transport: "claude-cli"`로 표기해 API 런과 구분한다(A/B 비교·감사 추적용). 게이트·승격 코드는 이 필드를 모르므로 동작 불변.

## 3. Phase 0 — 드레스 리허설 실측 (완료, 2026-08-02)

이 계획의 유일한 미검증 가정이었던 "실제 22축 tool 스키마를 `--json-schema`로 강제할 수 있는가"를 실측으로 확정했다.

**실행 조건**: claude CLI 2.1.219, macOS, Keychain OAuth(Max 구독, `ANTHROPIC_API_KEY` 셸에 없음), 스크래치 cwd, 실제 `buildDeepAnalysisToolSchema().input_schema`(3,016 bytes) + 실제 `DEEP_ANALYSIS_SYSTEM_PROMPT`(9,580 chars) + 축약 가짜 공고(초기창업패키지 모사, 자격 4·제외 3·우대 2 조건).

```bash
claude -p "$(cat user-prompt.txt)" \
  --output-format json \
  --model claude-sonnet-5 \
  --system-prompt "$(cat deep-system-prompt.txt)" \
  --tools "" \
  --json-schema "$(cat deep-tool-schema.json)" \
  --no-session-persistence \
  --effort high
```

**결과** (exit 0, 벽시계 108초, 출력 23KB):

| 검증 항목 | 결과 |
|---|---|
| `structured_output` 전용 필드 | 존재. `JSON.parse(result)`와 완전 동일 객체 |
| 스키마 준수 | 최상위 5키 정확(analysis_markdown/program_intent/criteria/axis_assessments/taxonomy_proposals) |
| `stop_reason` | `"tool_use"` — 기존 분기 로직과 그대로 호환 |
| `usage` 필드명 | `input_tokens`/`output_tokens`/`cache_creation_input_tokens`/`cache_read_input_tokens` — **Anthropic API와 동일**, `normalizeUsage` 무수정 통과 |
| `modelUsage` 키 | 정확히 `claude-sonnet-5` (풀 id 에코 → 모델 검증 가드 구현 가능) |
| 하류 정규화 | `normalizeCriteria` 8/8건 enum 통과, **spanVerified 8/8**, `normalizeAxisAssessments` 정확히 22건, condition_found 7축 |
| 명목 비용 | `total_cost_usd` $0.251 (구독이므로 실지출 0 — 명목치는 게이트 계산용으로 유지) |

## 4. 신규 모듈 — `apps/web/src/lib/server/analysis-lab/claude-cli-transport.ts`

### 4-1. 공개 인터페이스

```ts
/** env ANALYSIS_LAB_TRANSPORT 해석: 미설정/"api" → "api"(기존 경로), "claude-cli" → "claude-cli". 그 외 값은 throw(오타 fail-fast). */
export function resolveLabTransport(): "api" | "claude-cli";

/** transport=claude-cli일 때만 호출. fetch 호환 shim 반환. */
export function buildClaudeCliFetch(config?: {
  claudeBinary?: string;   // 기본 "claude" (PATH 해석)
  scratchCwd?: string;     // 기본: os.tmpdir() 하위 고정 빈 디렉터리(생성 보장) — 프로젝트 스코프 CLAUDE.md·.mcp.json 차단.
                           // 사용자 스코프(~/.claude/CLAUDE.md·user MCP)는 cwd와 무관하게 로드될 수 있음 — Phase 1 ④ 실측 항목
}): typeof fetch;

/** transport 분기 + apiKey 요구 스킵을 한 곳으로: 진입점 4곳이 공용으로 쓴다. */
export function resolveLabLlmBinding(): {
  transport: "api" | "claude-cli";
  apiKey: string;              // claude-cli면 더미 "subscription" (shim이 x-api-key를 무시)
  fetchImpl: typeof fetch | undefined;  // api면 undefined(기존 전역 fetch)
};
```

`resolveLabLlmBinding`의 api 분기는 기존 `resolveAnthropicApiKey`/`requireApiKey` 동작(loadMonorepoEnv 보강 후 `ANTHROPIC_API_KEY` 없으면 throw)을 그대로 위임한다.

### 4-2. 요청 번역 (Messages API body → argv)

shim은 `fetch(url, init)`로 들어온 `init.body`(JSON)를 해석한다. 호출부는 정확히 2곳이므로 body 형태는 폐쇄적이다.

| Messages API body | claude CLI argv | 비고 |
|---|---|---|
| `model` | `--model <그대로>` | **풀 id 그대로** (별칭 금지 — 가격표·순환 가드·파일 키가 풀 id 결속) |
| `system` | `--system-prompt <그대로>` | 기본 시스템 프롬프트 완전 대체 (Phase 0 실측 방식) |
| `messages[0].content` | **stdin으로 전달** (`claude -p` 무인자 + `child.stdin.write`) | extractor는 join된 string, ai-review도 string(블록 배열이면 text join). **argv 전달 금지** — 딥분석 입력은 최대 800k chars(`maxTotalInputChars`)라 macOS ARG_MAX(1MB, env+argv 합산)를 초과할 수 있다. Phase 0 프로브는 소형 입력이라 위치 인자로 통과했지만, 구현은 stdin 고정이며 Phase 1 유닛에 대형 입력 케이스를 포함한다 |
| `tools[0].input_schema` | `--json-schema <JSON 문자열>` | 인라인 문자열 (help 확인·실측 완료) |
| `tool_choice.name` | (응답 재조립 시 `tool_use.name`으로 사용) | |
| `output_config.effort` | `--effort <값>` | extractor가 effort 지원 모델에 `high` 전송 — 그대로 매핑 |
| `max_tokens` | **매핑 불가 — 알려진 갭** | §8-1 참조 |
| (고정 플래그) | `--output-format json --tools "" --no-session-persistence` | Phase 0 실측 세트 그대로. 추가 격리 플래그는 넣지 않는다(실측 안 된 조합 금지) |

실행: `execFile(claudeBinary, argv, { cwd: scratchCwd, maxBuffer: 64MB, signal: init.signal })`.

- **AbortSignal은 execFile의 `signal` 옵션으로 그대로 전달**한다. abort 시 `AbortError` **명의** 에러로 reject되어야 extractor.ts:136-139·ai-review.ts:528-531의 타임아웃 분기가 발화한다 — shim이 kill만 하고 일반 에러로 던지면 타임아웃이 일반 실패로 오분류되고, `Command failed: claude --system-prompt <9.5k>...` 꼴 메시지의 앞 2,000자(시스템 프롬프트 노출)가 error 런에 저장된다. 기존 540s 정책(`ANALYSIS_LAB_TIMEOUT_MS`)은 이 경로로 무수정 적용되며, macOS `timeout` 바이너리 부재 문제도 함께 해소.
- **stdin 전달 프로토콜 필수**: `child.stdin.on("error", () => {})` 부착 → write → `end()`. CLI가 stdin을 읽기 전에 조기 종료하면(잘못된 플래그, 로그아웃, 버전 드리프트, 윈도 소진 즉시 에러 — 전부 이 계획이 예상하는 상황) 대형 입력(~2.4MB) write가 **EPIPE**를 던지는데, 핸들러 미부착 시 uncaught exception으로 batch 워커 풀 프로세스가 통째로 죽는다(error 런 저장 설계 무력화). `end()` 누락 시 CLI가 EOF 대기로 540s를 통째로 소진한다.

### 4-3. 응답 재조립 (CLI JSON → Messages API 모양 Response)

성공 경로 (`is_error: false`, `subtype: "success"`):

```ts
new Response(JSON.stringify({
  content: [{
    type: "tool_use",
    name: <요청의 tool_choice.name>,
    input: cliJson.structured_output ?? JSON.parse(cliJson.result),
  }],
  stop_reason: cliJson.stop_reason ?? "tool_use",   // Phase 0 실측: "tool_use" 그대로 옴
  usage: cliJson.usage,   // 필드명 동일 실측 — 무변환 통과
}), { status: 200 })
```

**필수 가드** (재조립 전 검사, 위반 시 throw):

1. **모델 에코 검증**: `Object.keys(cliJson.modelUsage)`에 요청 모델 풀 id가 없으면 throw — CLI가 내부에서 모델을 바꾼 provenance 오염을 차단 (타당성 검토 리스크 #3).
2. `structured_output`이 없고 `result`도 JSON 파싱 불가면 throw (메시지에 `result` 앞 500자 포함).
3. `is_error: true` 또는 exit ≠ 0 → 에러 경로(아래).

에러 경로 — 기존 재시도·에러 계약에 합류시키기 위해 **합성 HTTP 상태**로 돌려준다:

| CLI 실패 양상 | 합성 응답 | 기존 코드의 반응 |
|---|---|---|
| stderr/result에 rate-limit·overloaded 류 시그널 | `status: 529` + body=stderr tail | extractor/ai-review의 1회 재시도(5s) 합류 |
| Max 사용량 윈도 소진 시그널(수 시간 지속) | `status: 400` + **고정 한국어 본문만** — 마커 `[CLAUDE_CLI_WINDOW_EXHAUSTED]` 포함, **stderr tail 병합 금지**. CLI가 에코하는 API 에러 JSON의 `invalid_request_error`가 섞이면 ai-review.ts:552의 `/retention\|zero data\|invalid_request/i` 분기가 "fable-5 ZDR 설정" 오진 메시지로 둔갑시킨다 | 추출 레인: error 런 저장 후 **batch가 run.error의 마커를 감지해 costCapped와 동일하게 신규 착수 중단**(§5 배선 #6). 사이드카 레인: CLI들의 겉(outer) 재시도 1회 후 실패(ai-review-cli.ts:425-448 등 — "즉시"는 아님) |
| 그 외 exit ≠ 0 / is_error | `status: 500` + body=stderr+result tail | 1회 재시도 후 실패. tail 컷은 기존 코드가 레인별로 수행: 추출 1,000자(extractor.ts:155) / 사이드카 일반 800자·특수 분기 500자(ai-review.ts:549·555·559) |

시그널 문자열 매칭은 구현 시 실제 에러를 1회 유발해 확정한다(§7 Phase 1 체크리스트 ②). 판별 불가 에러는 500(재시도 쪽)이 기본값. 합성 400 본문이 위 정규식에 미매치함은 유닛으로 고정한다(§6-1).

### 4-4. 명목 비용의 의미 (설계 결정)

usage를 무변환 통과시키므로 `priceDeepAnalysisUsage`가 기존 가격표로 **명목 비용**을 계산한다. 이는 의도된 동작이다:

- aggregate의 `costPerNotice ≤ $1` 게이트, batch의 `--max-cost-usd` 상한이 **"API로 돌렸다면"의 경제성 판단으로 그대로 유효** (usage 소실 시 게이트가 0으로 허위 통과하는 리스크 #1의 정확한 해소). 운용 모델 `claude-opus-5`도 가격표 등재 확인(costPolicy.ts:36, $5/$25) — costUsd null 연쇄 없음.
- 실지출은 0 (구독). 런 파일의 costUsd는 명목치임을 `transport` 필드가 표시한다.
- 주의: CLI 경유 출력 토큰에는 하네스 특성상 추론 토큰이 포함될 수 있어 API 실측 대비 명목치가 다소 과대할 수 있다 — 게이트 방향으로는 보수적이므로 허용.

## 5. 배선 (기존 파일 수정 — 전부 lab 전용 파일. Phase 2 = #1·#3·#5·#6, #2·#4는 안내 로그만 남기고 Phase 5 이연)

| # | 파일 | 현재 | 변경 |
|---|---|---|---|
| 1 | `analysis-lab/analyze.ts:122-123` | `resolveAnthropicApiKey()` 후 `runDeepGrantAnalysis({ apiKey, inputText })` — 둘 다 try **안** | **위치가 provenance 정합성의 핵심**: ① `resolveLabTransport()`(순수 env 파싱)는 try **밖**에서 1회 수행해 성공/실패 런 모두 그 값을 `transport`로 기록 — try 안에 두면 claude-cli로 돌다 실패한 error 런이 `transport: undefined`(=api 해석)로 남는 provenance 오염, 전부 try 밖이면 키 부재가 "실패해도 error 런 저장" 계약(analyze.ts:4)을 깨고 runLabAnalysis 전체 throw로 바뀐다. ② apiKey/fetchImpl **구체화**(throw 가능)는 기존처럼 try **안**. LabRun 조립부(:128-154)에 `transport` 기록 |
| 2 | `analysis-lab/ai-review-cli.ts:103-107, 198, 427` | `requireApiKey()` + `runAiReview({ run, model, apiKey, force })` | **Phase 5 이연** (결정 ① — ai-review는 API 유지). Phase 2에서는 배선 대신 **안내 로그 1줄만**: transport=claude-cli 감지 시 "이 레인은 API 유지(전환 제외)" 출력 — roundtrip 레인과 같은 조용한 오해 방지. (`runAiReview`는 이미 `fetchImpl` 수용·통과, ai-review.ts:591 — 이연 비용 없음) |
| 3 | `analysis-lab/ai-audit-cli.ts:67-71, 235` | `requireApiKey()` + `runAiAudit({ ..., apiKey })` | **Phase 2 포함** (결정 ①): binding 사용 + `fetchImpl` 전달 (`runAiAudit`은 이미 수용·통과, ai-audit.ts:323·404). 감사 모델은 기존대로 `ANALYSIS_LAB_AUDIT_MODEL`/기본 claude-sonnet-5. 감사 provenance: `runAiAudit`에 transport를 전달해 감사 사이드카에 `aiAuditTransport` 기록 |
| 4 | `analysis-lab/confirmations-cli.ts:68-72, 211` | `requireApiKey()` + 기본 deps(동적 import) | **Phase 5 이연** (결정 ① — API 유지, #2와 동일 안내 로그). 이연 시 배선 방법 기록: `ConfirmationsLlmDeps`(confirmations.ts:308-318)는 3필드 **전부 필수**이므로 완전한 deps를 구성한다: `{ reassembleInput: reassembleLabInputForRun, callModel: (o) => callAnthropicToolModel({ ...o, ...(fetchImpl ? { fetchImpl } : {}) }), computeCostUsd: computeAiReviewCostUsd }` (confirmations-cli.ts:16이 이미 ai-review를 정적 import — 로딩 부담 없음). **api 경로에서는 deps 미전달**(undefined → 기존 `loadDefaultLlmDeps()` 경로 보존). confirmations.ts 자체는 무수정 |
| 5 | `features/dev/analysis-lab/contract.ts:152-175, 315-336` | `LabRun`·`LabAudit` | `LabRun.transport?: "api" | "claude-cli"` + `LabAudit.aiAuditTransport?: "api" | "claude-cli"` 옵셔널 추가 (기존 파일 undefined = api로 해석, 마이그레이션 불필요) |
| 6 | `analysis-lab/batch.ts` (워커 루프 :250-296) + 진입점 | 윈도 소진을 모름 — 소진 후에도 잔여 타깃 전부 CLI 스폰→실패→불변 error 런 축적, 기본 재실행은 error 런을 **보류**(batch-plan.ts:51 `errorCurrent && !retryErrors` → heldError)라 재개도 안 됨 | ① run.error에 `[CLAUDE_CLI_WINDOW_EXHAUSTED]` 마커가 보이면 **costCapped와 동일하게 신규 착수 중단**(~15줄). 중단 후 재실행하면 미분석 공고는 자연 재개, 소진 시점에 이미 착수됐던 소수의 error 런만 `--retry-errors` 대상 ② 진입점에서 `resolveLabTransport()` 1회 선검증 — env 오타를 배치 시작 전에 fail-fast (smoke.ts도 동일 1줄) |

**무수정 확인 대상**: `deep-analysis/extractor.ts`(심 이미 존재), `confirmations.ts`(DI로 흡수), 운영 worker 전 경로, aggregate/shadow/promote(transport 필드 무인지). `batch.ts`/`smoke.ts`는 #6의 소폭 수정만.

**dev 전용 웹 라우트 주의**: `runLabAnalysis`는 dev 웹 라우트에서도 호출된다(analysis-lab UI). `ANALYSIS_LAB_TRANSPORT=claude-cli`가 dev 서버 env에 설정돼 있으면 웹 경유 분석도 구독으로 실행된다 — 의도된 동작이나, **Next dev 서버 프로세스에서 claude CLI 스폰이 동작하는지 Phase 2에서 1회 확인**(PATH·Keychain 접근). 문제가 있으면 라우트 경로는 api 강제로 좁힌다.

## 6. 테스트 계획

### 6-1. 유닛 (신규 `claude-cli-transport.test.ts` + package.json `lab:transport:test`)

execFile을 페이크로 주입(테스트 전용 `execFileImpl` 파라미터)해 실 CLI 무호출:

1. 요청 번역: extractor 실 body 샘플 → argv에 `--model` 풀 id·`--json-schema`·`--system-prompt`·`--effort high`·고정 플래그가 정확히 조립되는지, `max_tokens`는 argv에 등장하지 않는지, 사용자 콘텐츠는 argv가 아니라 stdin으로 가는지(대형 입력 케이스 포함)
2. 응답 재조립: Phase 0 실측 JSON(축약본을 픽스처로) → 200 Response, `content[0].type === "tool_use"`, usage 무변환, `stop_reason` 통과
3. 가드: modelUsage 키 불일치 throw / structured_output·result 모두 파싱 불가 throw / `is_error` → 합성 상태 매핑 3종
4. abort: signal abort 시 **`AbortError` 명의 에러로 reject**되는지 (kill 호출 확인만으로는 부족 — §4-2)
5. `resolveLabTransport`: 미설정→api, `claude-cli`→claude-cli, 오타값 throw
6. **조기 종료 내성**: stdin을 읽지 않고 즉시 exit≠0으로 죽는 페이크 child → EPIPE가 프로세스로 전파되지 않고 합성 에러 응답으로 합류하는지
7. **합성 400 본문**: `/retention|zero data|invalid_request/i`에 미매치 어서션 (ai-review.ts:552 오진 분기 회피 고정)

### 6-2. 회귀 (기존 스위트 전부 무수정 통과가 합격선)

```
pnpm lab:ai-review:test && pnpm lab:audit:test && pnpm lab:confirmations:test \
  && pnpm lab:promote:test && pnpm lab:release:test && pnpm lab:shadow:test
```

(참고: `verify:service-data` 미종료와 extraction/report.test 기존 실패 2건은 본 트랙과 무관한 기지 이슈.)

### 6-3. 격리 검증 (운영 무영향 증명)

- `rg -l "claude-cli-transport|ANALYSIS_LAB_TRANSPORT" apps/web/src/lib/server/deep-analysis/` → **0건** (직접 참조 차단)
- `rg -l "claude-cli-transport" apps/web/src` → **§5의 진입점 목록과 정확히 일치** (deep-analysis↔analysis-lab 의존이 양방향이므로 전이 유입도 이 전수 목록 대조로 차단 — §2 원칙 2)
- env 미설정 상태에서 `lab:smoke` 1건 → 기존 API 경로 실행·런 파일에 `transport` 부재(또는 "api") 확인
- 위 3항목 전부 커밋 전 체크리스트

### 6-4. 통합 스모크 (수동, 구독 소량 소진)

```
ANALYSIS_LAB_TRANSPORT=claude-cli ANALYSIS_LAB_MODEL=claude-opus-5 pnpm lab:smoke
```

합격 기준: 런 파일 생성, `transport: "claude-cli"`, `model: "claude-opus-5"`(요청 풀 id 일치), `usage`·`costUsd` 비-null, criteria spanVerified 존재, error null. 이어서 해당 런에 `ANALYSIS_LAB_TRANSPORT=claude-cli pnpm lab:ai-audit` 1회 — 감사 파일에 `aiAuditTransport: "claude-cli"`·`aiAuditModel: "claude-sonnet-5"` 기록 확인.

## 7. 실행 순서 (커밋 단위)

| Phase | 내용 | 규모 추정 |
|---|---|---|
| **0** | ~~드레스 리허설 실측~~ **완료** (§3) | — |
| **1** | transport 모듈 + 유닛 테스트 + `lab:transport:test` 스크립트. 체크리스트: ①**`claude-opus-5` 풀 id 1회 실측**(Max 구독 CLI 가용 확인 — 결정 ②의 전제, 거의 확실하나 미실측) ②에러 시그널 문자열 실측 확정(잘못된 플래그로 1회 유발) ③stdin 프롬프트 전달 1회 실측(`cat prompt.txt \| claude -p --output-format json ...` — §4-2 stdin 고정의 전제) ④**사용자 스코프 컨텍스트 로드 실측**: `~/.claude/CLAUDE.md`·user MCP가 `-p` 런에 로드되는지 확인(verbose/usage로 판별) — 로드되면 격리 플래그 1종을 실측 후 고정 세트에 편입, 불가하면 §8-2 교란 변수로 명기 ⑤**ai-audit 대표 스키마 실측 1회**: 감사 tool 스키마는 `criterion_index`가 동적 enum + min/maxItems 고정이라 추출 스키마보다 제약이 강함 — `--json-schema`가 이를 강제하는지 확인(결정 ①로 감사 레인이 Phase 2에 포함되므로 필수) | 모듈 ~200줄 + 테스트 ~250줄 |
| **2** | 배선(#1 analyze + #3 ai-audit-cli + #5 contract + #6 batch/smoke, #2·#4는 안내 로그만) + 회귀·격리 검증(§6-2·6-3) + 통합 스모크(§6-4, 추출+감사). dev 웹 라우트 스폰 확인. **대형 공고 1건 벽시계 실측** — Phase 0은 소형 입력 sonnet-5로 108초였고, 실전은 대형 입력 + claude-opus-5 + effort high + CLI 추가 턴 오버헤드라 540s 초과 가능 → 필요 시 배치 명령에 `ANALYSIS_LAB_TIMEOUT_MS` 상향 동봉(기존 env, 코드 무수정) | ~70줄 diff |
| **3** | **A/B 섀도 비교** (§8-2) — 채택 게이트 (추출 레인 + 감사 레인 각각) | 실행·판독 |
| **4** | 채택 시: `lab:batch`를 `ANALYSIS_LAB_TRANSPORT=claude-cli ANALYSIS_LAB_MODEL=claude-opus-5`로 대량 실행 운용 시작. `.env.example`에 `ANALYSIS_LAB_TRANSPORT` 문서화(기존 `ANALYSIS_LAB_*` env 8종 — MODEL/MAX_TOKENS/TIMEOUT_MS/REVIEW_MODEL/AUDIT_MODEL/CONFIRMATION_MODEL/INPUT_CHAR_CAP/ARTIFACT_HMAC_KEY — 전부 미등재인 드리프트도 이때 함께 정리) | — |
| **5** | (선택) 잔여 사이드카 확대(ai-review·confirmations) — §9 결정 ①의 유보 레인. 착수 조건: §8-2 방식의 소규모 일치율 검증 통과(ai-review는 AI_REVIEW_ADOPTED 캘리브레이션 결속이라 특히 신중) | — |

## 8. 리스크·갭

### 8-1. max_tokens 갭 (알려진 트레이드오프)

CLI에는 요청 단위 `max_tokens` 개념이 없어 `ANALYSIS_LAB_MAX_TOKENS`(기본 12,000)가 CLI 경로에 적용되지 않고, `stop_reason=max_tokens` 분기(친절한 증액 안내)도 발화하지 않는다. 실질 영향: 출력이 CLI 내부 한도에서 잘리면 `--json-schema` 검증 실패 → shim의 파싱 가드가 throw → error 런 저장. **수용** — 딥분석 출력(≈7~12k 토큰)은 CLI 한도 대비 여유가 크고, 실패해도 배치 재개 설계에 흡수된다.

### 8-2. 행동 동등성 — A/B 섀도 비교가 채택 게이트

`--system-prompt`로 대체해도 CLI 하네스가 원시 API 호출과 바이트 동일하지는 않다(구조화 출력용 내부 툴 턴 등, Phase 0에서 `num_turns: 2` 관측). 사용자 스코프 컨텍스트(`~/.claude/CLAUDE.md`·user MCP)가 로드된다면 모든 구독 런에 API 런에는 없는 머신별 프롬프트 델타가 체계적으로 섞인다 — Phase 1 ④의 실측·격리 결과를 이 비교의 전제로 삼고, 격리 불가 시 교란 변수로 판독에 참작한다. 채택 전 필수 절차:

결정 ②(lab CLI 레인 = claude-opus-5)로 신규 레인은 기존 런과 **transport와 모델이 동시에** 다르다. 비교를 2단으로 설계해 원인을 분해한다:

- **본비교 (채택 게이트)**: 신규 레인(CLI·claude-opus-5) vs 기존 런(API·opus-4-8, spike-out 재사용 — 추가 API 지출 0). 층화 5~10건(조건 밀도 상·중·하 혼합), promptVersion 동일 고정. 운용상 실제 질문("새 레인이 기존 레인 이상인가")에 직접 답한다
- **원인 분해 (본비교 미달 시에만)**: transport 단독 효과를 분리 — 동일 공고 2~3건을 `claude-sonnet-5`로 양 transport 실행(API 측도 sonnet이라 지출 소액). 차이가 transport 기인인지 모델 기인인지 판별 후 대응
- **감사 레인 검증 (결정 ①로 필수)**: 사람 판정이 이미 확정된 기존 감사 항목 표본(§10 자동 확정 70항목 활용)을 CLI 감사로 재실행 → aiAuditVerdict concur 일치율 확인. 추출과 달리 정답셋이 있으므로 판정이 명확하다
- 비교 도구: 기존 `diff.ts`의 축 단위 diff 재활용 — criteria (dimension, kind, operator, value) 집합 일치율. 단 drop-in은 아니다: `computeLabDimensionDiffs`의 `current` 파라미터는 `LabCurrentCriterion`(needsReview 필수) 타입이라 비교 기준 런 criteria에 `needsReview: null` 보충 어댑터가 필요하고, spanVerified율·axis status 분포·taxonomy 제안 유무는 diff 산출물이 아니라 양쪽 LabRun 필드에서 직접 집계한다
- 판정 기준(제안): 본비교 축 단위 verdict 일치율 ≥ 0.9 **그리고** spanVerified율 저하 없음, 감사 레인 concur 일치율 ≥ 0.9 → 채택. 미달 시 차이 항목을 판정 사례집 방식으로 검토 후 재판정
- 비교 리포트는 `docs/research/`에 한글 파일명으로 기록

### 8-3. CLI 버전 드리프트

shim은 claude CLI 2.1.219의 JSON 출력 계약(`structured_output`, `modelUsage`, usage 필드명)에 의존한다. CLI 자동 업데이트로 계약이 바뀌면 유닛 테스트가 아닌 런타임에서 깨진다. 완화: shim이 시작 시 `claude --version`을 로그에 남기고, 재조립 가드가 구조 변화를 명시적 에러로 승격(조용한 오염 불가). 런 파일 error에 버전이 함께 남도록 에러 메시지에 버전 문자열 포함.

### 8-4. Max 사용량 윈도

5시간 롤링 + 주간 상한. 딥분석 1건 ≈ 입력 수만~수십만 토큰. 대량 배치는: `--concurrency 2`(기존 기본) 유지, 윈도 소진 시 §4-3 마커 → §5 #6 분기가 **costCapped처럼 신규 착수를 중단**한다(이 분기 없이는 잔여 타깃 전부가 스폰→실패→불변 error 런으로 축적되고, 기본 재실행은 error 런을 보류(batch-plan.ts:51)해 `--retry-errors` 없이 재개가 안 된다). 윈도 리셋 후 같은 명령 재실행 시 미착수 공고는 자연 재개, 소진 시점에 이미 착수됐던 소수 error 런만 `--retry-errors`로 마저 처리. 운용 모델은 결정 ②대로 `claude-opus-5` 유지가 기본이다(구독 한도 넉넉 — 모델 하향은 상시 수단이 아니라, 실제 윈도 충돌이 반복 관측될 때만 검토하는 최후 선택지).

### 8-5. 약관 경계 (재확인)

구독 실행은 **로컬 dev 배치·실험실 용도에 한정**한다. 운영 worker·Cloud Run·사용자 대면 경로는 API 유지. 강제 수단은 규약이 아니라 검증이다: 스위치를 읽는 곳이 lab 진입점뿐임과 운영 worker 사슬의 transport 모듈 무접촉을 §6-3 rg 검증으로 커밋마다 증명한다(§2 원칙 2 — deep-analysis↔analysis-lab 의존은 이미 양방향이므로 디렉터리 위치만으로는 격리가 보장되지 않는다).

## 9. 결정 기록 (2026-08-02 사용자 확정)

1. **초기 전환 범위 = 추출 + ai-audit.** 권고(추출만)에 감사 레인을 더한 확정 — 불일치 항목 자동 확정 루프(lab:ai-audit)가 대량 실행의 실사용처이므로 함께 전환한다. **ai-review·confirmations는 API 유지**(Phase 5 유보): ai-review는 `AI_REVIEW_ADOPTED`(fable-5, 24/28 캘리브레이션) 결속 판정 레인이라 CLI 하네스 차이가 판정 분포를 흔들 수 있고, 별도 일치율 검증 통과가 전환 조건. 감사 레인 전환의 안전판은 §8-2 감사 검증(확정 정답셋 concur 일치율 ≥ 0.9).
2. **lab CLI 레인 모델 = `claude-opus-5`.** 구독 한도가 넉넉하므로 하위 모델로 내리지 않는다. 운영 primary allowlist는 불변(opus-5는 lab 레인 운용값 — 문서 상단 "결정 사항"에 코드 계약 검증 기록). 운용 명령에 `ANALYSIS_LAB_MODEL=claude-opus-5`를 명시하며(§6-4·§7 Phase 4), `resolveLabModel`의 코드 기본값(opus-4-8)은 건드리지 않는다 — env 미설정 API 경로의 기존 동작 보존.

## 10. 완료 정의 (DoD)

- [ ] Phase 1 유닛 테스트 전부 통과 + 실측 체크리스트 ①~⑤ 확인(`claude-opus-5` 가용·ai-audit 스키마 포함)
- [ ] Phase 2 배선 후 §6-2 회귀 전부 통과, §6-3 격리 0건, §6-4 스모크(추출+감사) 합격
- [ ] env 미설정 시 동작이 현재와 완전 동일함을 스모크로 확인 (운영 무영향 증명)
- [ ] Phase 3 A/B 비교 리포트 작성·판정 — 추출 본비교 + 감사 concur 검증 (채택/보류)
- [ ] 채택 시 `.env.example`·본 문서 진행 상황 블록 갱신
