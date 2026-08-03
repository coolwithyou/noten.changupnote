// 공모 딥분석 실험실 — 웹 배치 잡 관리자 (동시 1잡 싱글턴, dev 전용 — 2026-08-03 계획 §3-1/§3-2).
// ops/batch 라우트(POST 시작 · GET 폴링 · DELETE abort)가 소비한다. 러너(runLabBatch)를
// fire-and-forget 으로 구동하고, 진행은 onEvent 링 버퍼(최근 200건)와 progress 누적으로
// LabBatchJobSnapshot(contract.ts)에 반영한다.
// 설계 요점:
// - **globalThis 심볼 스태시**: Next dev 의 HMR 이 이 모듈을 재인스턴스해도 잡 상태를 잃지
//   않도록, 모듈 로컬 변수 대신 globalThis[Symbol.for("cunote.labBatchJob")] 에만 상태를 둔다
//   (db/client 의 dev 커넥션 스태시와 같은 패턴). 모듈 로컬 가변 상태 금지.
// - **스냅샷 영속(베스트에포트)**: 상태 변화마다 spike-out/analysis-lab/batch-job.json 에
//   직렬화해 둔다(쓰기 실패 무시 — 잡 진행을 막지 않는다). dev 서버 재시작으로 메모리 잡이
//   소멸하면, GET 이 이 파일을 "직전 잡 잔상(stale, process-restarted)"으로 복원한다 —
//   저장 당시 running 이던 잡은 aborted 로 강등한다(CLI Ctrl-C 와 동일 의미론: 완료 런은
//   run-store 에 저장돼 있고, 같은 옵션 재실행이 곧 재개다).
// - **CLI 관측 브리지(2026-08-03)**: CLI 배치(batch.ts)도 같은 파일에 origin "cli" + pid 로
//   스냅샷을 중계한다. 파일 폴백은 origin "cli" 면 pid 생존 판정으로 가른다 — 살아 있으면
//   running 그대로(진행은 파일이 유일한 채널이라 메모리 캐시 금지·매 GET 재독), 죽었는데
//   running 이면 aborted 강등. 웹 잡 시작은 살아 있는 CLI running 스냅샷을 busy 로 거부한다
//   (웹·CLI 동시 실행 금지 규칙의 코드 승격 — 동시 쓰기 배제).
// - abort 는 신규 착수만 중단한다(러너 계약) — 상태 전이는 러너 종료 시점에 finished/aborted.
// - 러너 자체 throw(인프라 실패·LabCohortMissingError 포함)는 state "error" + error 메시지로
//   흡수한다 — 게이트 중단(guard-stop)·error 런과 구분된다.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  LabBatchEvent,
  LabBatchJobSnapshot,
  LabBatchStartRequest,
  LabBatchSummary,
} from "@/features/dev/analysis-lab/contract";
import { runLabBatch, type LabBatchRunnerOptions } from "./batch-runner";
import { resolveLabTransport } from "./claude-cli-transport";
import { resolveLabModel } from "./extractor";
import { analysisLabDir } from "./run-store";

/** 이벤트 링 버퍼 상한 — 폴링 UI 가 그대로 렌더한다(contract.ts LabBatchJobSnapshot.events). */
const EVENT_RING_LIMIT = 200;

/** 프로세스 재시작 강등 시의 안내 — UI 가 그대로 노출한다. */
const PROCESS_RESTARTED_MESSAGE = "dev 서버 재시작으로 잡이 소멸(완료 런은 저장됨)";

/** CLI 스냅샷의 pid 사망 강등 안내 — UI 가 그대로 노출한다(관측 브리지). */
const CLI_PROCESS_EXITED_MESSAGE = "CLI 배치 프로세스 종료 감지(완료 런은 저장됨)";

// ---- 공개 계약 -----------------------------------------------------------------

