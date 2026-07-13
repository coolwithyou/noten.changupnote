// 교차 소스 dedup 링크 발행 코어. 활성 공고를 읽어 dedup 후보를 계획하고, dry-run 이 아니면 링크를 발행한다.
//
// 이 모듈은 순수 코어다: argv/env 파싱과 loadMonorepoEnv, db 생성은 호출부(CLI · API 라우트)의 책임이며,
// 여기서는 process.env 가 이미 주입돼 있다고 가정한다.
// CLI 는 publish-dedup.ts, 서버 라우트는 /api/cron/grant-cycle-post 가 이 함수를 호출한다.
import {
  findGrantDedupCandidates,
  type FindGrantDedupCandidatesOptions,
  type GrantDedupCandidate,
} from "@cunote/core";
import type { CunoteDb } from "../db/client";
import { createDrizzleRepositories } from "../repositories/drizzle";
import {
  planDedupLinkPublication,
  publishDedupLinks,
} from "./dedupLinkPublisher";

export interface RunDedupPublishInput {
  db: CunoteDb;
  dryRun: boolean;
  limit: number;
  minScore: number | undefined;
  asOf: Date;
  pairKeys?: DedupPairKey[];
}

export interface DedupPairKey {
  canonicalGrantKey: string;
  memberGrantKey: string;
}

export async function runDedupPublish(input: RunDedupPublishInput): Promise<Record<string, unknown>> {
  const options = dedupOptions(input.minScore);
  const repositories = createDrizzleRepositories<unknown>({
    dialect: "drizzle",
    client: input.db,
  });
  const entries = await repositories.grants.listActiveGrants({
    limit: input.limit,
    asOf: input.asOf,
    includeConfirmedDuplicates: true,
  });
  const allCandidates = findGrantDedupCandidates(entries, options);
  const candidates = scopeDedupCandidates(allCandidates, input.pairKeys ?? []);

  if (input.dryRun) {
    const plan = planDedupLinkPublication(candidates);
    return {
      dryRun: true,
      asOf: input.asOf.toISOString(),
      activeGrantCount: entries.length,
      minScore: options.minScore ?? null,
      requestedPairs: input.pairKeys ?? [],
      unscopedCandidateCount: allCandidates.length,
      ...plan,
    };
  }

  const result = await publishDedupLinks(input.db, candidates);
  return {
    dryRun: false,
    asOf: input.asOf.toISOString(),
    activeGrantCount: entries.length,
    minScore: options.minScore ?? null,
    requestedPairs: input.pairKeys ?? [],
    unscopedCandidateCount: allCandidates.length,
    ...result,
  };
}

export function scopeDedupCandidates(
  candidates: GrantDedupCandidate[],
  pairs: DedupPairKey[],
): GrantDedupCandidate[] {
  if (pairs.length === 0) return candidates;
  const requested = new Set(pairs.map((pair) => unorderedPairKey(pair.canonicalGrantKey, pair.memberGrantKey)));
  if (requested.size !== pairs.length) throw new Error("dedup pair scope contains duplicates");
  const scoped = candidates.filter((candidate) => requested.has(unorderedPairKey(
    candidate.canonicalGrantKey,
    candidate.memberGrantKey,
  )));
  const found = new Set(scoped.map((candidate) => unorderedPairKey(
    candidate.canonicalGrantKey,
    candidate.memberGrantKey,
  )));
  const missing = [...requested].filter((pair) => !found.has(pair));
  if (missing.length > 0) throw new Error(`dedup pair scope no longer matches current candidates: ${missing.join(",")}`);
  return scoped;
}

function unorderedPairKey(left: string, right: string): string {
  return [left, right].sort().join("\u0000");
}

function dedupOptions(minScore: number | undefined): FindGrantDedupCandidatesOptions {
  const options: FindGrantDedupCandidatesOptions = {};
  if (minScore !== undefined) options.minScore = minScore;
  return options;
}
