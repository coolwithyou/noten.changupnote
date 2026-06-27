import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const companyKindEnum = pgEnum("company_kind", ["active", "preliminary"]);
export const companyRoleEnum = pgEnum("company_role", ["owner", "admin", "member", "viewer"]);
export const appDevicePlatformEnum = pgEnum("app_device_platform", ["ios", "android"]);
export const companyProfileSourceEnum = pgEnum("company_profile_source", [
  "popbill",
  "nts",
  "codef",
  "self_declared",
  "ocr",
]);
export const consentScopeEnum = pgEnum("consent_scope", ["basic_info", "hometax", "insurance"]);
export const grantSourceEnum = pgEnum("grant_source", ["kstartup", "bizinfo", "bizinfo_event"]);
export const grantRawStatusEnum = pgEnum("grant_raw_status", [
  "fetched",
  "converted",
  "extracted",
  "normalized",
  "published",
  "failed",
]);
export const grantStatusEnum = pgEnum("grant_status", ["upcoming", "open", "closed", "unknown"]);
export const criterionDimensionEnum = pgEnum("criterion_dimension", [
  "region",
  "biz_age",
  "industry",
  "size",
  "revenue",
  "employees",
  "founder_age",
  "founder_trait",
  "certification",
  "prior_award",
  "ip",
  "target_type",
  "business_status",
  "other",
]);
export const criterionOperatorEnum = pgEnum("criterion_operator", [
  "in",
  "not_in",
  "lte",
  "gte",
  "between",
  "exists",
  "text_only",
]);
export const criterionKindEnum = pgEnum("criterion_kind", ["required", "preferred", "exclusion"]);
export const eligibilityEnum = pgEnum("eligibility", ["eligible", "conditional", "ineligible"]);
export const matchEventEnum = pgEnum("match_event", ["surfaced", "clicked", "saved", "apply_click"]);
export const feedbackTargetEnum = pgEnum("feedback_target", ["extraction", "match"]);
export const feedbackTypeEnum = pgEnum("feedback_type", [
  "implicit",
  "explicit_relevant",
  "explicit_irrelevant",
  "outcome",
]);
export const feedbackActorEnum = pgEnum("feedback_actor", ["user", "reviewer"]);
export const extractionStatusEnum = pgEnum("extraction_status", ["auto", "review", "labeled"]);
export const goldenKindEnum = pgEnum("golden_kind", ["extraction", "matching"]);
export const evalTargetEnum = pgEnum("eval_target", ["extraction", "matching"]);
export const versionTypeEnum = pgEnum("version_type", [
  "model",
  "prompt",
  "ruleset",
  "scoring",
  "taxonomy",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  emailIdx: uniqueIndex("users_email_idx").on(table.email),
}));

export const accounts = pgTable("accounts", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
}, (table) => ({
  pk: primaryKey({ columns: [table.provider, table.providerAccountId] }),
  userIdx: index("accounts_user_id_idx").on(table.userId),
}));

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
}, (table) => ({
  userIdx: index("sessions_user_id_idx").on(table.userId),
}));

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.identifier, table.token] }),
  tokenIdx: uniqueIndex("verification_tokens_token_idx").on(table.token),
}));

export const appRefreshTokens = pgTable("app_refresh_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  deviceId: text("device_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  rotatedFrom: uuid("rotated_from"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  hashIdx: uniqueIndex("app_refresh_tokens_hash_idx").on(table.tokenHash),
  userDeviceIdx: index("app_refresh_tokens_user_device_idx").on(table.userId, table.deviceId),
}));

export const appDevices = pgTable("app_devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull(),
  platform: appDevicePlatformEnum("platform").notNull(),
  pushToken: text("push_token").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userDeviceIdx: uniqueIndex("app_devices_user_device_idx").on(table.userId, table.deviceId),
}));

export const notificationSettings = pgTable("notification_settings", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  deadlineReminder: boolean("deadline_reminder").default(true).notNull(),
  newMatch: boolean("new_match").default(true).notNull(),
  quietHoursStart: text("quiet_hours_start"),
  quietHoursEnd: text("quiet_hours_end"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const companies = pgTable("companies", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: companyKindEnum("kind").notNull(),
  bizNo: text("biz_no"),
  legalType: text("legal_type"),
  name: text("name"),
  verified: boolean("verified").default(false).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  verifyMethod: text("verify_method"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  bizNoIdx: uniqueIndex("companies_biz_no_idx").on(table.bizNo),
  createdByIdx: index("companies_created_by_idx").on(table.createdBy),
}));

export const userCompany = pgTable("user_company", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  role: companyRoleEnum("role").notNull(),
  invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.companyId] }),
  companyIdx: index("user_company_company_id_idx").on(table.companyId),
}));

export const companyProfiles = pgTable("company_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  dimension: criterionDimensionEnum("dimension").notNull(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  source: companyProfileSourceEnum("source").notNull(),
  confidence: real("confidence").notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  companyDimensionIdx: index("company_profiles_company_dimension_idx").on(table.companyId, table.dimension),
}));

