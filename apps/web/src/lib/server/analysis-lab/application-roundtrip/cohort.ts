import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { VERSION } from "kordoc";
import type {
  RoundtripCohortNotice,
  RoundtripCohortResponse,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import {
  classifyRoundtripDocument,
  declaredRoundtripFormat,
  likelyApplicationRole,
} from "./core";

const MAX_ARCHIVE_ROWS = 320;
const COHORT_SIZE = 12;
const SOURCES = ["kstartup", "bizinfo"] as const;

export async function loadApplicationRoundtripCohort(): Promise<RoundtripCohortResponse> {
  const db = getCunoteDb();
  const rows = await db
    .select({
      grantId: schema.grants.id,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      title: schema.grants.title,
      agencyOperator: schema.grants.agencyOperator,
      agencyJurisdiction: schema.grants.agencyJurisdiction,
      applyEnd: schema.grants.applyEnd,
      url: schema.grants.url,
      updatedAt: schema.grants.updatedAt,
      filename: schema.grantAttachmentArchives.filename,
      bytes: schema.grantAttachmentArchives.bytes,
    })
    .from(schema.grantAttachmentArchives)
    .innerJoin(
      schema.grants,
      and(
        eq(schema.grantAttachmentArchives.source, schema.grants.source),
        eq(schema.grantAttachmentArchives.sourceId, schema.grants.sourceId),
      ),
    )
    .where(
      and(
        eq(schema.grants.status, "open"),
        inArray(schema.grants.source, [...SOURCES]),
        isNotNull(schema.grantAttachmentArchives.storageKey),
      ),
    )
    .orderBy(desc(schema.grants.updatedAt))
    .limit(MAX_ARCHIVE_ROWS);

  const byGrant = new Map<string, RoundtripCohortNotice & { updatedAt: string; rank: number }>();
  for (const row of rows) {
    const declaredFormat = declaredRoundtripFormat(row.filename);
    if (!declaredFormat) continue;
    const classification = classifyRoundtripDocument({
      filename: row.filename,
      markdown: "",
      fields: [],
      formConfidence: 0,
    });
    const roleHintScore = Math.max(...Object.values(classification.scores));
    const likely = likelyApplicationRole(classification.role);
    const current = byGrant.get(row.grantId) ?? {
      grantId: row.grantId,
      source: row.source,
      sourceId: row.sourceId,
      title: row.title,
      agency: row.agencyOperator ?? row.agencyJurisdiction ?? null,
      applyEnd: row.applyEnd?.toISOString() ?? null,
      url: row.url ?? null,
      attachments: [],
      likelyApplicationDocumentCount: 0,
      updatedAt: row.updatedAt?.toISOString() ?? "",
      rank: 0,
    };
    if (current.attachments.some((attachment) => attachment.filename === row.filename)) continue;
    current.attachments.push({
      filename: row.filename,
      declaredFormat,
      bytes: row.bytes ?? null,
      roleHint: classification.role,
      roleHintScore,
      likelyApplicationDocument: likely,
    });
    if (likely) current.likelyApplicationDocumentCount += 1;
    current.rank = Math.max(current.rank, likely ? 100 + roleHintScore : roleHintScore);
    byGrant.set(row.grantId, current);
  }

  const notices = [...byGrant.values()]
    .sort((a, b) => b.rank - a.rank || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, COHORT_SIZE)
    .map(({ updatedAt: _updatedAt, rank: _rank, ...notice }) => ({
      ...notice,
      attachments: notice.attachments.sort(
        (a, b) => Number(b.likelyApplicationDocument) - Number(a.likelyApplicationDocument)
          || b.roleHintScore - a.roleHintScore,
      ),
    }));

  return {
    engine: "kordoc",
    engineVersion: VERSION,
    generatedAt: new Date().toISOString(),
    notices,
  };
}
