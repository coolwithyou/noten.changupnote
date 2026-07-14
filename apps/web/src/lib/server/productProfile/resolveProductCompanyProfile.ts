import type {
  CompanyProfile,
  CompanyProfileEvidenceObservation,
  CompanyProfileQuestionAnswerState,
  ConsentRecordDto,
  ConsentScope,
  CriterionDimension,
  MatchingProfileView,
  MatchingProfileViewRow,
} from "@cunote/contracts";
import { isValidBizNoChecksum } from "@cunote/contracts";
import {
  OPERATIONAL_PROFILE_DIMENSIONS,
  assembleCompanyProfile,
  companyProfileToFieldUpdates,
  companyProfileValueForDimension,
  normalizeCompanyIndustryProfile,
  type CompanyProfileAssemblyDecision,
  type CompanyProfileFieldUpdate,
  type CompanyRecord,
  type EnrichmentCacheEntry,
  type ReadEnrichmentCacheInput,
  type SaveCompanyProfileInput,
} from "@cunote/core";
import { buildCachedTeaserProfileEnrichment } from "@/lib/server/teaser/cachedProfileEnrichment";

export type ProductProfileAccessContext =
  | "anonymous_teaser"
  | "owned_read"
  | "owned_refresh"
  | "system_recompute";

export type ProductProfileSourceId =
  | "anonymous_ephemeral"
  | "portable_user_answer"
  | "popbill_cache"
  | "popbill_refresh"
  | "nts_cache"
  | "smpp_cache"
  | "apick_cache"
  | "startup_confirmation_cache"
  | "kipris_cache"
  | "opendart_cache"
  | "public_registry"
  | "insurance_profile"
  | "derived_profile"
  | "codef_hometax"
  | "codef_insurance"
  | "nice_demo"
  | "unsupported_provider";

export type ProductProfileSourceClassification = "public" | "owner" | "consent" | "disabled";

export interface ProductProfileSourcePolicy {
  id: ProductProfileSourceId;
  classification: ProductProfileSourceClassification;
  consentScope: ConsentScope | null;
  acquisition: "request_only" | "cache_only" | "owner_refresh" | "none";
  match: "exact" | "fuzzy";
  absence: "authoritative" | "positive_only" | "none";
  ttlMs: number | null;
  timeoutMs: number;
  callBudget: number;
  failure: "required_base" | "optional_overlay" | "fail_closed";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fixed policy table. Adding a producer requires an explicit row and tests. */
export const PRODUCT_PROFILE_SOURCE_POLICIES: readonly ProductProfileSourcePolicy[] = [
  policy("anonymous_ephemeral", "owner", null, "request_only", "exact", "none", null, 0, 0, "optional_overlay"),
  policy("portable_user_answer", "owner", null, "none", "exact", "none", null, 0, 0, "optional_overlay"),
  policy("popbill_cache", "public", null, "cache_only", "exact", "positive_only", 30 * DAY_MS, 1_500, 0, "required_base"),
  policy("popbill_refresh", "consent", "basic_info", "owner_refresh", "exact", "positive_only", 30 * DAY_MS, 8_000, 1, "optional_overlay"),
  policy("nts_cache", "public", null, "cache_only", "exact", "authoritative", DAY_MS, 1_500, 0, "optional_overlay"),
  policy("smpp_cache", "public", null, "cache_only", "exact", "positive_only", 30 * DAY_MS, 1_500, 0, "optional_overlay"),
  policy("apick_cache", "public", null, "cache_only", "exact", "positive_only", 30 * DAY_MS, 1_500, 0, "optional_overlay"),
  policy("startup_confirmation_cache", "public", null, "cache_only", "exact", "positive_only", 30 * DAY_MS, 1_500, 0, "optional_overlay"),
  policy("kipris_cache", "public", null, "cache_only", "exact", "positive_only", 30 * DAY_MS, 1_500, 0, "optional_overlay"),
  policy("opendart_cache", "public", null, "cache_only", "exact", "positive_only", 30 * DAY_MS, 1_500, 0, "optional_overlay"),
  policy("public_registry", "public", null, "cache_only", "exact", "positive_only", null, 1_500, 0, "optional_overlay"),
  policy("insurance_profile", "consent", "insurance", "none", "exact", "positive_only", null, 0, 0, "optional_overlay"),
  policy("derived_profile", "owner", null, "none", "exact", "none", null, 0, 0, "optional_overlay"),
  // Current CODEF cache/company rows are bizNo-global or shared and do not carry a safe consent owner/version.
  policy("codef_hometax", "disabled", "hometax", "none", "exact", "none", null, 0, 0, "fail_closed"),
  policy("codef_insurance", "disabled", "insurance", "none", "exact", "none", null, 0, 0, "fail_closed"),
  // No production contract or approved source semantics exist for the demo path.
  policy("nice_demo", "disabled", null, "none", "fuzzy", "none", null, 0, 0, "fail_closed"),
  policy("unsupported_provider", "disabled", null, "none", "fuzzy", "none", null, 0, 0, "fail_closed"),
] as const;

export type ProductProfileSourceState =
  | "consumed"
  | "disabled"
  | "not_authorized"
  | "unavailable"
  | "failed";

export interface ProductProfileSourceReceipt {
  source: ProductProfileSourceId;
  state: ProductProfileSourceState;
  observationCount: number;
  reason: string;
}

type MatchingProfileStatus = MatchingProfileViewRow["status"];

export interface ProductProfileResolverCompanies {
  listUserCompanies(userId: string): Promise<CompanyRecord[]>;
  resolveCompanyProfile(input: { companyId?: string; bizNo?: string; userId?: string }): Promise<CompanyProfile | null>;
  saveCompanyProfile(input: SaveCompanyProfileInput): Promise<CompanyProfile>;
}

export interface ProductProfileResolverDependencies {
  companies: ProductProfileResolverCompanies;
  enrichmentCache: {
    getFresh(input: ReadEnrichmentCacheInput): Promise<EnrichmentCacheEntry | null>;
  };
  consents: {
    listCompanyConsents(companyId: string, userId: string): Promise<ConsentRecordDto[]>;
  };
  refreshOwnedSource?: (input: {
    source: "popbill_refresh";
    companyId: string;
    userId: string;
    bizNo: string;
    asOf: string;
  }) => Promise<CompanyProfile>;
}

interface CommonResolveInput {
  asOf: string;
}

export type ResolveProductCompanyProfileInput =
  | (CommonResolveInput & {
    context: "anonymous_teaser";
    bizNo?: string;
    ephemeralProfile?: CompanyProfile;
  })
  | (CommonResolveInput & {
    context: "owned_read";
    companyId: string;
    userId: string;
  })
  | (CommonResolveInput & {
    context: "owned_refresh";
    companyId: string;
    userId: string;
    bizNo: string;
    source: "popbill_refresh";
  })
  | (CommonResolveInput & {
    context: "system_recompute";
    companyId: string;
    userId?: string;
  });

export interface ResolvedProductCompanyProfile {
  context: ProductProfileAccessContext;
  asOf: string;
  stateScope: "request" | "user" | "company";
  profile: CompanyProfile;
  decisions: CompanyProfileAssemblyDecision[];
  view: MatchingProfileView;
  sourceReceipts: ProductProfileSourceReceipt[];
  persistence: "none" | "saved";
  refreshStatus: "not_requested" | "succeeded" | "failed";
}

export class ProductProfileResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ProductProfileResolutionError";
  }
}

