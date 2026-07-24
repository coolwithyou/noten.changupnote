// 주간 사람 검수 배분 CLI. 기본은 DB 쓰기, --dry-run은 계획만 출력한다.
// 복구 재분석은 --grant-ids 와 --batch-key 를 함께 써 기존 주간 배치와 분리할 수 있다.
import { readFile } from "node:fs/promises";
import { eq, inArray } from "drizzle-orm";
import { AI_REVIEW_ADOPTED } from "@/features/dev/analysis-lab/contract";
import {
  collectAiReviewsForAudit,
  labAuditFilePath,
  readLabAuditFileAt,
} from "./audit-store";
import { loadGuideRubric, reassembleLabInputForRun } from "./ai-review";
import {
  assignDispatchCandidates,
  buildDispatchCandidateItems,
  excludePreviouslyDispatched,
  limitQuestionSpotchecks,
  normalizeDispatchSeed,
  sha256,
  type DispatchNoticeCandidate,
} from "./dispatch-core";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

const DEFAULT_REVIEWERS = ["kim@noten.im", "young@noten.im"];
const DEFAULT_OVERLAP_RATIO = 0.15;

async function main(): Promise<number> {
  const week = readArg("week")?.trim() || isoWeek(new Date());
  if (!/^\d{4}-W\d{2}$/.test(week)) throw new Error("--week는 YYYY-Www 형식이어야 합니다.");
  const grantIds = readCsvArg("grant-ids");
  const batchKey = readArg("batch-key")?.trim() || week;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(batchKey)) {
    throw new Error("--batch-key는 영문/숫자로 시작하는 100자 이하 영문·숫자·점·밑줄·하이픈이어야 합니다.");
  }
  if (batchKey !== week && !grantIds) {
    throw new Error("사용자 지정 --batch-key는 정확한 --grant-ids 와 함께 사용해야 합니다.");
  }
  const reviewerEmails = (readArg("reviewers")?.split(",") ?? DEFAULT_REVIEWERS)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (reviewerEmails.length < 2) throw new Error("독립 중복 표본을 위해 reviewer 2명 이상이 필요합니다.");
  const seed = normalizeDispatchSeed(integerArg("seed") ?? weekSeed(batchKey));
  const questionLimit = integerArg("question-limit") ?? 15;
  if (questionLimit < 0) throw new Error("--question-limit은 0 이상의 정수여야 합니다.");
  const dryRun = process.argv.includes("--dry-run");
  const dispatchedBy = readArg("dispatched-by")?.trim() || process.env.USER || "local-operator";
  const db = getCunoteDb();

  const existingBatches = await db
    .select({ id: schema.auditDispatchBatches.id })
    .from(schema.auditDispatchBatches)
    .where(eq(schema.auditDispatchBatches.week, batchKey))
    .limit(1);
  if (existingBatches[0]) {
    console.log(`[dispatch] ${batchKey} 배치가 이미 존재합니다(${existingBatches[0].id}) — 멱등 종료.`);
    return 0;
  }

  const reviewerRows = await db
    .select({
      id: schema.adminUsers.id,
      email: schema.adminUsers.email,
      role: schema.adminUsers.role,
      status: schema.adminUsers.status,
    })
    .from(schema.adminUsers)
    .where(inArray(schema.adminUsers.email, reviewerEmails));
  const reviewerByEmail = new Map(reviewerRows.map((row) => [row.email.toLowerCase(), row]));
  const reviewers = reviewerEmails.map((email) => {
    const row = reviewerByEmail.get(email);
    if (!row || row.status !== "active" || row.role !== "reviewer") {
      throw new Error(`활성 reviewer 계정을 찾을 수 없습니다: ${email}`);
    }
    return row;
  });

  const distributedRows = await db
    .select({
      runId: schema.auditDispatchNotices.runId,
      sourceItemKey: schema.auditDispatchItems.sourceItemKey,
    })
    .from(schema.auditDispatchItems)
    .innerJoin(
      schema.auditDispatchNotices,
      eq(schema.auditDispatchItems.noticeId, schema.auditDispatchNotices.id),
    );
  const distributed = new Set(distributedRows.map((row) => `${row.runId}:${row.sourceItemKey}`));

  const allCollected = await collectAiReviewsForAudit(AI_REVIEW_ADOPTED.model, { quiet: true });
  const collected = grantIds
    ? allCollected.filter((entry) => grantIds.has(entry.review.grantId))
    : allCollected;
  if (grantIds) {
    const found = new Set(collected.map((entry) => entry.review.grantId));
    const missing = [...grantIds].filter((grantId) => !found.has(grantId));
    if (missing.length > 0) {
      throw new Error(`--grant-ids 중 채택 모델 AI 검수가 없는 공고: ${missing.join(", ")}`);
    }
  }
  const notices: DispatchNoticeCandidate[] = [];
  const auditFileByRun = new Map<string, { path: string; sha256: string }>();
  for (const entry of collected) {
    if (!entry.run || entry.run.error !== null) continue;
    const auditPath = labAuditFilePath(
      entry.run.source,
      entry.run.sourceId,
      entry.run.runId,
      AI_REVIEW_ADOPTED.model,
    );
    const audit = await readLabAuditFileAt(auditPath);
    const items = excludePreviouslyDispatched(entry.run.runId, buildDispatchCandidateItems({
      run: entry.run,
      review: entry.review,
      audit,
    }), distributed);
    if (items.length === 0) continue;
    let auditSha = "absent";
    try {
      auditSha = sha256(await readFile(auditPath));
      auditFileByRun.set(entry.run.runId, { path: auditPath, sha256: auditSha });
    } catch {
      auditFileByRun.set(entry.run.runId, { path: auditPath, sha256: auditSha });
    }
    notices.push({ run: entry.run, review: entry.review, audit, items });
  }
  notices.sort((left, right) => left.run.runId.localeCompare(right.run.runId));
  const limitedNotices = limitQuestionSpotchecks(notices, { seed, limit: questionLimit });

  const assignments = assignDispatchCandidates(limitedNotices, {
    seed,
    reviewerCount: reviewers.length,
    overlapRatio: DEFAULT_OVERLAP_RATIO,
  });
  const logicalItemCount = limitedNotices.reduce((sum, notice) => sum + notice.items.length, 0);
  const blindAssignmentCount = assignments.filter((assignment) => assignment.blind).length;
  console.log(
    `[dispatch] ${batchKey} · seed ${seed} · 공고 ${limitedNotices.length} · 항목 ${logicalItemCount} · ` +
    `배정 row ${assignments.length} · blind row ${blindAssignmentCount}`,
  );
  for (const [index, reviewer] of reviewers.entries()) {
    const count = assignments.filter((assignment) => assignment.reviewerIndex === index).length;
    console.log(`  - ${reviewer.email}: ${count}항목`);
  }
  if (dryRun || limitedNotices.length === 0) {
    console.log(dryRun ? "[dispatch] dry-run — DB 쓰기 없음." : "[dispatch] 새 배분 대상이 없습니다.");
    return 0;
  }

  const { guideSha256 } = await loadGuideRubric();
  const preparedInputs = await Promise.all(limitedNotices.map(async (notice) => {
    const input = await reassembleLabInputForRun(notice.run);
    if (input.inputSha256 !== notice.run.inputSha256) {
      throw new Error(
        `입력 drift로 dispatch 중단: ${notice.run.runId} expected=${notice.run.inputSha256} actual=${input.inputSha256}`,
      );
    }
    return input;
  }));

  const batchId = await db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(schema.auditDispatchBatches)
      .values({
        week: batchKey,
        seed,
        reviewerIds: reviewers.map((reviewer) => reviewer.id),
        overlapRatio: DEFAULT_OVERLAP_RATIO,
        guideSha256,
        dispatchedBy,
        itemCount: logicalItemCount,
        noticeCount: limitedNotices.length,
      })
      .returning({ id: schema.auditDispatchBatches.id });
    if (!batch) throw new Error("dispatch batch insert 실패");

    const noticeIds: string[] = [];
    for (const [noticeIndex, notice] of limitedNotices.entries()) {
      const input = preparedInputs[noticeIndex]!;
      const auditMeta = auditFileByRun.get(notice.run.runId);
      const [row] = await tx
        .insert(schema.auditDispatchNotices)
        .values({
          batchId: batch.id,
          grantId: notice.run.grantId,
          runId: notice.run.runId,
          source: notice.run.source,
          sourceId: notice.run.sourceId,
          title: notice.run.title,
          inputText: input.text,
          inputSha256: input.inputSha256,
          analysisMarkdown: notice.run.analysisMarkdown,
          reviewModel: notice.run.model,
          auditSchema: notice.audit?.schema ?? "none",
          auditFileSha256: auditMeta?.sha256 ?? "absent",
          aiReviewModel: notice.review.model,
          aiReviewPromptVer: notice.review.promptVersion,
        })
        .returning({ id: schema.auditDispatchNotices.id });
      if (!row) throw new Error(`dispatch notice insert 실패: ${notice.run.runId}`);
      noticeIds.push(row.id);
    }

    for (const assignment of assignments) {
      const reviewer = reviewers[assignment.reviewerIndex];
      const noticeId = noticeIds[assignment.noticeIndex];
      if (!reviewer || !noticeId) throw new Error("dispatch assignment 연결 실패");
      await tx.insert(schema.auditDispatchItems).values({
        noticeId,
        sourceItemKey: assignment.item.sourceItemKey,
        collectTarget: assignment.item.collectTarget,
        itemKind: assignment.item.itemKind,
        criterionIndex: assignment.item.criterionIndex,
        dimension: assignment.item.dimension,
        payload: assignment.item.payload,
        payloadSha256: sha256(JSON.stringify(assignment.item.payload)),
        assigneeId: reviewer.id,
        assigneeEmail: reviewer.email,
        overlapGroup: assignment.overlapGroup,
        blind: assignment.blind,
      });
    }
    return batch.id;
  });

  console.log(`[dispatch] 배치 저장 완료: ${batchId}`);
  return 0;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function integerArg(name: string): number | null {
  const value = readArg(name);
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`--${name}은 정수여야 합니다.`);
  return parsed;
}

function readCsvArg(name: string): ReadonlySet<string> | null {
  const raw = readArg(name);
  if (raw === undefined) return null;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`--${name}에는 값이 하나 이상 필요합니다.`);
  return new Set(values);
}

function weekSeed(week: string): number {
  return Number.parseInt(sha256(week).slice(0, 8), 16) >>> 0;
}

function isoWeek(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function closeDb(): Promise<void> {
  const { closeCunoteDb } = await import("../db/client");
  await closeCunoteDb();
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[dispatch] 실패:", error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });
