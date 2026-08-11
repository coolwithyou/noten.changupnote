// claude CLI transport 단위 테스트 (실 CLI 무호출 — execFileImpl 페이크 주입).
// 실행: pnpm lab:transport:test
// 검증: ① 요청 번역(argv 조립·stdin 전달·대형 입력 ARG_MAX 회피·effort 생략)
// ② 응답 재조립(200 tool_use·usage 무변환·result 폴백) ③ 가드(모델 에코·파싱 불가)
// ④ abort → AbortError 명의 그대로 reject ⑤ resolveLabTransport env 해석
// ⑥ 조기 종료 EPIPE 내성 ⑦ 윈도 소진 합성 400(오진 정규식 미매치) ⑧ api_error_status 통과
// ⑩ keyed round-robin 공정성·key 내부 FIFO·전역 상한·abort ⑪ 단일 key 4-slot drain.
import assert from "node:assert/strict";
import type { execFile } from "node:child_process";
import {
  CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER,
  buildClaudeCliFetch,
  createClaudeCliScheduler,
  resolveClaudeCliMaxConcurrency,
  resolveLabTransport,
  type ClaudeCliScheduler,
  type ClaudeCliSchedulerKey,
} from "./claude-cli-transport";

// ---- 페이크 execFile ---------------------------------------------------------------

const FAKE_CLI_VERSION = "2.1.219-test (fake)";
const API_URL = "https://api.anthropic.com/v1/messages";

interface RecordedStdin {
  chunks: string[];
  ended: boolean;
  /** write 시점에 부착돼 있던 error 핸들러 수(-1 = write 미호출). EPIPE 방어 검증용. */
  errorHandlerCountAtWrite: number;
}
interface RecordedCall {
  file: string;
  args: string[];
  opts: { cwd?: string; maxBuffer?: number; signal?: AbortSignal };
  stdin: RecordedStdin;
}
interface FakeOutcome {
  error?: (Error & { code?: number | string }) | null;
  stdout?: string;
  stderr?: string;
}

/** (file, args, opts, cb) 시그니처의 콜백형 페이크 — --version 호출은 공통 응답. */
function makeFakeExecFile(
  respond: (call: RecordedCall) => FakeOutcome,
  options: { epipeOnWrite?: boolean } = {},
): { impl: typeof execFile; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = ((
    file: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (args[0] === "--version") {
      queueMicrotask(() => cb(null, FAKE_CLI_VERSION, ""));
      return { stdin: null };
    }
    const stdinRecord: RecordedStdin = { chunks: [], ended: false, errorHandlerCountAtWrite: -1 };
    const errorHandlers: Array<(error: Error) => void> = [];
    const call: RecordedCall = { file, args, opts: opts as RecordedCall["opts"], stdin: stdinRecord };
    calls.push(call);
    queueMicrotask(() => {
      const outcome = respond(call);
      cb(outcome.error ?? null, outcome.stdout ?? "", outcome.stderr ?? "");
    });
    return {
      stdin: {
        on(event: string, handler: (error: Error) => void) {
          if (event === "error") errorHandlers.push(handler);
        },
        write(chunk: unknown) {
          stdinRecord.chunks.push(String(chunk));
          stdinRecord.errorHandlerCountAtWrite = errorHandlers.length;
          if (options.epipeOnWrite) {
            const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
            // 핸들러 미부착이면 실제 Node 처럼 uncaught 로 죽는 상황을 시뮬레이트한다.
            if (errorHandlers.length === 0) throw epipe;
            for (const handler of errorHandlers) handler(epipe);
            return false;
          }
          return true;
        },
        end() {
          stdinRecord.ended = true;
        },
      },
    };
  }) as unknown as typeof execFile;
  return { impl, calls };
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `${flag} 플래그 존재`);
  const value = args[index + 1];
  assert.ok(value !== undefined, `${flag} 값 존재`);
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- 요청 픽스처 (extractor.ts:101-119 실 body 형태) -------------------------------