interface ProfileInput {
  source: ProductProfileSourceId;
  profile: CompanyProfile;
  scopeOverride?: "shared" | "user";
  persistenceClass?: "portable_user_answer" | "versioned_provider_observation";
}

const ANONYMOUS_CACHE_KEYS: ReadonlyArray<{
  source: ProductProfileSourceId;
  provider: string;
  scope: string;
}> = [
  { source: "popbill_cache", provider: "popbill", scope: "checkBizInfo" },
  { source: "apick_cache", provider: "apick", scope: "bizDetail" },
  { source: "startup_confirmation_cache", provider: "kised", scope: "startup-confirmation" },
  { source: "kipris_cache", provider: "kipris", scope: "applicant-business-number" },
];

const OPERATIONAL_DIMENSION_SET = new Set<CriterionDimension>(OPERATIONAL_PROFILE_DIMENSIONS);
const POLICY_BY_ID = new Map(PRODUCT_PROFILE_SOURCE_POLICIES.map((entry) => [entry.id, entry]));

export async function resolveProductCompanyProfile(
  input: ResolveProductCompanyProfileInput,
  dependencies: ProductProfileResolverDependencies,
): Promise<ResolvedProductCompanyProfile> {
  const asOf = requireIsoTimestamp(input.asOf);
  const activeConsents = new Set<ConsentScope>();
  const receipts = initializeReceipts(input, activeConsents);
  const profileInputs: ProfileInput[] = [];
  let persistence: ResolvedProductCompanyProfile["persistence"] = "none";
  let refreshStatus: ResolvedProductCompanyProfile["refreshStatus"] = "not_requested";

  if (input.context === "anonymous_teaser") {
    if (!input.bizNo && !input.ephemeralProfile) {
      throw new ProductProfileResolutionError(
        "biz_no_required",
        "사업자번호 또는 현재 요청의 회사 답변이 필요합니다.",
        400,
        "bizNo",
      );
    }
    if (input.bizNo) {
      const bizNo = normalizeBizNo(input.bizNo);
      profileInputs.push(...await readAnonymousCacheProfiles({
        bizNo,
        asOf,
        dependencies,
        receipts,
      }));
    }
    if (input.ephemeralProfile) {
      profileInputs.push({
        source: "anonymous_ephemeral",
        profile: input.ephemeralProfile,
        scopeOverride: "user",
        persistenceClass: "portable_user_answer",
      });
    }
  } else if (input.context === "owned_read" || input.context === "owned_refresh") {
    const company = await requireOwnedCompany(input.companyId, input.userId, dependencies);
    if (input.context === "owned_refresh" && company.role === "viewer") {
      throw new ProductProfileResolutionError(
        "company_write_forbidden",
        "해당 회사 정보를 수정할 권한이 없습니다.",
        403,
        "companyId",
      );
    }
    await loadActiveConsents(input.companyId, input.userId, activeConsents, dependencies);
    resetReceiptAuthorization(input, activeConsents, receipts);
    const ownedName = company.profile.name ?? company.name ?? undefined;
    profileInputs.push({
      source: "portable_user_answer",
      profile: {
        ...company.profile,
        id: company.profile.id ?? company.id,
        ...(ownedName ? { name: ownedName } : {}),
      },
    });

    if (input.context === "owned_refresh") {
      const refreshPolicy = requirePolicy(input.source);
      if (!isPolicyAllowed(refreshPolicy, input, activeConsents)) {
        throw new ProductProfileResolutionError(
          "consent_required",
          `${refreshPolicy.consentScope ?? "basic_info"} 동의가 필요합니다.`,
          403,
          "scope",
        );
      }
      const refresh = dependencies.refreshOwnedSource;
      if (!refresh) {
        markReceipt(receipts, input.source, "unavailable", "refresh_adapter_unavailable");
        refreshStatus = "failed";
      } else {
        try {
          const refreshed = await refresh({
            source: input.source,
            companyId: input.companyId,
            userId: input.userId,
            bizNo: normalizeBizNo(input.bizNo),
            asOf,
          });
          profileInputs.push({
            source: input.source,
            profile: refreshed,
            scopeOverride: "user",
            persistenceClass: "versioned_provider_observation",
          });
          refreshStatus = "succeeded";
        } catch {
          markReceipt(receipts, input.source, "failed", "refresh_failed");
          refreshStatus = "failed";
        }
      }
    }
  } else {
    const profile = await dependencies.companies.resolveCompanyProfile({
      companyId: input.companyId,
      ...(input.userId ? { userId: input.userId } : {}),
    });
    if (!profile) {
      throw new ProductProfileResolutionError(
        "company_not_found",
        "회사를 찾지 못했습니다.",
        404,
        "companyId",
      );
    }
    if (input.userId) {
      await loadActiveConsents(input.companyId, input.userId, activeConsents, dependencies);
      resetReceiptAuthorization(input, activeConsents, receipts);
    }
    profileInputs.push({ source: "portable_user_answer", profile });
  }

  const updates = collectAllowedUpdates(input, profileInputs, activeConsents, receipts, asOf);
  if (input.context === "anonymous_teaser" && updates.length === 0) {
    throw new ProductProfileResolutionError(
      "product_profile_unavailable",
      "안전하게 사용할 수 있는 회사 프로필을 찾지 못했습니다.",
      503,
      "bizNo",
    );
  }
  const assembled = assembleCompanyProfile({
    baseProfile: buildIdentityBaseProfile(profileInputs),
    updates,
    asOf,
  });
  let profile = withAllowedQuestionState(assembled.profile, input, profileInputs);

  if (input.context === "owned_refresh" && refreshStatus === "succeeded") {
    profile = await dependencies.companies.saveCompanyProfile({
      companyId: input.companyId,
      userId: input.userId,
      profile,
    });
    persistence = "saved";
  }

  return {
    context: input.context,
    asOf,
    stateScope: stateScopeFor(input),
    profile,
    decisions: assembled.decisions,
    view: buildMatchingProfileView(profile, asOf),
    sourceReceipts: [...receipts.values()].sort((left, right) => left.source.localeCompare(right.source)),
    persistence,
    refreshStatus,
  };
}

