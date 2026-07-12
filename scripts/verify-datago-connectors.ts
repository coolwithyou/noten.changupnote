/**
 * data.go.kr 신규 커넥터(kcomwel·금융위 기업/개인재무) 라이브 스모크 + 하네스 상태 전이 확인.
 *
 * 실행: pnpm exec tsx --tsconfig apps/web/tsconfig.json scripts/verify-datago-connectors.ts \
 *          [법인사업자번호] [법인등록번호] [개인사업자번호]
 * 기본값: 삼성전자(1248100998 / 1301110006246) + 임의 개인사업자번호.
 *
 * .env(.local)에 CUNOTE_KCOMWEL_SERVICE_KEY / CUNOTE_FSC_FINANCE_SERVICE_KEY 가 있으면 실호출.
 * 키가 없으면 해당 필드는 pending("키 없음")으로 나온다. dev 서버는 띄우지 않는다(사용자 소유).
 */
import type { CompanyProfile } from "@cunote/contracts";
import { buildFieldCoverage, runExternalConnectors } from "../apps/web/src/lib/server/devServiceDataMonitor";
import { loadMonorepoEnv } from "../apps/web/src/lib/server/loadMonorepoEnv";

loadMonorepoEnv();

const PREFLIGHT_KEYS = [
  "CUNOTE_DATA_GO_KR_SERVICE_KEY",
  "CUNOTE_KCOMWEL_SERVICE_KEY",
  "CUNOTE_FSC_FINANCE_SERVICE_KEY",
] as const;

console.log("[masked env preflight]");
for (const key of PREFLIGHT_KEYS) {
  console.log(`  ${key}: ${process.env[key]?.trim() ? "configured" : "missing"}`);
}

const corpBizNo = (process.argv[2] ?? "1248100998").replace(/\D/g, "");
const corpRegNo = (process.argv[3] ?? "1301110006246").replace(/\D/g, "");
const personalBizNo = (process.argv[4] ?? "2148633211").replace(/\D/g, "");

const WATCH_KEYS = [
  "employees",
  "insured_workforce.employment_insurance_active",
  "revenue",
  "financial_health.debt_ratio_pct",
  "financial_health.impairment",
  "financial_health.total_assets_krw",
  "financial_health.equity_krw",
];

async function runCase(
  title: string,
  subject: "corporation" | "individual",
  bizNo: string,
  profile: CompanyProfile | null,
) {
  console.log(`\n===== ${title} (subject=${subject}, bizNo=${bizNo}) =====`);
  const connectorResults = await runExternalConnectors({ bizNo, subject, profile });
  const coverage = buildFieldCoverage({
    subject,
    profile,
    fields: [],
    originBySource: new Map(),
    connectorResults,
  });
  const byKey = new Map(coverage.map((row) => [row.key, row]));
  for (const key of WATCH_KEYS) {
    const row = byKey.get(key);
    if (!row) continue;
    const badge = `${row.status}/${row.connectorOutcome ?? "none"}`.toUpperCase().padEnd(22);
    const val = row.value ?? row.note ?? "—";
    const src = row.source ? ` [${row.source}]` : "";
    const asOf = row.asOf ? ` asOf=${row.asOf}` : "";
    console.log(`  ${key.padEnd(46)} ${badge} ${val}${src}${asOf}`);
  }
}

// 법인: apick 상세가 실어 준 법인등록번호를 프로필에 넣어 crno 브리지를 재현한다.
const corpProfile: CompanyProfile = {
  name: "스모크 법인",
  other_conditions: { apick_corporate_registration_no: corpRegNo },
};
await runCase("법인 · 법인번호 브리지 있음(apick 경로)", "corporation", corpBizNo, corpProfile);

// 법인: 법인등록번호 없음(팝빌 경로) → 재무 필드는 pending(skip) 유지.
await runCase("법인 · 법인번호 없음(팝빌 경로)", "corporation", corpBizNo, { name: "스모크 법인(번호없음)" });

// 개인사업자: 개인재무는 익명 집계셋 → revenue 는 schemaMismatch(failed).
await runCase("개인사업자", "individual", personalBizNo, { name: "스모크 개인" });

console.log("\n[verify-datago-connectors] done.");