/** 실행 중 잡이 있는데 새 잡을 시작하려 함 — 라우트가 409 + snapshot 으로 매핑한다. */
export class LabBatchJobBusyError extends Error {
  constructor(public readonly snapshot: LabBatchJobSnapshot) {
    super("배치 잡이 이미 실행 중입니다 — 동시 1잡 원칙. 완료를 기다리거나 중단(DELETE) 후 다시 시작하세요.");
    this.name = "LabBatchJobBusyError";
  }
}

/** 테스트 주입점 — 프로덕션 호출은 전부 생략한다(기본: 실구현 + 실제 spike-out 경로). */
export interface LabBatchJobDeps {
  /** 배치 러너 대체(페이크) — 기본 runLabBatch. */
  runBatchImpl?: (options: LabBatchRunnerOptions) => Promise<LabBatchSummary>;
  /** transport 미지정 시 확정 함수 — 기본 resolveLabTransport(env). */
  resolveTransportImpl?: () => "api" | "claude-cli";
  /** model 미지정 시 확정 함수 — 기본 resolveLabModel(env). */
  resolveModelImpl?: () => string;
  /** 스냅샷 영속 파일 경로 — 기본 spike-out/analysis-lab/batch-job.json. */
  snapshotPathImpl?: () => string;
  nowImpl?: () => Date;
}

// ---- globalThis 심볼 스태시 (HMR 생존) ------------------------------------------

interface InternalLabBatchJob {
  /** 가변 스냅샷 — onEvent/종료 핸들러가 제자리 갱신하고, 조회는 항상 clone 으로 나간다. */
  snapshot: LabBatchJobSnapshot;
  /** 파일에서 복원된 잔상 잡은 controller 가 없다(abort 불가 — 이미 죽은 잡). */
  controller: AbortController | null;
}

interface LabBatchJobStore {
  job: InternalLabBatchJob | null;
  /** 영속 쓰기 직렬화 체인 — 이벤트 연사 시 파일 내용이 뒤섞이지 않게 순차 기록한다. */
  persistChain: Promise<void>;
}

const JOB_STASH_KEY = Symbol.for("cunote.labBatchJob");

function jobStore(): LabBatchJobStore {
  const globalRef = globalThis as unknown as Record<symbol, unknown>;
  const existing = globalRef[JOB_STASH_KEY];
  if (existing) return existing as LabBatchJobStore;
  const created: LabBatchJobStore = { job: null, persistChain: Promise.resolve() };
  globalRef[JOB_STASH_KEY] = created;
  return created;
}

// ---- 스냅샷 유틸 ---------------------------------------------------------------

function idleSnapshot(): LabBatchJobSnapshot {
  return {
    jobId: null,
    state: "idle",
    startedAt: null,
    finishedAt: null,
    options: null,
    progress: null,
    guardStop: null,
    summary: null,
    events: [],
    error: null,
  };
}

/** 조회 응답용 사본 — 진행 중 잡의 가변 스냅샷을 호출부에 그대로 노출하지 않는다. */
function cloneSnapshot(snapshot: LabBatchJobSnapshot): LabBatchJobSnapshot {
  return structuredClone(snapshot);
}

/**
 * 스냅샷 영속 파일 경로 — 웹 잡 관리자와 CLI 관측 브리지(batch.ts)가 같은 파일을 쓴다
 * (동시 쓰기는 busy 가드 + 동시 실행 금지 규칙으로 배제 — 상단 설계 주석).
 */
export function labBatchJobFilePath(): string {
  return join(analysisLabDir(), "batch-job.json");
}

/** 상태 변화 시점의 스냅샷을 직렬화해 베스트에포트로 기록한다(실패 무시 — 잡 진행 우선). */
function schedulePersist(store: LabBatchJobStore, snapshot: LabBatchJobSnapshot, deps?: LabBatchJobDeps): void {
  const path = deps?.snapshotPathImpl?.() ?? labBatchJobFilePath();
  const payload = JSON.stringify(snapshot, null, 2);
  store.persistChain = store.persistChain
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, payload, "utf8");
    })
    .catch(() => {
      // 베스트에포트 — 디스크 실패가 배치 진행·폴링을 막으면 안 된다.
    });
}