/** Shared match_state is company-scoped, so system jobs must never materialize a user overlay. */
export function resolveSystemProductCompanyProfile(
  input: { companyId: string; asOf: string },
  dependencies: Pick<ProductProfileResolverDependencies, "companies" | "enrichmentCache">,
): Promise<ResolvedProductCompanyProfile> {
  return resolveProductCompanyProfile({
    context: "system_recompute",
    companyId: input.companyId,
    asOf: input.asOf,
  }, {
    ...dependencies,
    consents: {
      listCompanyConsents: async () => [],
    },
  });
}

function buildIdentityBaseProfile(profiles: readonly ProfileInput[]): CompanyProfile {
  const base: CompanyProfile = { confidence: {} };
  for (const item of profiles) {
    const id = safeText(item.profile.id);
    const name = safeText(item.profile.name);
    if (id) base.id = id;
    if (name) base.name = name;
    if (typeof item.profile.is_preliminary === "boolean") {
      base.is_preliminary = item.profile.is_preliminary;
    }
  }
  return base;
}

export function buildMatchingProfileView(profile: CompanyProfile, asOf: string): MatchingProfileView {
  const rows = OPERATIONAL_PROFILE_DIMENSIONS.map((dimension): MatchingProfileViewRow => {
    const evidence = profile.profile_evidence?.[dimension];
    const value = companyProfileValueForDimension(profile, dimension);
    const displayValue = displayValueForDimension(profile, dimension);
    const hasKnownAbsence = Array.isArray(value) && value.length === 0 && evidence?.axisCompleteness === "complete";
    const hasValue = displayValue !== null || hasKnownAbsence;
    const status: MatchingProfileStatus = !hasValue
      ? "unknown"
      : evidence?.axisCompleteness === "complete"
        ? "known"
        : "partial";
    const editMode = editModeForDimension(dimension);
    return {
      dimension,
      status,
      displayValue: hasKnownAbsence ? "해당 없음" : displayValue,
      sourceKind: evidence?.sourceKind ?? null,
      sourceLabel: evidence ? safeSourceLabel(evidence.provider) : null,
      asOf: evidence?.asOf ?? null,
      completeness: evidence?.axisCompleteness ?? (status === "unknown" ? "not_covered" : null),
      editMode,
      action: actionForRow({ dimension, status, editMode }),
    };
  });
  return {
    asOf: requireIsoTimestamp(asOf),
    knownCount: rows.filter((row) => row.status === "known").length,
    partialCount: rows.filter((row) => row.status === "partial").length,
    unknownCount: rows.filter((row) => row.status === "unknown").length,
    rows,
  };
}

