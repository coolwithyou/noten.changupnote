import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { appV1OpenApi, appV1OpenApiRoutePaths } from "../src/openapi.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head"] as const;
const ROUTE_METHOD_PATTERN = /\bexport\s+(?:async\s+)?function\s+(GET|PUT|POST|DELETE|PATCH|OPTIONS|HEAD)\b/g;

const workspaceRoot = process.cwd();
const appRouteRoot = resolve(workspaceRoot, "apps/web/src/app");
const appV1RouteRoot = resolve(appRouteRoot, "api/app/v1");

if (!existsSync(appV1RouteRoot)) {
  console.error(`Missing app v1 route root: ${appV1RouteRoot}`);
  process.exit(1);
}

const openApiPathItems: Record<string, unknown> = appV1OpenApi.paths;
const filesystemRoutes = discoverRouteFiles(appV1RouteRoot);
const filesystemPaths = Object.keys(filesystemRoutes).sort();
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
  const openApiMethods: string[] = [];
  for (const method of HTTP_METHODS) {
    const operationValue = pathItemValue[method];
    if (!operationValue) continue;
    operationCount += 1;
    openApiMethods.push(method);

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
    if (documentsNotImplemented(operationValue) && !filesystemRoutes[routePath]?.source.includes("appNotImplemented(")) {
      errors.push(`${method.toUpperCase()} ${routePath} documents 501 but route does not call appNotImplemented.`);
    }
  }

  if (operationCount === 0) {
    errors.push(`${routePath} has no HTTP operations.`);
  }

  const filesystemRoute = filesystemRoutes[routePath];
  if (filesystemRoute) {
    compareSets(
      `${routePath} filesystem method`,
      filesystemRoute.methods,
      `${routePath} OpenAPI method`,
      openApiMethods.sort(),
      errors,
    );
  }
}

verifyServiceDtoSchemas(errors);