const DEEP_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { analysis_markdown: { type: "string" }, criteria: { type: "array" } },
  required: ["analysis_markdown", "criteria"],
};
const SYSTEM_PROMPT = "너는 공공 지원사업 공고 분석가다. (테스트 시스템 프롬프트)";

function extractorBody(content: string | unknown[]): string {
  return JSON.stringify({
    model: "claude-opus-5",
    max_tokens: 12_000,
    output_config: { effort: "high" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    tools: [{ name: "deep_grant_analysis", description: "22축 딥분석", input_schema: DEEP_TOOL_SCHEMA }],
    tool_choice: { type: "tool", name: "deep_grant_analysis" },
  });
}

/** 사이드카(ai-review.ts:504-512) 형태 — output_config 없음. */
function sidecarBody(): string {
  return JSON.stringify({
    model: "claude-sonnet-5",
    max_tokens: 8_000,
    system: "검수 시스템 프롬프트",
    messages: [{ role: "user", content: "검수 대상 런 요약" }],
    tools: [{ name: "ai_review", description: "검수", input_schema: DEEP_TOOL_SCHEMA }],
    tool_choice: { type: "tool", name: "ai_review" },
  });
}

// ---- CLI 출력 픽스처 (probe-opus5-stdin.json / probe-badmodel.json 실측 축약) ------

const STRUCTURED_OUTPUT = {
  analysis_markdown: "# 공고 요약\n- 사업명: 초기창업패키지(테스트 축약)",
  criteria: [{ dimension: "region", operator: "in", kind: "required", value: { regions: ["11", "41"] } }],
};
const SUCCESS_USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 12_713,
  cache_read_input_tokens: 0,
  output_tokens: 7_615,
  service_tier: "standard",
};

function successCliJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    stop_reason: "tool_use",
    total_cost_usd: 0.317515,
    usage: SUCCESS_USAGE,
    modelUsage: { "claude-opus-5": { inputTokens: 2, outputTokens: 7_615, costUSD: 0.317515, provider: "firstParty" } },
    api_error_status: null,
    result: JSON.stringify(STRUCTURED_OUTPUT),
    structured_output: STRUCTURED_OUTPUT,
    ...overrides,
  });
}

// ---- ① 요청 번역 -------------------------------------------------------------------
{
  const bigContent = `공고본문시작\n${"내".repeat(1_000_000)}\n공고본문끝`;
  const { impl, calls } = makeFakeExecFile((call) => {
    const model = call.args[call.args.indexOf("--model") + 1] ?? "";
    return { stdout: successCliJson({ modelUsage: { [model]: {} } }) };
  });
  const fetchImpl = buildClaudeCliFetch({ execFileImpl: impl });
  const res = await fetchImpl(API_URL, { method: "POST", body: extractorBody(bigContent) });
  assert.equal(res.status, 200);

  const call = calls[0];
  assert.ok(call);
  const args = call.args;
  assert.equal(args[0], "-p");
  assert.equal(valueAfter(args, "--output-format"), "json");
  assert.equal(valueAfter(args, "--tools"), "");
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--safe-mode"), "--safe-mode 고정 세트 포함(사용자 스코프 차단 + OAuth 유지)");
  assert.ok(!args.includes("--bare"), "--bare 절대 금지(OAuth 미사용 → API 과금 전환)");
  assert.equal(valueAfter(args, "--model"), "claude-opus-5", "풀 id 그대로(별칭 변환 금지)");
  assert.equal(valueAfter(args, "--json-schema"), JSON.stringify(DEEP_TOOL_SCHEMA));
  assert.equal(valueAfter(args, "--system-prompt"), SYSTEM_PROMPT);
  assert.equal(valueAfter(args, "--effort"), "high");
  assert.ok(!args.some((arg) => arg.includes("max_tokens")), "max_tokens 미매핑(알려진 갭 §8-1)");
  assert.ok(args.every((arg) => !arg.includes("공고본문시작")), "대형 콘텐츠는 argv 어디에도 없음(ARG_MAX)");
  assert.equal(call.stdin.chunks.join(""), bigContent, "콘텐츠는 stdin.write 로 전달");
  assert.equal(call.stdin.ended, true, "stdin end() 호출(EOF 대기로 540s 소진 방지)");
  assert.equal(call.opts.maxBuffer, 64 * 1024 * 1024);

  // 사이드카형 body(output_config 없음) → --effort 플래그 생략
  await fetchImpl(API_URL, { method: "POST", body: sidecarBody() });
  const sidecarCall = calls[1];
  assert.ok(sidecarCall);
  assert.ok(!sidecarCall.args.includes("--effort"), "effort 부재 시 플래그 생략");
  assert.equal(valueAfter(sidecarCall.args, "--model"), "claude-sonnet-5");

  // 블록 배열 content → text 필드 join 후 stdin
  await fetchImpl(API_URL, {
    method: "POST",
    body: extractorBody([{ type: "text", text: "블록A" }, { type: "text", text: "블록B" }]),
  });
  const blockCall = calls[2];
  assert.ok(blockCall);
  assert.equal(blockCall.stdin.chunks.join(""), "블록A\n블록B");
  console.log("✅ 요청 번역 — argv 조립·stdin 전달·대형 입력 ARG_MAX 회피·effort 생략");
}

