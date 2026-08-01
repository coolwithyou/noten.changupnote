import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { listVirtualCompanyScenarios } from "./catalog";
import { verifyVirtualCompanyMatrix } from "./verifyVirtualCompanyMatrix";

loadMonorepoEnv();
process.env.CUNOTE_REPOSITORY_ADAPTER = "drizzle";

async function main(): Promise<number> {
  const asOf = new Date();
  if (Number.isNaN(asOf.getTime())) throw new Error("검증 기준 시각을 만들 수 없습니다.");
  const [{ loadServiceGrantUniverse }, { closeCunoteDb }] = await Promise.all([
    import("@/lib/server/serviceData"),
    import("@/lib/server/db/client"),
  ]);
  try {
    const grants = await loadServiceGrantUniverse({ asOf });
    const report = verifyVirtualCompanyMatrix({
      grants,
      scenarios: listVirtualCompanyScenarios({ asOf }),
      asOf,
    });
    console.log(JSON.stringify(report, null, 2));
    return report.status === "pass" ? 0 : 1;
  } finally {
    await closeCunoteDb();
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.error(JSON.stringify({
      status: "infrastructure_error",
      message: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exitCode = 1;
  });
