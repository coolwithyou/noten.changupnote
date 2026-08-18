import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { APPLICATION_ROUNDTRIP_ADOPTED_MODEL } from "@/lib/server/analysis-lab/application-roundtrip/contract";
import { kstDayStartUtc } from "@/lib/server/analysis-lab/notice-period";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import type { DeepRepairPlanningSelection } from "./cohort";
import { analyzeRoundtripDocument } from "./application-roundtrip/analyze-document";
import {
  declaredRoundtripFormat,
  likelyApplicationRole,
} from "./application-roundtrip/core";
import { isSubscriptionRoundtripLlmCandidate } from "./application-roundtrip/field-planner";
import { DEEP_REPAIR_FORMAL_MAX_SAMPLE_SIZE } from "./deep-repair-formal-policy";
import {
  DEEP_REPAIR_INITIAL_RELEASE_COHORT_SIZE,
  DEEP_REPAIR_INITIAL_MIN_REMAINING_DAYS,
  prioritizeDeepRepairTargetsForInitialKordocCohort,
  type DeepRepairKordocReadiness,
} from "./deep-repair-kordoc-priority";

const SHA256 = /^[a-f0-9]{64}$/u;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** 모델 호출 없이 보관 원문의 SHA와 Kordoc 구조를 확인해 첫 10건을 release-ready로 정렬한다. */
export async function prioritizeDeepRepairPlanningTargetsForKordoc(
  selection: DeepRepairPlanningSelection,
): Promise<DeepRepairPlanningSelection> {
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("R2 환경 설정이 없어 초기 Kordoc 코호트를 probe할 수 없습니다.");
  const grantIds = selection.targets.map((target) => target.grantId);
  const attachments = await getCunoteDb()
    .select({
      grantId: schema.grants.id,
      applyEnd: schema.grants.applyEnd,
      filename: schema.grantAttachmentArchives.filename,
      storageKey: schema.grantAttachmentArchives.storageKey,
      sha256: schema.grantAttachmentArchives.sha256,
    })
    .from(schema.grantAttachmentArchives)
    .innerJoin(
      schema.grants,
      and(
        eq(schema.grants.source, schema.grantAttachmentArchives.source),
        eq(schema.grants.sourceId, schema.grantAttachmentArchives.sourceId),
      ),
    )
    .where(inArray(schema.grants.id, grantIds));

  const readiness: DeepRepairKordocReadiness[] = [];
  let parseFailureCount = 0;
  const minimumApplyEnd = new Date(
    kstDayStartUtc(new Date()).getTime() + DEEP_REPAIR_INITIAL_MIN_REMAINING_DAYS * DAY_MS,
  );
  for (const target of selection.targets) {
    let selectedDocumentCount = 0;
    let fieldCandidateCount = 0;
    let llmCandidateCount = 0;
    const sourceSha256s: string[] = [];
    for (const attachment of attachments.filter((item) => item.grantId === target.grantId)) {
      const declaredFormat = declaredRoundtripFormat(attachment.filename);
      const expectedSha256 = attachment.sha256?.toLowerCase() ?? "";
      if (!declaredFormat || !attachment.storageKey || !SHA256.test(expectedSha256)) continue;
      const body = (await storage.getObjectBytes(attachment.storageKey)).body;
      const actualSha256 = createHash("sha256").update(body).digest("hex");
      if (actualSha256 !== expectedSha256) {
        throw new Error(`Kordoc source SHA-256 drift: ${target.grantId}/${attachment.filename}`);
      }
      let document: Awaited<ReturnType<typeof analyzeRoundtripDocument>>["document"];
      try {
        ({ document } = await analyzeRoundtripDocument({
          attachmentId: actualSha256.slice(0, 20),
          filename: attachment.filename,
          declaredFormat,
          sourceSha256: actualSha256,
          body,
          apiKey: null,
          model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
          transport: "api",
        }));
      } catch {
        parseFailureCount += 1;
        continue;
      }
      if (!likelyApplicationRole(document.role)) continue;
      selectedDocumentCount += 1;
      fieldCandidateCount += document.fields.length;
      llmCandidateCount += document.fields.filter(isSubscriptionRoundtripLlmCandidate).length;
      sourceSha256s.push(actualSha256);
    }
    readiness.push({
      grantId: target.grantId,
      selectedDocumentCount,
      fieldCandidateCount,
      llmCandidateCount,
      sourceSha256s: [...new Set(sourceSha256s)].sort(),
      releaseWindowReady: attachments.some(
        (item) => item.grantId === target.grantId
          && item.applyEnd !== null
          && item.applyEnd.getTime() >= minimumApplyEnd.getTime(),
      ),
    });
  }

  const targets = prioritizeDeepRepairTargetsForInitialKordocCohort(selection.targets, readiness)
    .slice(0, DEEP_REPAIR_FORMAL_MAX_SAMPLE_SIZE);
  const quotas = {
    unified: {
      target: selection.quotas.unified.target,
      achieved: targets.filter((target) => target.isUnified).length,
    },
    richCriteria: {
      target: selection.quotas.richCriteria.target,
      achieved: targets.filter((target) => target.isRichCriteria).length,
    },
  };
  const quotaWarnings: string[] = [];
  if (quotas.unified.achieved < quotas.unified.target) {
    quotaWarnings.push(
      `쿼터 미충족(soft): 통합공고 ${quotas.unified.achieved}/${quotas.unified.target}건 — 출시 코호트 적합성 우선`,
    );
  }
  if (quotas.richCriteria.achieved < quotas.richCriteria.target) {
    quotaWarnings.push(
      `쿼터 미충족(soft): 현행 criterion 3개 이상 ${quotas.richCriteria.achieved}/${quotas.richCriteria.target}건 — 출시 코호트 적합성 우선`,
    );
  }
  return {
    ...selection,
    targets,
    quotas,
    warnings: [
      ...selection.warnings,
      ...quotaWarnings,
      ...(parseFailureCount > 0
        ? [`Kordoc parse 제외 문서 ${parseFailureCount}개 — 다른 ready 원문으로 코호트 충족`]
        : []),
      `초기 출시 코호트 ${DEEP_REPAIR_INITIAL_RELEASE_COHORT_SIZE}건 Kordoc 원문 probe 및 접수 여유 ${DEEP_REPAIR_INITIAL_MIN_REMAINING_DAYS}일 통과`,
    ],
  };
}
