import { and, desc, eq, inArray, like } from "drizzle-orm";
import { daysUntil, normalizeSupportAmount } from "@cunote/core";
import type { FeedbackKind, MatchCard, SupportAmount } from "@cunote/contracts";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { getCunoteDb, withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import {
  applicationManagementFromPayload,
  listRuntimeApplicationManagementFeedback,
  type ApplicationManagement,
  type ApplicationManagementFeedbackSnapshot,
  type ApplicationManagementStage,
} from "./applicationManagementFeedback";

export type ApplicationStage = ApplicationManagementStage;

export interface ApplicationPipelineItem {
  grantId: string;
  title: string;
  agency: string | null;
  /** 현재 매칭 결과 밖(직접 준비)이면 조건 확인도를 산정할 수 없어 null이다. */
  fitScore: number | null;
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
  /**
   * 현재 매칭 목록에는 없지만 초안·피드백 등 사용자 행동이 있어 파이프라인에 편입된 공고.
   * fitScore/eligibility는 매치 전용 값이므로 UI는 이 플래그로 "매칭 밖 · 직접 준비"를 표기한다.
   */
  outsideMatches?: boolean;
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
  const now = input.now ?? new Date();

  // 초안은 회사 전체를 로드한다 — 매칭 여부와 무관하게 "직접 준비" 공고를 발견하기 위한 원천.
  const drafts = await loadDraftSnapshots(input.access);

  // 현재 매칭에서 빠진 뒤에도 저장·제출·선정 이력은 신청 관리에 남아야 하므로
  // 회사의 match 피드백 전체를 로드한다.
  const feedback = await loadFeedbackSnapshots(input.access);

  // 신청 관리는 추천 목록의 복제본이 아니라 사용자가 실제로 추적하기 시작한 공고만 다룬다.
  // 적격 여부와 무관하게 초안·저장·메모·제출 같은 행동이 있으면 유지한다.
  const matchItems = input.matches
    .filter((match) => drafts.has(match.grantId) || feedback.has(match.grantId))
    .slice(0, 80)
    .map((match) => assemblePipelineItem({
      grantId: match.grantId,
      title: match.title,
      agency: match.agency,
      fitScore: match.fitScore,
      eligibility: match.eligibility,
      dDay: match.dDay,
      applyEnd: match.applyEnd,
      supportLabel: formatSupportAmount(match.supportAmount),
      feedback: feedback.get(match.grantId) ?? null,
      draft: drafts.get(match.grantId) ?? emptyDraftSnapshot(),
    }));

  // 초안은 있으나 매칭 목록(위 유지분)에 없는 공고를 DB 메타로 보강한다 — "매칭 밖이어도 지원" 시나리오의 핵심.
  const coveredGrantIds = new Set(matchItems.map((item) => item.grantId));
  const outsideGrantIds = uniqueStrings([...drafts.keys(), ...feedback.keys()])
    .filter((grantId) => !coveredGrantIds.has(grantId));
  const outsideMeta = await loadOutsideGrantMeta(input.access, outsideGrantIds);
  const outsideItems = outsideGrantIds
    .map((grantId) => {
      const meta = outsideMeta.get(grantId);
      if (!meta) return null;
      const applyEnd = meta.applyEnd ? meta.applyEnd.toISOString() : null;
      return assemblePipelineItem({
        grantId,
        title: meta.title,
        agency: meta.agencyOperator ?? meta.agencyJurisdiction ?? null,
        fitScore: null,
        // 매치가 없어 정직한 적격 판정이 없다 — UI는 outsideMatches 플래그로 구분한다.
        eligibility: "conditional",
        dDay: daysUntil(applyEnd, now),
        applyEnd,
        supportLabel: formatSupportAmount(normalizeSupportAmount(meta.supportAmount)),
        outsideMatches: true,
        feedback: feedback.get(grantId) ?? null,
        draft: drafts.get(grantId) ?? emptyDraftSnapshot(),
      });
    })
    .filter((item): item is ApplicationPipelineItem => item !== null);

  const items = [...matchItems, ...outsideItems]
    .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage) || (a.dDay ?? 9999) - (b.dDay ?? 9999));

  return {
    generatedAt: now.toISOString(),
    stats: buildStats(items),
    items,
  };
}

