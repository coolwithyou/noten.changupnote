import { loadMonorepoEnv } from "../apps/web/src/lib/server/loadMonorepoEnv.js";
import { resolveDartCompanyBridge } from "../apps/web/src/lib/server/dartCompanyBridge.js";
import { resolveLatestDartOverlay } from "../apps/web/src/lib/server/dartOverlay.js";
import { runExternalConnectors } from "../apps/web/src/lib/server/devServiceDataMonitor.js";
import { getServiceRepositories } from "../apps/web/src/lib/server/serviceData.js";

loadMonorepoEnv();
const apiKey = process.env.OPENDART_API_KEY?.trim();
console.log(`OPENDART_API_KEY: ${apiKey ? "configured" : "missing"}`);
if (apiKey) {
  const bizNo = (process.argv[2] ?? "1248100998").replace(/\D/g, "");
  const companyName = process.argv[3] ?? "삼성전자";
  const lookup = await resolveDartCompanyBridge({
    apiKey,
    bizNo,
    companyName,
    cache: getServiceRepositories().enrichmentCache,
  });
  console.log(JSON.stringify(lookup, null, 2));
  if (lookup.state === "covered" && lookup.bridge) {
    const overlay = await resolveLatestDartOverlay({
      apiKey,
      bizNo,
      bridge: lookup.bridge,
      cache: getServiceRepositories().enrichmentCache,
    });
    console.log(JSON.stringify({
      businessYear: overlay.businessYear,
      reportCode: overlay.reportCode,
      origin: overlay.origin,
      employee: overlay.employee,
      employeeError: overlay.employeeError,
      financials: overlay.financials,
      financialError: overlay.financialError,
    }, null, 2));
    if (process.argv.includes("--connectors")) {
      const connectors = await runExternalConnectors({
        bizNo,
        subject: "corporation",
        profile: { name: lookup.bridge.corpName },
      });
      console.log(JSON.stringify(Object.fromEntries(
        [...connectors].filter(([key]) => key === "employees" || key === "revenue" || key.startsWith("financial_health.")),
      ), null, 2));
    }
  }
}
