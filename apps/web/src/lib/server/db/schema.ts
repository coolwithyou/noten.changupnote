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
export const adminRoleEnum = pgEnum("admin_role", ["owner", "admin", "support", "viewer"]);
export const adminStatusEnum = pgEnum("admin_status", ["active", "disabled"]);
export const teamInvitationStatusEnum = pgEnum("team_invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
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
export const supportTicketAuthorEnum = pgEnum("support_ticket_author", ["user", "admin", "system"]);
export const supportTicketMessageVisibilityEnum = pgEnum("support_ticket_message_visibility", [
  "public",
  "internal",
]);
export const notificationReceiptStatusEnum = pgEnum("notification_receipt_status", [
  "unread",
  "read",
  "dismissed",
]);
export const extractionStatusEnum = pgEnum("extraction_status", ["auto", "review", "labeled"]);
export const goldenKindEnum = pgEnum("golden_kind", ["extraction", "matching", "field_map"]);
export const reviewStatusEnum = pgEnum("review_status", ["pending", "in_review", "approved"]);
export const evalTargetEnum = pgEnum("eval_target", ["extraction", "matching", "field_map"]);
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
  passwordHash: text("password_hash"),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  privacyAcceptedAt: timestamp("privacy_accepted_at", { withTimezone: true }),
  termsVersion: text("terms_version"),
  privacyVersion: text("privacy_version"),
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

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  passwordHash: text("password_hash"),
  role: adminRoleEnum("role").default("admin").notNull(),
  status: adminStatusEnum("status").default("active").notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  emailIdx: uniqueIndex("admin_users_email_idx").on(table.email),
  statusRoleIdx: index("admin_users_status_role_idx").on(table.status, table.role),
}));

export const adminAccounts = pgTable("admin_accounts", {
  adminUserId: uuid("admin_user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.provider, table.providerAccountId] }),
  adminUserIdx: index("admin_accounts_admin_user_id_idx").on(table.adminUserId),
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

export const notificationReceipts = pgTable("notification_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  notificationId: text("notification_id").notNull(),
  kind: text("kind").notNull(),
  target: text("target").notNull(),
  status: notificationReceiptStatusEnum("status").default("unread").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userCompanyNotificationIdx: uniqueIndex("notification_receipts_user_company_notification_idx")
    .on(table.userId, table.companyId, table.notificationId),
  userCompanyStatusIdx: index("notification_receipts_user_company_status_idx")
    .on(table.userId, table.companyId, table.status),
  updatedAtIdx: index("notification_receipts_updated_at_idx").on(table.updatedAt),
}));

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

export const teamInvitations = pgTable("team_invitations", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: companyRoleEnum("role").notNull(),
  tokenHash: text("token_hash").notNull(),
  status: teamInvitationStatusEnum("status").default("pending").notNull(),
  invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tokenHashIdx: uniqueIndex("team_invitations_token_hash_idx").on(table.tokenHash),
  companyStatusIdx: index("team_invitations_company_status_idx").on(table.companyId, table.status),
  emailStatusIdx: index("team_invitations_email_status_idx").on(table.email, table.status),
  expiresAtIdx: index("team_invitations_expires_at_idx").on(table.expiresAt),
}));

export const teamRoleChangeEvents = pgTable("team_role_change_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  previousRole: companyRoleEnum("previous_role").notNull(),
  nextRole: companyRoleEnum("next_role").notNull(),
  targetSnapshot: jsonb("target_snapshot").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  actorSnapshot: jsonb("actor_snapshot").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  source: text("source").default("team_management").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  companyCreatedAtIdx: index("team_role_change_events_company_created_at_idx").on(table.companyId, table.createdAt),
  targetUserIdx: index("team_role_change_events_target_user_idx").on(table.targetUserId),
  actorUserIdx: index("team_role_change_events_actor_user_idx").on(table.actorUserId),
}));

