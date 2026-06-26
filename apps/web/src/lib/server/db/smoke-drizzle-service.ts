import assert from "node:assert/strict";
import { closeCunoteDb } from "./client";
import { mockUserId } from "../auth/mockIdentity";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

const DEFAULT_DEMO_COMPANY_ID = "00000000-0000-4000-8000-000000000101";

loadMonorepoEnv();

const dryRun = process.argv.includes("--dry-run");
const companyId = readArg("companyId") ?? process.env.CUNOTE_DEMO_COMPANY_ID ?? DEFAULT_DEMO_COMPANY_ID;
const userId = readArg("userId") ?? mockUserId();

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    adapter: "drizzle",
    userId,
    companyId,
    prerequisites: [
      "pnpm db:migrate",
      "pnpm seed:demo",
      "pnpm publish:kstartup -- --source=sample",
      "pnpm publish:bizinfo -- --source=sample",
    ],
  }, null, 2));
} else {
  process.env.CUNOTE_REPOSITORY_ADAPTER = "drizzle";
  try {
    const { loadServiceApplySheet, loadServiceDashboard } = await import("../serviceData");
    const dashboard = await loadServiceDashboard({ companyId, userId, limit: 10 });
    assert.ok(dashboard.matches.length > 0, "DB-backed dashboard should return match cards");
    assert.ok(
      dashboard.counts.eligible + dashboard.counts.conditional + dashboard.counts.ineligible > 0,
      "DB-backed dashboard should return non-empty counts",
    );

    const firstMatch = dashboard.matches[0];
    assert.ok(firstMatch?.grantId, "DB-backed dashboard should expose match ids");
    const sheet = await loadServiceApplySheet(encodeURIComponent(firstMatch.grantId), { companyId, userId });
    assert.ok(sheet, "DB-backed apply sheet should resolve first match");
    assert.equal(sheet.grant.id, firstMatch.grantId, "apply sheet id should match selected grant");

    console.log(JSON.stringify({
      dryRun: false,
      adapter: "drizzle",
      userId,
      companyId,
      counts: dashboard.counts,
      firstMatch: {
        id: firstMatch.grantId,
        title: firstMatch.title,
        eligibility: firstMatch.eligibility,
        fitScore: firstMatch.fitScore,
      },
      applySheet: {
        id: sheet.grant.id,
        satisfied: sheet.satisfied.length,
        needsCheck: sheet.needsCheck.length,
        documents: sheet.documents.length,
      },
    }, null, 2));
  } finally {
    await closeCunoteDb();
  }
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