function assemblePipelineItem(input: {
  grantId: string;
  title: string;
  agency: string | null;
  fitScore: number | null;
  eligibility: MatchCard["eligibility"];
  dDay: number | null;
  applyEnd: string | null;
  supportLabel: string;
  feedback: FeedbackSnapshot | null;
  draft: DraftSnapshot;
  outsideMatches?: boolean;
}): ApplicationPipelineItem {
  const { feedback: feedbackSnapshot, draft } = input;
  const stage = resolveStage({ feedback: feedbackSnapshot, draft });
  const item: ApplicationPipelineItem = {
    grantId: input.grantId,
    title: input.title,
    agency: input.agency,
    fitScore: input.fitScore,
    eligibility: input.eligibility,
    dDay: input.dDay,
    applyEnd: input.applyEnd,
    supportLabel: input.supportLabel,
    stage,
    stageLabel: stageLabel(stage),
    lastActionAt: latestDate(feedbackSnapshot?.ts ?? null, draft.updatedAt)?.toISOString() ?? null,
    draftCount: draft.count,
    reviewedDraftCount: draft.reviewedCount,
    warningCount: draft.warningCount,
    detailHref: `/grants/${encodeURIComponent(input.grantId)}`,
    nextAction: nextActionFor(stage, draft.count),
    assigneeName: feedbackSnapshot?.management?.assigneeName ?? null,
    reminderAt: feedbackSnapshot?.management?.reminderAt ?? null,
    outcomeNote: feedbackSnapshot?.management?.outcomeNote ?? null,
  };
  if (input.outsideMatches) item.outsideMatches = true;
  return item;
}

async function loadFeedbackSnapshots(
  access: CompanyAccess,
): Promise<Map<string, FeedbackSnapshot>> {
  const result = new Map<string, FeedbackSnapshot>();
  mergeRuntimeFeedbackSnapshots(result, access);
  if (!hasDatabaseUrl()) return result;
  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, access.userId, async (tx) => tx
      .select({
        targetId: schema.feedback.targetId,
        value: schema.feedback.value,
        ts: schema.feedback.ts,
      })
      .from(schema.feedback)
      .where(and(
        eq(schema.feedback.targetType, "match"),
        like(schema.feedback.targetId, `${access.companyId}:%`),
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

interface OutsideGrantMeta {
  id: string;
  title: string;
  agencyOperator: string | null;
  agencyJurisdiction: string | null;
  applyEnd: Date | null;
  supportAmount: Record<string, unknown> | null;
}

async function loadOutsideGrantMeta(
  access: CompanyAccess,
  grantIds: string[],
): Promise<Map<string, OutsideGrantMeta>> {
  const result = new Map<string, OutsideGrantMeta>();
  if (grantIds.length === 0 || !hasDatabaseUrl()) return result;
  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, access.userId, async (tx) => tx
      .select({
        id: schema.grants.id,
        title: schema.grants.title,
        agencyOperator: schema.grants.agencyOperator,
        agencyJurisdiction: schema.grants.agencyJurisdiction,
        applyEnd: schema.grants.applyEnd,
        supportAmount: schema.grants.supportAmount,
      })
      .from(schema.grants)
      .where(inArray(schema.grants.id, grantIds)));
    for (const row of rows) {
      result.set(row.id, row);
    }
    return result;
  } catch {
    return result;
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
  if (input.draft.count > 0) return "preparing";
  if (input.feedback?.kind === "note") {
    const stage = input.feedback.management?.applicationStage;
    return stage === "recommended" || stage === "preparing" ? stage : "preparing";
  }
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}

function mergeRuntimeFeedbackSnapshots(
  result: Map<string, FeedbackSnapshot>,
  access: CompanyAccess,
): void {
  const snapshots = listRuntimeApplicationManagementFeedback({
    companyId: access.companyId,
    userId: access.userId,
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