export const billingSubscriptions = pgTable("billing_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  provider: text("provider").default("manual").notNull(),
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  status: text("status").default("early_access").notNull(),
  planCode: text("plan_code").default("early_access").notNull(),
  planName: text("plan_name").default("Early Access").notNull(),
  priceLabel: text("price_label").default("월 0원").notNull(),
  renewalLabel: text("renewal_label").default("결제 연동 전").notNull(),
  seatLimit: integer("seat_limit").default(5).notNull(),
  autoBillingEnabled: boolean("auto_billing_enabled").default(false).notNull(),
  invoicesEnabled: boolean("invoices_enabled").default(false).notNull(),
  paymentMethodManaged: boolean("payment_method_managed").default(false).notNull(),
  providerPortalUrl: text("provider_portal_url"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  companyIdx: uniqueIndex("billing_subscriptions_company_idx").on(table.companyId),
  statusIdx: index("billing_subscriptions_status_idx").on(table.status),
  updatedAtIdx: index("billing_subscriptions_updated_at_idx").on(table.updatedAt),
}));

export const billingWebhookEvents = pgTable("billing_webhook_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider").notNull(),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  signatureVerified: boolean("signature_verified").default(false).notNull(),
  processingStatus: text("processing_status").default("received").notNull(),
  error: text("error"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => ({
  providerEventIdx: uniqueIndex("billing_webhook_events_provider_event_idx").on(table.provider, table.eventId),
  providerReceivedIdx: index("billing_webhook_events_provider_received_idx").on(table.provider, table.receivedAt),
  companyReceivedIdx: index("billing_webhook_events_company_received_idx").on(table.companyId, table.receivedAt),
  processingStatusIdx: index("billing_webhook_events_processing_status_idx").on(table.processingStatus),
}));

export const billingInvoices = pgTable("billing_invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerInvoiceId: text("provider_invoice_id").notNull(),
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  invoiceNumber: text("invoice_number"),
  status: text("status").default("draft").notNull(),
  currency: text("currency").default("KRW").notNull(),
  amountDue: integer("amount_due").default(0).notNull(),
  amountPaid: integer("amount_paid").default(0).notNull(),
  taxAmount: integer("tax_amount").default(0).notNull(),
  hostedInvoiceUrl: text("hosted_invoice_url"),
  receiptUrl: text("receipt_url"),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  dueAt: timestamp("due_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  payload: jsonb("payload").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  providerInvoiceIdx: uniqueIndex("billing_invoices_provider_invoice_idx").on(table.provider, table.providerInvoiceId),
  companyIssuedIdx: index("billing_invoices_company_issued_idx").on(table.companyId, table.issuedAt),
  companyStatusIdx: index("billing_invoices_company_status_idx").on(table.companyId, table.status),
  subscriptionIdx: index("billing_invoices_subscription_idx").on(table.providerSubscriptionId),
}));

export const billingPaymentMethods = pgTable("billing_payment_methods", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerCustomerId: text("provider_customer_id"),
  providerPaymentMethodId: text("provider_payment_method_id").notNull(),
  type: text("type").default("card").notNull(),
  brand: text("brand"),
  last4: text("last4"),
  expMonth: integer("exp_month"),
  expYear: integer("exp_year"),
  holderName: text("holder_name"),
  billingEmail: text("billing_email"),
  status: text("status").default("active").notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  providerPortalUrl: text("provider_portal_url"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  payload: jsonb("payload").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  providerMethodIdx: uniqueIndex("billing_payment_methods_provider_method_idx").on(table.provider, table.providerPaymentMethodId),
  companyDefaultIdx: index("billing_payment_methods_company_default_idx").on(table.companyId, table.isDefault),
  companyUpdatedIdx: index("billing_payment_methods_company_updated_idx").on(table.companyId, table.updatedAt),
  customerIdx: index("billing_payment_methods_customer_idx").on(table.providerCustomerId),
}));

