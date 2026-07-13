import { fetchMoefSubsidyAnnouncementPage } from "../../packages/core/src/moef/fetch";
import { loadMonorepoEnv } from "../../apps/web/src/lib/server/loadMonorepoEnv";

loadMonorepoEnv();
const serviceKey = process.env.CUNOTE_DATA_GO_KR_SERVICE_KEY?.trim();
if (!serviceKey) throw new Error("CUNOTE_DATA_GO_KR_SERVICE_KEY is required");
const businessYear = new Date().getFullYear();

try {
  const page = await fetchMoefSubsidyAnnouncementPage({ serviceKey, businessYear, pageNo: 1, numOfRows: 100 });
  console.log(JSON.stringify({
    ok: true,
    writeMode: false,
    businessYear,
    pageNo: page.pageNo,
    totalCount: page.totalCount,
    itemCount: page.items.length,
    fieldCoverage: {
      supportTarget: ratio(page.items.filter((item) => item.supportTarget).length, page.items.length),
      exclusionTarget: ratio(page.items.filter((item) => item.exclusionTarget).length, page.items.length),
      applicationDates: ratio(page.items.filter((item) => item.applicationStartDate && item.applicationEndDate).length, page.items.length),
      announcementUrl: ratio(page.items.filter((item) => item.announcementUrl).length, page.items.length),
      requiredDocuments: ratio(page.items.filter((item) => item.requiredDocuments).length, page.items.length),
    },
    samples: page.items.slice(0, 10).map((item) => ({
      announcementName: item.announcementName,
      jurisdictionName: item.jurisdictionName,
      operatorName: item.operatorName,
      applicationStartDate: item.applicationStartDate,
      applicationEndDate: item.applicationEndDate,
      supportTarget: item.supportTarget,
      exclusionTarget: item.exclusionTarget,
    })),
    nextGate: "기업·mixed audience 비율과 기존 공고 순증률 검수 전에는 ingestion하지 않음",
  }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const approvalRequired = /403 Forbidden|SERVICE KEY IS NOT REGISTERED/i.test(message);
  console.error(JSON.stringify({
    ok: false,
    writeMode: false,
    code: approvalRequired ? "api_utilization_approval_required" : "probe_failed",
    message,
    externalAction: approvalRequired
      ? "공공데이터포털에서 국고보조금 공모사업 상세 API 활용신청을 승인받은 뒤 다시 실행"
      : "응답 상태와 API 명세를 확인",
  }, null, 2));
  process.exitCode = 2;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}
