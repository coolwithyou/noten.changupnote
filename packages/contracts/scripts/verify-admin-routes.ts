import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const workspaceRoot = process.cwd();
const adminRouteRoot = resolve(workspaceRoot, "apps/web/src/app/api/admin");
const errors: string[] = [];

if (existsSync(adminRouteRoot)) {
  for (const routeFile of walkRouteFiles(adminRouteRoot)) {
    const source = readFileSync(routeFile, "utf8");
    if (!source.includes("requireAdminAccess(")) {
      errors.push(`${routePath(routeFile)} does not call requireAdminAccess`);
    }
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
  return `/${relative(resolve(workspaceRoot, "apps/web/src/app"), routeFile)
    .split(sep)
    .filter((segment) => segment !== "route.ts")
    .join("/")}`;
}
