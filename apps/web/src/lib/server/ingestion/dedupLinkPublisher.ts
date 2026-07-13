import { and, eq, sql } from "drizzle-orm";
import type { NormalizedGrant } from "@cunote/contracts";
import {
  findGrantDedupCandidates,
  grantDedupKey,
  type FindGrantDedupCandidatesOptions,
  type GrantDedupCandidate,
} from "@cunote/core";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";

export interface DedupLinkPlanItem {
  canonicalGrantKey: string;
  memberGrantKey: string;
  score: number;
  confirmed: boolean;
}

export interface DedupLinkPublishPlan {
  candidateCount: number;
  linkCount: number;
  skippedCount: number;
  links: DedupLinkPlanItem[];
}

export interface DedupLinkPublishResult extends DedupLinkPublishPlan {
  publishedAt: string;
  resolvedLinkCount: number;
  unresolvedKeys: string[];
}

export interface DedupLinksForPublicationPlan extends DedupLinkPublishPlan {
  publishedEntryCount: number;
  poolEntryCount: number;
  scopedCandidateCount: number;
}

export function planDedupLinksForPublication<TPayload>(
  publishedEntries: Array<NormalizedGrant<TPayload>>,
  candidatePool: Array<NormalizedGrant<TPayload>>,
  options: FindGrantDedupCandidatesOptions = {},
): DedupLinksForPublicationPlan {
  const publishedKeys = new Set(publishedEntries.map((entry) => grantDedupKey(entry.grant)));
  const entryByKey = new Map<string, NormalizedGrant<TPayload>>();

  for (const entry of [...candidatePool, ...publishedEntries]) {
    entryByKey.set(grantDedupKey(entry.grant), entry);
  }

  const candidates = findGrantDedupCandidates([...entryByKey.values()], options)
    .filter((candidate) =>
      publishedKeys.has(candidate.canonicalGrantKey) || publishedKeys.has(candidate.memberGrantKey)
    );
  const plan = planDedupLinkPublication(candidates);

  return {
    ...plan,
    publishedEntryCount: publishedEntries.length,
    poolEntryCount: candidatePool.length,
    scopedCandidateCount: candidates.length,
  };
}

export function planDedupLinkPublication(candidates: GrantDedupCandidate[]): DedupLinkPublishPlan {
  const links = new Map<string, DedupLinkPlanItem>();
  let skippedCount = 0;

  for (const candidate of candidates) {
    if (candidate.canonicalGrantKey === candidate.memberGrantKey) {
      skippedCount += 1;
      continue;
    }
    const [leftKey, rightKey] = sortPair(candidate.canonicalGrantKey, candidate.memberGrantKey);
    const key = `${leftKey}\u0000${rightKey}`;
    const current = links.get(key);
    if (!current || candidate.score > current.score) {
      links.set(key, {
        canonicalGrantKey: candidate.canonicalGrantKey,
        memberGrantKey: candidate.memberGrantKey,
        score: candidate.score,
        confirmed: current?.confirmed === true || candidate.decision === "auto_duplicate",
      });
    } else {
      if (candidate.decision === "auto_duplicate" && !current.confirmed) current.confirmed = true;
      skippedCount += 1;
    }
  }

  return {
    candidateCount: candidates.length,
    linkCount: links.size,
    skippedCount,
    links: [...links.values()].sort((left, right) =>
      right.score - left.score ||
      left.canonicalGrantKey.localeCompare(right.canonicalGrantKey) ||
      left.memberGrantKey.localeCompare(right.memberGrantKey)
    ),
  };
}

export async function publishDedupLinks(
  db: CunoteDb,
  candidates: GrantDedupCandidate[],
): Promise<DedupLinkPublishResult> {
  const plan = planDedupLinkPublication(candidates);
  const unresolvedKeys = new Set<string>();
  let resolvedLinkCount = 0;

  await db.transaction(async (tx) => {
    for (const link of plan.links) {
      const session = tx as unknown as CunoteDbSession;
      const canonicalGrantId = await resolveGrantRowId(session, link.canonicalGrantKey);
      const memberGrantId = await resolveGrantRowId(session, link.memberGrantKey);
      if (!canonicalGrantId || !memberGrantId) {
        if (!canonicalGrantId) unresolvedKeys.add(link.canonicalGrantKey);
        if (!memberGrantId) unresolvedKeys.add(link.memberGrantKey);
        continue;
      }

      await tx
        .insert(schema.dedupLinks)
        .values({
          canonicalGrantId,
          memberGrantId,
          score: link.score,
          confirmed: link.confirmed,
        })
        .onConflictDoUpdate({
          target: [schema.dedupLinks.canonicalGrantId, schema.dedupLinks.memberGrantId],
          set: {
            score: link.score,
            confirmed: sql`${schema.dedupLinks.confirmed} OR ${link.confirmed}`,
          },
        });
      resolvedLinkCount += 1;
    }
  });

  return {
    ...plan,
    publishedAt: new Date().toISOString(),
    resolvedLinkCount,
    unresolvedKeys: [...unresolvedKeys].sort(),
  };
}

async function resolveGrantRowId(db: Pick<CunoteDbSession, "select">, grantKey: string): Promise<string | null> {
  const parsed = parseGrantKey(grantKey);
  const [row] = await db
    .select({ id: schema.grants.id })
    .from(schema.grants)
    .where(parsed
      ? and(eq(schema.grants.source, parsed.source), eq(schema.grants.sourceId, parsed.sourceId))
      : eq(schema.grants.id, grantKey))
    .limit(1);
  return row?.id ?? null;
}

function parseGrantKey(value: string): { source: "kstartup" | "bizinfo" | "bizinfo_event"; sourceId: string } | null {
  const [source, ...rest] = value.split(":");
  const sourceId = rest.join(":");
  if (!sourceId) return null;
  if (source === "kstartup" || source === "bizinfo" || source === "bizinfo_event") {
    return { source, sourceId };
  }
  return null;
}

function sortPair(left: string, right: string): [string, string] {
  return left.localeCompare(right) <= 0 ? [left, right] : [right, left];
}
