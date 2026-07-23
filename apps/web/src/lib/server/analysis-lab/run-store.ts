// 공모 딥분석 실험실 — 런 파일 저장소 (dev 전용, DB 미사용).
// 런 결과는 <모노레포 루트>/spike-out/analysis-lab/<source>__<sourceId>/<runId>.json 에
// **불변**으로 저장한다: 덮어쓰기·삭제 금지(flag "wx" — 이미 있으면 실패).
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  AI_REVIEW_ADOPTED,
  isAiAuditConcur,
  type LabRun,
  type LabRunAuditSummary,
  type LabRunSummary,
} from "@/features/dev/analysis-lab/contract";

/** process.cwd() 에서 위로 pnpm-workspace.yaml 을 탐색해 모노레포 루트를 찾는다. */
export function findMonorepoRoot(): string {
  let current = resolve(process.cwd());
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("pnpm-workspace.yaml 을 찾지 못했습니다 — 모노레포 안에서 실행해주세요.");
}

/** 실험실 산출물 루트: <root>/spike-out/analysis-lab */
export function analysisLabDir(): string {
  return join(findMonorepoRoot(), "spike-out", "analysis-lab");
}

/**
 * runId = run-<ISO타임스탬프 콜론 제거>-<랜덤 6hex> (예: run-2026-07-17T051234.567Z-a1b2c3).
 * 랜덤 접미로 같은 millisecond 동시 실행의 "wx" EEXIST 충돌을 막는다(Codex 리뷰 L1).
 */
export function buildLabRunId(startedAt: Date): string {
  return `run-${startedAt.toISOString().replace(/:/g, "")}-${randomBytes(3).toString("hex")}`;
}

// 경로 조작 방지: runId 는 buildLabRunId 산출 형태만 허용한다(접미 없는 구버전 형식 호환).
const RUN_ID_PATTERN = /^run-[0-9TZ.\-]{10,40}(?:-[a-f0-9]{4,8})?$/;

/** 파일시스템 안전화: source/sourceId 디렉토리 조각에서 허용 외 문자를 _ 로 치환. */
function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._\-]/g, "_");
}

/**
 * 모델 ID 의 파일명 안전 변환(허용 외 문자 → _) — AI 검수(<runId>.ai-review.<slug>.json)와
 * 감사(<runId>.audit.<slug>.json) 파일명이 공유한다. 파일 명명은 run-store 소관이라 여기에
 * 두고 ai-review.ts 가 재수출한다(ai-review → run-store 단방향 유지).
 */
export function modelSlug(model: string): string {
  return model.replace(/[^A-Za-z0-9._\-]/g, "_");
}

function runDirFor(source: string, sourceId: string): string {
  return join(analysisLabDir(), `${sanitizeSegment(source)}__${sanitizeSegment(sourceId)}`);
}

export function labRunFilePath(source: string, sourceId: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`허용되지 않는 runId 형식: ${runId}`);
  return join(runDirFor(source, sourceId), `${runId}.json`);
}

