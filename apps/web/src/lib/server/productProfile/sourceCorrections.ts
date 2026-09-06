import { and, desc, eq, sql } from "drizzle-orm";
import { isOfficialSourceSnapshot, isVerifiedSourceCurrent, sourceCorrectionIsOpen,
  type CompanyProfile, type CriterionDimension, type SourceCorrectionRecord, type SourceCorrectionSnapshot } from "@cunote/contracts";
import { companyProfileValueForDimension } from "@cunote/core";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb, type CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { buildMatchingProfileView, type ResolvedProductCompanyProfile } from "./resolveProductCompanyProfile";

export const sourceCorrectionsEnabled = () => process.env.CUNOTE_SOURCE_CORRECTIONS_ENABLED === "true";
export function correctionError(code: string, message: string, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
export function sourceCorrectionSnapshot(profile: CompanyProfile, dimension: CriterionDimension): SourceCorrectionSnapshot {
  const evidence = profile.profile_evidence?.[dimension];
  const row = buildMatchingProfileView(profile, new Date().toISOString()).rows.find((item) => item.dimension === dimension);
  if (!evidence || !row) throw correctionError("source_not_confirmed", "공식 원천이 확인된 필드만 정정을 요청할 수 있습니다.");
  const snapshot = { dimension, value: companyProfileValueForDimension(profile, dimension), displayValue: row.displayValue, evidence };
  if (!isOfficialSourceSnapshot(snapshot)) throw correctionError("source_not_confirmed", "직접 입력한 정보는 프로필에서 수정해주세요.");
  return snapshot;
}
function assertWriter(access: CompanyAccess) {
  if (access.mode !== "session" || access.role === "viewer") throw correctionError("company_write_forbidden", "로그인한 회사의 편집 권한이 필요합니다.", 403);
}
export async function listSourceCorrections(access: CompanyAccess, db: CunoteDb = getCunoteDb()) {
  return db.select().from(schema.profileSourceCorrections).where(and(
    eq(schema.profileSourceCorrections.companyId, access.companyId), eq(schema.profileSourceCorrections.userId, access.userId),
  )).orderBy(desc(schema.profileSourceCorrections.createdAt)).limit(100);
}

/** Baseline is server-resolved, never the submitted value/source. Ticket + request are one transaction. */
export async function createSourceCorrection(input: {
  access: CompanyAccess; email: string; dimension: CriterionDimension; statement: unknown; profile: CompanyProfile;
}, db: CunoteDb = getCunoteDb()) {
  assertWriter(input.access);
  if (typeof input.statement !== "string" || input.statement.trim().length < 10 || input.statement.length > 2000) {
    throw correctionError("invalid_correction_statement", "실제 상황과 다른 점을 10~2,000자로 설명해주세요.");
  }
  const baseline = sourceCorrectionSnapshot(input.profile, input.dimension);
  const statement = input.statement.trim();
  return db.transaction(async (tx) => {
    // Serialize creation for this company and recheck current membership inside the write transaction.
    await tx.execute(sql`select id from companies where id=${input.access.companyId}::uuid for update`);
    const member = await tx.select().from(schema.userCompany).where(and(eq(schema.userCompany.companyId, input.access.companyId), eq(schema.userCompany.userId, input.access.userId))).limit(1).for("share");
    if (!member[0] || member[0].role === "viewer") throw correctionError("company_write_forbidden", "회사 편집 권한이 변경되었습니다.", 403);
    const existing = await tx.select().from(schema.profileSourceCorrections).where(and(
      eq(schema.profileSourceCorrections.companyId, input.access.companyId), eq(schema.profileSourceCorrections.userId, input.access.userId), eq(schema.profileSourceCorrections.dimension, input.dimension),
      sql`${schema.profileSourceCorrections.status} in ('open','reviewing','waiting_source')`,
    )).limit(1);
    if (existing[0]) {
      if (existing[0].statement !== statement) throw correctionError("source_correction_exists", "이 필드의 진행 중 요청이 있습니다. 기존 문의에 설명을 추가하거나 철회 후 다시 접수해주세요.", 409);
      return existing[0];
    }
    const [ticket] = await tx.insert(schema.supportTickets).values({
      companyId: input.access.companyId, userId: input.access.userId, email: input.email,
      category: "bug", subject: `[원천 정정] ${input.dimension}`, message: statement,
      metadata: { workflow: "source_correction_v1" },
    }).returning();
    const [record] = await tx.insert(schema.profileSourceCorrections).values({
      ticketId: ticket!.id, companyId: input.access.companyId, userId: input.access.userId,
      dimension: input.dimension, baseline, statement,
      events: [{ at: new Date().toISOString(), actor: input.access.userId, action: "submitted", note: "공식 원천값을 보존하고 정정 검토를 요청했습니다." }],
    }).returning();
    return record!;
  });
}

export async function updateOwnSourceCorrection(input: {
  access: CompanyAccess; id: string; revision: number; action: "recheck" | "withdraw"; profile: CompanyProfile;
}, db: CunoteDb = getCunoteDb()) {
  assertWriter(input.access);
  return db.transaction(async (tx) => {
    const member = await tx.select().from(schema.userCompany).where(and(eq(schema.userCompany.companyId, input.access.companyId), eq(schema.userCompany.userId, input.access.userId))).limit(1).for("share");
    if (!member[0] || member[0].role === "viewer") throw correctionError("company_write_forbidden", "회사 편집 권한이 변경되었습니다.", 403);
    const [record] = await tx.select().from(schema.profileSourceCorrections).where(and(
      eq(schema.profileSourceCorrections.id, input.id), eq(schema.profileSourceCorrections.companyId, input.access.companyId),
      eq(schema.profileSourceCorrections.userId, input.access.userId),
    )).for("update");
    if (!record) throw correctionError("source_correction_not_found", "정정 요청을 찾지 못했습니다.", 404);
    if (record.revision !== input.revision || !sourceCorrectionIsOpen(record.status)) throw correctionError("source_correction_conflict", "처리 상태가 변경되었습니다. 다시 조회해주세요.", 409);
    const observation = input.action === "recheck" ? sourceCorrectionSnapshot(input.profile, record.dimension) : record.observation;
    const now = new Date();
    const status = input.action === "withdraw" ? "withdrawn" as const : record.status;
    const [updated] = await tx.update(schema.profileSourceCorrections).set({
      observation, status, revision: record.revision + 1, updatedAt: now,
      events: [...record.events, { at: now.toISOString(), actor: input.access.userId, action: input.action,
        note: input.action === "withdraw" ? "사용자가 정정 요청을 철회했습니다." : "서비스가 보유한 공식 원천을 재확인했습니다. 외부 기관 갱신이나 정정 완료를 뜻하지 않습니다." }],
    }).where(eq(schema.profileSourceCorrections.id, record.id)).returning();
    if (status === "withdrawn") await tx.update(schema.supportTickets).set({ status: "closed", updatedAt: now }).where(eq(schema.supportTickets.id, record.ticketId));
    return updated!;
  });
}

export function annotateSourceCorrectionState(resolution: ResolvedProductCompanyProfile, records: SourceCorrectionRecord[]): ResolvedProductCompanyProfile {
  const disputed = new Set<CriterionDimension>();
  // Latest request per requester/axis supersedes historical resolved/rejected requests.
  const latest = new Map<string, SourceCorrectionRecord>();
  for (const record of records) {
    const key = `${record.userId}:${record.dimension}`;
    const previous = latest.get(key);
    if (!previous || (record.events[0]?.at ?? "") > (previous.events[0]?.at ?? "")) latest.set(key, record);
  }
  for (const record of latest.values()) {
    if (sourceCorrectionIsOpen(record.status)) disputed.add(record.dimension);
    // Later observations may retain the same fact, but changed facts/providers or older data reopen deferral.
    if (record.status === "resolved") {
      try {
        if (!record.observation || !isVerifiedSourceCurrent(record.observation, sourceCorrectionSnapshot(resolution.profile, record.dimension))) disputed.add(record.dimension);
      } catch { disputed.add(record.dimension); }
    }
  }
  const profile = { ...resolution.profile, source_disputes: [...disputed] };
  return { ...resolution, profile, view: buildMatchingProfileView(profile, resolution.asOf) };
}

export async function applySourceCorrectionState(resolution: ResolvedProductCompanyProfile, companyId: string) {
  if (!sourceCorrectionsEnabled()) return resolution;
  const table = schema.profileSourceCorrections;
  const records = await getCunoteDb().selectDistinctOn([table.userId, table.dimension]).from(table)
    .where(eq(table.companyId, companyId)).orderBy(table.userId, table.dimension, desc(table.createdAt));
  return annotateSourceCorrectionState(resolution, records);
}
