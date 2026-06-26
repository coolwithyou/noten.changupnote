import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  PUBLIC_APP_ROUTES,
  PUBLIC_WEB_ROUTES,
  SESSION_APP_ROUTES,
  SESSION_WEB_ROUTES,
} from "../../../apps/web/src/lib/server/auth/routePolicy.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;
const METHOD_PATTERN = new RegExp(
  `export\\s+(?:async\\s+)?function\\s+(${HTTP_METHODS.join("|")})\\b`,
  "g",
);

const workspaceRoot = process.cwd();
const appRouteRoot = resolve(workspaceRoot, "apps/web/src/app");
const apiScopes = [
  resolve(appRouteRoot, "api/web"),
  resolve(appRouteRoot, "api/app/v1"),
] as const;

const policyRoutes = [
  ...PUBLIC_WEB_ROUTES,
  ...SESSION_WEB_ROUTES,
  ...PUBLIC_APP_ROUTES,
  ...SESSION_APP_ROUTES,
].filter((route) => route.includes(" /api/"));
const publicRoutes = new Set<string>([...PUBLIC_WEB_ROUTES, ...PUBLIC_APP_ROUTES]);
const sessionRoutes = new Set<string>([...SESSION_WEB_ROUTES, ...SESSION_APP_ROUTES]);
const actualRoutes = apiScopes.flatMap(discoverApiRouteMethods).sort();
const errors: string[] = [];

compareSets("API route file", actualRoutes, "route policy", [...policyRoutes].sort(), errors);

for (const route of policyRoutes) {
  if (publicRoutes.has(route) && sessionRoutes.has(route)) {
    errors.push(`${route} is listed as both public and session-protected.`);
  }
}

if (errors.length > 0) {
  console.error("Route policy verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Route policy verification passed (${actualRoutes.length} API methods).`);

function discoverApiRouteMethods(root: string): string[] {
  if (!existsSync(root)) return [];
  return walkRouteFiles(root).flatMap((routeFile) => {
    const routePath = routePathFromFile(routeFile);
    return exportedMethods(routeFile).map((method) => `${method} ${routePath}`);
  });
}

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

function routePathFromFile(routeFile: string): string {
  const routeDir = dirname(routeFile);
  const relativeRouteDir = relative(appRouteRoot, routeDir);
  return `/${relativeRouteDir.split(sep).filter(Boolean).join("/")}`;
}

function exportedMethods(routeFile: string): string[] {
  const source = readFileSync(routeFile, "utf8");
  const methods = new Set<string>();
  for (const match of source.matchAll(METHOD_PATTERN)) {
    if (match[1]) methods.add(match[1]);
  }
  return [...methods].sort();
}

function compareSets(
  leftLabel: string,
  leftValues: string[],
  rightLabel: string,
  rightValues: string[],
  errors: string[],
) {
  const left = new Set(leftValues);
  const right = new Set(rightValues);

  for (const value of leftValues) {
    if (!right.has(value)) errors.push(`${leftLabel} ${value} is missing from ${rightLabel}.`);
  }

  for (const value of rightValues) {
    if (!left.has(value)) errors.push(`${rightLabel} ${value} is missing from ${leftLabel}s.`);
  }
}
