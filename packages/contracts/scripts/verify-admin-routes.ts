import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const workspaceRoot = process.cwd();
const adminRouteRoot = resolve(workspaceRoot, "apps/admin/src/app/api/admin");
const adminStatusRoute = resolve(adminRouteRoot, "status/route.ts");
const removedWebAdminPaths = [
  "apps/web/src/app/(admin)/admin/page.tsx",
  "apps/web/src/app/internal/live-match/page.tsx",
  "apps/web/src/app/api/admin",
  "apps/web/src/app/api/matches/live/route.ts",
] as const;
const expectedAdminSurfaces = [
  "extraction_log",
  "feedback",
  "review_queue",
  "match_events",
  "golden_set",
  "eval_runs",
  "grant_insight_snapshots",
  "grant_attachment_archives",
  "support_tickets",
  "billing_subscriptions",
  "billing_tax_profiles",
  "billing_tax_documents",
  "billing_invoices",
  "billing_payment_methods",
  "billing_webhook_events",
  "legal_readiness",
  "saas_readiness",
  "saas_release_checklist",
  "support_ticket_report",
  "live_match",
];
const errors: string[] = [];

for (const path of removedWebAdminPaths) {
  const absolute = resolve(workspaceRoot, path);
  if (existsSync(absolute)) errors.push(`${path} must be removed from the web app`);
}

if (existsSync(adminRouteRoot)) {
  for (const routeFile of walkRouteFiles(adminRouteRoot)) {
    const source = readFileSync(routeFile, "utf8");
    if (!source.includes("requireAdminSession(")) {
      errors.push(`${routePath(routeFile)} does not call requireAdminSession`);
    }
  }
} else {
  errors.push(`${relative(workspaceRoot, adminRouteRoot)} is missing`);
}

if (existsSync(adminStatusRoute)) {
  const source = readFileSync(adminStatusRoute, "utf8");
  for (const surface of expectedAdminSurfaces) {
    if (!source.includes(`"${surface}"`)) {
      errors.push(`/api/admin/status does not expose ${surface}`);
    }
  }
  if (!source.includes("runtime") || !source.includes("sharedWithWeb: false")) {
    errors.push("/api/admin/status does not expose runtime status");
  }
}

if (errors.length > 0) {
  console.error("Admin route verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Admin route verification passed.");

function walkRouteFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const routeFiles: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      routeFiles.push(...walkRouteFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === "route.ts") routeFiles.push(fullPath);
  }

  return routeFiles;
}

function routePath(routeFile: string): string {
  return `/${relative(resolve(workspaceRoot, "apps/admin/src/app"), routeFile)
    .split(sep)
    .filter((segment) => segment !== "route.ts")
    .join("/")}`;
}