/**
 * 러너 이벤트 1건을 스냅샷에 반영 — 링 버퍼 push(상한 200) + progress 누적.
 * CLI 관측 브리지(batch.ts)도 이 함수를 공유한다 — 웹·CLI 스냅샷의 직렬화 형태가
 * 갈라지면 파일 폴백(GET)이 깨지므로, 반영 규칙은 여기가 단일 원천이다.
 */
export function applyLabBatchEvent(snapshot: LabBatchJobSnapshot, event: LabBatchEvent): void {
  snapshot.events.push(event);
  if (snapshot.events.length > EVENT_RING_LIMIT) {
    snapshot.events.splice(0, snapshot.events.length - EVENT_RING_LIMIT);
  }
  const progress = snapshot.progress ?? { total: 0, started: 0, ok: 0, error: 0, cumulativeCostUsd: 0 };
  snapshot.progress = progress;
  switch (event.type) {
    case "plan":
      progress.total = event.targets;
      break;
    case "target-started":
      progress.started += 1;
      break;
    case "target-ok":
      progress.ok += 1;
      progress.cumulativeCostUsd = event.cumulativeCostUsd;
      break;
    case "target-error":
      progress.error += 1;
      break;
    case "guard-stop":
      snapshot.guardStop = { reason: event.reason, cumulativeCostUsd: event.cumulativeCostUsd };
      progress.cumulativeCostUsd = event.cumulativeCostUsd;
      break;
    case "finished":
      snapshot.summary = event.summary;
      progress.cumulativeCostUsd = event.summary.totalCostUsd;
      break;
  }
}

// ---- 영속 잔상 복원 (프로세스 재시작 후) ----------------------------------------

const JOB_STATES = new Set<LabBatchJobSnapshot["state"]>([
  "idle",
  "running",
  "finished",
  "aborted",
  "error",
]);

/** 최소 구조 검증 — 파손 파일은 조용히 무시하고 초기 상태로 간다(불변 저장소 원칙과 동일). */
function isPersistedSnapshot(value: unknown): value is LabBatchJobSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.state === "string" &&
    JOB_STATES.has(record.state as LabBatchJobSnapshot["state"]) &&
    Array.isArray(record.events)
  );
}

/** 파일 원본을 최소 검증만 거쳐 읽는다 — 강등 판단 이전의 raw 스냅샷(busy 가드도 사용). */
function readPersistedSnapshot(deps?: LabBatchJobDeps): LabBatchJobSnapshot | null {
  const path = deps?.snapshotPathImpl?.() ?? labBatchJobFilePath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // 파일 없음·JSON 파손 — 잔상 없음
  }
  if (!isPersistedSnapshot(parsed)) return null;
  return parsed;
}

/**
 * pid 생존 판정 — signal 0 은 신호 전달 없이 존재 확인만 한다. EPERM 은 "존재하지만 권한
 * 없음"이므로 생존으로 본다(다른 uid 소유 프로세스 — ESRCH 만 사망).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    return (caught as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 파일에 "지금 살아서 도는" CLI 배치 스냅샷이 있으면 반환한다(관측 브리지) —
 * origin "cli" + state running + pid 생존의 3중 조건. 그 외(웹 스냅샷·종결·pid 사망)는 null.
 */
function readLiveCliSnapshot(deps?: LabBatchJobDeps): LabBatchJobSnapshot | null {
  const parsed = readPersistedSnapshot(deps);
  if (!parsed || parsed.origin !== "cli" || parsed.state !== "running") return null;
  if (typeof parsed.pid !== "number" || !isPidAlive(parsed.pid)) return null;
  return parsed;
}