export const companyEnrichmentCache = pgTable("company_enrichment_cache", {
  provider: text("provider").notNull(),
  bizNo: text("biz_no").notNull(),
  scope: text("scope").notNull(),
  rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),
  canonicalPayload: jsonb("canonical_payload").$type<Record<string, unknown>>(),
  providerResultCode: text("provider_result_code"),
  providerResultMessage: text("provider_result_message"),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  payloadHash: text("payload_hash"),
  lastError: jsonb("last_error").$type<Record<string, unknown>>(),
}, (table) => ({
  pk: primaryKey({ columns: [table.provider, table.bizNo, table.scope] }),
  expiryIdx: index("company_enrichment_cache_expiry_idx").on(table.expiresAt),
}));

export const consents = pgTable("consents", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scope: consentScopeEnum("scope").notNull(),
  purpose: text("purpose").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => ({
  companyUserIdx: index("consents_company_user_idx").on(table.companyId, table.userId),
}));

export const grantRaw = pgTable("grant_raw", {
  id: uuid("id").defaultRandom().primaryKey(),
  source: grantSourceEnum("source").notNull(),
  sourceId: text("source_id").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  attachments: jsonb("attachments").$type<Array<Record<string, unknown>>>(),
  rawHash: text("raw_hash"),
  collectedAt: timestamp("collected_at", { withTimezone: true }).defaultNow().notNull(),
  status: grantRawStatusEnum("status").notNull(),
}, (table) => ({
  sourceIdIdx: uniqueIndex("grant_raw_source_id_idx").on(table.source, table.sourceId),
}));

export const grants = pgTable("grants", {
  id: uuid("id").defaultRandom().primaryKey(),
  source: grantSourceEnum("source").notNull(),
  sourceId: text("source_id").notNull(),
  title: text("title").notNull(),
  url: text("url"),
  agencyJurisdiction: text("agency_jurisdiction"),
  agencyOperator: text("agency_operator"),
  categoryL1: text("category_l1"),
  categoryL2: text("category_l2"),
  applyStart: timestamp("apply_start", { withTimezone: true }),
  applyEnd: timestamp("apply_end", { withTimezone: true }),
  applyMethod: jsonb("apply_method").$type<Record<string, string | null>>(),
  supportAmount: jsonb("support_amount").$type<Record<string, unknown>>(),
  requiredDocuments: jsonb("required_documents").$type<Array<Record<string, unknown>>>(),
  status: grantStatusEnum("status").notNull(),
  fRegions: text("f_regions").array().notNull().default(sql`ARRAY[]::text[]`),
  fIndustries: text("f_industries").array().notNull().default(sql`ARRAY[]::text[]`),
  fBizAgeMinMonths: integer("f_biz_age_min_months"),
  fBizAgeMaxMonths: integer("f_biz_age_max_months"),
  fSizes: text("f_sizes").array().notNull().default(sql`ARRAY[]::text[]`),
  fFounderTraits: text("f_founder_traits").array().notNull().default(sql`ARRAY[]::text[]`),
  fRequiredCerts: text("f_required_certs").array().notNull().default(sql`ARRAY[]::text[]`),
  embedding: jsonb("embedding").$type<number[]>(),
  overallConfidence: real("overall_confidence").notNull(),
  modelVer: text("model_ver"),
  promptVer: text("prompt_ver"),
  parserVersion: text("parser_version"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  sourceIdIdx: uniqueIndex("grants_source_id_idx").on(table.source, table.sourceId),
  statusIdx: index("grants_status_idx").on(table.status),
  regionIdx: index("grants_f_regions_idx").on(table.fRegions),
}));

export const grantCriteria = pgTable("grant_criteria", {
  id: uuid("id").defaultRandom().primaryKey(),
  grantId: uuid("grant_id").notNull().references(() => grants.id, { onDelete: "cascade" }),
  dimension: criterionDimensionEnum("dimension").notNull(),
  operator: criterionOperatorEnum("operator").notNull(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  kind: criterionKindEnum("kind").notNull(),
  weight: real("weight"),
  confidence: real("confidence").notNull(),
  sourceSpan: text("source_span"),
  rawText: text("raw_text"),
  sourceField: text("source_field"),
  needsReview: boolean("needs_review").default(false).notNull(),
  parserVersion: text("parser_version"),
}, (table) => ({
  grantIdx: index("grant_criteria_grant_id_idx").on(table.grantId),
  reviewIdx: index("grant_criteria_review_idx").on(table.needsReview),
}));

export const dedupLinks = pgTable("dedup_links", {
  canonicalGrantId: uuid("canonical_grant_id").notNull().references(() => grants.id, { onDelete: "cascade" }),
  memberGrantId: uuid("member_grant_id").notNull().references(() => grants.id, { onDelete: "cascade" }),
  score: real("score").notNull(),
  confirmed: boolean("confirmed").default(false).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.canonicalGrantId, table.memberGrantId] }),
}));

