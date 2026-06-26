import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { appV1OpenApi, appV1OpenApiRoutePaths } from "../src/openapi.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head"] as const;

const workspaceRoot = process.cwd();
const appRouteRoot = resolve(workspaceRoot, "apps/web/src/app");
const appV1RouteRoot = resolve(appRouteRoot, "api/app/v1");

if (!existsSync(appV1RouteRoot)) {
  console.error(`Missing app v1 route root: ${appV1RouteRoot}`);
  process.exit(1);
}

const openApiPathItems: Record<string, unknown> = appV1OpenApi.paths;
const filesystemPaths = discoverRoutePaths(appV1RouteRoot);
const openApiPaths = Object.keys(openApiPathItems).sort();
const contractPaths = [...appV1OpenApiRoutePaths].sort();
const errors: string[] = [];

compareSets("filesystem route", filesystemPaths, "OpenAPI path", openApiPaths, errors);
compareSets("contract path list", contractPaths, "OpenAPI path", openApiPaths, errors);

for (const [routePath, pathItemValue] of Object.entries(openApiPathItems)) {
  if (!isRecord(pathItemValue)) {
    errors.push(`${routePath} path item must be an object.`);
    continue;
  }

  let operationCount = 0;
  for (const method of HTTP_METHODS) {
    const operationValue = pathItemValue[method];
    if (!operationValue) continue;
    operationCount += 1;

    if (!isRecord(operationValue)) {
      errors.push(`${method.toUpperCase()} ${routePath} operation must be an object.`);
      continue;
    }

    if (!isNonEmptyString(operationValue.operationId)) {
      errors.push(`${method.toUpperCase()} ${routePath} is missing operationId.`);
    }
    if (!isRecord(operationValue.responses) || Object.keys(operationValue.responses).length === 0) {
      errors.push(`${method.toUpperCase()} ${routePath} is missing responses.`);
    }
  }

  if (operationCount === 0) {
    errors.push(`${routePath} has no HTTP operations.`);
  }
}

verifyServiceDtoSchemas(errors);

if (errors.length > 0) {
  console.error("OpenAPI contract verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`OpenAPI contract verification passed (${openApiPaths.length} paths).`);

function discoverRoutePaths(root: string): string[] {
  return walkRouteFiles(root)
    .map((routeFile) => {
      const routeDir = dirname(routeFile);
      const relativeRouteDir = relative(appRouteRoot, routeDir);
      const segments = relativeRouteDir.split(sep).filter(Boolean).map(convertSegment);
      return `/${segments.join("/")}`;
    })
    .sort();
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

function convertSegment(segment: string): string {
  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll?.[1]) return `{${catchAll[1]}}`;

  const dynamic = segment.match(/^\[(.+)\]$/);
  if (dynamic?.[1]) return `{${dynamic[1]}}`;

  return segment;
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
    if (!right.has(value)) errors.push(`${leftLabel} ${value} is missing from ${rightLabel}s.`);
  }

  for (const value of rightValues) {
    if (!left.has(value)) errors.push(`${rightLabel} ${value} is missing from ${leftLabel}s.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function verifyServiceDtoSchemas(errors: string[]) {
  const schemas = appV1OpenApi.components?.schemas;
  if (!isRecord(schemas)) {
    errors.push("OpenAPI components.schemas must be an object.");
    return;
  }

  const matchCard = schemas.MatchCard;
  if (!isRecord(matchCard) || !isRecord(matchCard.properties)) {
    errors.push("MatchCard schema is missing properties.");
    return;
  }

  const fitScore = matchCard.properties.fitScore;
  if (!isRecord(fitScore) || fitScore.minimum !== 0 || fitScore.maximum !== 100) {
    errors.push("MatchCard.fitScore must be documented as a 0..100 score.");
  }

  if (nullableStringFormat(matchCard.properties.applyEnd) !== "date") {
    errors.push("MatchCard.applyEnd must use nullable date format.");
  }

  const applySchedule = schemas.ApplySchedule;
  if (!isRecord(applySchedule) || !isRecord(applySchedule.properties)) {
    errors.push("ApplySchedule schema is missing properties.");
    return;
  }
  if (nullableStringFormat(applySchedule.properties.applyStart) !== "date") {
    errors.push("ApplySchedule.applyStart must use nullable date format.");
  }
  if (nullableStringFormat(applySchedule.properties.applyEnd) !== "date") {
    errors.push("ApplySchedule.applyEnd must use nullable date format.");
  }

  const notificationSettings = schemas.NotificationSettings;
  if (!isRecord(notificationSettings) || !isRecord(notificationSettings.properties)) {
    errors.push("NotificationSettings schema is missing properties.");
    return;
  }
  if (!Array.isArray(notificationSettings.required) ||
    !notificationSettings.required.includes("deadlineReminder") ||
    !notificationSettings.required.includes("newMatch")) {
    errors.push("NotificationSettings must require deadlineReminder and newMatch.");
  }
  if (propertyType(notificationSettings.properties.deadlineReminder) !== "boolean") {
    errors.push("NotificationSettings.deadlineReminder must be boolean.");
  }
  if (propertyType(notificationSettings.properties.newMatch) !== "boolean") {
    errors.push("NotificationSettings.newMatch must be boolean.");
  }
}

function nullableStringFormat(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const variants = Array.isArray(value.anyOf) ? value.anyOf : [];
  const stringVariant = variants.find((variant) => isRecord(variant) && variant.type === "string");
  return isRecord(stringVariant) && typeof stringVariant.format === "string"
    ? stringVariant.format
    : null;
}

function propertyType(value: unknown): string | null {
  return isRecord(value) && typeof value.type === "string" ? value.type : null;
}