async function readAnonymousCacheProfiles(input: {
  bizNo: string;
  asOf: string;
  dependencies: ProductProfileResolverDependencies;
  receipts: Map<ProductProfileSourceId, ProductProfileSourceReceipt>;
}): Promise<ProfileInput[]> {
  const reads = await Promise.all(ANONYMOUS_CACHE_KEYS.map(async (key) => {
    try {
      const entry = await input.dependencies.enrichmentCache.getFresh({
        provider: key.provider,
        scope: key.scope,
        bizNo: input.bizNo,
        now: new Date(input.asOf),
      });
      return { key, entry };
    } catch {
      markReceipt(input.receipts, key.source, "failed", "cache_read_failed");
      return { key, entry: null };
    }
  }));
  const result: ProfileInput[] = [];
  for (const { key, entry } of reads) {
    if (!entry) continue;
    const profile = profileFromAnonymousCache(entry, key.source);
    if (!profile) continue;
    result.push({
      source: key.source,
      profile,
      scopeOverride: "shared",
      persistenceClass: "versioned_provider_observation",
    });
  }
  return result;
}

function profileFromAnonymousCache(
  entry: EnrichmentCacheEntry,
  source: ProductProfileSourceId,
): CompanyProfile | null {
  if (source === "popbill_cache") {
    const profile = entry.canonicalPayload?.profile;
    if (!isRecord(profile)) return null;
    try {
      return normalizeCompanyIndustryProfile(profile as CompanyProfile);
    } catch {
      return null;
    }
  }
  return buildCachedTeaserProfileEnrichment([entry]).profiles[0] ?? null;
}

function collectAllowedUpdates(
  input: ResolveProductCompanyProfileInput,
  profiles: ProfileInput[],
  activeConsents: ReadonlySet<ConsentScope>,
  receipts: Map<ProductProfileSourceId, ProductProfileSourceReceipt>,
  asOf: string,
): CompanyProfileFieldUpdate[] {
  const updates: CompanyProfileFieldUpdate[] = [];
  for (const item of profiles) {
    const evidenceBacked = companyProfileToFieldUpdates(item.profile, {
      ...(item.scopeOverride ? { scope: item.scopeOverride } : {}),
      ...(item.persistenceClass ? { persistenceClass: item.persistenceClass } : {}),
      resolverVersion: "product-profile-r2-v1",
    });
    const candidates = item.source === "portable_user_answer"
      ? [...evidenceBacked, ...legacyPortableProfileUpdates(item.profile, asOf)]
      : evidenceBacked;
    for (const update of candidates) {
      if (!OPERATIONAL_DIMENSION_SET.has(update.field)) continue;
      const source = sourceForUpdate(update, item.source);
      const sourcePolicy = requirePolicy(source);
      if (!isUpdateAllowed(update, sourcePolicy, input, activeConsents, item.source)) {
        if (sourcePolicy.classification !== "disabled") {
          markReceipt(receipts, source, "not_authorized", "scope_or_consent_not_allowed");
        }
        continue;
      }
      const supplementalEvidence = (update.supplementalEvidence ?? []).filter((evidence) =>
        isObservationAllowed(evidence, input, activeConsents));
      updates.push({
        ...update,
        ...(supplementalEvidence.length > 0 ? { supplementalEvidence } : { supplementalEvidence: [] }),
      });
      incrementConsumed(receipts, source);
    }
  }
  return updates;
}

