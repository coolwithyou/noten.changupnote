import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const checks: Array<{
  file: string;
  patterns: string[];
}> = [
  {
    file: "apps/web/src/lib/server/db/client.ts",
    patterns: ["withCunoteDbUser", "set_config('app.current_user_id'"],
  },
  {
    file: "apps/web/src/lib/server/repositories/drizzle.ts",
    patterns: ["withCunoteDbUser", "transactionWithOptionalUser", "input.userId"],
  },
  {
    file: "apps/web/src/lib/server/auth/appRefreshTokenStore.ts",
    patterns: ["withCunoteDbUser", "findActiveByHash(tokenHash: string, userId?: string)"],
  },
  {
    file: "apps/web/src/lib/server/appApi/preferencesStore.ts",
    patterns: ["withCunoteDbUser"],
  },
  {
    file: "apps/web/src/lib/server/consents/consentStore.ts",
    patterns: ["withCunoteDbUser"],
  },
  {
    file: "apps/web/src/lib/server/serviceData.ts",
    patterns: ["userId?: string", "saveMatchState", "userId: input.userId"],
  },
  {
    file: "apps/web/src/app/api/web/dashboard/route.ts",
    patterns: ["userId: access.userId"],
  },
  {
    file: "apps/web/src/app/api/app/v1/companies/[companyId]/matches/route.ts",
    patterns: ["userId: access.userId"],
  },
];

const errors: string[] = [];

for (const check of checks) {
  const source = readFileSync(resolve(process.cwd(), check.file), "utf8");
  for (const pattern of check.patterns) {
    if (!source.includes(pattern)) errors.push(`${check.file} is missing ${pattern}`);
  }
}

if (errors.length > 0) {
  console.error("RLS context verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("RLS context verification passed.");