export const billingTaxProfiles = pgTable("billing_tax_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  businessName: text("business_name"),
  businessRegistrationNumber: text("business_registration_number"),
  recipientName: text("recipient_name"),
  recipientEmail: text("recipient_email"),
  recipientPhone: text("recipient_phone"),
  taxInvoiceEmail: text("tax_invoice_email"),
  billingAddressLine1: text("billing_address_line1"),
  billingAddressLine2: text("billing_address_line2"),
  postalCode: text("postal_code"),
  taxInvoiceEnabled: boolean("tax_invoice_enabled").default(false).notNull(),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  companyIdx: uniqueIndex("billing_tax_profiles_company_idx").on(table.companyId),
  updatedAtIdx: index("billing_tax_profiles_updated_at_idx").on(table.updatedAt),
  taxInvoiceEmailIdx: index("billing_tax_profiles_tax_invoice_email_idx").on(table.taxInvoiceEmail),
}));

export const billingTaxDocuments = pgTable("billing_tax_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  documentKind: text("document_kind").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  bytes: integer("bytes").notNull(),
  sha256: text("sha256").notNull(),
  storageKey: text("storage_key").notNull(),
  archiveUrl: text("archive_url").notNull(),
  status: text("status").default("active").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  companyStatusIdx: index("billing_tax_documents_company_status_idx").on(table.companyId, table.status),
  uploadedByIdx: index("billing_tax_documents_uploaded_by_idx").on(table.uploadedBy),
  shaIdx: index("billing_tax_documents_sha_idx").on(table.sha256),
  updatedAtIdx: index("billing_tax_documents_updated_at_idx").on(table.updatedAt),
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

export const userBusinessLookupHistory = pgTable("user_business_lookup_history", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  bizNo: text("biz_no").notNull(),
  firstLookedUpAt: timestamp("first_looked_up_at", { withTimezone: true }).defaultNow().notNull(),
  lastLookedUpAt: timestamp("last_looked_up_at", { withTimezone: true }).defaultNow().notNull(),
  lookupCount: integer("lookup_count").default(1).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.bizNo] }),
  userLastLookupIdx: index("user_business_lookup_history_user_last_lookup_idx")
    .on(table.userId, table.lastLookedUpAt),
  bizNoIdx: index("user_business_lookup_history_biz_no_idx").on(table.bizNo),
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
  benefits: jsonb("benefits").$type<Array<Record<string, unknown>>>(),
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
  sourceStatusIdx: index("grants_source_status_idx").on(table.source, table.status),
  applyEndIdx: index("grants_apply_end_idx").on(table.applyEnd),
  updatedAtIdx: index("grants_updated_at_idx").on(table.updatedAt),
  benefitsIdx: index("grants_benefits_idx").using("gin", table.benefits),
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
  dimensionGrantIdx: index("grant_criteria_dimension_grant_idx").on(table.dimension, table.grantId),
  operatorGrantIdx: index("grant_criteria_operator_grant_idx").on(table.operator, table.grantId),
  reviewIdx: index("grant_criteria_review_idx").on(table.needsReview),
}));

