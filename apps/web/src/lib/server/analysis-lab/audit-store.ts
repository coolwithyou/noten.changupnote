// 공모 딥분석 실험실 — AI 검수 감사(audit) 저장소 (dev 전용, DB·네트워크 미사용).
// 확대 실험 계획 §9 "AI 전수 + 사람 표본 감사"의 사람 감사 판정을 기록한다.
// 감사 파일은 런 파일 옆 <runId>.audit.<modelSlug>.json 이며 두 단계로 다룬다:
//   ① 최초 로드 시 생성: 채택 모델의 AI 검수 파일 풀 전체에 selectAuditTargets
//      (AUDIT_SEED·AUDIT_SAMPLE_RATIO — CLI --audit-list 와 동일 상수)를 돌려 이 런의
//      대상만 items 로 심는다. correct 20% 표본은 풀 단위 셔플이므로 반드시 CLI 와 같은
//      풀(모델 전체 스캔)로 계산해야 같은 대상이 나온다(결정론 — 런 단위 계산 금지).
//   ② 이후 로드는 저장본 재사용(대상 목록 동결) — 풀이 늘어나도(배치 2 등) 기존 감사
//      대상은 변하지 않는다. 저장은 humanVerdict/note/auditorEmail/overallNote 만 병합한다
//      (사람 산출물이라 덮어쓰기 허용, createdAt·대상 목록·AI 판정 스냅샷은 보존).
//      ②' AI 블라인드 감사(lab:ai-audit, §9 완화 개정)는 aiAuditVerdict/aiAuditNote 와
//      최상위 aiAudit* 메타만 별도 병합한다 — 사람 판정 필드는 불가침(applyAiAuditJudgments).
// 사람 review.json 보유 공고에는 감사 파일을 만들지 않는다(§9 — 사람 전수 검수가 항상
// 우선이며, AI 검수 감사는 "사람 검수 없는 공고"의 표본 확인이다).
// import 방향: audit-store → run-store/ai-review-compare 단방향. ai-review.ts 는 import
// 하지 않는다(그 모듈은 input.ts 를 통해 R2 스토리지 체인을 끌고 온다) — AI 검수 파일은
// 관대 파싱만 복제해 읽는다(형식 소유자: ai-review.ts 의 AiReviewFile/readAiReviewFile).
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CriterionDimension } from "@cunote/contracts";
import {
  isAiAuditConcur,
  type LabAudit,
  type LabAuditItem,
  type LabCriterionVerdict,
  type LabEmptyAxisVerdict,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import {
  AUDIT_SAMPLE_RATIO,
  AUDIT_SEED,
  selectAuditTargets,
  type AiReviewForAudit,
} from "./ai-review-compare";
import { analysisLabDir, labRunFilePath, modelSlug, readLabRun } from "./run-store";

export const LAB_AUDIT_SCHEMA = "lab-audit-v1";

const CRITERION_VERDICTS: readonly LabCriterionVerdict[] = ["correct", "needs_edit", "wrong", "unsure"];
const AXIS_VERDICTS: readonly LabEmptyAxisVerdict[] = ["confirmed_absent", "missed_condition"];

/** 감사 파일 경로: 런 파일(<runId>.json) 옆의 <runId>.audit.<modelSlug>.json. */
export function labAuditFilePath(source: string, sourceId: string, runId: string, model: string): string {
  return labRunFilePath(source, sourceId, runId).replace(/\.json$/, `.audit.${modelSlug(model)}.json`);
}

/**
 * 감사 완료 판정 — 항목이 (a) 사람 판정(humanVerdict ≠ null)이 있거나 (b) AI 블라인드 감사가
 * 기존 AI 검수 판정과 일치(isAiAuditConcur — unsure 제외 정확 일치)하면 완료다(§9 완화 개정,
 * 2026-07-23 사용자 승인). 불일치·unsure 항목은 humanVerdict 가 채워져야 완료.
 * 대상 0건(비-correct·플래그·표본 모두 없음)은 확인할 것이 없으므로 공허하게 완료로 본다
 * (그 공고의 AI 검수는 감사 없이 확정 편입).
 */
export function isLabAuditComplete(audit: LabAudit): boolean {
  return audit.items.every((item) => item.humanVerdict !== null || isAiAuditConcur(item));
}

// ---- AI 검수 파일 수집 (CLI --audit-list 와 감사 생성이 공유하는 풀) ---------------

/**
 * AI 검수 파일의 관대 파싱 결과 — 형식 소유자는 ai-review.ts(AiReviewFile)다. 여기서는
 * 감사에 필요한 필드만 검증해 읽는다(무거운 import 체인 회피 — 모듈 상단 주석).
 */
export interface AuditSourceAiReview {
  runId: string;
  grantId: string;
  model: string;
  promptVersion: string;
  createdAt: string;
  criterionReviews: Array<{ criterionIndex: number; verdict: LabCriterionVerdict; note: string | null }>;
  axisReviews: Array<{ dimension: CriterionDimension; verdict: LabEmptyAxisVerdict; note: string | null }>;
}

export interface CollectedAiReview {
  review: AuditSourceAiReview;
  /** 짝 런 파일(관대 파싱) — 없으면 null(감사 목록은 만들 수 있으나 집계·병합 대상은 아님). */
  run: LabRun | null;
  /** 표시용 제목 — 런 파일이 없으면 runId. */
  title: string;
  /** 산출물 디렉토리 절대 경로 — 감사 파일 등 이웃 파일 접근용. */
  dir: string;
}

async function readAiReviewFileLenient(path: string): Promise<AuditSourceAiReview | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AuditSourceAiReview> & {
      schema?: unknown;
    };
    return parsed.schema === "lab-ai-review-v1" &&
      typeof parsed.runId === "string" &&
      typeof parsed.grantId === "string" &&
      typeof parsed.model === "string" &&
      typeof parsed.promptVersion === "string" &&
      Array.isArray(parsed.criterionReviews) &&
      Array.isArray(parsed.axisReviews)
      ? {
          runId: parsed.runId,
          grantId: parsed.grantId,
          model: parsed.model,
          promptVersion: parsed.promptVersion,
          createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
          criterionReviews: parsed.criterionReviews,
          axisReviews: parsed.axisReviews,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * 지정 모델의 AI 검수 파일 전수 수집 — CLI(--audit-list)와 감사 파일 생성(§9 풀 결정론),
 * 감사 확정 로더(audited-reviews)가 같은 선정 규칙을 공유한다:
 *   - spike-out/analysis-lab/<source>__<sourceId>/ 의 <runId>.ai-review.<slug>.json 전수
 *   - 사람 review.json 이 하나라도 있는 공고 디렉토리는 통째로 제외(§9 — 사람 검수 우선.
 *     캘리브레이션용 파일럿 AI 검수의 감사 혼입 차단)
 */
export async function collectAiReviewsForAudit(
  model: string,
  options: { quiet?: boolean } = {},
): Promise<CollectedAiReview[]> {
  const suffix = `.ai-review.${modelSlug(model)}.json`;
  const root = analysisLabDir();
  const collected: CollectedAiReview[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.includes("__")) continue;
    const dir = join(root, entry);
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    const hasHumanReview = files.some((file) => file.endsWith(".review.json"));
    for (const file of files) {
      if (!file.endsWith(suffix)) continue;
      const parsed = await readAiReviewFileLenient(join(dir, file));
      if (!parsed) {
        console.warn(`[audit] AI 검수 파일 파싱 실패 — 건너뜀: ${entry}/${file}`);
        continue;
      }
      if (hasHumanReview) {
        if (options.quiet !== true) console.log(`[audit] 사람 검수 보유 공고 제외: ${entry}/${parsed.runId}`);
        continue;
      }
      // 제목·병합용 런은 짝 런 파일에서 관대하게 읽는다(런이 없어도 감사 목록은 유효).
      let run: LabRun | null = null;
      try {
        const runParsed = JSON.parse(await readFile(join(dir, `${parsed.runId}.json`), "utf8")) as LabRun;
        if (typeof runParsed.runId === "string" && typeof runParsed.grantId === "string") run = runParsed;
      } catch {
        run = null;
      }
      collected.push({ review: parsed, run, title: run?.title ?? parsed.runId, dir });
    }
  }
  return collected;
}

/** CollectedAiReview → selectAuditTargets 입력(AiReviewForAudit) 변환. */
export function toAiReviewForAudit(collected: CollectedAiReview): AiReviewForAudit {
  return {
    grantId: collected.review.grantId,
    runId: collected.review.runId,
    title: collected.title,
    criterionReviews: collected.review.criterionReviews,
    axisReviews: collected.review.axisReviews,
  };
}

// ---- 감사 항목 생성 (순수 — 테스트 대상) -------------------------------------------

/**
 * 풀 전체 selectAuditTargets(시드·비율 단일 원천) 결과에서 한 런의 감사 항목만 뽑는다.
 * CLI --audit-list 의 대상 목록을 runId 로 필터한 것과 항목·순서가 정확히 일치해야 한다
 * (순서: 비-correct 전수 → missed 플래그 전수 → correct 표본, 각각 결정론 정렬).
 */
export function buildAuditItemsForRun(pool: AiReviewForAudit[], runId: string): LabAuditItem[] {
  const selection = selectAuditTargets(pool, { seed: AUDIT_SEED, sampleRatio: AUDIT_SAMPLE_RATIO });
  return selection.targets
    .filter((target) => target.runId === runId)
    .map((target) => ({
      kind: target.criterionIndex !== undefined ? ("criterion" as const) : ("axis" as const),
      ...(target.criterionIndex !== undefined ? { criterionIndex: target.criterionIndex } : {}),
      ...(target.dimension !== undefined ? { dimension: target.dimension } : {}),
      reason: target.kind,
      aiVerdict: target.aiVerdict,
      aiNote: target.aiNote,
      humanVerdict: null,
      note: null,
    }));
}

// ---- 로드(없으면 생성) -------------------------------------------------------------

export type LabAuditLoadOutcome =
  | { status: "ok"; audit: LabAudit; run: LabRun; created: boolean }
  | { status: "run_not_found" }
  /** 사람 review.json 보유 공고 — 감사 파일을 만들지 않는다(§9 사람 검수 우선). */
  | { status: "human_review_exists" }
  /** 지정 모델의 AI 검수 파일이 없다 — 감사 대상 산출 불가. */
  | { status: "ai_review_missing" }
  /** 기존 감사 파일 파싱 실패 — 재생성하면 사람 판정이 소실되므로 정직하게 실패한다. */
  | { status: "audit_parse_failed"; path: string };

async function readAuditFile(path: string): Promise<LabAudit | null> {
  const body = await readFile(path, "utf8");
  const parsed = JSON.parse(body) as LabAudit;
  return parsed.schema === LAB_AUDIT_SCHEMA &&
    typeof parsed.runId === "string" &&
    typeof parsed.grantId === "string" &&
    Array.isArray(parsed.items)
    ? parsed
    : null;
}

/** 감사 파일 관대 읽기(경로 직접) — 로더(audited-reviews) 표시·병합용. 없거나 깨졌으면 null. */
export async function readLabAuditFileAt(path: string): Promise<LabAudit | null> {
  try {
    return await readAuditFile(path);
  } catch {
    return null;
  }
}

/**
 * 감사 시트 로드 — 저장본이 있으면 재사용(대상 목록 동결), 없으면 §9 대상 산출로 생성해
 * 디스크에 기록한다(생성 시점에 동결하는 것이 목적이므로 로드가 곧 생성이다).
 */
export async function loadOrCreateLabAudit(options: {
  grantId: string;
  runId: string;
  model: string;
}): Promise<LabAuditLoadOutcome> {
  const run = await readLabRun(options.grantId, options.runId);
  if (!run) return { status: "run_not_found" };

  const path = labAuditFilePath(run.source, run.sourceId, run.runId, options.model);
  const dir = dirname(path);
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    files = [];
  }
  if (files.some((file) => file.endsWith(".review.json"))) {
    return { status: "human_review_exists" };
  }

  const auditFileName = path.slice(dir.length + 1);
  if (files.includes(auditFileName)) {
    try {
      const existing = await readAuditFile(path);
      if (!existing || existing.grantId !== run.grantId || existing.runId !== run.runId) {
        return { status: "audit_parse_failed", path };
      }
      return { status: "ok", audit: existing, run, created: false };
    } catch {
      return { status: "audit_parse_failed", path };
    }
  }

  const aiReviewPath = labRunFilePath(run.source, run.sourceId, run.runId).replace(
    /\.json$/,
    `.ai-review.${modelSlug(options.model)}.json`,
  );
  const aiReview = await readAiReviewFileLenient(aiReviewPath);
  if (!aiReview) return { status: "ai_review_missing" };

  // §9 결정론: correct 20% 표본은 풀 단위 셔플 — 반드시 모델 전체 풀로 계산한다(상단 주석).
  const pool = (await collectAiReviewsForAudit(options.model)).map(toAiReviewForAudit);
  const items = buildAuditItemsForRun(pool, run.runId);

  const now = new Date().toISOString();
  const audit: LabAudit = {
    schema: LAB_AUDIT_SCHEMA,
    grantId: run.grantId,
    runId: run.runId,
    model: options.model,
    aiPromptVersion: aiReview.promptVersion,
    auditorEmail: null,
    createdAt: now,
    updatedAt: now,
    items,
    overallNote: null,
  };
  try {
    // "wx": 동시 생성 경합이면 먼저 쓴 쪽을 채택한다(대상 목록 동결 — 재계산본으로 덮지 않는다).
    await writeFile(path, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const existing = await readAuditFile(path);
        if (existing) return { status: "ok", audit: existing, run, created: false };
      } catch {
        // fallthrough
      }
      return { status: "audit_parse_failed", path };
    }
    throw caught;
  }
  return { status: "ok", audit, run, created: true };
}