/** 런 저장(불변). 같은 runId 가 이미 있으면 덮어쓰지 않고 실패한다. 저장 경로를 반환. */
export async function saveLabRun(run: LabRun): Promise<string> {
  const path = labRunFilePath(run.source, run.sourceId, run.runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

/** 특정 공고의 런 요약 목록(startedAt desc). 디렉토리가 없으면 빈 배열. */
export async function listLabRunSummaries(source: string, sourceId: string): Promise<LabRunSummary[]> {
  const dir = runDirFor(source, sourceId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const summaries: LabRunSummary[] = [];
  for (const file of files) {
    if (!file.startsWith("run-") || !file.endsWith(".json")) continue;
    // 검수 시트(<runId>.review.json)는 런 파일이 아니다 — 런 목록에서 제외.
    if (file.endsWith(".review.json")) continue;
    // AI 검수(<runId>.ai-review.<slug>.json)·감사(<runId>.audit.<slug>.json)·질문 보강
    // 사이드카(<runId>.confirmations.json, Phase B-0) 파일도 런이 아니다 — runId/grantId 를
    // 갖고 있어 readRunFile 관대 파싱을 통과해 버리므로(감사 파일은 startedAt 이 없어
    // 정렬에서 크래시) 파일명으로 먼저 제외한다.
    if (file.includes(".ai-review.") || file.includes(".audit.") || file.includes(".confirmations.")) continue;
    const run = await readRunFile(join(dir, file));
    if (!run) continue;
    const reviewedAt = await readReviewedAt(join(dir, `${run.runId}.review.json`));
    const auditStatus = await readAuditStatus(dir, files, run.runId);
    summaries.push(toRunSummary(run, reviewedAt, auditStatus));
  }
  return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * 단건 읽기 — grantId + runId. 저장 디렉토리는 source__sourceId 키라서 grantId 만으로는
 * 경로를 못 만든다 → 하위 디렉토리를 스캔해 runId 파일을 찾고 grantId 일치를 확인한다
 * (런 수가 적은 dev 실험실이라 스캔 비용 무시 가능, DB 의존 없음).
 */
export async function readLabRun(grantId: string, runId: string): Promise<LabRun | null> {
  if (!RUN_ID_PATTERN.test(runId)) return null;
  const root = analysisLabDir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.includes("__")) continue; // cohort.json 등 파일 제외
    const run = await readRunFile(join(root, entry, `${runId}.json`));
    if (run && run.grantId === grantId) return run;
  }
  return null;
}

function toRunSummary(
  run: LabRun,
  reviewedAt: string | null,
  auditStatus: LabRunAuditSummary | null,
): LabRunSummary {
  return {
    runId: run.runId,
    startedAt: run.startedAt,
    model: run.model,
    promptVersion: run.promptVersion,
    durationMs: run.durationMs,
    costUsd: run.costUsd,
    ok: run.error === null,
    error: run.error,
    reviewedAt,
    auditStatus,
  };
}

/**
 * 런 요약용 reviewedAt — 같은 디렉토리의 <runId>.review.json 에서 updatedAt(문자열)만
 * 관대하게 읽는다. 검수 파일 형식의 소유자는 review-store.ts 다(여기서는 표시용 필드만
 * 조회하고 검증하지 않는다). 파일이 없거나 파싱에 실패하면 null.
 */
async function readReviewedAt(path: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { updatedAt?: unknown };
    return typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
  } catch {
    return null;
  }
}

/**
 * 런 요약용 감사 상태(§9) — 채택 모델(AI_REVIEW_ADOPTED.model)의 ai-review 파일이 있고
 * 사람 review.json 이 **없는** 런만 non-null(사람 검수 보유 런은 감사 대상이 아니다).
 * 감사 파일은 표시용 필드(items 의 humanVerdict)만 관대하게 읽는다 — 형식 소유자는
 * audit-store.ts 다. 감사 파일이 없거나 파싱 실패면 "감사 대기"(decided/total null).
 */
async function readAuditStatus(
  dir: string,
  files: string[],
  runId: string,
): Promise<LabRunAuditSummary | null> {
  if (files.includes(`${runId}.review.json`)) return null;
  const slug = modelSlug(AI_REVIEW_ADOPTED.model);
  if (!files.includes(`${runId}.ai-review.${slug}.json`)) return null;
  const pending: LabRunAuditSummary = {
    model: AI_REVIEW_ADOPTED.model,
    decidedItems: null,
    totalItems: null,
  };
  try {
    const parsed = JSON.parse(
      await readFile(join(dir, `${runId}.audit.${slug}.json`), "utf8"),
    ) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return pending;
    // 완료 규칙은 audit-store isLabAuditComplete 와 동일 — 사람 판정 또는 AI 블라인드 감사
    // 일치(isAiAuditConcur)면 확정된 항목으로 센다(§9 완화 개정).
    const decided = parsed.items.filter((item) => {
      if (typeof item !== "object" || item === null) return false;
      const record = item as { humanVerdict?: unknown; aiVerdict?: unknown; aiAuditVerdict?: unknown };
      if (record.humanVerdict != null) return true;
      return (
        typeof record.aiVerdict === "string" &&
        typeof record.aiAuditVerdict === "string" &&
        isAiAuditConcur({ aiVerdict: record.aiVerdict, aiAuditVerdict: record.aiAuditVerdict })
      );
    }).length;
    return { model: AI_REVIEW_ADOPTED.model, decidedItems: decided, totalItems: parsed.items.length };
  } catch {
    return pending;
  }
}

async function readRunFile(path: string): Promise<LabRun | null> {
  try {
    const body = await readFile(path, "utf8");
    const parsed = JSON.parse(body) as LabRun;
    // startedAt 검사는 부속 파일(검수·AI 검수·감사) 오인 방어 — 실제 런 파일은 전부 보유.
    return typeof parsed.runId === "string" &&
      typeof parsed.grantId === "string" &&
      typeof parsed.startedAt === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}
