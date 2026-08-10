// Claude CLI transport — 실험실(lab) 전용 전송층 shim (dev 전용, 운영 worker 무접촉).
// Anthropic Messages API 모양의 fetch(url, init) 호출을 로컬 claude CLI 실행
// (`claude -p --output-format json ...`)으로 번역하고, CLI 의 단일 JSON stdout 을
// Messages API 모양 Response 로 재조립한다 — lab:batch 등 대량 딥분석을
// Max 구독(Keychain OAuth)으로 API 토큰 지출 없이 실행하기 위한 것.
// 설계 정본: docs/plans/2026-08-02-claude-cli-transport-for-deep-analysis.md §4.
// - 주입은 기존 심(fetchImpl 파라미터)으로만 — 검증·정규화·게이트 로직 무수정.
// - 응답 불신 원칙: shim 은 "모양"만 재조립하고 내용 검증은 기존 하류가 수행한다.
// - 재시도는 이 모듈의 몫이 아니다 — 합성 HTTP 상태를 본 기존 호출부의 분기가 발화한다.
import { execFile, type ExecFileException } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONFIGURABLE_CONCURRENCY = 16;
/** Max 사용량 윈도 소진 판별 시그널(CLI 자체 에러 텍스트 대상). */
const WINDOW_EXHAUSTED_SIGNAL =
  /usage limit|session limit|rate limit|quota|limit reached|hit your .* limit|exceeded|resets?\s+\d/i;
/** batch 가 신규 착수 중단 분기(§5 #6)에서 감지하는 마커 — 문자열 계약. */
export const CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER = "[CLAUDE_CLI_WINDOW_EXHAUSTED]";

/** 하위 CLI 루프가 재시도를 즉시 중단할 수 있는 문자열 계약. */
export function isClaudeCliWindowExhaustedError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value);
  return message.includes(CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER);
}

// ── transport 스위치 ─────────────────────────────────────────────────────────

/** env ANALYSIS_LAB_TRANSPORT 해석: 미설정/""/"api" → "api", "claude-cli" → "claude-cli", 그 외 throw(오타 fail-fast). */
export function resolveLabTransport(): "api" | "claude-cli" {
  const raw = (process.env.ANALYSIS_LAB_TRANSPORT ?? "").trim();
  if (raw === "" || raw === "api") return "api";
  if (raw === "claude-cli") return "claude-cli";
  throw new Error(
    `ANALYSIS_LAB_TRANSPORT 값이 잘못됐습니다: "${raw}" — 허용값은 "api" 또는 "claude-cli" 뿐입니다(오타 fail-fast).`,
  );
}

// ── fetch 호환 shim ──────────────────────────────────────────────────────────

export interface ClaudeCliFetchConfig {
  /** claude 바이너리. 기본 "claude"(PATH 해석). */
  claudeBinary?: string;
  /** CLI 실행 cwd. 기본 os.tmpdir() 하위 고정 빈 디렉터리 — 프로젝트 스코프 CLAUDE.md·.mcp.json 로드 차단. */
  scratchCwd?: string;
  /** 테스트 주입용(node:child_process 콜백형). 기본 실 execFile. */
  execFileImpl?: typeof execFile;
  /** 테스트·시뮬레이션용 스케줄러. 기본은 모든 fetch 인스턴스가 공유하는 프로세스 전역 스케줄러. */
  scheduler?: ClaudeCliScheduler;
}

/**
 * claude -p 프로세스 실행 상한. 공고 배치·딥분석·Kordoc·검수 레인이
 * 서로 다른 fetch shim을 만들어도 동일 스케줄러를 통과해 Max 세션 폭주를 막는다.
 */
