// K-Startup raw `rcrt_prgs_yn=N` 상태만 보수적으로 closed로 교정한다.
// 기본은 dry-run이며 criteria/raw/match-state는 건드리지 않는다.
//
// dry-run:
//   pnpm backfill:kstartup-recruitment-status
// write:
//   pnpm backfill:kstartup-recruitment-status -- --write --confirm=CLOSE_KSTARTUP_RECRUITMENT_ENDED
import { and, eq, inArray } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { isKStartupRecruitmentClosedPayload } from "../repositories/activeGrantFilter";
import * as schema from "../db/schema";

const CONFIRMATION = "CLOSE_KSTARTUP_RECRUITMENT_ENDED";

loadMonorepoEnv();

const write = process.argv.includes("--write");
const confirmation = readArg("confirm");
if (write && confirmation !== CONFIRMATION) {
  throw new Error(`--write requires --confirm=${CONFIRMATION}`);
}

const db = getCunoteDb();
try {
  const rows = await db
    .select({
      id: schema.grants.id,
      sourceId: schema.grants.sourceId,
      title: schema.grants.title,
      status: schema.grants.status,
      payload: schema.grantRaw.payload,
    })
    .from(schema.grants)
    .innerJoin(
      schema.grantRaw,
      and(
        eq(schema.grantRaw.source, schema.grants.source),
        eq(schema.grantRaw.sourceId, schema.grants.sourceId),
      ),
    )
    .where(and(
      eq(schema.grants.source, "kstartup"),
      inArray(schema.grants.status, ["open", "upcoming", "unknown"]),
    ));

  const candidates = rows.filter((row) => isKStartupRecruitmentClosedPayload("kstartup", row.payload));
  let updatedCount = 0;
  if (write && candidates.length > 0) {
    const candidateIds = candidates.map((row) => row.id);
    const updated = await db
      .update(schema.grants)
      .set({ status: "closed", updatedAt: new Date() })
      .where(and(
        inArray(schema.grants.id, candidateIds),
        inArray(schema.grants.status, ["open", "upcoming", "unknown"]),
      ))
      .returning({ id: schema.grants.id });
    updatedCount = updated.length;
    if (updatedCount !== candidateIds.length) {
      throw new Error(`optimistic status guard failed: planned=${candidateIds.length}, updated=${updatedCount}`);
    }
  }

  console.log(JSON.stringify({
    dryRun: !write,
    scannedActiveStatusCount: rows.length,
    candidateCount: candidates.length,
    updatedCount,
    byStoredStatus: histogram(candidates.map((row) => row.status)),
    sample: candidates.slice(0, 20).map((row) => ({
      sourceId: row.sourceId,
      title: row.title,
      storedStatus: row.status,
      nextStatus: "closed",
    })),
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