/** Single compatibility adapter for pre-evidence persisted user profiles. */
function legacyPortableProfileUpdates(profile: CompanyProfile, asOf: string): CompanyProfileFieldUpdate[] {
  const updates: CompanyProfileFieldUpdate[] = [];
  for (const field of OPERATIONAL_PROFILE_DIMENSIONS) {
    if (profile.profile_evidence?.[field]) continue;
    const value = companyProfileValueForDimension(profile, field);
    if (value === undefined || value === null) continue;
    const listCompleteness = isListDimension(field) ? profile.list_completeness?.[field] ?? "partial" : "complete";
    updates.push({
      field,
      value,
      mode: isListDimension(field) && listCompleteness === "partial" ? "merge" : "replace",
      sourceKind: "self_declared",
      provider: "legacy_company_profile",
      asOf,
      axisCompleteness: listCompleteness,
      confidence: profile.confidence?.[field] ?? 0.6,
      observation: {
        scope: "user",
        persistenceClass: "portable_user_answer",
        resolverVersion: "product-profile-r4-legacy-adapter-v1",
      },
    });
  }
  return updates;
}

function isListDimension(field: CriterionDimension): field is "industry" | "founder_trait" | "certification" | "prior_award" | "ip" | "target_type" {
  return field === "industry" || field === "founder_trait" || field === "certification" ||
    field === "prior_award" || field === "ip" || field === "target_type";
}

function isUpdateAllowed(
  update: CompanyProfileFieldUpdate,
  sourcePolicy: ProductProfileSourcePolicy,
  input: ResolveProductCompanyProfileInput,
  activeConsents: ReadonlySet<ConsentScope>,
  origin: ProductProfileSourceId,
): boolean {
  if (!isPolicyAllowed(sourcePolicy, input, activeConsents)) return false;
  if (origin === "anonymous_ephemeral") return input.context === "anonymous_teaser";
  const scope = update.observation?.scope;
  if (input.context === "system_recompute" && !input.userId && scope === "user") return false;
  if (sourcePolicy.classification === "owner" || sourcePolicy.classification === "consent") {
    return scope === "user";
  }
  return input.context !== "system_recompute" || Boolean(input.userId) || scope !== "user";
}

function isObservationAllowed(
  observation: CompanyProfileEvidenceObservation,
  input: ResolveProductCompanyProfileInput,
  activeConsents: ReadonlySet<ConsentScope>,
): boolean {
  const policyEntry = requirePolicy(sourceForProvider(observation.provider, observation.sourceKind, undefined));
  if (!isPolicyAllowed(policyEntry, input, activeConsents)) return false;
  if (input.context === "system_recompute" && !input.userId && observation.scope === "user") return false;
  if (policyEntry.classification === "owner" || policyEntry.classification === "consent") {
    return observation.scope === "user";
  }
  return true;
}

function sourceForUpdate(update: CompanyProfileFieldUpdate, origin: ProductProfileSourceId): ProductProfileSourceId {
  if (origin === "anonymous_ephemeral") return origin;
  const provider = update.provider?.trim().toLowerCase() ?? "";
  if (
    (origin === "popbill_cache" && provider === "popbill") ||
    (origin === "apick_cache" && provider === "apick") ||
    (origin === "startup_confirmation_cache" && (provider === "kised" || provider === "startup_confirmation")) ||
    (origin === "kipris_cache" && provider === "kipris") ||
    (origin === "popbill_refresh" && provider === "popbill")
  ) return origin;
  return sourceForProvider(provider, update.sourceKind, update.field);
}