export interface ClaudeCliScheduler {
  readonly maxConcurrency: number;
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export function createClaudeCliScheduler(maxConcurrency: number): ClaudeCliScheduler {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_CONFIGURABLE_CONCURRENCY) {
    throw new Error(`Claude CLI 동시성은 1~${MAX_CONFIGURABLE_CONCURRENCY} 정수여야 합니다.`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const drain = (): void => {
    while (active < maxConcurrency) {
      const launch = queue.shift();
      if (!launch) return;
      launch();
    }
  };

  return {
    maxConcurrency,
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      return new Promise<T>((resolve, reject) => {
        let queued = true;
        const onAbort = (): void => {
          if (!queued) return;
          const index = queue.indexOf(launch);
          if (index >= 0) queue.splice(index, 1);
          queued = false;
          reject(abortReason(signal));
        };
        const launch = (): void => {
          if (!queued) return;
          queued = false;
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(abortReason(signal));
            queueMicrotask(drain);
            return;
          }
          active += 1;
          // 슬롯 배정 즉시 task를 시작해 execFile이 AbortSignal 리스너를 붙인다.
          // 한 microtask 늦추면 호출자의 즉시 abort가 리스너 등록보다 먼저 일어나 자식이 대기한다.
          let pending: Promise<T>;
          try {
            pending = task();
          } catch (error) {
            reject(error);
            active -= 1;
            drain();
            return;
          }
          void pending.then(resolve, reject).finally(() => {
            active -= 1;
            drain();
          });
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(launch);
        drain();
      });
    },
  };
}

export function resolveClaudeCliMaxConcurrency(): number {
  const raw = process.env.ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY?.trim();
  if (!raw) return DEFAULT_MAX_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONFIGURABLE_CONCURRENCY) {
    throw new Error(
      `ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY는 1~${MAX_CONFIGURABLE_CONCURRENCY} 정수여야 합니다: "${raw}"`,
    );
  }
  return parsed;
}

let sharedScheduler: ClaudeCliScheduler | null = null;

function getSharedClaudeCliScheduler(): ClaudeCliScheduler {
  sharedScheduler ??= createClaudeCliScheduler(resolveClaudeCliMaxConcurrency());
  return sharedScheduler;
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function buildClaudeCliFetch(config?: ClaudeCliFetchConfig): typeof fetch {
  const binary = config?.claudeBinary ?? "claude";
  const scratchCwd = config?.scratchCwd ?? join(tmpdir(), "cunote-claude-cli-transport");
  const execFileImpl = config?.execFileImpl ?? execFile;
  const scheduler = config?.scheduler ?? getSharedClaudeCliScheduler();
  mkdirSync(scratchCwd, { recursive: true });

  const claudeCliFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // url 과 x-api-key 헤더는 의도적으로 무시한다 — 실행 대상이 원격 API 가 아니라
    // 로컬 claude 바이너리이고, 인증은 CLI 의 Keychain OAuth(Max 구독)가 담당하기 때문.
    const request = parseAnthropicRequest(init?.body);
    const signal = init?.signal ?? undefined;
    const outcome = await scheduler.run(() => runClaudeCli({
      execFileImpl,
      binary,
      argv: buildArgv(request),
      cwd: scratchCwd,
      signal,
      stdinText: request.content,
    }), signal);
    const getVersion = () => resolveCliVersion(execFileImpl, binary);
    const cliJson = parseJsonSafe(outcome.stdout);
    if (isRecord(cliJson) && cliJson.is_error === false) {
      return assembleSuccessResponse(request, cliJson, getVersion);
    }
    return assembleErrorResponse(cliJson, outcome, getVersion);
  };
  return claudeCliFetch as typeof fetch;
}

// ── 진입점 공용 바인딩 ───────────────────────────────────────────────────────

export interface LabLlmBinding {
  transport: "api" | "claude-cli";
  /** claude-cli 면 더미 "subscription" — shim 이 x-api-key 를 무시하므로 자리채움일 뿐이다. */
  apiKey: string;
  /** api 면 undefined(기존 전역 fetch 경로 보존). */
  fetchImpl: typeof fetch | undefined;
}

/**
 * transport 분기 + apiKey 요구 스킵을 한 곳으로 — lab 진입점들이 공용으로 쓴다.
 * api 분기는 analyze.ts 의 resolveAnthropicApiKey 와 동일 동작·동일 메시지
 * (loadMonorepoEnv 동적 import 가 필요해 async — 시그니처만 Promise 로 다르다).
 */
export async function resolveLabLlmBinding(): Promise<LabLlmBinding> {
  const transport = resolveLabTransport();
  if (transport === "claude-cli") {
    return { transport, apiKey: "subscription", fetchImpl: buildClaudeCliFetch() };
  }
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    const { loadMonorepoEnv } = await import("../loadMonorepoEnv");
    loadMonorepoEnv();
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY 가 설정되어 있지 않습니다. 모노레포 루트 .env(.env.local)에 키를 넣고 dev 서버를 재시작해주세요.",
    );
  }
  return { transport, apiKey, fetchImpl: undefined };
}