// ---- ② 응답 재조립 -----------------------------------------------------------------
{
  const { impl } = makeFakeExecFile(() => ({ stdout: successCliJson() }));
  const res = await buildClaudeCliFetch({ execFileImpl: impl })(API_URL, { method: "POST", body: extractorBody("소형 입력") });
  assert.equal(res.status, 200);
  const payload = (await res.json()) as {
    content: Array<{ type: string; name: string; input: unknown }>;
    stop_reason: string;
    usage: unknown;
  };
  assert.equal(payload.content.length, 1);
  const block = payload.content[0];
  assert.ok(block);
  assert.equal(block.type, "tool_use");
  assert.equal(block.name, "deep_grant_analysis", "tool_choice.name 으로 재조립");
  assert.deepEqual(block.input, STRUCTURED_OUTPUT, "structured_output 우선 사용");
  // input_tokens 만 보정(2 + cache_creation 12,713 — CLI 가 프롬프트를 cache_creation 으로
  // 계상해 명목 입력이 소실되는 실측 결함의 회복), 그 외 필드는 무변환 통과.
  assert.deepEqual(
    payload.usage,
    { ...SUCCESS_USAGE, input_tokens: 2 + 12_713 },
    "usage: input_tokens 에 cache_creation 합산, 나머지 필드 무변환",
  );
  assert.equal(payload.stop_reason, "tool_use");

  // structured_output 부재 → result JSON.parse 폴백
  const { impl: implFallback } = makeFakeExecFile(() => ({ stdout: successCliJson({ structured_output: undefined }) }));
  const resFallback = await buildClaudeCliFetch({ execFileImpl: implFallback })(API_URL, { method: "POST", body: extractorBody("입력") });
  assert.equal(resFallback.status, 200);
  const payloadFallback = (await resFallback.json()) as { content: Array<{ input: unknown }> };
  assert.deepEqual(payloadFallback.content[0]?.input, STRUCTURED_OUTPUT, "result 파싱 폴백");
  console.log("✅ 응답 재조립 — 200 tool_use·usage 무변환·stop_reason 통과·result 폴백");
}