export const grantAttachmentArchives = pgTable("grant_attachment_archives", {
  id: uuid("id").defaultRandom().primaryKey(),
  source: grantSourceEnum("source").notNull(),
  sourceId: text("source_id").notNull(),
  filename: text("filename").notNull(),
  sourceUri: text("source_uri").notNull().default(""),
  archiveUrl: text("archive_url"),
  storageKey: text("storage_key"),
  contentType: text("content_type"),
  bytes: integer("bytes"),
  sha256: text("sha256"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  conversionStatus: text("conversion_status"),
  markdownUrl: text("markdown_url"),
  markdownStorageKey: text("markdown_storage_key"),
  markdownSha256: text("markdown_sha256"),
  markdownBytes: integer("markdown_bytes"),
  converter: text("converter"),
  convertedAt: timestamp("converted_at", { withTimezone: true }),
  conversionError: text("conversion_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  sourceAttachmentIdx: uniqueIndex("grant_attachment_archives_source_attachment_idx")
    .on(table.source, table.sourceId, table.filename, table.sourceUri),
  sourceIdIdx: index("grant_attachment_archives_source_id_idx").on(table.source, table.sourceId),
  shaIdx: index("grant_attachment_archives_sha_idx").on(table.sha256),
}));

export const grantDocumentFields = pgTable("grant_document_fields", {
  id: uuid("id").defaultRandom().primaryKey(),
  grantId: uuid("grant_id").notNull().references(() => grants.id, { onDelete: "cascade" }),
  source: grantSourceEnum("source").notNull(),
  sourceId: text("source_id").notNull(),
  documentCategory: text("document_category").notNull(),
  documentName: text("document_name").notNull(),
  sourceAttachment: text("source_attachment"),
  fieldKey: text("field_key").notNull(),
  label: text("label").notNull(),
  section: text("section"),
  fieldType: text("field_type").notNull(),
  required: boolean("required").default(false).notNull(),
  sourceSpan: text("source_span"),
  mappedCompanyField: text("mapped_company_field"),
  fillStrategy: text("fill_strategy").notNull(),
  confidence: real("confidence").notNull(),
  parserVersion: text("parser_version").notNull(),
  // Phase 1 surface 모델 연결 (백필 전략: 마스터 설계 문서 11장)
  surfaceId: uuid("surface_id").references(() => grantApplicationSurfaces.id, { onDelete: "set null" }),
  // DocumentFieldPosition: { page, bbox(0~1 상대좌표), blockId, tablePath, xpath, cssSelector }
  position: jsonb("position").$type<Record<string, unknown>>(),
  visualEvidence: jsonb("visual_evidence").$type<Record<string, unknown>>(),
  textEvidence: jsonb("text_evidence").$type<Record<string, unknown>>(),
  reviewRequired: boolean("review_required").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  grantIdx: index("grant_document_fields_grant_id_idx").on(table.grantId),
  sourceIdIdx: index("grant_document_fields_source_id_idx").on(table.source, table.sourceId),
  sourceAttachmentIdx: index("grant_document_fields_source_attachment_idx").on(table.source, table.sourceId, table.sourceAttachment),
  categoryIdx: index("grant_document_fields_category_idx").on(table.documentCategory),
  surfaceIdx: index("grant_document_fields_surface_idx").on(table.surfaceId),
}));

export const grantDocumentDrafts = pgTable("grant_document_drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  grantId: uuid("grant_id").notNull().references(() => grants.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  documentKey: text("document_key").notNull(),
  documentCategory: text("document_category").notNull(),
  documentName: text("document_name").notNull(),
  sourceAttachment: text("source_attachment"),
  draftMarkdown: text("draft_markdown").notNull(),
  filledFields: jsonb("filled_fields").$type<Record<string, string>>().notNull(),
  missingFields: jsonb("missing_fields").$type<Array<Record<string, unknown>>>().notNull(),
  usedProfileFields: jsonb("used_profile_fields").$type<string[]>().notNull(),
  assumptions: jsonb("assumptions").$type<string[]>().notNull(),
  warnings: jsonb("warnings").$type<string[]>().notNull(),
  status: text("status").notNull(),
  modelVer: text("model_ver").notNull(),
  promptVer: text("prompt_ver").notNull(),
  parserVersion: text("parser_version").notNull(),
  // Phase 1 surface 모델 연결 (백필 전략: 마스터 설계 문서 11장)
  surfaceId: uuid("surface_id").references(() => grantApplicationSurfaces.id, { onDelete: "set null" }),
  // FieldFillPlan[] (마스터 설계 문서 7.6)
  draftPlan: jsonb("draft_plan").$type<Array<Record<string, unknown>>>(),
  evidenceRefs: jsonb("evidence_refs").$type<Array<Record<string, unknown>>>(),
  llmCost: jsonb("llm_cost").$type<Record<string, unknown>>(),
  // user_review_required | user_reviewed | exported
  reviewState: text("review_state").default("user_review_required").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  grantCompanyIdx: index("grant_document_drafts_grant_company_idx").on(table.grantId, table.companyId),
  companyStatusIdx: index("grant_document_drafts_company_status_idx").on(table.companyId, table.status),
  userUpdatedIdx: index("grant_document_drafts_user_updated_idx").on(table.userId, table.updatedAt),
  documentKeyIdx: index("grant_document_drafts_document_key_idx").on(table.grantId, table.companyId, table.documentKey),
  surfaceIdx: index("grant_document_drafts_surface_idx").on(table.surfaceId),
}));