// ---- 저장(판정 병합) ---------------------------------------------------------------

/** 항목 판정 갱신 — 키는 kind + criterionIndex/dimension(대상 목록은 불변이라 안정 키). */
export interface LabAuditItemUpdate {
  kind: "criterion" | "axis";
  criterionIndex?: number | undefined;
  dimension?: CriterionDimension | undefined;
  humanVerdict: LabCriterionVerdict | LabEmptyAxisVerdict;
  note: string | null;
}

export type LabAuditSaveOutcome =
  | { status: "ok"; audit: LabAudit }
  | { status: "run_not_found" }
  /** 감사 파일이 없다 — 로드(생성) 없이 저장 금지(검수 시트 사고 교훈의 서버측 가드). */
  | { status: "audit_not_found" }
  | { status: "audit_parse_failed"; path: string }
  | { status: "invalid"; message: string };

function itemKeyOf(item: { kind: string; criterionIndex?: number | undefined; dimension?: string | undefined }): string {
  return item.kind === "criterion" ? `c:${item.criterionIndex ?? "?"}` : `a:${item.dimension ?? "?"}`;
}

/**
 * 사람 감사 판정 저장 — 저장본 대상 목록에 humanVerdict/note 만 병합한다(부분 저장 허용).
 * 요청에 없는 항목의 기존 판정은 유지된다. 서버가 저장본을 기준으로 병합하므로 "빈 시트
 * 저장이 기존 판정을 통째로 덮는" 사고 경로(2026-07-22 검수 실사고)가 구조적으로 없다.
 * 뒤집기(humanVerdict ≠ aiVerdict)는 note 필수. createdAt·대상 목록·AI 스냅샷은 보존.
 */