// ── 요청 번역 (Messages API body → argv + stdin) ────────────────────────────

interface ParsedAnthropicRequest {
  model: string;
  system: string | null;
  /** messages[0].content — stdin 으로만 전달한다(argv 금지: 800k chars 입력이 macOS ARG_MAX 초과). */
  content: string;
  schemaJson: string;
  toolName: string;
  effort: string | null;
}

function parseAnthropicRequest(body: unknown): ParsedAnthropicRequest {
  if (typeof body !== "string" || body === "") {
    throw new Error("claude-cli transport: init.body 가 JSON 문자열이 아닙니다 — 지원 밖 호출 형태입니다.");
  }
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) throw new Error("claude-cli transport: 요청 body 가 객체가 아닙니다.");
  const model = typeof parsed.model === "string" ? parsed.model : null;
  if (!model) throw new Error("claude-cli transport: 요청 body 에 model 이 없습니다.");
  const system = typeof parsed.system === "string" ? parsed.system : null;

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const first: unknown = messages[0];
  const rawContent = isRecord(first) ? first.content : undefined;
  let content: string | null = null;
  if (typeof rawContent === "string") {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    // 블록 배열이면 text 필드만 join — 호출부 2곳은 string 이지만 방어적으로 수용.
    content = rawContent
      .map((block: unknown) =>
        typeof block === "string" ? block : isRecord(block) && typeof block.text === "string" ? block.text : "")
      .join("\n");
  }
  if (content === null) throw new Error("claude-cli transport: messages[0].content 를 해석할 수 없습니다.");

  const tools = Array.isArray(parsed.tools) ? (parsed.tools as unknown[]) : [];
  const firstTool = isRecord(tools[0]) ? tools[0] : null;
  const inputSchema = firstTool && isRecord(firstTool.input_schema) ? firstTool.input_schema : null;
  if (!inputSchema) throw new Error("claude-cli transport: tools[0].input_schema 가 없습니다 — tool 강제 호출만 지원합니다.");
  const toolChoice = isRecord(parsed.tool_choice) ? parsed.tool_choice : null;
  const toolName = typeof toolChoice?.name === "string"
    ? toolChoice.name
    : firstTool && typeof firstTool.name === "string" ? firstTool.name : null;
  if (!toolName) throw new Error("claude-cli transport: tool_choice.name 을 해석할 수 없습니다.");

  const outputConfig = isRecord(parsed.output_config) ? parsed.output_config : null;
  const effort = typeof outputConfig?.effort === "string" ? outputConfig.effort : null;
  // max_tokens 는 매핑하지 않는다 — CLI 에 요청 단위 개념이 없음(알려진 갭, 계획 §8-1).
  // 출력이 CLI 내부 한도에서 잘리면 하류 파싱 가드가 throw → error 런으로 흡수된다.
  return { model, system, content, schemaJson: JSON.stringify(inputSchema), toolName, effort };
}

function buildArgv(request: ParsedAnthropicRequest): string[] {
  // 고정 플래그는 Phase 0 실측 세트 + --safe-mode(실측 확정: 사용자 스코프 ~/.claude/CLAUDE.md·MCP
  // 로드를 차단하면서 OAuth 구독 인증은 유지). --bare 는 절대 금지 — OAuth 미사용으로 API 과금 전환됨.
  const argv = [
    "-p",
    "--output-format", "json",
    "--tools", "",
    "--no-session-persistence",
    "--safe-mode",
    "--model", request.model, // 풀 id 그대로 — 별칭 변환 금지(가격표·순환 가드·파일 키가 풀 id 결속)
    "--json-schema", request.schemaJson,
  ];
  if (request.system !== null) argv.push("--system-prompt", request.system);
  if (request.effort !== null) argv.push("--effort", request.effort); // 사이드카 호출엔 없음 → 생략
  return argv;
}

// ── CLI 실행 ─────────────────────────────────────────────────────────────────

interface CliExecOutcome {
  error: ExecFileException | null;
  stdout: string;
  stderr: string;
}