export const grantDocumentDraftEvents = pgTable("grant_document_draft_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  draftId: uuid("draft_id").notNull().references(() => grantDocumentDrafts.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  draftIdx: index("grant_document_draft_events_draft_idx").on(table.draftId),
  actorIdx: index("grant_document_draft_events_actor_idx").on(table.actorUserId),
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

export const supportTickets = pgTable("support_tickets", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  email: text("email").notNull(),
  name: text("name"),
  category: text("category").notNull(),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  status: text("status").default("open").notNull(),
  priority: text("priority").default("normal").notNull(),
  source: text("source").default("web").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  companyStatusIdx: index("support_tickets_company_status_idx").on(table.companyId, table.status),
  userIdx: index("support_tickets_user_idx").on(table.userId),
  statusCreatedIdx: index("support_tickets_status_created_idx").on(table.status, table.createdAt),
}));

export const supportTicketMessages = pgTable("support_ticket_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  ticketId: uuid("ticket_id").notNull().references(() => supportTickets.id, { onDelete: "cascade" }),
  authorType: supportTicketAuthorEnum("author_type").notNull(),
  authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
  authorEmail: text("author_email"),
  body: text("body").notNull(),
  visibility: supportTicketMessageVisibilityEnum("visibility").default("public").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  ticketCreatedIdx: index("support_ticket_messages_ticket_created_idx").on(table.ticketId, table.createdAt),
  ticketVisibilityIdx: index("support_ticket_messages_ticket_visibility_idx").on(table.ticketId, table.visibility),
}));

