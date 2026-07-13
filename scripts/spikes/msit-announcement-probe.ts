import { fetchMsitAnnouncementSnapshot, measureMsitIncrementalCoverage } from "../../packages/core/src/index";
import { loadMonorepoEnv } from "../../apps/web/src/lib/server/loadMonorepoEnv";
import { closeCunoteDb, getCunoteDb } from "../../apps/web/src/lib/server/db/client";
import { createDrizzleRepositories } from "../../apps/web/src/lib/server/repositories/drizzle";

loadMonorepoEnv();
const serviceKey = process.env.CUNOTE_DATA_GO_KR_SERVICE_KEY?.trim();
if (!serviceKey) throw new Error("CUNOTE_DATA_GO_KR_SERVICE_KEY is required");
try {
  const snapshot = await fetchMsitAnnouncementSnapshot({ serviceKey, numOfRows: 100, maxPages: 100 });
  const db = getCunoteDb();
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const existingGrants = await repositories.grants.listActiveGrants({ limit: 2_000 });
  const coverage = measureMsitIncrementalCoverage({
    announcements: snapshot.items,
    existingGrants,
    windowDays: 90,
  });
  console.log(JSON.stringify({
    ok: true,
    writeMode: false,
    snapshotComplete: snapshot.complete,
    fetchedPages: snapshot.fetchedPages,
    totalCount: snapshot.totalCount,
    itemCount: snapshot.items.length,
    attachmentCoverage: ratio(snapshot.items.filter((item) => item.fileUrl).length, snapshot.items.length),
    latestPressDate: snapshot.items.map((item) => item.pressDt).sort().at(-1) ?? null,
    oldestPressDate: snapshot.items.map((item) => item.pressDt).sort().at(0) ?? null,
    existingActiveGrantCount: existingGrants.length,
    coverage: {
      asOf: coverage.asOf,
      windowDays: coverage.windowDays,
      windowStart: coverage.windowStart,
      inWindowCount: coverage.inWindowCount,
      exactTitleCount: coverage.exactTitleCount,
      highConfidenceOverlapCount: coverage.highConfidenceOverlapCount,
      reviewRequiredCount: coverage.reviewRequiredCount,
      conservativeIncrementalCount: coverage.conservativeIncrementalCount,
      operationallyUsable: snapshot.complete && coverage.invalidPressDateCount === 0,
    },
    samples: snapshot.items.slice(0, 10).map((item) => ({
      subject: item.subject,
      pressDt: item.pressDt,
      deptName: item.deptName,
      hasAttachment: Boolean(item.fileUrl),
    })),
  }, null, 2));
  await closeCunoteDb();
} catch (error) {
  await closeCunoteDb();
  const message = error instanceof Error ? error.message : String(error);
  const approvalRequired = /403 Forbidden|SERVICE KEY IS NOT REGISTERED/i.test(message);
  console.error(JSON.stringify({
    ok: false,
    writeMode: false,
    code: approvalRequired ? "api_utilization_approval_required" : "probe_failed",
    message,
    externalAction: approvalRequired
      ? "공공데이터포털에서 과학기술정보통신부_사업공고 API 활용신청을 승인받은 뒤 다시 실행"
      : "응답 상태와 API 명세를 확인",
  }, null, 2));
  process.exitCode = 2;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}
