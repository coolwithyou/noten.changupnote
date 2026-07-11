/**
 * NICE BizAPI(OpenGate) 커넥터 라이브 스모크 + 하네스 상태 전이 확인.
 *
 * 실행: pnpm exec tsx --tsconfig apps/web/tsconfig.json scripts/verify-nice-connectors.ts \
 *          [법인사업자번호] [개인사업자번호]
 * 기본값: 삼성전자(1248100998, corporation) + 임의 개인사업자번호.
 *
 * .env(.local)에 NICE_BIZ_CLIENT_APP_KEY / NICE_BIZ_CLIENT_SECRET 가 있으면 실호출한다
 * (runExternalConnectors 내부 loadMonorepoEnv 가 로드). 키가 없으면 pending("키 없음").
 * dev 서버는 띄우지 않는다(사용자 소유). companyKey=사업자번호(법인등록번호 브리지 불필요).
 *
 * 기대: 법인 → revenue·financial_health.* = LIVE(nice, 삼성 실값), credit/tax 결격 = LIVE "해당없음",
 *       bond_default·bankruptcy_filed = PENDING. 개인 → NICE 미실행(pending/n-a).
 */
import type { CompanyProfile } from "@cunote/contracts";
import { buildFieldCoverage, runExternalConnectors } from "../apps/web/src/lib/server/devServiceDataMonitor";

const corpBizNo = (process.argv[2] ?? "1248100998").replace(/\D/g, "");
const personalBizNo = (process.argv[3] ?? "2148633211").replace(/\D/g, "");

const WATCH_KEYS = [
  "revenue",
  "financial_health.debt_ratio_pct",
  "financial_health.impairment",
  "financial_health.total_assets_krw",
  "financial_health.equity_krw",
  "credit_status.credit_delinquency",
  "credit_status.financial_misconduct",
  "tax_compliance.national_tax_delinquent",
  "credit_status.rehabilitation_in_progress",
  "credit_status.bond_default",
  "credit_status.bankruptcy_filed",
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
    const badge = row.status.toUpperCase().padEnd(8);
    const val = row.value ?? row.note ?? "—";
    const src = row.source ? ` [${row.source}]` : "";
    console.log(`  ${key.padEnd(44)} ${badge} ${val}${src}`);
  }
}

// 법인: 팝빌 경로(법인등록번호 브리지 없음) → FSC 기업재무는 skip, NICE OCOV06 가 재무를 채운다.
await runCase("법인 · NICE OpenGate", "corporation", corpBizNo, { name: "스모크 법인" });

// 개인사업자: NICE 재무/신용은 법인 기준(corpOnly) → 미실행(pending/n-a 유지).
await runCase("개인사업자 · NICE 미실행", "individual", personalBizNo, { name: "스모크 개인" });

console.log("\n[verify-nice-connectors] done.");