export const supportTicketAttachments = pgTable("support_ticket_attachments", {
  id: uuid("id").defaultRandom().primaryKey(),
  ticketId: uuid("ticket_id").notNull().references(() => supportTickets.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").references(() => supportTicketMessages.id, { onDelete: "set null" }),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  bytes: integer("bytes").notNull(),
  sha256: text("sha256").notNull(),
  storageKey: text("storage_key").notNull(),
  archiveUrl: text("archive_url").notNull(),
  visibility: supportTicketMessageVisibilityEnum("visibility").default("public").notNull(),
  status: text("status").default("active").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  ticketStatusIdx: index("support_ticket_attachments_ticket_status_idx").on(table.ticketId, table.status),
  ticketVisibilityIdx: index("support_ticket_attachments_ticket_visibility_idx").on(table.ticketId, table.visibility),
  messageIdx: index("support_ticket_attachments_message_idx").on(table.messageId),
  companyIdx: index("support_ticket_attachments_company_idx").on(table.companyId),
  shaIdx: index("support_ticket_attachments_sha_idx").on(table.sha256),
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

/**
 * 필드맵 검수 워크스페이스(마스터 9.8 첫 슬라이스, docs/plans/2026-07-03-reviewer-workspace-v1.md).
 * spike-labels/ 파일 라벨을 임포트해 정본으로 삼고, 검수 확정이 곧 golden_set(kind=field_map) 승격이다.
 * 필드 단위 정규화는 하지 않고 labelJson.fields 통째로 저장한다.
 */
export const fieldMapReviewDocs = pgTable("field_map_review_docs", {
  id: uuid("id").defaultRandom().primaryKey(),
  docRef: text("doc_ref").notNull(),
  docId: text("doc_id").notNull(),
  sourceFilename: text("source_filename"),
  pageCount: integer("page_count"),
  labelJson: jsonb("label_json").$type<Record<string, unknown>>().notNull(),
  labeledBy: text("labeled_by"),
  labeledAt: text("labeled_at"),
  reviewStatus: reviewStatusEnum("review_status").default("pending").notNull(),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  correctionNotes: text("correction_notes"),
  // 리뷰어가 운영자에게 남기는 문서별 메모 (v1.1 피드백 채널). 9.8 인박스의 씨앗.
  reviewerComment: text("reviewer_comment"),
  pageImageKeys: jsonb("page_image_keys").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  docRefIdx: uniqueIndex("field_map_review_docs_doc_ref_idx").on(table.docRef),
  statusIdx: index("field_map_review_docs_status_idx").on(table.reviewStatus),
}));

/**
 * 질문 기반 검수 모드(v2, docs/plans/2026-07-03-reviewer-workspace-v1.md "v2 — 질문 기반 검수 모드").
 * 리뷰어는 라벨 편집자가 아니라 "질문에 답하는 전문가"다. 질문은 사전 배치(LLM)로 생성한다.
 * 이 테이블은 마스터 18.6 Field Question 의 씨앗 — 이후 사용자 Q&A 도 같은 구조로 수렴한다.
 */
export const fieldMapReviewQuestions = pgTable("field_map_review_questions", {
  id: uuid("id").defaultRandom().primaryKey(),
  reviewDocId: uuid("review_doc_id")
    .notNull()
    .references(() => fieldMapReviewDocs.id, { onDelete: "cascade" }),
  // null 이면 문서/페이지 레벨 질문 (missing_sweep 등).
  fieldIndex: integer("field_index"),
  page: integer("page"),
  // 'quick_confirm' | 'question' | 'missing_sweep'
  kind: text("kind").notNull(),
  prompt: text("prompt").notNull(),
  // 'confirm' | 'yes_no_unsure' | 'choice' | 'short_text'
  answerType: text("answer_type").notNull(),
  // choice 선택지 [{value,label}]
  options: jsonb("options").$type<Array<{ value: string; label: string }>>(),
  // 답변값 → 라벨 패치 { "yes": { "manual": true }, ... } (결정적 반영)
  applyMap: jsonb("apply_map").$type<Record<string, Record<string, unknown>>>(),
  orderIndex: integer("order_index").notNull(),
  // { value, text? }
  answer: jsonb("answer").$type<{ value: string; text?: string }>(),
  answeredBy: text("answered_by"),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  docIdx: index("field_map_review_questions_doc_idx").on(table.reviewDocId),
  docOrderIdx: index("field_map_review_questions_doc_order_idx").on(table.reviewDocId, table.orderIndex),
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

// --- 지원서 작성 가이드: Application Surface / Artifact 모델 (Phase 1) ---
// 설계: docs/public-support-application-guide-master-architecture.md 7.3, 7.4, 7.7, 11장

export const formTemplates = pgTable("form_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  // 제목/섹션/필드 시그니처 기반 구조 해시. sha256 정확 일치보다 넓은 유사 양식 재사용 키.
  structureHash: text("structure_hash").notNull(),
  // 대표 surface. 순환 FK를 피하기 위해 제약 없이 uuid만 저장한다.
  canonicalSurfaceId: uuid("canonical_surface_id"),
  verifiedFieldMapVersion: text("verified_field_map_version"),
  usageCount: integer("usage_count").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  structureHashIdx: uniqueIndex("form_templates_structure_hash_idx").on(table.structureHash),
}));

export const grantApplicationSurfaces = pgTable("grant_application_surfaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  grantId: uuid("grant_id").notNull().references(() => grants.id, { onDelete: "cascade" }),
  templateId: uuid("template_id").references(() => formTemplates.id, { onDelete: "set null" }),
  source: grantSourceEnum("source").notNull(),
  sourceId: text("source_id").notNull(),
  // file_template | web_form | freeform_instruction
  type: text("type").notNull(),
  title: text("title").notNull(),
  // hwp | hwpx | docx | pptx | pdf | html | web | markdown | unknown
  format: text("format").notNull(),
  sourceUrl: text("source_url"),
  sourceAttachment: text("source_attachment"),
  // pending | preview_ready | fields_ready | failed
  extractionStatus: text("extraction_status").default("pending").notNull(),
  extractionVersion: text("extraction_version"),
  confidence: real("confidence"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  grantIdx: index("grant_application_surfaces_grant_idx").on(table.grantId),
  templateIdx: index("grant_application_surfaces_template_idx").on(table.templateId),
  sourceIdIdx: index("grant_application_surfaces_source_id_idx").on(table.source, table.sourceId),
  sourceAttachmentIdx: uniqueIndex("grant_application_surfaces_source_attachment_idx")
    .on(table.source, table.sourceId, table.type, table.sourceAttachment, table.sourceUrl),
  statusIdx: index("grant_application_surfaces_status_idx").on(table.extractionStatus),
}));

export const documentArtifacts = pgTable("document_artifacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  surfaceId: uuid("surface_id").notNull().references(() => grantApplicationSurfaces.id, { onDelete: "cascade" }),
  // original | pdf | page_image | markdown | layout_json | ocr_json | field_candidates | annotated_pdf | pptx_guide | filled_hwpx | filled_docx
  kind: text("kind").notNull(),
  page: integer("page"),
  storageKey: text("storage_key").notNull(),
  url: text("url"),
  contentType: text("content_type"),
  sha256: text("sha256"),
  // 렌더링 엔진, DPI, 페이지 크기, quality score 등 (8.3, 8.4 좌표계 규칙)
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  surfaceKindIdx: index("document_artifacts_surface_kind_idx").on(table.surfaceId, table.kind, table.page),
  shaIdx: index("document_artifacts_sha_idx").on(table.sha256),
}));