export async function saveLabAuditJudgments(options: {
  grantId: string;
  runId: string;
  model: string;
  auditorEmail: string;
  items: LabAuditItemUpdate[];
  overallNote: string | null;
}): Promise<LabAuditSaveOutcome> {
  const run = await readLabRun(options.grantId, options.runId);
  if (!run) return { status: "run_not_found" };

  const path = labAuditFilePath(run.source, run.sourceId, run.runId, options.model);
  let stored: LabAudit | null;
  try {
    stored = await readAuditFile(path);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return { status: "audit_not_found" };
    return { status: "audit_parse_failed", path };
  }
  if (!stored) return { status: "audit_parse_failed", path };

  const byKey = new Map(stored.items.map((item) => [itemKeyOf(item), item]));
  const seen = new Set<string>();
  for (const update of options.items) {
    const key = itemKeyOf(update);
    if (seen.has(key)) return { status: "invalid", message: `감사 항목 판정이 중복되었습니다: ${key}` };
    seen.add(key);
    const target = byKey.get(key);
    if (!target) {
      return { status: "invalid", message: `감사 대상 목록에 없는 항목입니다: ${key} — 대상 목록은 생성 시 동결됩니다.` };
    }
    const vocabulary: readonly string[] = target.kind === "criterion" ? CRITERION_VERDICTS : AXIS_VERDICTS;
    if (!vocabulary.includes(update.humanVerdict)) {
      return {
        status: "invalid",
        message: `${key}: ${target.kind === "criterion" ? "criterion" : "빈 축"} 판정 어휘가 아닙니다(${update.humanVerdict}).`,
      };
    }
    if (update.humanVerdict !== target.aiVerdict && (update.note === null || update.note.trim().length === 0)) {
      return {
        status: "invalid",
        message: `${key}: AI 판정을 뒤집으려면(AI ${target.aiVerdict} → ${update.humanVerdict}) 사유(note)가 필수입니다.`,
      };
    }
    target.humanVerdict = update.humanVerdict;
    target.note = update.note !== null && update.note.trim().length > 0 ? update.note.trim() : null;
  }

  const saved: LabAudit = {
    ...stored,
    auditorEmail: options.auditorEmail,
    updatedAt: new Date().toISOString(),
    overallNote: options.overallNote,
  };
  await writeFile(path, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  return { status: "ok", audit: saved };
}

// ---- AI 블라인드 감사 판정 병합 (§9 완화 개정 — lab:ai-audit 러너 전용) --------------

/** AI 블라인드 감사 판정 1건 — 키는 사람 판정 저장(LabAuditItemUpdate)과 동일 규칙. */
export interface LabAuditAiJudgment {
  kind: "criterion" | "axis";
  criterionIndex?: number | undefined;
  dimension?: CriterionDimension | undefined;
  aiAuditVerdict: LabCriterionVerdict | LabEmptyAxisVerdict;
  aiAuditNote: string | null;
}

export type ApplyAiAuditOutcome =
  | { status: "ok"; audit: LabAudit; applied: number; skippedHuman: number }
  | { status: "invalid"; message: string };

/**
 * AI 블라인드 감사 판정을 저장본에 병합하는 순수 함수(테스트 대상) — aiAuditVerdict/aiAuditNote
 * 와 최상위 aiAudit* 메타만 갱신한다. **humanVerdict/note/auditorEmail/overallNote/createdAt/
 * 대상 목록은 절대 건드리지 않는다.** humanVerdict 가 이미 있는 항목은 스킵한다(사람 판정
 * 우선 — skippedHuman 으로 집계). 감사 모델 === 검수 모델(stored.model)이면 거부한다
 * (자기 확인 순환 차단 — 러너의 하드 가드와 이중).
 */
export function applyAiAuditJudgments(
  stored: LabAudit,
  options: {
    aiAuditModel: string;
    aiAuditPromptVersion: string;
    judgments: LabAuditAiJudgment[];
    /** 테스트 결정론용 — 생략 시 현재 시각. */
    now?: string;
  },
): ApplyAiAuditOutcome {
  if (options.aiAuditModel === stored.model) {
    return {
      status: "invalid",
      message: `AI 감사 모델(${options.aiAuditModel})이 AI 검수 모델(${stored.model})과 같습니다 — 자기 확인 순환 금지(§9).`,
    };
  }

  const items = stored.items.map((item) => ({ ...item }));
  const byKey = new Map(items.map((item) => [itemKeyOf(item), item]));
  const seen = new Set<string>();
  let applied = 0;
  let skippedHuman = 0;
  for (const judgment of options.judgments) {
    const key = itemKeyOf(judgment);
    if (seen.has(key)) return { status: "invalid", message: `AI 감사 판정이 중복되었습니다: ${key}` };
    seen.add(key);
    const target = byKey.get(key);
    if (!target) {
      return { status: "invalid", message: `감사 대상 목록에 없는 항목입니다: ${key} — 대상 목록은 생성 시 동결됩니다.` };
    }
    const vocabulary: readonly string[] = target.kind === "criterion" ? CRITERION_VERDICTS : AXIS_VERDICTS;
    if (!vocabulary.includes(judgment.aiAuditVerdict)) {
      return {
        status: "invalid",
        message: `${key}: ${target.kind === "criterion" ? "criterion" : "빈 축"} 판정 어휘가 아닙니다(${judgment.aiAuditVerdict}).`,
      };
    }
    if (target.humanVerdict !== null) {
      skippedHuman += 1;
      continue;
    }
    target.aiAuditVerdict = judgment.aiAuditVerdict;
    target.aiAuditNote =
      judgment.aiAuditNote !== null && judgment.aiAuditNote.trim().length > 0
        ? judgment.aiAuditNote.trim()
        : null;
    applied += 1;
  }

  const now = options.now ?? new Date().toISOString();
  return {
    status: "ok",
    applied,
    skippedHuman,
    audit: {
      ...stored,
      items,
      aiAuditModel: options.aiAuditModel,
      aiAuditPromptVersion: options.aiAuditPromptVersion,
      aiAuditedAt: now,
      updatedAt: now,
    },
  };
}

export type LabAuditAiSaveOutcome =
  | { status: "ok"; audit: LabAudit; applied: number; skippedHuman: number; path: string }
  | { status: "run_not_found" }
  /** 감사 파일이 없다 — AI 감사도 로드(생성) 없이 저장 금지(사람 판정 저장과 동일 가드). */
  | { status: "audit_not_found" }
  | { status: "audit_parse_failed"; path: string }
  | { status: "invalid"; message: string };

/**
 * AI 블라인드 감사 판정 저장 — read-merge-write. 병합 규칙은 applyAiAuditJudgments(순수)가
 * 소유하고 여기는 IO 만 담당한다. 쓰기는 기존 감사 저장 관행(saveLabAuditJudgments)과 동일.
 */
export async function saveLabAuditAiJudgments(options: {
  grantId: string;
  runId: string;
  /** AI 검수(감사 파일 키)의 모델 — 파일 경로 산출용. */
  model: string;
  aiAuditModel: string;
  aiAuditPromptVersion: string;
  judgments: LabAuditAiJudgment[];
}): Promise<LabAuditAiSaveOutcome> {
  const run = await readLabRun(options.grantId, options.runId);
  if (!run) return { status: "run_not_found" };

  const path = labAuditFilePath(run.source, run.sourceId, run.runId, options.model);
  let stored: LabAudit | null;
  try {
    stored = await readAuditFile(path);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return { status: "audit_not_found" };
    return { status: "audit_parse_failed", path };
  }
  if (!stored) return { status: "audit_parse_failed", path };

  const merged = applyAiAuditJudgments(stored, {
    aiAuditModel: options.aiAuditModel,
    aiAuditPromptVersion: options.aiAuditPromptVersion,
    judgments: options.judgments,
  });
  if (merged.status === "invalid") return merged;

  await writeFile(path, `${JSON.stringify(merged.audit, null, 2)}\n`, "utf8");
  return { status: "ok", audit: merged.audit, applied: merged.applied, skippedHuman: merged.skippedHuman, path };
}
