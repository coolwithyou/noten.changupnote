import { and, desc, eq, inArray } from "drizzle-orm";
import type { FeedbackKind, MatchCard, SupportAmount } from "@cunote/contracts";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { getCunoteDb, withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import {
  applicationManagementFromPayload,
  listRuntimeApplicationManagementFeedback,
  type ApplicationManagement,
  type ApplicationManagementFeedbackSnapshot,
} from "./applicationManagementFeedback";

export type ApplicationStage =
  | "recommended"
  | "saved"
  | "preparing"
  | "submitted"
  | "selected"
  | "rejected"
  | "blocked"
  | "dismissed";

export interface ApplicationPipelineItem {
  grantId: string;
  title: string;
  agency: string | null;
  fitScore: number;
  eligibility: MatchCard["eligibility"];
  dDay: number | null;
  applyEnd: string | null;
  supportLabel: string;
  stage: ApplicationStage;
  stageLabel: string;
  lastActionAt: string | null;
  draftCount: number;
  reviewedDraftCount: number;
  warningCount: number;
  detailHref: string;
  nextAction: string;
  assigneeName: string | null;
  reminderAt: string | null;
  outcomeNote: string | null;
}

export interface ApplicationPipelineResult {
  generatedAt: string;
  stats: Record<ApplicationStage, number>;
  items: ApplicationPipelineItem[];
}

interface FeedbackSnapshot {
  kind: FeedbackKind;
  ts: Date;
  management: ApplicationManagement | null;
}

interface DraftSnapshot {
  count: number;
  reviewedCount: number;
  warningCount: number;
  updatedAt: Date | null;
}

export async function buildApplicationPipeline(input: {
  access: CompanyAccess;
  matches: MatchCard[];
  now?: Date;
}): Promise<ApplicationPipelineResult> {
  const matches = input.matches
    .filter((match) => match.eligibility !== "ineligible")
    .slice(0, 80);
  const [feedback, drafts] = await Promise.all([
    loadFeedbackSnapshots(input.access, matches.map((match) => match.grantId)),
    loadDraftSnapshots(input.access),
  ]);
  const items = matches.map((match) => {
    const feedbackSnapshot = feedback.get(match.grantId) ?? null;
    const draft = drafts.get(match.grantId) ?? emptyDraftSnapshot();
    const stage = resolveStage({
      feedback: feedbackSnapshot,
      draft,
    });
    return {
      grantId: match.grantId,
      title: match.title,
      agency: match.agency,
      fitScore: match.fitScore,
      eligibility: match.eligibility,
      dDay: match.dDay,
      applyEnd: match.applyEnd,
      supportLabel: formatSupportAmount(match.supportAmount),
      stage,
      stageLabel: stageLabel(stage),
      lastActionAt: latestDate(feedbackSnapshot?.ts ?? null, draft.updatedAt)?.toISOString() ?? null,
      draftCount: draft.count,
      reviewedDraftCount: draft.reviewedCount,
      warningCount: draft.warningCount,
      detailHref: `/grants/${encodeURIComponent(match.grantId)}`,
      nextAction: nextActionFor(stage, draft.count),
      assigneeName: feedbackSnapshot?.management?.assigneeName ?? null,
      reminderAt: feedbackSnapshot?.management?.reminderAt ?? null,
      outcomeNote: feedbackSnapshot?.management?.outcomeNote ?? null,
    } satisfies ApplicationPipelineItem;
  }).sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage) || (a.dDay ?? 9999) - (b.dDay ?? 9999));

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    stats: buildStats(items),
    items,
  };
}

async function loadFeedbackSnapshots(
  access: CompanyAccess,
  grantIds: string[],
): Promise<Map<string, FeedbackSnapshot>> {
  const result = new Map<string, FeedbackSnapshot>();
  mergeRuntimeFeedbackSnapshots(result, access, grantIds);
  if (grantIds.length === 0 || !hasDatabaseUrl()) return result;
  try {
    const db = getCunoteDb();
    const targetIds = grantIds.map((grantId) => `${access.companyId}:${grantId}`);
    const rows = await withCunoteDbUser(db, access.userId, async (tx) => tx
      .select({
        targetId: schema.feedback.targetId,
        value: schema.feedback.value,
        ts: schema.feedback.ts,
      })
      .from(schema.feedback)
      .where(and(
        eq(schema.feedback.targetType, "match"),
        inArray(schema.feedback.targetId, targetIds),
      ))
      .orderBy(desc(schema.feedback.ts)));

    for (const row of rows) {
      const grantId = grantIdFromTarget(row.targetId, access.companyId);
      if (!grantId) continue;
      const kind = feedbackKind(row.value?.kind);
      if (!kind) continue;
      const management = applicationManagementFromPayload(row.value?.payload);
      mergeFeedbackSnapshot(result, grantId, { kind, ts: row.ts, management });
    }
    return result;
  } catch {
    return result;
  }
}

async function loadDraftSnapshots(access: CompanyAccess): Promise<Map<string, DraftSnapshot>> {
  if (!hasDatabaseUrl()) return new Map();
  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, access.userId, async (tx) => tx
      .select({
        grantId: schema.grantDocumentDrafts.grantId,
        status: schema.grantDocumentDrafts.status,
        warnings: schema.grantDocumentDrafts.warnings,
        updatedAt: schema.grantDocumentDrafts.updatedAt,
      })
      .from(schema.grantDocumentDrafts)
      .where(eq(schema.grantDocumentDrafts.companyId, access.companyId)));

    const result = new Map<string, DraftSnapshot>();
    for (const row of rows) {
      const current = result.get(row.grantId) ?? emptyDraftSnapshot();
      current.count += 1;
      if (row.status === "reviewed" || row.status === "exported") current.reviewedCount += 1;
      current.warningCount += row.warnings.length;
      current.updatedAt = latestDate(current.updatedAt, row.updatedAt);
      result.set(row.grantId, current);
    }
    return result;
  } catch {
    return new Map();
  }
}

