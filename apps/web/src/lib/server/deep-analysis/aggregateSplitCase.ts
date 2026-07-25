import { eq } from "drizzle-orm";

import type { CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import type { DeepAnalysisInputSeal } from "./inputManifest";
import { sha256Hex, stableJson } from "./sourceRevision";

export const AGGREGATE_SPLIT_DETECTOR_VERSION =
  "aggregate-split-detector-v1" as const;

export interface AggregateSplitRequirement {
  reasonCode: "oversized_aggregate_notice";
  inputChars: number;
  inputCapChars: number;
  chunkCount: number;
  attachmentCount: number;
  evidence: Record<string, unknown>;
  evidenceSha256: string;
}

/**
 * 단순히 긴 단일사업 공고는 자동 분리 대상으로 오인하지 않는다. 입력 상한을 실제로
 * 넘었고 제목이 통합공고임을 명시한 경우만 사람 승인 케이스로 승격한다.
 */
export function detectAggregateSplitRequirement(input: {
  title: string;
  seal: DeepAnalysisInputSeal;
  inputCapChars: number;
}): AggregateSplitRequirement | null {
  const blockerCodes = [
    ...new Set(input.seal.blockers.map((blocker) => blocker.code)),
  ];
  const blockedOnlyByCap = (
    blockerCodes.length === 1
    && blockerCodes[0] === "blocked_cap"
  );
  if (
    !blockedOnlyByCap
    || input.seal.totalChars <= input.inputCapChars
    || !isAggregateNoticeTitle(input.title)
  ) {
    return null;
  }

  const evidence = {
    schema: "aggregate-split-detection-v1",
    detectorVersion: AGGREGATE_SPLIT_DETECTOR_VERSION,
    grantId: input.seal.grantId,
    sourceRevisionSha256: input.seal.sourceRevisionSha256,
    title: input.title,
    reasonCode: "oversized_aggregate_notice",
    inputChars: input.seal.totalChars,
    inputCapChars: input.inputCapChars,
    chunkCount: input.seal.chunks.length,
    attachmentCount: input.seal.attachments.filter(
      (attachment) => attachment.disposition === "included",
    ).length,
    blockerCodes,
  };

  return {
    reasonCode: "oversized_aggregate_notice",
    inputChars: input.seal.totalChars,
    inputCapChars: input.inputCapChars,
    chunkCount: input.seal.chunks.length,
    attachmentCount: input.seal.attachments.filter(
      (attachment) => attachment.disposition === "included",
    ).length,
    evidence,
    evidenceSha256: sha256Hex(stableJson(evidence)),
  };
}

/**
 * 같은 원문 revision은 한 번만 등록한다. 이미 사람이 승인한 케이스를 detector 재실행이
 * pending_review로 되돌리지 않도록 상태·승인 필드는 갱신하지 않는다.
 */
export async function ensureAggregateSplitCaseForSeal(input: {
  db: CunoteDbSession;
  grantId: string;
  seal: DeepAnalysisInputSeal;
  inputCapChars: number;
}): Promise<typeof schema.grantAggregateSplitCases.$inferSelect | null> {
  if (!input.seal.blockers.some((blocker) => blocker.code === "blocked_cap")) {
    return null;
  }

  const [grant] = await input.db
    .select({ title: schema.grants.title })
    .from(schema.grants)
    .where(eq(schema.grants.id, input.grantId))
    .limit(1);
  if (!grant) throw new Error(`Grant not found: ${input.grantId}`);

  const requirement = detectAggregateSplitRequirement({
    title: grant.title,
    seal: input.seal,
    inputCapChars: input.inputCapChars,
  });
  if (!requirement) return null;

  const [splitCase] = await input.db
    .insert(schema.grantAggregateSplitCases)
    .values({
      grantId: input.grantId,
      sourceRevisionSha256: input.seal.sourceRevisionSha256,
      status: "pending_review",
      reasonCode: requirement.reasonCode,
      inputChars: requirement.inputChars,
      inputCapChars: requirement.inputCapChars,
      chunkCount: requirement.chunkCount,
      attachmentCount: requirement.attachmentCount,
      evidence: requirement.evidence,
      evidenceSha256: requirement.evidenceSha256,
    })
    .onConflictDoUpdate({
      target: [
        schema.grantAggregateSplitCases.grantId,
        schema.grantAggregateSplitCases.sourceRevisionSha256,
      ],
      set: {
        inputChars: requirement.inputChars,
        inputCapChars: requirement.inputCapChars,
        chunkCount: requirement.chunkCount,
        attachmentCount: requirement.attachmentCount,
        evidence: requirement.evidence,
        evidenceSha256: requirement.evidenceSha256,
        updatedAt: new Date(),
      },
    })
    .returning();
  return splitCase ?? null;
}

function isAggregateNoticeTitle(title: string): boolean {
  const normalized = title.replace(/\s+/g, " ").trim();
  return (
    /통합\s*공고/u.test(normalized)
    || /통합\s*모집\s*공고/u.test(normalized)
    || /통합\s*지원사업/u.test(normalized)
    || /중앙부처.{0,30}지자체.{0,30}창업지원사업/u.test(normalized)
  );
}