function sourceForProvider(
  rawProvider: string,
  sourceKind: CompanyProfileEvidenceObservation["sourceKind"] | undefined,
  field: CriterionDimension | undefined,
): ProductProfileSourceId {
  const provider = rawProvider.trim().toLowerCase();
  if (sourceKind === "self_declared" || provider.startsWith("cunote_") || provider === "user" || provider === "manual" || provider === "legacy_company_profile") {
    return "portable_user_answer";
  }
  if (provider === "popbill") return "popbill_refresh";
  if (provider === "nts") return "nts_cache";
  if (provider === "smpp") return "smpp_cache";
  if (provider === "apick") return "apick_cache";
  if (provider === "kised" || provider === "startup_confirmation") return "startup_confirmation_cache";
  if (provider === "kipris") return "kipris_cache";
  if (provider === "dart" || provider === "opendart") return "opendart_cache";
  if (provider === "fsc" || provider === "registry") return "public_registry";
  if (provider === "kcomwel" || provider === "insurance") return "insurance_profile";
  if (provider === "codef") return field === "insured_workforce" ? "codef_insurance" : "codef_hometax";
  if (provider === "nice") return "nice_demo";
  if (sourceKind === "derived") return "derived_profile";
  return "unsupported_provider";
}

function initializeReceipts(
  input: ResolveProductCompanyProfileInput,
  activeConsents: ReadonlySet<ConsentScope>,
): Map<ProductProfileSourceId, ProductProfileSourceReceipt> {
  return new Map(PRODUCT_PROFILE_SOURCE_POLICIES.map((entry) => {
    const allowed = isPolicyAllowed(entry, input, activeConsents);
    const state: ProductProfileSourceState = entry.classification === "disabled"
      ? "disabled"
      : allowed
        ? "unavailable"
        : "not_authorized";
    return [entry.id, {
      source: entry.id,
      state,
      observationCount: 0,
      reason: entry.classification === "disabled"
        ? "policy_disabled"
        : allowed
          ? "no_materialized_observation"
          : "context_or_consent_not_allowed",
    }];
  }));
}

function resetReceiptAuthorization(
  input: ResolveProductCompanyProfileInput,
  activeConsents: ReadonlySet<ConsentScope>,
  receipts: Map<ProductProfileSourceId, ProductProfileSourceReceipt>,
): void {
  for (const entry of PRODUCT_PROFILE_SOURCE_POLICIES) {
    if (entry.classification === "disabled") continue;
    const current = receipts.get(entry.id);
    if (!current || current.state === "consumed" || current.state === "failed") continue;
    const allowed = isPolicyAllowed(entry, input, activeConsents);
    receipts.set(entry.id, {
      ...current,
      state: allowed ? "unavailable" : "not_authorized",
      reason: allowed ? "no_materialized_observation" : "context_or_consent_not_allowed",
    });
  }
}

function isPolicyAllowed(
  sourcePolicy: ProductProfileSourcePolicy,
  input: ResolveProductCompanyProfileInput,
  activeConsents: ReadonlySet<ConsentScope>,
): boolean {
  if (sourcePolicy.classification === "disabled") return false;
  if (sourcePolicy.id === "anonymous_ephemeral") return input.context === "anonymous_teaser";
  if (sourcePolicy.classification === "public") return true;
  const hasUserScope = input.context === "owned_read" || input.context === "owned_refresh" ||
    (input.context === "system_recompute" && Boolean(input.userId));
  if (!hasUserScope) return false;
  if (sourcePolicy.classification === "owner") return true;
  return Boolean(sourcePolicy.consentScope && activeConsents.has(sourcePolicy.consentScope));
}

async function requireOwnedCompany(
  companyId: string,
  userId: string,
  dependencies: ProductProfileResolverDependencies,
): Promise<CompanyRecord> {
  let companies: CompanyRecord[];
  try {
    companies = await dependencies.companies.listUserCompanies(userId);
  } catch {
    throw new ProductProfileResolutionError(
      "company_access_unavailable",
      "회사 접근 권한을 확인하지 못했습니다.",
      503,
      "companyId",
    );
  }
  const company = companies.find((entry) => entry.id === companyId);
  if (!company) {
    throw new ProductProfileResolutionError(
      "company_forbidden",
      "해당 회사에 접근할 권한이 없습니다.",
      403,
      "companyId",
    );
  }
  return company;
}

async function loadActiveConsents(
  companyId: string,
  userId: string,
  target: Set<ConsentScope>,
  dependencies: ProductProfileResolverDependencies,
): Promise<void> {
  let consents: ConsentRecordDto[];
  try {
    consents = await dependencies.consents.listCompanyConsents(companyId, userId);
  } catch {
    throw new ProductProfileResolutionError(
      "consent_unavailable",
      "동의 상태를 확인하지 못했습니다.",
      503,
      "scope",
    );
  }
  for (const consent of consents) if (consent.revokedAt === null) target.add(consent.scope);
}