// ---- ③ 가드 ------------------------------------------------------------------------
{
  // 모델 에코 실패: modelUsage 키에 요청 모델 없음 → throw
  const { impl: implMismatch } = makeFakeExecFile(() => ({
    stdout: successCliJson({ modelUsage: { "claude-haiku-4-5-20251001": {} } }),
  }));
  await assert.rejects(
    buildClaudeCliFetch({ execFileImpl: implMismatch })(API_URL, { method: "POST", body: extractorBody("입력") }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("modelUsage") && error.message.includes("claude-opus-5"),
  );

  // haiku 보조 호출 공존: 요청 모델이 "포함"이면 통과(정확 일치 요구 금지 — --safe-mode 실측)
  const { impl: implCoexist } = makeFakeExecFile(() => ({
    stdout: successCliJson({ modelUsage: { "claude-haiku-4-5-20251001": {}, "claude-opus-5": {} } }),
  }));
  const resCoexist = await buildClaudeCliFetch({ execFileImpl: implCoexist })(API_URL, { method: "POST", body: extractorBody("입력") });
  assert.equal(resCoexist.status, 200);

  // structured_output 부재 + result 파싱 불가 → throw(result 앞부분 포함)
  const { impl: implBadResult } = makeFakeExecFile(() => ({
    stdout: successCliJson({ structured_output: undefined, result: "JSON 이 아닌 자유 텍스트" }),
  }));
  await assert.rejects(
    buildClaudeCliFetch({ execFileImpl: implBadResult })(API_URL, { method: "POST", body: extractorBody("입력") }),
    (error: unknown) => error instanceof Error && error.message.includes("JSON 이 아닌 자유 텍스트"),
  );
  console.log("✅ 가드 — 모델 에코 불일치 throw·haiku 공존 통과·파싱 불가 throw");
}

// ---- ④ abort → AbortError 그대로 reject --------------------------------------------
{
  const stubChild = { stdin: { on() {}, write() { return true; }, end() {} } };
  const abortImpl = ((
    _file: string,
    args: string[],
    opts: { signal?: AbortSignal },
    cb: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (args[0] === "--version") {
      queueMicrotask(() => cb(null, FAKE_CLI_VERSION, ""));
      return stubChild;
    }
    // 실 execFile 처럼: signal abort 시 name "AbortError" 에러로 콜백, 그때까진 미종료.
    opts.signal?.addEventListener("abort", () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      cb(error, "", "");
    });
    return stubChild;
  }) as unknown as typeof execFile;

  const controller = new AbortController();
  const pending = buildClaudeCliFetch({ execFileImpl: abortImpl })(API_URL, {
    method: "POST",
    body: extractorBody("입력"),
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
    "AbortError 를 다른 에러로 감싸면 extractor.ts:136-139 타임아웃 분기가 죽는다",
  );
  console.log("✅ abort — AbortError 명의 그대로 reject(기존 타임아웃 분기 발화 계약)");
}

// ---- ⑤ resolveLabTransport ----------------------------------------------------------
{
  const saved = process.env.ANALYSIS_LAB_TRANSPORT;
  try {
    delete process.env.ANALYSIS_LAB_TRANSPORT;
    assert.equal(resolveLabTransport(), "api");
    process.env.ANALYSIS_LAB_TRANSPORT = "";
    assert.equal(resolveLabTransport(), "api");
    process.env.ANALYSIS_LAB_TRANSPORT = "api";
    assert.equal(resolveLabTransport(), "api");
    process.env.ANALYSIS_LAB_TRANSPORT = "claude-cli";
    assert.equal(resolveLabTransport(), "claude-cli");
    process.env.ANALYSIS_LAB_TRANSPORT = "claude_cli";
    assert.throws(() => resolveLabTransport(), /ANALYSIS_LAB_TRANSPORT/, "오타 fail-fast");
  } finally {
    if (saved === undefined) delete process.env.ANALYSIS_LAB_TRANSPORT;
    else process.env.ANALYSIS_LAB_TRANSPORT = saved;
  }
  console.log("✅ resolveLabTransport — 미설정/빈값/api/claude-cli/오타 fail-fast(env 복원)");
}

{
  const saved = process.env.ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY;
  try {
    delete process.env.ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY;
    assert.equal(resolveClaudeCliMaxConcurrency(), 4, "전역 CLI 기본 상한");
    process.env.ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY = "6";
    assert.equal(resolveClaudeCliMaxConcurrency(), 6);
    process.env.ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY = "0";
    assert.throws(() => resolveClaudeCliMaxConcurrency(), /MAX_CONCURRENCY/, "0은 fail-fast");
    process.env.ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY = "4.5";
    assert.throws(() => resolveClaudeCliMaxConcurrency(), /MAX_CONCURRENCY/, "정수 아니면 fail-fast");
  } finally {
    if (saved === undefined) delete process.env.ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY;
    else process.env.ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY = saved;
  }
  console.log("✅ CLI 전역 상한 — 기본 4·env 오버라이드·오타 fail-fast");
}

// ---- ⑥ 조기 종료 내성(EPIPE) --------------------------------------------------------
{
  const exitError = Object.assign(
    new Error(`Command failed: claude --system-prompt ${SYSTEM_PROMPT}`),
    { code: 1 },
  );
  const { impl, calls } = makeFakeExecFile(() => ({ error: exitError, stdout: "", stderr: "" }), {
    epipeOnWrite: true,
  });
  const res = await buildClaudeCliFetch({ execFileImpl: impl })(API_URL, { method: "POST", body: extractorBody("입력") });
  assert.equal(res.status, 500, "EPIPE 전파 없이 합성 500 응답으로 합류(프로세스 생존)");
  const body = await res.text();
  assert.ok(body.includes(FAKE_CLI_VERSION), "합성 본문에 CLI 버전 포함(§8-3 드리프트 진단)");
  assert.ok(!body.includes("테스트 시스템 프롬프트"), "error.message 미포함(argv 시스템 프롬프트 노출 방지)");
  const call = calls[0];
  assert.ok(call);
  assert.ok(call.stdin.errorHandlerCountAtWrite >= 1, "write 이전에 stdin error 핸들러 부착");
  console.log("✅ 조기 종료 내성 — EPIPE 무해화·합성 500·프롬프트 비노출");
}

// ---- ⑦ 윈도 소진 합성 400 -----------------------------------------------------------
{
  const { impl } = makeFakeExecFile(() => ({
    error: Object.assign(new Error("Command failed"), { code: 1 }),
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: null,
      result: "Claude AI usage limit reached|1754121600",
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
    }),
    stderr: "",
  }));
  const res = await buildClaudeCliFetch({ execFileImpl: impl })(API_URL, { method: "POST", body: extractorBody("입력") });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.ok(body.includes(CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER), "batch 중단 분기(§5 #6)용 마커 포함");
  assert.ok(body.includes(FAKE_CLI_VERSION), "본문에 CLI 버전 포함");
  assert.ok(
    !/retention|zero data|invalid_request/i.test(body),
    "ai-review.ts:552 오진 분기 절대 미매치(fable-5 ZDR 메시지 둔갑 방지)",
  );
  console.log("✅ 합성 400 — 윈도 소진 마커·고정 한국어 본문·오진 정규식 미매치");
}

