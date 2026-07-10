/**
 * 팝빌 미터링 코드 경로 검증(6.5). DrizzleCreditSystemRepository.recordFreeUsageEvent 가
 * usage_events 에 creditsCharged=0/status=free 로 적재하고, pepper HMAC bizNoRef 가
 * 무염 SHA-256 과 다른(가명 키) 것을 확인한다.
 *
 * 실행(일회용 테스트 DB): DATABASE_URL=... pnpm exec tsx --tsconfig apps/web/tsconfig.json \
 *   apps/web/src/lib/server/repositories/verify-popbill-metering.ts
 */
import { createHash, createHmac } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { DrizzleCreditSystemRepository } from "./creditRepository";

const url = process.env.DATABASE_URL ?? "";
if (!url) { console.error("DATABASE_URL required"); process.exit(1); }
if (url.includes("pooler.supabase.com")) { console.error("ABORT: pooler host"); process.exit(1); }

const client = postgres(url, { prepare: false, max: 2 });
const db = drizzle(client, { schema });
const sysrepo = new DrizzleCreditSystemRepository({ client: db });

const bizNo = "1234567890";
const pepper = "test-pepper-secret";
const bizNoRef = createHmac("sha256", pepper).update(bizNo).digest("hex");
const naiveHash = createHash("sha256").update(bizNo).digest("hex");

try {
  const { id } = await sysrepo.recordFreeUsageEvent({
    walletId: null,
    userId: null,
    companyId: null,
    featureCode: "popbill_lookup",
    provider: "popbill",
    contextRef: { bizNoRef },
  });
  const [row] = await client`
    SELECT feature_code, provider, status, credits_charged::int AS charged, context_ref
    FROM usage_events WHERE id = ${id}::uuid`;
  const ok =
    row!.feature_code === "popbill_lookup" &&
    row!.provider === "popbill" &&
    row!.status === "free" &&
    Number(row!.charged) === 0 &&
    (row!.context_ref as { bizNoRef?: string }).bizNoRef === bizNoRef &&
    bizNoRef !== naiveHash;
  console.log(
    JSON.stringify(
      {
        ok,
        row: { feature: row!.feature_code, provider: row!.provider, status: row!.status, charged: Number(row!.charged) },
        hmacDiffersFromNaive: bizNoRef !== naiveHash,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error("FAIL", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