export const matchState = pgTable("match_state", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  grantId: uuid("grant_id").notNull().references(() => grants.id, { onDelete: "cascade" }),
  eligibility: eligibilityEnum("eligibility").notNull(),
  matchScore: integer("match_score").notNull(),
  fitScore: integer("fit_score").notNull(),
  competitiveness: jsonb("competitiveness").$type<Record<string, unknown>>(),
  valueScore: integer("value_score"),
  ruleTrace: jsonb("rule_trace").$type<Array<Record<string, unknown>>>().notNull(),
  matchConfidence: real("match_confidence").notNull(),
  eligibleFrom: timestamp("eligible_from", { withTimezone: true }),
  eligibleUntil: timestamp("eligible_until", { withTimezone: true }),
  rulesetVer: text("ruleset_ver").notNull(),
  scoringVer: text("scoring_ver").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.companyId, table.grantId] }),
  eligibleFromIdx: index("match_state_eligible_from_idx").on(table.eligibleFrom),
  eligibleUntilIdx: index("match_state_eligible_until_idx").on(table.eligibleUntil),
}));

export const matchEvents = pgTable("match_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  grantId: uuid("grant_id").notNull().references(() => grants.id, { onDelete: "cascade" }),
  event: matchEventEnum("event").notNull(),
  rulesetVer: text("ruleset_ver").notNull(),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  companyGrantIdx: index("match_events_company_grant_idx").on(table.companyId, table.grantId),
}));

export const feedback = pgTable("feedback", {
  id: uuid("id").defaultRandom().primaryKey(),
  targetType: feedbackTargetEnum("target_type").notNull(),
  targetId: text("target_id").notNull(),
  type: feedbackTypeEnum("type").notNull(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  actor: feedbackActorEnum("actor").notNull(),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  targetIdx: index("feedback_target_idx").on(table.targetType, table.targetId),
}));

export const extractionLog = pgTable("extraction_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  grantId: uuid("grant_id").references(() => grants.id, { onDelete: "set null" }),
  inputRef: text("input_ref").notNull(),
  output: jsonb("output").$type<Record<string, unknown>>().notNull(),
  confidence: real("confidence").notNull(),
  status: extractionStatusEnum("status").notNull(),
  reviewer: uuid("reviewer").references(() => users.id, { onDelete: "set null" }),
  modelVer: text("model_ver").notNull(),
  promptVer: text("prompt_ver").notNull(),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  statusIdx: index("extraction_log_status_idx").on(table.status),
}));

export const goldenSet = pgTable("golden_set", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: goldenKindEnum("kind").notNull(),
  ref: text("ref").notNull(),
  gold: jsonb("gold").$type<Record<string, unknown>>().notNull(),
  curatedBy: uuid("curated_by").references(() => users.id, { onDelete: "set null" }),
  goldenVer: text("golden_ver").notNull(),
}, (table) => ({
  kindVerIdx: index("golden_set_kind_ver_idx").on(table.kind, table.goldenVer),
}));

export const evalRuns = pgTable("eval_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  target: evalTargetEnum("target").notNull(),
  versionRefs: jsonb("version_refs").$type<Record<string, string>>().notNull(),
  metrics: jsonb("metrics").$type<Record<string, number>>().notNull(),
  goldenVer: text("golden_ver").notNull(),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  targetVerIdx: index("eval_runs_target_ver_idx").on(table.target, table.goldenVer),
}));

export const grantInsightSnapshots = pgTable("grant_insight_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: text("kind").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }),
  windowEnd: timestamp("window_end", { withTimezone: true }),
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  metrics: jsonb("metrics").$type<Record<string, number>>().notNull(),
  dimensions: jsonb("dimensions").$type<Record<string, unknown>>().notNull(),
  insights: jsonb("insights").$type<Array<Record<string, unknown>>>().notNull(),
}, (table) => ({
  kindGeneratedIdx: index("grant_insight_snapshots_kind_generated_idx").on(table.kind, table.generatedAt),
}));

export const versions = pgTable("versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: versionTypeEnum("type").notNull(),
  hash: text("hash").notNull(),
  notes: text("notes"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
}, (table) => ({
  typeHashIdx: uniqueIndex("versions_type_hash_idx").on(table.type, table.hash),
}));

export const industryTaxonomy = pgTable("industry_taxonomy", {
  ksic: varchar("ksic", { length: 16 }).notNull(),
  policyTag: text("policy_tag").notNull(),
  ver: text("ver").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.ksic, table.policyTag, table.ver] }),
}));

export const regionHierarchy = pgTable("region_hierarchy", {
  sigungu: text("sigungu").primaryKey(),
  sido: text("sido").notNull(),
  regionGroup: text("region_group"),
});

export const sizeThresholds = pgTable("size_thresholds", {
  ksic: varchar("ksic", { length: 16 }).notNull(),
  segment: text("segment").notNull(),
  revenueMax: integer("revenue_max"),
  employeesMax: integer("employees_max"),
}, (table) => ({
  pk: primaryKey({ columns: [table.ksic, table.segment] }),
}));

export const sourceCursor = pgTable("source_cursor", {
  source: grantSourceEnum("source").primaryKey(),
  lastPage: integer("last_page"),
  lastCollectedAt: timestamp("last_collected_at", { withTimezone: true }),
});