/**
 * batch-job.json 을 "직전 잡 잔상(stale, process-restarted)"으로 복원한다.
 * - origin "cli"(관측 브리지): running 이라도 기록 프로세스(pid)가 살아 있으면 **그대로**
 *   반환한다(진행 중 — 라벨용 origin 유지). pid 가 죽었는데 running 이면 웹 관행대로
 *   aborted 강등 + CLI 종료 안내를 부여한다.
 * - origin "web"(또는 부재): 저장 당시 running 이던 잡은 프로세스 재시작으로 이미
 *   소멸했으므로 aborted 로 강등하고 안내 메시지를 error 에 부여한다(완료 런은
 *   run-store 에 저장돼 있어 재실행=재개).
 */
function restorePersistedSnapshot(deps?: LabBatchJobDeps): LabBatchJobSnapshot | null {
  const parsed = readPersistedSnapshot(deps);
  if (!parsed) return null;
  if (parsed.state !== "running") return parsed;
  if (parsed.origin === "cli") {
    if (typeof parsed.pid === "number" && isPidAlive(parsed.pid)) return parsed;
    return { ...parsed, state: "aborted", error: CLI_PROCESS_EXITED_MESSAGE };
  }
  return { ...parsed, state: "aborted", error: PROCESS_RESTARTED_MESSAGE };
}

// ---- 공개 API ------------------------------------------------------------------

/**
 * 배치 잡 시작 — 실행 중이면 LabBatchJobBusyError(라우트 409). transport/model 미지정 시
 * resolveLabTransport/resolveLabModel 로 확정해 options 에 기록하고, 러너에도 명시 오버라이드로
 * 전달한다(env 해석과 동일 값 — 스냅샷 provenance 와 실행이 항상 일치). 러너는 fire-and-forget
 * 으로 구동한다(수 분짜리 잡 — 라우트는 202 + 스냅샷으로 즉시 응답, 진행은 GET 폴링).
 */
export function startLabBatchJob(
  request: LabBatchStartRequest,
  deps?: LabBatchJobDeps,
): LabBatchJobSnapshot {
  const store = jobStore();
  if (store.job && store.job.snapshot.state === "running") {
    throw new LabBatchJobBusyError(cloneSnapshot(store.job.snapshot));
  }
  // CLI 배치(관측 브리지)가 실행 중이면 웹 잡 시작 금지 — 웹·CLI 동시 실행 금지 규칙의
  // 코드 승격. pid 가 죽은 CLI running 잔상은 막지 않는다(새 웹 잡이 파일을 대체한다).
  const liveCli = readLiveCliSnapshot(deps);
  if (liveCli) throw new LabBatchJobBusyError(liveCli);

  const transport = request.transport ?? (deps?.resolveTransportImpl ?? resolveLabTransport)();
  const model = request.model ?? (deps?.resolveModelImpl ?? resolveLabModel)();
  const now = deps?.nowImpl ?? (() => new Date());
  const startedAt = now();
  // run-store buildLabRunId 와 같은 규약(콜론 제거 ISO + 랜덤 6hex) — 파일명·로그 안전.
  const jobId = `job-${startedAt.toISOString().replace(/:/g, "")}-${randomBytes(3).toString("hex")}`;
  const controller = new AbortController();

  const snapshot: LabBatchJobSnapshot = {
    jobId,
    state: "running",
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    options: { ...request, transport, model },
    progress: { total: 0, started: 0, ok: 0, error: 0, cumulativeCostUsd: 0 },
    guardStop: null,
    summary: null,
    events: [],
    error: null,
  };
  const job: InternalLabBatchJob = { snapshot, controller };
  store.job = job;
  schedulePersist(store, snapshot, deps);

  const runBatch = deps?.runBatchImpl ?? ((options: LabBatchRunnerOptions) => runLabBatch(options));
  // fire-and-forget — await 금지(계획 §3-1: 진행은 onEvent, 종료는 then/catch 로 수렴).
  void runBatch({
    limit: request.limit,
    concurrency: request.concurrency,
    maxCostUsd: request.maxCostUsd,
    retryErrors: request.retryErrors,
    reanalyzeOutdated: request.reanalyzeOutdated,
    transport,
    model,
    signal: controller.signal,
    onEvent: (event) => {
      if (store.job !== job) return; // 슬롯을 새 잡이 차지한 뒤의 늦은 이벤트 방어
      applyLabBatchEvent(snapshot, event);
      schedulePersist(store, snapshot, deps);
    },
  })
    .then((summary) => {
      if (store.job !== job) return;
      snapshot.summary = summary;
      snapshot.state = summary.stopReason === "aborted" ? "aborted" : "finished";
      snapshot.finishedAt = now().toISOString();
      schedulePersist(store, snapshot, deps);
    })
    .catch((caught: unknown) => {
      if (store.job !== job) return;
      // 러너 자체 실패(인프라·LabCohortMissingError 등) — 게이트 중단·error 런과 구분되는 잡 실패.
      snapshot.state = "error";
      snapshot.error = caught instanceof Error ? caught.message : String(caught);
      snapshot.finishedAt = now().toISOString();
      schedulePersist(store, snapshot, deps);
    });

  return cloneSnapshot(snapshot);
}