// ---- ⑧ api_error_status 통과(404 → 기존 '모델 접근 불가' 분기 합류) ------------------
{
  const badModelResult =
    "There's an issue with the selected model (claude-bogus-999). It may not exist or you may not have access to it. Run --model to pick a different model.";
  const { impl } = makeFakeExecFile(() => ({
    error: Object.assign(new Error("Command failed"), { code: 1 }),
    stdout: JSON.stringify({
      type: "result",
      subtype: "success", // 실측: 에러여도 subtype 은 "success" — is_error 로만 판별해야 함
      is_error: true,
      api_error_status: 404,
      result: badModelResult,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
    }),
    stderr: "",
  }));
  const res = await buildClaudeCliFetch({ execFileImpl: impl })(API_URL, { method: "POST", body: extractorBody("입력") });
  assert.equal(res.status, 404, "api_error_status 를 그 status 그대로 통과");
  assert.equal(await res.text(), badModelResult, "body = result 문자열(기존 403/404 분기 자연 발화)");
  console.log("✅ api_error_status 통과 — exit 1 이어도 stdout JSON 우선 파싱·404 재현");
}

// ---- ⑨ api_error_status=429 세션 한도 → 전용 윈도 소진 마커 ----------------
{
  const sessionLimitResult = "You've hit your session limit · resets 10:10pm (Asia/Seoul)";
  const { impl } = makeFakeExecFile(() => ({
    error: Object.assign(new Error("Command failed"), { code: 1 }),
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: sessionLimitResult,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
    }),
    stderr: "",
  }));
  const res = await buildClaudeCliFetch({ execFileImpl: impl })(API_URL, {
    method: "POST",
    body: extractorBody("입력"),
  });
  assert.equal(res.status, 400, "구독 세션 한도 429는 일반 429 재시도 루프로 보내지 않음");
  assert.ok((await res.text()).includes(CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER));
  console.log("✅ api_error_status=429 세션 한도 — 전용 윈도 소진 마커로 승격");
}