// --- 운영 지식 인제스천: Knowledge Source / Review Lesson ---
// 설계: 마스터 18.5(ReviewLesson) + docs/plans/2026-07-05-ops-knowledge-ingestion.md §6.1
// 제3 유입 채널(운영 보고 문서) — 보고서가 올 때마다 지식 레이어가 누적적으로 강화된다.

/**
 * 운영 지식 원천 문서 (불변 원본).
 * 설계: docs/plans/2026-07-05-ops-knowledge-ingestion.md §6.1.
 * 인터뷰·피드백·공고 해설 문서를 R2에 불변 보관하고, 추출 패스가 항목 단위로 lesson 후보를 뽑는다.
 * sha256 uniqueIndex 로 같은 파일의 중복 등록을 막는다 (멱등 등록 키).
 * enum 컬럼은 pgEnum 대신 text + TS union 주석 방식(fieldMapReviewQuestions.kind 선례).
 */
export const knowledgeSources = pgTable("knowledge_sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  // 'ops_interview' | 'user_feedback_report' | 'official_announcement' | 'program_faq'
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  // 원본 파일 sha256(hex). 같은 파일 재등록 방지·멱등 키.
  sha256: text("sha256").notNull(),
  // R2 키: 원본 파일 (PDF/텍스트 등).
  r2Key: text("r2_key").notNull(),
  // R2 키: 추출 텍스트([page N] 마커 포함). null 이면 아직 추출 전.
  extractedTextKey: text("extracted_text_key"),
  // R2 키: 추출 결과 전문 JSON.
  extractionJsonKey: text("extraction_json_key"),
  // 예: "LIPS/TIPS". 추출 시 scope 힌트로 프롬프트에 전달.
  programHint: text("program_hint"),
  institutionHint: text("institution_hint"),
  // 문서 작성 시점(YYYY-MM-DD). lesson 시효(reviewBy) 계산 기준.
  sourceDate: text("source_date").notNull(),
  // 등록자 이메일.
  uploadedBy: text("uploaded_by").notNull(),
  // 'registered' | 'extracted' | 'curated'
  status: text("status").default("registered").notNull(),
  // 추출에 사용한 모델·프롬프트 버전 기록 (재현성).
  extractionModel: text("extraction_model"),
  extractionPromptVer: text("extraction_prompt_ver"),
  // 추출된 비-lesson 항목 요약 (faq_candidate | exemplar | product_feedback). lesson 은 review_lessons 로 분리 적재.
  nonLessonItems: jsonb("non_lesson_items")
    .$type<Array<{ kind: string; content: string; quote: string; page: number | null }>>()
    .default(sql`'[]'::jsonb`)
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  shaIdx: uniqueIndex("knowledge_sources_sha_idx").on(table.sha256),
  kindStatusIdx: index("knowledge_sources_kind_status_idx").on(table.kind, table.status),
}));