/**
 * 현재 잡 스냅샷 — 실행 중인 메모리 잡(웹 소유)이 있으면 그 사본이 항상 진실이다.
 * 그 외에는 batch-job.json 을 본다(web running 잔상은 aborted 강등, CLI 스냅샷은 pid
 * 생존 판정 — restorePersistedSnapshot 참조). CLI 관측 브리지 특칙 2가지:
 * - 파일이 origin "cli" 면 **종결 메모리 잔상보다 파일이 우선**한다 — 웹 잡도 종료 시
 *   자신을 같은 파일에 남기므로, 파일에 CLI 스냅샷이 있다는 것은 곧 "직전 웹 잡 이후의
 *   더 새로운 기록"이라는 뜻이다(잔상이 가리면 브리지가 무용해진다).
 * - CLI 스냅샷은 메모리에 캐시하지 않는다 — 진행 갱신·종료·재실행이 전부 파일로만
 *   도착하므로 매 GET 재독해야 한다(dev 폴링 3s 에 파일 1회 읽기 — 비용 무시 가능).
 * 파일도 없으면 종결 메모리 잔상 또는 초기(idle) 상태를 돌려준다.
 */
export function getLabBatchJobSnapshot(deps?: LabBatchJobDeps): LabBatchJobSnapshot {
  const store = jobStore();
  if (store.job && store.job.snapshot.state === "running") {
    return cloneSnapshot(store.job.snapshot);
  }
  const restored = restorePersistedSnapshot(deps);
  if (restored?.origin === "cli") return restored; // CLI 스냅샷 캐시 금지 — 매 GET 재독
  if (store.job) return cloneSnapshot(store.job.snapshot);
  if (restored) {
    store.job = { snapshot: restored, controller: null }; // 잔상 캐시 — 매 GET 파일 재독 방지
    return cloneSnapshot(restored);
  }
  return idleSnapshot();
}

/**
 * 실행 중 잡에 abort 신호를 보낸다 — 러너는 신규 착수만 중단하고 진행분은 완료·저장한다.
 * 상태 전이는 러너 종료 시점(then)에 aborted 로 일어나므로, 직후 응답은 running 일 수 있다.
 * 실행 중 잡이 없으면 no-op(현재 스냅샷 반환).
 */
export function abortLabBatchJob(deps?: LabBatchJobDeps): LabBatchJobSnapshot {
  const store = jobStore();
  const job = store.job;
  if (job && job.snapshot.state === "running" && job.controller) {
    job.controller.abort();
  }
  return getLabBatchJobSnapshot(deps);
}