function withAllowedQuestionState(
  profile: CompanyProfile,
  input: ResolveProductCompanyProfileInput,
  profiles: ProfileInput[],
): CompanyProfile {
  if (input.context === "system_recompute" && !input.userId) return profile;
  const states = new Map<CriterionDimension, CompanyProfileQuestionAnswerState>();
  for (const item of profiles) {
    if (item.source !== "anonymous_ephemeral" && item.source !== "portable_user_answer") continue;
    for (const [rawDimension, state] of Object.entries(item.profile.question_answer_state ?? {})) {
      if (!state) continue;
      const dimension = rawDimension as CriterionDimension;
      const current = states.get(dimension);
      if (!current || current.answeredAt.localeCompare(state.answeredAt) < 0) states.set(dimension, state);
    }
  }
  if (states.size === 0) return profile;
  return { ...profile, question_answer_state: Object.fromEntries(states) };
}

function displayValueForDimension(
  profile: CompanyProfile,
  dimension: (typeof OPERATIONAL_PROFILE_DIMENSIONS)[number],
): string | null {
  switch (dimension) {
    case "region": return profile.region?.label ?? profile.region?.code ?? null;
    case "biz_age": return formatMonths(profile.biz_age_months);
    case "industry": return joinSafe([...(profile.industries ?? []), ...(profile.industry_codes ?? [])]);
    case "size": return safeText(profile.size);
    case "revenue": return formatKrw(profile.revenue_krw);
    case "employees": return formatCount(profile.employees_count, "명");
    case "founder_age": return formatCount(profile.founder_age, "세");
    case "founder_trait": return joinSafe(profile.traits);
    case "certification": return joinSafe(profile.certs);
    case "prior_award": return joinSafe([
      ...(profile.prior_award_history?.records.flatMap((record) => record.program ? [record.program] : []) ?? []),
      ...(profile.prior_awards ?? []),
    ]);
    case "ip": return joinSafe(profile.ip);
    case "target_type": return joinSafe(profile.target_types);
    case "business_status": return profile.business_status?.label ??
      (profile.business_status?.active === true ? "정상 영업" : profile.business_status?.active === false ? "확인 필요" : null);
    case "tax_compliance": return formatDisqualification(profile.tax_compliance);
    case "credit_status": return formatDisqualification(profile.credit_status);
    case "sanction": return formatDisqualification(profile.sanction);
    case "financial_health": return joinSafe([
      formatPercent("부채비율", profile.financial_health?.debt_ratio_pct),
      safeText(profile.financial_health?.impairment ? `자본잠식 ${profile.financial_health.impairment}` : null),
      formatNumber("이자보상배율", profile.financial_health?.interest_coverage_ratio),
      formatKrwLabeled("자산", profile.financial_health?.total_assets_krw),
      formatKrwLabeled("자본", profile.financial_health?.equity_krw),
    ]);
    case "insured_workforce": return joinSafe([
      typeof profile.insured_workforce?.employment_insurance_active === "boolean"
        ? `고용보험 ${profile.insured_workforce.employment_insurance_active ? "가입" : "미가입"}`
        : null,
      typeof profile.insured_workforce?.insured_count === "number"
        ? `피보험자 ${profile.insured_workforce.insured_count.toLocaleString("ko-KR")}명`
        : null,
      profile.insured_workforce?.no_layoff === true
        ? "최근 감원 없음"
        : formatCount(profile.insured_workforce?.months_since_last_layoff, "개월 전 감원"),
    ]);
    case "investment": return joinSafe([
      formatKrwLabeled("누적 투자", profile.investment?.total_raised_krw),
      safeText(profile.investment?.last_round ? `최근 ${profile.investment.last_round}` : null),
      profile.investment?.tips_backed === true ? "TIPS 선정" : profile.investment?.tips_backed === false ? "TIPS 미선정" : null,
    ]);
  }
}

function editModeForDimension(
  dimension: (typeof OPERATIONAL_PROFILE_DIMENSIONS)[number],
): MatchingProfileViewRow["editMode"] {
  if (dimension === "business_status") return "read_only";
  if (
    dimension === "tax_compliance" || dimension === "credit_status" || dimension === "sanction" ||
    dimension === "financial_health" || dimension === "insured_workforce" || dimension === "investment" ||
    dimension === "prior_award"
  ) return "question_only";
  return "direct";
}

function actionForRow(input: {
  dimension: MatchingProfileViewRow["dimension"];
  status: MatchingProfileStatus;
  editMode: MatchingProfileViewRow["editMode"];
}): MatchingProfileViewRow["action"] {
  if (input.status === "known") return { kind: "none", label: "확인됨" };
  if (input.dimension === "business_status") return { kind: "refresh", label: "기본정보 새로고침" };
  if (input.dimension === "insured_workforce") return { kind: "connect", label: "고용정보 연결" };
  if (input.dimension === "tax_compliance" || input.dimension === "financial_health") {
    return { kind: "connect", label: "세무정보 연결" };
  }
  return { kind: "answer", label: input.editMode === "direct" ? "입력하기" : "질문에 답하기" };
}