// ---- ⑩ 일시 rate limit·context exceeded는 전역 윈도 소진으로 오진하지 않음 ----
{
  const { impl: rateLimitImpl } = makeFakeExecFile(() => ({
    error: Object.assign(new Error("Command failed"), { code: 1 }),
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: "Rate limit exceeded. Please retry shortly.",
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
    }),
    stderr: "",
  }));
  const rateLimitResponse = await buildClaudeCliFetch({ execFileImpl: rateLimitImpl })(API_URL, {
    method: "POST",
    body: extractorBody("입력"),
  });
  assert.equal(rateLimitResponse.status, 429, "일시 429는 기존 재시도 분기로 전달");
  assert.ok(!(await rateLimitResponse.text()).includes(CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER));

  const { impl: contextLimitImpl } = makeFakeExecFile(() => ({
    error: Object.assign(new Error("Command failed"), { code: 1 }),
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: null,
      result: "Maximum context length exceeded for this request.",
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
    }),
    stderr: "",
  }));
  const contextLimitResponse = await buildClaudeCliFetch({ execFileImpl: contextLimitImpl })(API_URL, {
    method: "POST",
    body: extractorBody("입력"),
  });
  assert.equal(contextLimitResponse.status, 500, "컨텍스트 초과는 요청 오류로 유지");
  assert.ok(!(await contextLimitResponse.text()).includes(CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER));
  console.log("✅ 윈도 소진 오진 방지 — 일시 429·context exceeded는 전역 중단 안 함");
}

