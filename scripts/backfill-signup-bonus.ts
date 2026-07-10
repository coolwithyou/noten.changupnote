/**
 * 기존 가입 사용자 소급 가입 보너스 지급 스크립트.
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md 15장 P1 / 6.6.
 *
 * ⚠️ 절대 자동 실행하지 말 것. 현재 DATABASE_URL 은 실서비스 공용 DB이며,
 *    지급 시점은 사용자(운영자)가 결정한다. 이 파일은 "작성만" 하고 실행 금지.
 *
 * 멱등: applyLedgerEntry 의 signup:{userId} 키 덕분에 재실행해도 중복 지급이 없다.
 *
 * 실행(사용자가 의도적으로 결정했을 때만) — 웹 모듈 해석 위해 web tsconfig 사용:
 *   pnpm exec tsx --tsconfig apps/web/tsconfig.json scripts/backfill-signup-bonus.ts --confirm
 *   옵션:
 *     --confirm        실제 지급 실행(없으면 dry-run: 대상 수만 집계)
 *     --limit=N        최대 N명만 처리(배치)
 *     --all-users      이메일 미인증 사용자도 포함(기본은 인증 사용자만 — 6.6 lazy grant 정합)
 *
 * 구현 메모: drizzle-orm 은 리포지토리 루트에서 해석되지 않으므로, 후보 조회는
 *   루트에서 해석 가능한 postgres 로 직접 하고, 실제 지급만 web 리포지토리(동적 import)로 위임한다.
 *   web 모듈은 자기 스코프(apps/web/node_modules)에서 자신의 의존성을 해석한다.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

interface Options {
  confirm: boolean;
  limit: number | null;
  onlyVerified: boolean;
}

function parseArgs(argv: string[]): Options {
  const confirm = argv.includes("--confirm");
  const onlyVerified = !argv.includes("--all-users"); // 기본: 인증 사용자만
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const parsed = limitArg ? Number.parseInt(limitArg.split("=")[1] ?? "", 10) : NaN;
  return { confirm, limit: Number.isFinite(parsed) ? parsed : null, onlyVerified };
}

function loadEnvFile(fileName: string) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!k || process.env[k] !== undefined) continue;
    process.env[k] = v.replace(/^['"]|['"]$/g, "");
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  loadEnvFile(".env");
  loadEnvFile(".env.local");
  const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL;
  if (!url) {
    console.error("DATABASE_URL 이 필요합니다.");
    process.exitCode = 1;
    return;
  }
  const sql = postgres(url, { prepare: false, max: 1 });

  try {
    // 후보: 아직 지갑이 없는 사용자(옵션에 따라 이메일 인증자만). signup:{userId} 멱등이라
    // 지갑이 있어도 안전하지만, 대상 축소로 노이즈를 줄인다.
    const rows = opts.onlyVerified
      ? await sql<{ id: string }[]>`
          SELECT u.id FROM users u
          LEFT JOIN credit_wallets w ON w.user_id = u.id
          WHERE u.email_verified IS NOT NULL AND w.id IS NULL
          ${opts.limit ? sql`LIMIT ${opts.limit}` : sql``}
        `
      : await sql<{ id: string }[]>`
          SELECT u.id FROM users u
          LEFT JOIN credit_wallets w ON w.user_id = u.id
          WHERE w.id IS NULL
          ${opts.limit ? sql`LIMIT ${opts.limit}` : sql``}
        `;

    console.log(JSON.stringify({
      mode: opts.confirm ? "EXECUTE" : "DRY_RUN",
      onlyVerified: opts.onlyVerified,
      limit: opts.limit,
      candidates: rows.length,
    }, null, 2));

    if (!opts.confirm) {
      console.log("dry-run: --confirm 없이는 지급하지 않습니다. (실행 금지 원칙)");
      return;
    }

    // 지급은 web 리포지토리(단일 진입점 applyLedgerEntry)로만. 동적 import — web 스코프에서 해석.
    const { getServiceRepositories } = await import("../apps/web/src/lib/server/serviceData");
    const repos = getServiceRepositories();
    let granted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await repos.credits.ensureWalletWithSignupBonus(row.id);
        granted += 1;
      } catch (error) {
        failed += 1;
        console.error(`user ${row.id} 지급 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(JSON.stringify({ ok: true, granted, failed }, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("backfill-signup-bonus failed:", error);
  process.exitCode = 1;
});