function safeSourceLabel(provider: string): string {
  const labels: Record<string, string> = {
    popbill: "사업자 기본정보",
    nts: "국세청",
    smpp: "공공구매 확인정보",
    apick: "기업 기본정보 캐시",
    kised: "창업기업 확인정보",
    startup_confirmation: "창업기업 확인정보",
    kipris: "특허정보",
    dart: "전자공시",
    opendart: "전자공시",
    fsc: "공개 금융정보",
    registry: "공개 명단",
    kcomwel: "고용보험 정보",
    cunote_profile_question: "직접 답변",
    cunote_teaser_answer: "직접 답변",
    cunote_teaser_manual: "직접 입력",
    cunote_profile_question_range: "직접 답변",
    user: "직접 입력",
  };
  return labels[provider.trim().toLowerCase()] ?? "확인된 정보";
}

function formatDisqualification(value: CompanyProfile["tax_compliance"]): string | null {
  if (!value) return null;
  const flags = joinSafe(value.flags);
  if (flags) return flags;
  return value.known_flags.length > 0 ? "확인 완료" : null;
}

function formatMonths(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const months = Math.max(0, Math.trunc(value));
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  if (years === 0) return `${remainder}개월`;
  return remainder > 0 ? `${years}년 ${remainder}개월` : `${years}년`;
}

function formatKrw(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${Math.trunc(value).toLocaleString("ko-KR")}원`;
}

function formatKrwLabeled(label: string, value: number | null | undefined): string | null {
  const formatted = formatKrw(value);
  return formatted ? `${label} ${formatted}` : null;
}

function formatCount(value: number | null | undefined, suffix: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${Math.trunc(value).toLocaleString("ko-KR")}${suffix}`;
}

function formatPercent(label: string, value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${label} ${value.toLocaleString("ko-KR")}%`;
}

function formatNumber(label: string, value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${label} ${value.toLocaleString("ko-KR")}`;
}

function joinSafe(values: readonly (string | null | undefined)[] | undefined): string | null {
  const normalized = [...new Set((values ?? []).flatMap((value) => {
    const safe = safeText(value);
    return safe ? [safe] : [];
  }))].slice(0, 12);
  return normalized.length > 0 ? normalized.join(", ") : null;
}

function safeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 120) : null;
}

function stateScopeFor(input: ResolveProductCompanyProfileInput): ResolvedProductCompanyProfile["stateScope"] {
  if (input.context === "anonymous_teaser") return "request";
  if (input.context === "system_recompute" && !input.userId) return "company";
  return "user";
}

function incrementConsumed(
  receipts: Map<ProductProfileSourceId, ProductProfileSourceReceipt>,
  source: ProductProfileSourceId,
): void {
  const current = receipts.get(source);
  if (!current) return;
  receipts.set(source, {
    ...current,
    state: "consumed",
    observationCount: current.observationCount + 1,
    reason: "materialized",
  });
}

function markReceipt(
  receipts: Map<ProductProfileSourceId, ProductProfileSourceReceipt>,
  source: ProductProfileSourceId,
  state: ProductProfileSourceState,
  reason: string,
): void {
  const current = receipts.get(source);
  if (!current || current.state === "consumed") return;
  receipts.set(source, { ...current, state, reason });
}

function requirePolicy(source: ProductProfileSourceId): ProductProfileSourcePolicy {
  const entry = POLICY_BY_ID.get(source);
  if (!entry) throw new Error(`Product profile source policy missing: ${source}`);
  return entry;
}

function policy(
  id: ProductProfileSourceId,
  classification: ProductProfileSourceClassification,
  consentScope: ConsentScope | null,
  acquisition: ProductProfileSourcePolicy["acquisition"],
  match: ProductProfileSourcePolicy["match"],
  absence: ProductProfileSourcePolicy["absence"],
  ttlMs: number | null,
  timeoutMs: number,
  callBudget: number,
  failure: ProductProfileSourcePolicy["failure"],
): ProductProfileSourcePolicy {
  return { id, classification, consentScope, acquisition, match, absence, ttlMs, timeoutMs, callBudget, failure };
}

function normalizeBizNo(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!isValidBizNoChecksum(digits)) {
    throw new ProductProfileResolutionError(
      "invalid_biz_no",
      "유효하지 않은 사업자등록번호입니다.",
      400,
      "bizNo",
    );
  }
  return digits;
}

function requireIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new ProductProfileResolutionError("invalid_as_of", "asOf가 올바르지 않습니다.", 400, "asOf");
  }
  return parsed.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