/**
 * 재사용 가능한 검수 교훈 (ReviewLesson).
 * 설계: 마스터 18.5 + docs/plans/2026-07-05-ops-knowledge-ingestion.md §6.1.
 * 운영 보고 문서·리뷰어 교정·필드 질문에서 도출한 항목 단위 지식. 승격(approved) 후 scope 매칭으로 주입한다.
 * 승격 게이트(저장 계층): sourceRefs(원문 인용) 또는 goldenCaseRef 중 하나가 없으면 approved 로 올릴 수 없다
 *   (계획 §6 "원문 인용 없는 후보 생성/승격 금지"의 DB 버전).
 * 시효: reviewBy 도래 lesson 은 자동 retire 가 아니라 재검토 큐로 올린다. evidenceTier 는 주입 시 프롬프트에 표기.
 */
export const reviewLessons = pgTable("review_lessons", {
  id: uuid("id").defaultRandom().primaryKey(),
  // 'classification' | 'criteria' | 'field_interpretation' | 'fill_value' | 'guide' | 'evaluation'
  target: text("target").notNull(),
  // 적용 범위(최소 1개 축). 보수적으로: 문서에서 확인되는 범위만 (과일반화 금지).
  scope: jsonb("scope")
    .$type<{
      program?: string;
      institution?: string;
      formTemplateId?: string;
      documentCategory?: string;
      fieldPattern?: string;
      condition?: string;
    }>()
    .notNull(),
  instruction: text("instruction").notNull(),
  rationale: text("rationale").notNull(),
  // 'reviewer_correction' | 'field_question' | 'ops_report' (유입 채널)
  sourceKind: text("source_kind").notNull(),
  // 'official_document' | 'staff_confirmed' | 'ops_inference' (출처 신뢰 등급)
  evidenceTier: text("evidence_tier").notNull(),
  // 원문 인용 필수 근거. [{ sourceId, page, quote }]. 승격 게이트의 한 축.
  sourceRefs: jsonb("source_refs")
    .$type<Array<{ sourceId: string; page: number | null; quote: string }>>()
    .default(sql`'[]'::jsonb`)
    .notNull(),
  // 원천 문서 FK. 문서가 삭제돼도 lesson 은 남긴다(set null).
  sourceId: uuid("source_id").references(() => knowledgeSources.id, { onDelete: "set null" }),
  // golden_set 사례 참조(선택). 승격 게이트의 다른 한 축.
  goldenCaseRef: text("golden_case_ref"),
  // 예: "2026 LIPS 2차". 문서에서 확인되면 기입.
  programRound: text("program_round"),
  validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
  // 이 날짜 이후 재검토 필요(회차 갱신 주기 기반). null 이면 상시 유효.
  reviewBy: timestamp("review_by", { withTimezone: true }),
  // 'proposed' | 'approved' | 'rejected' | 'retired'
  status: text("status").default("proposed").notNull(),
  lessonVer: text("lesson_ver").default("v1").notNull(),
  // 승인/기각한 사람 이메일 + 시점 + 사유.
  curatedBy: text("curated_by"),
  curatedAt: timestamp("curated_at", { withTimezone: true }),
  curationNote: text("curation_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  statusIdx: index("review_lessons_status_idx").on(table.status),
  statusTargetIdx: index("review_lessons_status_target_idx").on(table.status, table.target),
  sourceIdx: index("review_lessons_source_idx").on(table.sourceId),
}));