function runClaudeCli(options: {
  execFileImpl: typeof execFile;
  binary: string;
  argv: string[];
  cwd: string;
  signal: AbortSignal | undefined;
  stdinText: string;
}): Promise<CliExecOutcome> {
  return new Promise((resolve, reject) => {
    const child = options.execFileImpl(
      options.binary,
      options.argv,
      { cwd: options.cwd, maxBuffer: MAX_BUFFER_BYTES, signal: options.signal },
      (error, stdout, stderr) => {
        // abort 는 그대로 reject — 기존 호출부(extractor.ts:136-139)의 타임아웃 분기가
        // error.name === "AbortError" 로 발화한다. 다른 에러로 감싸면 오분류된다.
        if (error && error.name === "AbortError") {
          reject(error);
          return;
        }
        // exit≠0 이어도 stdout 에 유효 JSON 이 올 수 있으므로(실측: 404 케이스 exit 1 +
        // 완전한 JSON) error 유무와 무관하게 stdout 을 함께 넘긴다.
        resolve({ error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    // stdin 프로토콜 필수: error 핸들러 부착 → write → end.
    // CLI 가 stdin 을 읽기 전에 조기 종료하면 대형 입력 write 가 EPIPE 를 던지는데,
    // 핸들러 미부착 시 uncaught exception 으로 batch 워커 풀 프로세스가 통째로 죽는다(실측된 실패 모드).
    // end() 누락 시 CLI 가 EOF 대기로 타임아웃(540s)을 통째로 소진한다.
    const stdin = child?.stdin;
    if (stdin) {
      stdin.on("error", () => {});
      try {
        stdin.write(options.stdinText);
        stdin.end();
      } catch {
        // 이미 파괴된 스트림의 동기 throw 방어 — 실패 원인은 execFile 콜백 쪽에서 합류한다.
      }
    }
  });
}

// ── CLI 버전(에러 진단용 — §8-3 버전 드리프트) ──────────────────────────────

let cliVersionCache: string | null = null;

/** 최초 필요 시 1회 `claude --version` 실행해 모듈 수준 캐시. 실패하면 "unknown". */
function resolveCliVersion(execFileImpl: typeof execFile, binary: string): Promise<string> {
  if (cliVersionCache !== null) return Promise.resolve(cliVersionCache);
  return new Promise<string>((resolve) => {
    try {
      execFileImpl(binary, ["--version"], {}, (error, stdout) => {
        const text = String(stdout ?? "").trim();
        cliVersionCache = error || !text ? "unknown" : text;
        resolve(cliVersionCache);
      });
    } catch {
      cliVersionCache = "unknown";
      resolve(cliVersionCache);
    }
  });
}

// ── 응답 재조립 (CLI JSON → Messages API 모양 Response) ─────────────────────

async function assembleSuccessResponse(
  request: ParsedAnthropicRequest,
  cliJson: Record<string, unknown>,
  getVersion: () => Promise<string>,
): Promise<Response> {
  // 가드 1 — 모델 에코: 요청 모델이 modelUsage 키에 "포함"되어야 한다(정확 일치 아님 —
  // 실측에서 --safe-mode 시 haiku 보조 호출이 함께 잡힘). CLI 가 내부에서 모델을 바꾼
  // provenance 오염을 차단한다.
  const modelUsage = isRecord(cliJson.modelUsage) ? cliJson.modelUsage : {};
  const modelKeys = Object.keys(modelUsage);
  if (!modelKeys.includes(request.model)) {
    throw new Error(
      `claude CLI 응답의 modelUsage [${modelKeys.join(", ")}] 에 요청 모델(${request.model})이 없습니다 — ` +
        `provenance 오염 차단을 위해 실패 처리합니다. (claude ${await getVersion()})`,
    );
  }
  // 가드 2 — structured_output 부재 시 result 를 JSON.parse, 둘 다 실패면 throw.
  let input: unknown = cliJson.structured_output;
  if (input === undefined || input === null) {
    const resultText = typeof cliJson.result === "string" ? cliJson.result : "";
    try {
      input = JSON.parse(resultText);
    } catch {
      throw new Error(
        `claude CLI 응답에 structured_output 이 없고 result 도 JSON 파싱에 실패했습니다: ` +
          `${resultText.slice(0, 500)} (claude ${await getVersion()})`,
      );
    }
  }
  return new Response(
    JSON.stringify({
      content: [{ type: "tool_use", name: request.toolName, input }],
      stop_reason: cliJson.stop_reason ?? "tool_use",
      // 필드명은 Anthropic API 와 동일(실측)하나 한 가지 보정이 필수다: CLI 는 프롬프트를
      // cache_creation_input_tokens 로 계상해 input_tokens 가 2 따위로 온다(92k 자 실공고 실측).
      // normalizeUsage 는 cache_creation 을 읽지 않으므로 그대로 통과시키면 명목 입력이
      // 통째로 소실돼 비용 게이트(costPerNotice·--max-cost-usd)가 과소 계상된다(계획 §4-4 위반).
      // → input_tokens 에 cache_creation 을 합산해 "API 로 돌렸다면"의 명목 입력을 보존한다.
      usage: withCacheCreationFoldedIntoInput(cliJson.usage),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function assembleErrorResponse(
  cliJson: unknown,
  outcome: CliExecOutcome,
  getVersion: () => Promise<string>,
): Promise<Response> {
  const version = await getVersion();
  if (isRecord(cliJson) && cliJson.is_error === true) {
    const resultText = typeof cliJson.result === "string" ? cliJson.result : "";
    const windowSignalText = `${resultText}\n${outcome.stderr}`;
    // CLI 가 API 에러를 에코한 경우 → 그 상태 그대로 통과시켜 기존 403/404 "모델 접근 불가"·
    // 429/500/529 재시도 분기를 자연 발화시킨다. 주의: 이때 subtype 은 "success" 로 온다(실측) —
    // 에러 판별은 subtype 이 아니라 is_error 로만 한다.
    if (typeof cliJson.api_error_status === "number") {
      // Max 구독 한도는 실측상 api_error_status=429와 "session limit · resets ..."로
      // 오기도 한다. 이를 일반 429로 넘기면 배치 루프가 모든 남은 공고를 2회씩
      // 즉시 실패로 소진하므로, 전용 마커로 승격해 신규 착수를 fail-closed 한다.
      if (cliJson.api_error_status === 429 && WINDOW_EXHAUSTED_SIGNAL.test(windowSignalText)) {
        return buildWindowExhaustedResponse(version);
      }
      return new Response(resultText, { status: cliJson.api_error_status });
    }
    // api_error_status 없는 CLI 자체 에러 — Max 사용량 윈도 소진 판별.
    // 고정 한국어 본문만 사용(stderr 병합 금지): CLI 가 에코하는 invalid_request_error 류가
    // 섞이면 ai-review.ts:552 의 /retention|zero data|invalid_request/i 분기가 오진한다.
    if (WINDOW_EXHAUSTED_SIGNAL.test(windowSignalText)) {
      return buildWindowExhaustedResponse(version);
    }
    return new Response(buildErrorTailBody(outcome, resultText, version), { status: 500 });
  }
  // stdout 파싱 불가(형태 미상 출력 포함) → 500. 진단을 위해 stdout 원문 tail 을 result 자리에 싣는다.
  return new Response(buildErrorTailBody(outcome, outcome.stdout, version), { status: 500 });
}

function buildWindowExhaustedResponse(version: string): Response {
  return new Response(
    `Claude Max 사용량 윈도 소진으로 판단됨 ${CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER} — ` +
      `윈도 리셋 후 같은 명령으로 재실행하세요. (claude ${version})`,
    { status: 400 },
  );
}

/** stderr tail + result tail 을 합쳐 2,000자 컷 + CLI 버전. error.message 는 싣지 않는다(argv 에 시스템 프롬프트가 노출됨). */
function buildErrorTailBody(outcome: CliExecOutcome, resultText: string, version: string): string {
  const exitNote = outcome.error ? `[exit ${String(outcome.error.code ?? "?")}] ` : "";
  const merged = [outcome.stderr.slice(-1_000).trim(), resultText.slice(-1_000).trim()]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2_000);
  return `${exitNote}${merged || "claude CLI 실행 실패(출력 없음)"}\n(claude ${version})`;
}

/** usage 의 input_tokens 에 cache_creation_input_tokens 를 합산(사유는 호출부 주석). 그 외 필드 무변환. */
function withCacheCreationFoldedIntoInput(usage: unknown): unknown {
  if (!isRecord(usage)) return usage;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const cacheCreation =
    typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
  return { ...usage, input_tokens: input + cacheCreation };
}

// ── 공용 ─────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
