// 읽기 전용. 모델·lease·승격·문서 생성 함수는 호출하지 않는다.
export {};
const args = process.argv.slice(2);
const source = args[0];
if (args.length !== 1 || (source !== "--source=runtime" && source !== "--source=database")) {
  throw new Error("사용법: pnpm report:product-readiness --source=runtime|--source=database (DB는 환경 구성을 별도로 주입)");
}
process.env.CUNOTE_REPOSITORY_ADAPTER = source === "--source=database" ? "drizzle" : "runtime";
const { getServiceRepositories } = await import("../serviceData");
const { loadProductReadinessReport } = await import("./report");
const { productExposureEnabled, loadProductExposureSummary } = await import("./exposure");
try {
  const report = await loadProductReadinessReport({
  asOf: new Date(), repository: getServiceRepositories().grants,
  source: source === "--source=database" ? "database" : "runtime_fixture",
  });
  const promotionToExposureLatency = source === "--source=database" && productExposureEnabled()
    ? await loadProductExposureSummary() : report.promotionToExposureLatency;
  console.log(JSON.stringify({ ...report, promotionToExposureLatency }, null, 2));
} finally {
  if (source === "--source=database") {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  }
}