function resolveStage(input: {
  feedback: FeedbackSnapshot | null;
  draft: DraftSnapshot;
}): ApplicationStage {
  if (input.feedback?.kind === "selected") return "selected";
  if (input.feedback?.kind === "rejected") return "rejected";
  if (input.feedback?.kind === "blocked") return "blocked";
  if (input.feedback?.kind === "dismissed" || input.feedback?.kind === "wrong") return "dismissed";
  if (input.feedback?.kind === "applied") return "submitted";
  if (input.draft.count > 0 || input.feedback?.kind === "note") return "preparing";
  if (input.feedback?.kind === "saved") return "saved";
  return "recommended";
}

function buildStats(items: ApplicationPipelineItem[]): Record<ApplicationStage, number> {
  return {
    recommended: items.filter((item) => item.stage === "recommended").length,
    saved: items.filter((item) => item.stage === "saved").length,
    preparing: items.filter((item) => item.stage === "preparing").length,
    submitted: items.filter((item) => item.stage === "submitted").length,
    selected: items.filter((item) => item.stage === "selected").length,
    rejected: items.filter((item) => item.stage === "rejected").length,
    blocked: items.filter((item) => item.stage === "blocked").length,
    dismissed: items.filter((item) => item.stage === "dismissed").length,
  };
}

function stageLabel(stage: ApplicationStage): string {
  if (stage === "recommended") return "추천";
  if (stage === "saved") return "저장";
  if (stage === "preparing") return "준비";
  if (stage === "submitted") return "제출";
  if (stage === "selected") return "선정";
  if (stage === "rejected") return "탈락";
  if (stage === "blocked") return "막힘";
  return "보류";
}

function nextActionFor(stage: ApplicationStage, draftCount: number): string {
  if (stage === "recommended") return "저장하거나 준비를 시작하세요.";
  if (stage === "saved") return "공고 상세에서 필요한 서류를 확인하세요.";
  if (stage === "preparing" && draftCount === 0) return "AI 초안을 만들고 제출서류를 정리하세요.";
  if (stage === "preparing") return "초안을 검토하고 제출 전 원문 양식을 확인하세요.";
  if (stage === "submitted") return "결과 발표와 후속 증빙 일정을 기록하세요.";
  if (stage === "selected") return "선정 이력과 후속 의무를 관리하세요.";
  if (stage === "rejected") return "탈락 사유가 있으면 기록해 다음 추천 보정에 활용하세요.";
  if (stage === "blocked") return "신청을 막은 조건을 확인해 매칭 조건을 보정하세요.";
  return "다시 검토할 때 저장으로 되돌릴 수 있습니다.";
}

function stageOrder(stage: ApplicationStage): number {
  if (stage === "preparing") return 0;
  if (stage === "saved") return 1;
  if (stage === "recommended") return 2;
  if (stage === "submitted") return 3;
  if (stage === "selected") return 4;
  if (stage === "rejected") return 5;
  if (stage === "blocked") return 6;
  return 7;
}

function formatSupportAmount(amount: SupportAmount): string {
  if (amount.label) return amount.label;
  if (amount.max) return `${new Intl.NumberFormat("ko-KR").format(amount.max)}원`;
  return "금액 미확인";
}

function grantIdFromTarget(targetId: string, companyId: string): string | null {
  const prefix = `${companyId}:`;
  return targetId.startsWith(prefix) ? targetId.slice(prefix.length) : null;
}

function feedbackKind(value: unknown): FeedbackKind | null {
  if (
    value === "saved" ||
    value === "dismissed" ||
    value === "wrong" ||
    value === "applied" ||
    value === "selected" ||
    value === "rejected" ||
    value === "blocked" ||
    value === "note"
  ) {
    return value;
  }
  return null;
}

function emptyDraftSnapshot(): DraftSnapshot {
  return {
    count: 0,
    reviewedCount: 0,
    warningCount: 0,
    updatedAt: null,
  };
}

function latestDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}

function mergeRuntimeFeedbackSnapshots(
  result: Map<string, FeedbackSnapshot>,
  access: CompanyAccess,
  grantIds: string[],
): void {
  const snapshots = listRuntimeApplicationManagementFeedback({
    companyId: access.companyId,
    userId: access.userId,
    grantIds,
  });
  for (const [grantId, snapshot] of snapshots) {
    mergeFeedbackSnapshot(result, grantId, snapshot);
  }
}

function mergeFeedbackSnapshot(
  result: Map<string, FeedbackSnapshot>,
  grantId: string,
  snapshot: Pick<ApplicationManagementFeedbackSnapshot, "kind" | "ts" | "management">,
): void {
  const current = result.get(grantId);
  if (!current) {
    result.set(grantId, { kind: snapshot.kind, ts: snapshot.ts, management: snapshot.management });
    return;
  }
  if (snapshot.ts.getTime() > current.ts.getTime()) {
    result.set(grantId, {
      kind: snapshot.kind,
      ts: snapshot.ts,
      management: snapshot.management ?? current.management,
    });
    return;
  }
  if (!current.management && snapshot.management) {
    current.management = snapshot.management;
  }
}