// ---- ⑪ key 공정성·FIFO·전역 상한·대기 중 abort -------------------------------
{
  const delegated = createClaudeCliScheduler(4);
  const seenKeys: ClaudeCliSchedulerKey[] = [];
  const observingScheduler: ClaudeCliScheduler = {
    maxConcurrency: delegated.maxConcurrency,
    run(key, task, signal) {
      seenKeys.push(key);
      return delegated.run(key, task, signal);
    },
  };
  const { impl } = makeFakeExecFile(() => ({ stdout: successCliJson() }));
  await buildClaudeCliFetch({
    execFileImpl: impl,
    scheduler: observingScheduler,
    schedulerKey: "run-explicit-key",
  })(API_URL, { method: "POST", body: extractorBody("key 전달") });
  assert.deepEqual(seenKeys, ["run-explicit-key"], "fetch shim이 명시적 run/notice key를 스케줄러에 전달");

  const fairScheduler = createClaudeCliScheduler(1);
  const order: string[] = [];
  function controlled(key: string, label: string) {
    const started = deferred<void>();
    const gate = deferred<void>();
    const promise = fairScheduler.run(key, async () => {
      order.push(label);
      started.resolve();
      await gate.promise;
    });
    return { started, gate, promise };
  }

  const a1 = controlled("notice-a", "a1");
  await a1.started.promise;
  const a2 = controlled("notice-a", "a2");
  const a3 = controlled("notice-a", "a3");
  const b1 = controlled("notice-b", "b1");
  const b2 = controlled("notice-b", "b2");

  a1.gate.resolve();
  await a2.started.promise;
  a2.gate.resolve();
  await b1.started.promise;
  b1.gate.resolve();
  await a3.started.promise;
  a3.gate.resolve();
  await b2.started.promise;
  b2.gate.resolve();
  await Promise.all([a1.promise, a2.promise, a3.promise, b1.promise, b2.promise]);
  assert.deepEqual(order, ["a1", "a2", "b1", "a3", "b2"], "key 내부 FIFO를 지키며 key 사이를 round-robin");

  const scheduler = createClaudeCliScheduler(4);
  let active = 0;
  let maxActive = 0;
  const completed: number[] = [];
  await Promise.all(Array.from({ length: 12 }, (_, index) => scheduler.run(`notice-${index % 3}`, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(4);
    completed.push(index);
    active -= 1;
  })));
  assert.equal(maxActive, 4, "여러 key 요청이 동시 진입해도 실행 프로세스는 전역 상한 4");
  assert.equal(completed.length, 12);

  const singleSlot = createClaudeCliScheduler(1);
  const gate = deferred<void>();
  const first = singleSlot.run("notice-a", () => gate.promise);
  const controller = new AbortController();
  let queuedStarted = false;
  const queued = singleSlot.run("notice-b", async () => {
    queuedStarted = true;
  }, controller.signal);
  controller.abort();
  await assert.rejects(
    queued,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
    "대기열에서 타임아웃된 요청은 프로세스를 시작하지 않고 즉시 제거",
  );
  assert.equal(queuedStarted, false);
  gate.resolve();
  await first;
  console.log("✅ keyed 전역 스케줄러 — key 공정성·FIFO·실행 상한·대기열 abort 계약");
}

// ---- ⑫ 실행 timeout은 스케줄러 대기 후 시작 -------------------------------
{
  const scheduler = createClaudeCliScheduler(1);
  const gate = deferred<void>();
  const blockerStarted = deferred<void>();
  const blocker = scheduler.run("blocker", async () => {
    blockerStarted.resolve();
    await gate.promise;
  });
  await blockerStarted.promise;

  const { impl } = makeFakeExecFile(() => ({ stdout: successCliJson() }));
  const request = buildClaudeCliFetch({
    execFileImpl: impl,
    scheduler,
    schedulerKey: "queued-request",
  })(API_URL, {
    method: "POST",
    headers: { "x-cunote-execution-timeout-ms": "10" },
    body: extractorBody("대기 후 실행"),
  });
  let settled = false;
  void request.finally(() => { settled = true; });
  await delay(30);
  assert.equal(settled, false, "대기 30ms가 실행 timeout 10ms를 소진하지 않음");
  gate.resolve();
  await blocker;
  assert.equal((await request).status, 200);
  console.log("✅ 실행 기준 timeout — 스케줄러 대기시간 제외");
}

// ---- ⑬ 단일 key도 전역 4슬롯을 work-conserving 방식으로 소진 ----------------
{
  const scheduler = createClaudeCliScheduler(4);
  const gate = deferred<void>();
  const firstWaveStarted = deferred<void>();
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const tasks = Array.from({ length: 8 }, () => scheduler.run("only-notice", async () => {
    active += 1;
    started += 1;
    maxActive = Math.max(maxActive, active);
    if (started === 4) firstWaveStarted.resolve();
    await gate.promise;
    active -= 1;
  }));
  await firstWaveStarted.promise;
  assert.equal(active, 4, "단일 heavy notice도 첫 파동에서 4슬롯을 모두 사용");
  gate.resolve();
  await Promise.all(tasks);
  assert.equal(started, 8);
  assert.equal(maxActive, 4, "단일 key drain도 전역 상한을 넘지 않음");
  console.log("✅ 단일 key work-conserving drain — 전역 4슬롯 활용·상한 보존");
}

console.log("\nclaude-cli-transport 테스트 전부 통과");