if (errors.length > 0) {
  console.error("OpenAPI contract verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`OpenAPI contract verification passed (${openApiPaths.length} paths).`);

function discoverRouteFiles(root: string): Record<string, { methods: string[]; source: string }> {
  const files: Record<string, { methods: string[]; source: string }> = {};
  for (const routeFile of walkRouteFiles(root)) {
    const source = readFileSync(routeFile, "utf8");
    files[routePathFromFile(routeFile)] = {
      methods: exportedMethods(source),
      source,
    };
  }
  return files;
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

function routePathFromFile(routeFile: string): string {
  const routeDir = dirname(routeFile);
  const relativeRouteDir = relative(appRouteRoot, routeDir);
  const segments = relativeRouteDir.split(sep).filter(Boolean).map(convertSegment);
  return `/${segments.join("/")}`;
}

function exportedMethods(source: string): string[] {
  const methods = new Set<string>();
  for (const match of source.matchAll(ROUTE_METHOD_PATTERN)) {
    if (match[1]) methods.add(match[1].toLowerCase());
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

function documentsNotImplemented(operationValue: Record<string, unknown>): boolean {
  return isRecord(operationValue.responses) && Object.hasOwn(operationValue.responses, "501");
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

  const teaserRequest = schemas.TeaserRequest;
  if (!isRecord(teaserRequest) || !isRecord(teaserRequest.properties)) {
    errors.push("TeaserRequest schema is missing properties.");
    return;
  }
  if (propertyType(teaserRequest.properties.bizNo) !== "string") {
    errors.push("TeaserRequest.bizNo must be string.");
  }
  if (!isRecord(teaserRequest.properties.profile) || teaserRequest.properties.profile.$ref !== "#/components/schemas/CompanyProfile") {
    errors.push("TeaserRequest.profile must reference CompanyProfile.");
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

  const actionQueue = schemas.ActionQueueResult;
  if (!isRecord(actionQueue) || !isRecord(actionQueue.properties)) {
    errors.push("ActionQueueResult schema is missing properties.");
    return;
  }
  if (!Array.isArray(actionQueue.required) || !actionQueue.required.includes("actions")) {
    errors.push("ActionQueueResult must require actions.");
  }

  const actionQueueItem = schemas.ActionQueueItem;
  if (!isRecord(actionQueueItem) || !isRecord(actionQueueItem.properties)) {
    errors.push("ActionQueueItem schema is missing properties.");
    return;
  }
  if (!Array.isArray(actionQueueItem.required) ||
    !actionQueueItem.required.includes("affectedGrantIds") ||
    !actionQueueItem.required.includes("score")) {
    errors.push("ActionQueueItem must require affectedGrantIds and score.");
  }
  const actionKind = actionQueueItem.properties.kind;
  if (!isRecord(actionKind) || !Array.isArray(actionKind.enum) || !actionKind.enum.includes("apply")) {
    errors.push("ActionQueueItem.kind must include apply.");
  }

  const enrichmentRequest = schemas.CompanyEnrichmentRequest;
  if (!isRecord(enrichmentRequest) || !isRecord(enrichmentRequest.properties)) {
    errors.push("CompanyEnrichmentRequest schema is missing properties.");
    return;
  }
  if (!Array.isArray(enrichmentRequest.required) || !enrichmentRequest.required.includes("bizNo")) {
    errors.push("CompanyEnrichmentRequest must require bizNo.");
  }
  if (propertyType(enrichmentRequest.properties.bizNo) !== "string") {
    errors.push("CompanyEnrichmentRequest.bizNo must be string.");
  }

  const enrichmentFacts = schemas.CompanyEnrichmentFacts;
  if (!isRecord(enrichmentFacts) || !isRecord(enrichmentFacts.properties)) {
    errors.push("CompanyEnrichmentFacts schema is missing properties.");
    return;
  }
  if (!Array.isArray(enrichmentFacts.required) ||
    !enrichmentFacts.required.includes("maskedBizNo") ||
    !enrichmentFacts.required.includes("hasBizAge") ||
    !enrichmentFacts.required.includes("hasIndustry")) {
    errors.push("CompanyEnrichmentFacts must require maskedBizNo, hasBizAge and hasIndustry.");
  }
  if (nullableStringType(enrichmentFacts.properties.maskedBizNo) !== true) {
    errors.push("CompanyEnrichmentFacts.maskedBizNo must be nullable string.");
  }
  if (propertyType(enrichmentFacts.properties.hasBizAge) !== "boolean") {
    errors.push("CompanyEnrichmentFacts.hasBizAge must be boolean.");
  }

  const verificationRequest = schemas.CompanyVerificationRequest;
  if (!isRecord(verificationRequest) || !isRecord(verificationRequest.properties)) {
    errors.push("CompanyVerificationRequest schema is missing properties.");
    return;
  }
  if (!Array.isArray(verificationRequest.required) || !verificationRequest.required.includes("bizNo")) {
    errors.push("CompanyVerificationRequest must require bizNo.");
  }
  if (propertyType(verificationRequest.properties.bizNo) !== "string") {
    errors.push("CompanyVerificationRequest.bizNo must be string.");
  }

  const verificationResult = schemas.CompanyVerificationResult;
  if (!isRecord(verificationResult) || !isRecord(verificationResult.properties)) {
    errors.push("CompanyVerificationResult schema is missing properties.");
    return;
  }
  if (!Array.isArray(verificationResult.required) ||
    !verificationResult.required.includes("companyId") ||
    !verificationResult.required.includes("bizNoMasked") ||
    !verificationResult.required.includes("verified") ||
    !verificationResult.required.includes("verifiedAt") ||
    !verificationResult.required.includes("verifyMethod")) {
    errors.push("CompanyVerificationResult must require companyId, bizNoMasked, verified, verifiedAt and verifyMethod.");
  }
  if (Object.hasOwn(verificationResult.properties, "bizNo")) {
    errors.push("CompanyVerificationResult must not expose raw bizNo.");
  }
  if (propertyType(verificationResult.properties.bizNoMasked) !== "string") {
    errors.push("CompanyVerificationResult.bizNoMasked must be string.");
  }
  if (propertyType(verificationResult.properties.verified) !== "boolean") {
    errors.push("CompanyVerificationResult.verified must be boolean.");
  }

  const enrichmentResult = schemas.CompanyEnrichmentResult;
  if (!isRecord(enrichmentResult) || !isRecord(enrichmentResult.properties)) {
    errors.push("CompanyEnrichmentResult schema is missing properties.");
    return;
  }
  if (!Array.isArray(enrichmentResult.required) ||
    !enrichmentResult.required.includes("profile") ||
    !enrichmentResult.required.includes("facts")) {
    errors.push("CompanyEnrichmentResult must require profile and facts.");
  }

  const companyRecord = schemas.CompanyRecord;
  if (!isRecord(companyRecord) || !isRecord(companyRecord.properties)) {
    errors.push("CompanyRecord schema is missing properties.");
    return;
  }
  if (Object.hasOwn(companyRecord.properties, "bizNo")) {
    errors.push("CompanyRecord must not expose raw bizNo.");
  }
  if (propertyType(companyRecord.properties.verified) !== "boolean") {
    errors.push("CompanyRecord.verified must be boolean.");
  }
  if (nullableStringType(companyRecord.properties.bizNoMasked) !== true) {
    errors.push("CompanyRecord.bizNoMasked must be nullable string.");
  }
  if (nullableStringFormat(companyRecord.properties.verifiedAt) !== "date-time") {
    errors.push("CompanyRecord.verifiedAt must use nullable date-time format.");
  }

  const createCompanyRequest = schemas.CreateCompanyRequest;
  if (!isRecord(createCompanyRequest) || !isRecord(createCompanyRequest.properties)) {
    errors.push("CreateCompanyRequest schema is missing properties.");
    return;
  }
  if (!Array.isArray(createCompanyRequest.required) || !createCompanyRequest.required.includes("profile")) {
    errors.push("CreateCompanyRequest must require profile.");
  }
  if (!isRecord(createCompanyRequest.properties.profile) ||
    createCompanyRequest.properties.profile.$ref !== "#/components/schemas/CompanyProfile") {
    errors.push("CreateCompanyRequest.profile must reference CompanyProfile.");
  }

  const deviceRequest = schemas.DeviceRegistrationRequest;
  if (!isRecord(deviceRequest) || !isRecord(deviceRequest.properties)) {
    errors.push("DeviceRegistrationRequest schema is missing properties.");
    return;
  }
  if (!Array.isArray(deviceRequest.required) ||
    !deviceRequest.required.includes("deviceId") ||
    !deviceRequest.required.includes("platform") ||
    !deviceRequest.required.includes("pushToken")) {
    errors.push("DeviceRegistrationRequest must require deviceId, platform and pushToken.");
  }
  const platform = deviceRequest.properties.platform;
  if (!isRecord(platform) || !Array.isArray(platform.enum) ||
    !platform.enum.includes("ios") || !platform.enum.includes("android")) {
    errors.push("DeviceRegistrationRequest.platform must allow ios and android.");
  }

  const deviceResult = schemas.DeviceResult;
  if (!isRecord(deviceResult) || !isRecord(deviceResult.properties)) {
    errors.push("DeviceResult schema is missing properties.");
    return;
  }
  if (propertyType(deviceResult.properties.registered) !== "boolean") {
    errors.push("DeviceResult.registered must be boolean.");
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

function nullableStringType(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const variants = Array.isArray(value.anyOf) ? value.anyOf : [];
  return variants.some((variant) => isRecord(variant) && variant.type === "string") &&
    variants.some((variant) => isRecord(variant) && variant.type === "null");
}

function propertyType(value: unknown): string | null {
  return isRecord(value) && typeof value.type === "string" ? value.type : null;
}
