import type {
  CompanyProfile,
  CompanyProfileEvidenceObservation,
  CompanyProfileFieldEvidence,
  CompanyProfileObservationMetadata,
  CompanyProfileObservationPersistenceClass,
  CompanyProfileObservationScope,
  CriterionDimension,
} from "@cunote/contracts";
import { normalizeCompanyIndustryProfile } from "./profile-from-popbill.js";
import { resolveEvidencePrecedence, type EvidencePrecedenceResult } from "./evidence-priority.js";
import { updateCompanyProfileField, type CompanyProfileFieldUpdate } from "./update-profile-field.js";

export const COMPANY_PROFILE_ASSEMBLY_VERSION = "p1-v1";

export interface CanonicalCompanyProfileObservationIdentity {
  dimension: CriterionDimension;
  sourceKind: CompanyProfileEvidenceObservation["sourceKind"];
  provider: string;
  scope: CompanyProfileObservationScope;
  asOf: string;
  canonicalValue: string;
  observationId: string;
  observationVersion: string;
}

export interface CompanyProfileAssemblyDecision {
  sequence: number;
  field: CriterionDimension;
  observation: CanonicalCompanyProfileObservationIdentity;
  valueDisposition: "applied" | "merged_supplemental" | "retained" | "deduplicated" | "conflict_unknown";
  evidenceDisposition: "incoming_primary" | "current_primary_incoming_supplemental" | "conflict_supplemental";
  reason: EvidencePrecedenceResult["reason"] | "no_current_evidence" | "equal_value_tie" | "unequal_value_tie";
  primaryEvidence: CompanyProfileEvidenceObservation;
  supplementalEvidence: CompanyProfileEvidenceObservation[];
}

export interface AssembleCompanyProfileInput {
  baseProfile: CompanyProfile;
  updates: readonly CompanyProfileFieldUpdate[];
  /** Explicit deterministic boundary timestamp. No Date.now() is read here. */
  asOf: string;
}

export interface AssembleCompanyProfileResult {
  profile: CompanyProfile;
  decisions: CompanyProfileAssemblyDecision[];
}

interface Candidate {
  kind: "base" | "update";
  field: CriterionDimension;
  value: unknown;
  canonicalValue: string;
  evidence: CompanyProfileFieldEvidence;
  identity: CanonicalCompanyProfileObservationIdentity;
  update?: CompanyProfileFieldUpdate;
}

const TIE_REASONS = new Set<EvidencePrecedenceResult["reason"]>([
  "same_provider_tie",
  "unknown_provider_tie",
]);

/**
 * Production-safe pure assembly. Semantic evidence precedence remains owned by
 * resolveEvidencePrecedence(); canonical ordering is only used when that policy
 * returns a tie.
 */
export function assembleCompanyProfile(input: AssembleCompanyProfileInput): AssembleCompanyProfileResult {
  const boundaryAsOf = requireIsoTimestamp(input.asOf, "asOf");
  if (input.updates.length === 0) return { profile: cloneValue(input.baseProfile), decisions: [] };
  let profile = cloneValue(input.baseProfile);
  const candidatesByField = new Map<CriterionDimension, Candidate[]>();

  for (const [rawField, evidence] of Object.entries(input.baseProfile.profile_evidence ?? {})) {
    if (!evidence) continue;
    const field = rawField as CriterionDimension;
    const value = companyProfileValueForDimension(input.baseProfile, field);
    if (value === undefined) continue;
    addCandidate(candidatesByField, candidateFromBase(field, value, evidence, boundaryAsOf));
  }

  for (const update of input.updates) {
    addCandidate(candidatesByField, candidateFromUpdate(update, boundaryAsOf));
  }

  const decisions: Omit<CompanyProfileAssemblyDecision, "sequence">[] = [];
  for (const field of [...candidatesByField.keys()].sort()) {
    const candidates = candidatesByField.get(field) ?? [];
    const baseCandidate = candidates.find((candidate) => candidate.kind === "base");
    const ranked = [...candidates].sort(compareCandidatePriority);
    if (ranked.length === 0) continue;
    // Unknown-provider ties are not transitive with same-provider confidence
    // ordering. Keep only candidates that no other observation strictly beats
    // before applying the exact-tie conflict rule.
    const top = candidates.filter((candidate) => !candidates.some((other) =>
      other !== candidate && isStrictlyPreferred(other, candidate, field)));
    const topValues = new Set(top.map((candidate) => candidate.canonicalValue));
    const conflict = topValues.size > 1;
    const winner = [...top].sort(compareCandidateCanonicalKey)[0] ?? ranked[0]!;

    if (conflict) {
      profile = clearCompanyProfileDimension(profile, field);
    } else if (winner.kind === "update") {
      profile = applyCandidate(profile, winner);
    }

    let supplementalValueMerged = false;
    if (!conflict) {
      for (const candidate of ranked) {
        if (candidate === winner || candidate.kind !== "update") continue;
        if (!shouldMergeSupplementalValue(candidate, winner)) continue;
        profile = applyCandidate(profile, candidate);
        supplementalValueMerged = true;
      }
    }

    const fieldEvidence = conflict
      ? conflictEvidence(field, candidates, boundaryAsOf)
      : mergedCandidateEvidence(winner, candidates);
    profile = setFieldEvidence(profile, field, fieldEvidence, conflict ? null : winner, supplementalValueMerged);

    const updateCandidates = candidates
      .filter((candidate): candidate is Candidate & { kind: "update"; update: CompanyProfileFieldUpdate } =>
        candidate.kind === "update" && Boolean(candidate.update))
      .sort(compareCandidateCanonicalKey);
    for (const candidate of updateCandidates) {
      const duplicateOfWinner = !conflict && candidate !== winner && top.includes(candidate) &&
        candidate.canonicalValue === winner.canonicalValue;
      const supplementalMerge = !conflict && candidate !== winner && shouldMergeSupplementalValue(candidate, winner);
      const relation = candidate === winner
        ? relationReason(baseCandidate ?? winner, candidate, field)
        : relationReason(winner, candidate, field);
      decisions.push({
        field,
        observation: candidate.identity,
        valueDisposition: conflict && top.includes(candidate)
          ? "conflict_unknown"
          : candidate === winner
            ? "applied"
            : duplicateOfWinner
              ? "deduplicated"
              : supplementalMerge
                ? "merged_supplemental"
                : "retained",
        evidenceDisposition: conflict && top.includes(candidate)
          ? "conflict_supplemental"
          : candidate === winner
            ? "incoming_primary"
            : "current_primary_incoming_supplemental",
        reason: conflict && top.includes(candidate)
          ? "unequal_value_tie"
          : duplicateOfWinner
            ? "equal_value_tie"
            : relation,
        primaryEvidence: stripSupplemental(fieldEvidence),
        supplementalEvidence: [...(fieldEvidence.supplemental ?? [])],
      });
    }
  }

  profile = canonicalizeCompanyProfile(profile, new Set(candidatesByField.keys()));
  const sortedDecisions = decisions
    .sort((left, right) => left.field.localeCompare(right.field) ||
      canonicalObservationKey(left.observation).localeCompare(canonicalObservationKey(right.observation)))
    .map((decision, sequence) => ({ ...decision, sequence }));
  return { profile, decisions: sortedDecisions };
}

export function canonicalCompanyProfileObservationIdentity(input: {
  dimension: CriterionDimension;
  sourceKind: CompanyProfileEvidenceObservation["sourceKind"];
  provider: string;
  scope?: CompanyProfileObservationScope;
  asOf: string;
  value: unknown;
  observationId?: string;
  observationVersion?: string;
}): CanonicalCompanyProfileObservationIdentity {
  const sourceKind = input.sourceKind;
  const provider = normalizeProvider(input.provider);
  const scope = input.scope ?? defaultObservationScope(sourceKind);
  const asOf = requireIsoTimestamp(input.asOf, "observation.asOf");
  const canonicalValue = stableCanonicalStringify(input.value);
  const observationVersion = normalizeToken(input.observationVersion) ?? "1";
  const seed = stableCanonicalStringify({
    dimension: input.dimension,
    sourceKind,
    provider,
    scope,
    asOf,
    canonicalValue,
    observationVersion,
  });
  const observationId = normalizeToken(input.observationId) ?? `profile-observation-${stableHash(seed)}`;
  return {
    dimension: input.dimension,
    sourceKind,
    provider,
    scope,
    asOf,
    canonicalValue,
    observationId,
    observationVersion,
  };
}

/** Convert an evidence-backed profile snapshot into typed assembly updates. */
export function companyProfileToFieldUpdates(
  profile: CompanyProfile,
  options: {
    scope?: CompanyProfileObservationScope;
    persistenceClass?: CompanyProfileObservationPersistenceClass;
    resolverVersion?: string;
  } = {},
): CompanyProfileFieldUpdate[] {
  const updates: CompanyProfileFieldUpdate[] = [];
  for (const [rawField, evidence] of Object.entries(profile.profile_evidence ?? {})) {
    if (!evidence) continue;
    const field = rawField as CriterionDimension;
    const value = companyProfileValueForDimension(profile, field);
    if (value === undefined) continue;
    updates.push({
      field,
      value,
      mode: isListDimension(field) && evidence.axisCompleteness === "partial" ? "merge" : "replace",
      sourceKind: evidence.sourceKind,
      provider: evidence.provider,
      asOf: evidence.asOf,
      axisCompleteness: evidence.axisCompleteness,
      confidence: evidence.confidence,
      allowAuthoritativeOverride: true,
      ...(evidence.supplemental?.length ? { supplementalEvidence: evidence.supplemental } : {}),
      observation: {
        ...((options.scope ?? evidence.scope) ? { scope: options.scope ?? evidence.scope } : {}),
        ...(evidence.observationId ? { observationId: evidence.observationId } : {}),
        ...(evidence.observationVersion ? { observationVersion: evidence.observationVersion } : {}),
        ...(evidence.canonicalValue !== undefined ? { canonicalValue: evidence.canonicalValue } : {}),
        ...((options.persistenceClass ?? evidence.persistenceClass)
          ? { persistenceClass: options.persistenceClass ?? evidence.persistenceClass }
          : {}),
        ...((options.resolverVersion ?? evidence.resolverVersion)
          ? { resolverVersion: options.resolverVersion ?? evidence.resolverVersion }
          : {}),
      },
    });
  }
  return updates;
}

export function companyProfileValueForDimension(profile: CompanyProfile, field: CriterionDimension): unknown {
  switch (field) {
    case "region": return profile.region;
    case "biz_age": return profile.biz_age_months;
    case "industry": return profile.industries || profile.industry_codes
      ? [...(profile.industries ?? []), ...(profile.industry_codes ?? [])]
      : undefined;
    case "size": return profile.size;
    case "revenue": return profile.revenue_krw;
    case "employees": return profile.employees_count;
    case "founder_age": return profile.founder_age;
    case "founder_trait": return profile.traits;
    case "certification": return profile.certs;
    case "prior_award": return profile.prior_award_history ?? profile.prior_awards;
    case "ip": return profile.ip;
    case "target_type": return profile.target_types;
    case "business_status": return profile.business_status;
    case "tax_compliance": return profile.tax_compliance;
    case "credit_status": return profile.credit_status;
    case "sanction": return profile.sanction;
    case "financial_health": return profile.financial_health;
    case "insured_workforce": return profile.insured_workforce;
    case "investment": return profile.investment;
    case "other": return profile.other_conditions;
    case "premises":
    case "export_performance": return undefined;
  }
}

export function stableCanonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function candidateFromBase(
  field: CriterionDimension,
  value: unknown,
  evidence: CompanyProfileFieldEvidence,
  boundaryAsOf: string,
): Candidate {
  const identity = canonicalCompanyProfileObservationIdentity({
    dimension: field,
    sourceKind: evidence.sourceKind,
    provider: evidence.provider,
    ...(evidence.scope ? { scope: evidence.scope } : {}),
    asOf: evidence.asOf ?? boundaryAsOf,
    value,
    ...(evidence.observationId ? { observationId: evidence.observationId } : {}),
    ...(evidence.observationVersion ? { observationVersion: evidence.observationVersion } : {}),
  });
  return {
    kind: "base",
    field,
    value,
    canonicalValue: identity.canonicalValue,
    evidence: canonicalEvidence(evidence, identity, hasObservationMetadata(evidence)),
    identity,
  };
}

function candidateFromUpdate(update: CompanyProfileFieldUpdate, boundaryAsOf: string): Candidate {
  const sourceKind = update.sourceKind ?? "self_declared";
  const provider = update.provider?.trim() || (sourceKind === "self_declared" ? "user" : "unknown");
  const asOf = update.asOf ?? boundaryAsOf;
  const normalizedUpdate: CompanyProfileFieldUpdate = {
    ...update,
    sourceKind,
    provider,
    asOf,
    allowAuthoritativeOverride: true,
  };
  const normalizedProfile = normalizeCompanyIndustryProfile(updateCompanyProfileField(
    { confidence: {} },
    normalizedUpdate,
  ));
  const value = companyProfileValueForDimension(normalizedProfile, update.field);
  if (value === undefined) throw new Error(`${update.field} typed update가 canonical 값을 만들지 못했습니다.`);
  const identity = canonicalCompanyProfileObservationIdentity({
    dimension: update.field,
    sourceKind,
    provider,
    ...(update.observation?.scope ? { scope: update.observation.scope } : {}),
    asOf,
    value,
    ...(update.observation?.observationId ? { observationId: update.observation.observationId } : {}),
    ...(update.observation?.observationVersion
      ? { observationVersion: update.observation.observationVersion }
      : {}),
  });
  const evidence = normalizedProfile.profile_evidence?.[update.field];
  if (!evidence) throw new Error(`${update.field} typed update에 evidence metadata가 없습니다.`);
  return {
    kind: "update",
    field: update.field,
    value,
    canonicalValue: identity.canonicalValue,
    evidence: canonicalEvidence({
      ...evidence,
      ...(update.observation?.persistenceClass
        ? { persistenceClass: update.observation.persistenceClass }
        : {}),
      ...(update.observation?.resolverVersion
        ? { resolverVersion: update.observation.resolverVersion }
        : {}),
    }, identity, Boolean(update.observation && Object.keys(update.observation).length > 0)),
    identity,
    update: {
      ...normalizedUpdate,
      observation: observationMetadata(identity, update.observation),
    },
  };
}

function canonicalEvidence(
  evidence: CompanyProfileFieldEvidence,
  identity: CanonicalCompanyProfileObservationIdentity,
  includeIdentityMetadata: boolean,
): CompanyProfileFieldEvidence {
  const supplemental = [...(evidence.supplemental ?? [])]
    .map((item) => ({ ...item, provider: normalizeProvider(item.provider) }))
    .sort(compareEvidenceCanonical);
  return {
    sourceKind: identity.sourceKind,
    provider: identity.provider,
    asOf: evidence.asOf,
    axisCompleteness: evidence.axisCompleteness,
    confidence: evidence.confidence,
    ...(includeIdentityMetadata ? observationMetadata(identity, evidence) : {}),
    ...(supplemental.length > 0 ? { supplemental } : {}),
  };
}

function observationMetadata(
  identity: CanonicalCompanyProfileObservationIdentity,
  existing: CompanyProfileObservationMetadata | undefined,
): CompanyProfileObservationMetadata {
  return {
    scope: identity.scope,
    observationId: identity.observationId,
    observationVersion: identity.observationVersion,
    canonicalValue: identity.canonicalValue,
    ...(existing?.persistenceClass ? { persistenceClass: existing.persistenceClass } : {}),
    ...(existing?.resolverVersion ? { resolverVersion: existing.resolverVersion } : {}),
  };
}

function addCandidate(map: Map<CriterionDimension, Candidate[]>, candidate: Candidate): void {
  const values = map.get(candidate.field) ?? [];
  values.push(candidate);
  map.set(candidate.field, values);
}

function compareCandidatePriority(left: Candidate, right: Candidate): number {
  const result = resolveEvidencePrecedence({
    dimension: left.field,
    current: left.evidence,
    incoming: right.evidence,
  });
  if (TIE_REASONS.has(result.reason)) return compareCandidateCanonicalKey(left, right);
  return result.decision === "replace" ? 1 : -1;
}

function compareCandidateCanonicalKey(left: Candidate, right: Candidate): number {
  const semanticOrder = canonicalSemanticObservationKey(left.identity)
    .localeCompare(canonicalSemanticObservationKey(right.identity));
  if (semanticOrder !== 0) return semanticOrder;
  const metadataOrder = observationMetadataScore(right.evidence) - observationMetadataScore(left.evidence);
  if (metadataOrder !== 0) return metadataOrder;
  return canonicalObservationKey(left.identity).localeCompare(canonicalObservationKey(right.identity));
}

function isStrictlyPreferred(preferred: Candidate, current: Candidate, dimension: CriterionDimension): boolean {
  const result = resolveEvidencePrecedence({
    dimension,
    current: current.evidence,
    incoming: preferred.evidence,
  });
  return result.decision === "replace" && !TIE_REASONS.has(result.reason);
}

function relationReason(current: Candidate, incoming: Candidate, field: CriterionDimension): CompanyProfileAssemblyDecision["reason"] {
  if (current === incoming) return current.kind === "base" ? "no_current_evidence" : "no_current_evidence";
  const result = resolveEvidencePrecedence({ dimension: field, current: current.evidence, incoming: incoming.evidence });
  if (TIE_REASONS.has(result.reason) && current.canonicalValue === incoming.canonicalValue) return "equal_value_tie";
  return result.reason;
}

function applyCandidate(profile: CompanyProfile, candidate: Candidate): CompanyProfile {
  if (!candidate.update) return profile;
  const evidenceWithoutField = { ...(profile.profile_evidence ?? {}) };
  delete evidenceWithoutField[candidate.field];
  const seed: CompanyProfile = { ...profile, profile_evidence: evidenceWithoutField };
  if (Object.keys(evidenceWithoutField).length === 0) delete seed.profile_evidence;
  const incoming = normalizeCompanyIndustryProfile(updateCompanyProfileField(seed, {
    ...candidate.update,
    allowAuthoritativeOverride: true,
  }));
  return mergeWinningCompoundValue(profile, incoming, candidate.field);
}

function shouldMergeSupplementalValue(candidate: Candidate, winner: Candidate): boolean {
  if (candidate.update?.mode !== "merge" || candidate.evidence.sourceKind !== "self_declared") return false;
  return candidate.canonicalValue !== winner.canonicalValue && isSupplementalMergeDimension(candidate.field);
}

function mergeWinningCompoundValue(
  current: CompanyProfile,
  incoming: CompanyProfile,
  field: CriterionDimension,
): CompanyProfile {
  switch (field) {
    case "business_status": return {
      ...incoming,
      business_status: { ...(current.business_status ?? {}), ...(incoming.business_status ?? {}) },
    };
    case "financial_health": return {
      ...incoming,
      financial_health: { ...(current.financial_health ?? {}), ...(incoming.financial_health ?? {}) },
    };
    case "insured_workforce": return {
      ...incoming,
      insured_workforce: { ...(current.insured_workforce ?? {}), ...(incoming.insured_workforce ?? {}) },
    };
    case "investment": return {
      ...incoming,
      investment: { ...(current.investment ?? {}), ...(incoming.investment ?? {}) },
    };
    case "other": return {
      ...incoming,
      other_conditions: { ...(current.other_conditions ?? {}), ...(incoming.other_conditions ?? {}) },
    };
    default: return incoming;
  }
}

function mergedCandidateEvidence(winner: Candidate, candidates: Candidate[]): CompanyProfileFieldEvidence {
  const primary = stripSupplemental(winner.evidence);
  const primarySemanticKey = canonicalSemanticObservationKey(winner.identity);
  const supplemental = candidates
    .flatMap((candidate) => [
      ...(canonicalSemanticObservationKey(candidate.identity) === primarySemanticKey
        ? []
        : [stripSupplemental(candidate.evidence)]),
      ...(candidate.evidence.supplemental ?? []),
    ])
    .filter((evidence) => evidenceCanonicalKey(evidence) !== evidenceCanonicalKey(primary))
    .reduce<CompanyProfileEvidenceObservation[]>(appendUniqueObservation, [])
    .sort(compareEvidenceCanonical);
  return supplemental.length > 0 ? { ...primary, supplemental } : primary;
}

function conflictEvidence(
  field: CriterionDimension,
  candidates: Candidate[],
  asOf: string,
): CompanyProfileFieldEvidence {
  const supplemental = candidates
    .flatMap((candidate) => [{
      ...stripSupplemental(candidate.evidence),
      ...observationMetadata(candidate.identity, candidate.evidence),
    }, ...(candidate.evidence.supplemental ?? [])])
    .reduce<CompanyProfileEvidenceObservation[]>(appendUniqueObservation, [])
    .sort(compareEvidenceCanonical);
  const identity = canonicalCompanyProfileObservationIdentity({
    dimension: field,
    sourceKind: "derived",
    provider: "cunote_profile_conflict",
    scope: "shared",
    asOf,
    value: supplemental.map((item) => item.observationId ?? stableCanonicalStringify(item)),
    observationVersion: COMPANY_PROFILE_ASSEMBLY_VERSION,
  });
  return {
    sourceKind: "derived",
    provider: "cunote_profile_conflict",
    asOf,
    axisCompleteness: "partial",
    confidence: null,
    ...observationMetadata(identity, undefined),
    supplemental,
  };
}

function setFieldEvidence(
  profile: CompanyProfile,
  field: CriterionDimension,
  evidence: CompanyProfileFieldEvidence,
  winner: Candidate | null,
  supplementalValueMerged: boolean,
): CompanyProfile {
  const confidence = { ...(profile.confidence ?? {}) };
  if (
    winner &&
    (winner.kind === "update" || supplementalValueMerged) &&
    typeof evidence.confidence === "number"
  ) confidence[field] = evidence.confidence;
  if (!winner) delete confidence[field];
  return {
    ...profile,
    confidence,
    profile_evidence: { ...(profile.profile_evidence ?? {}), [field]: evidence },
  };
}

function clearCompanyProfileDimension(profile: CompanyProfile, field: CriterionDimension): CompanyProfile {
  const next = cloneValue(profile);
  switch (field) {
    case "region": delete next.region; break;
    case "biz_age": delete next.biz_age_months; break;
    case "industry": delete next.industries; delete next.industry_codes; break;
    case "size": delete next.size; break;
    case "revenue": delete next.revenue_krw; break;
    case "employees": delete next.employees_count; break;
    case "founder_age": delete next.founder_age; break;
    case "founder_trait": delete next.traits; break;
    case "certification": delete next.certs; break;
    case "prior_award": delete next.prior_awards; delete next.prior_award_history; break;
    case "ip": delete next.ip; break;
    case "target_type": delete next.target_types; break;
    case "business_status": delete next.business_status; break;
    case "tax_compliance": delete next.tax_compliance; break;
    case "credit_status": delete next.credit_status; break;
    case "sanction": delete next.sanction; break;
    case "financial_health": delete next.financial_health; break;
    case "insured_workforce": delete next.insured_workforce; break;
    case "investment": delete next.investment; break;
    case "other": delete next.other_conditions; break;
    case "premises":
    case "export_performance": break;
  }
  if (next.list_completeness) delete next.list_completeness[field as keyof typeof next.list_completeness];
  if (next.confidence) delete next.confidence[field];
  return next;
}

function stripSupplemental(evidence: CompanyProfileEvidenceObservation): CompanyProfileEvidenceObservation {
  const {
    sourceKind,
    provider,
    asOf,
    axisCompleteness,
    confidence,
    scope,
    observationId,
    observationVersion,
    canonicalValue,
    persistenceClass,
    resolverVersion,
  } = evidence;
  return {
    sourceKind,
    provider,
    asOf,
    axisCompleteness,
    confidence,
    ...(scope ? { scope } : {}),
    ...(observationId ? { observationId } : {}),
    ...(observationVersion ? { observationVersion } : {}),
    ...(canonicalValue !== undefined ? { canonicalValue } : {}),
    ...(persistenceClass ? { persistenceClass } : {}),
    ...(resolverVersion ? { resolverVersion } : {}),
  };
}

function appendUniqueObservation(
  values: CompanyProfileEvidenceObservation[],
  incoming: CompanyProfileEvidenceObservation,
): CompanyProfileEvidenceObservation[] {
  const key = evidenceCanonicalKey(incoming);
  if (!values.some((item) => evidenceCanonicalKey(item) === key)) values.push(incoming);
  return values;
}

function compareEvidenceCanonical(left: CompanyProfileEvidenceObservation, right: CompanyProfileEvidenceObservation): number {
  return evidenceCanonicalKey(left).localeCompare(evidenceCanonicalKey(right));
}

function evidenceCanonicalKey(evidence: CompanyProfileEvidenceObservation): string {
  return stableCanonicalStringify({
    sourceKind: evidence.sourceKind,
    provider: normalizeProvider(evidence.provider),
    scope: evidence.scope ?? defaultObservationScope(evidence.sourceKind),
    asOf: evidence.asOf,
    axisCompleteness: evidence.axisCompleteness,
    confidence: evidence.confidence,
    observationId: evidence.observationId,
    observationVersion: evidence.observationVersion,
    canonicalValue: evidence.canonicalValue,
    persistenceClass: evidence.persistenceClass,
    resolverVersion: evidence.resolverVersion,
  });
}

function canonicalObservationKey(identity: CanonicalCompanyProfileObservationIdentity): string {
  return stableCanonicalStringify(identity);
}

function canonicalSemanticObservationKey(identity: CanonicalCompanyProfileObservationIdentity): string {
  return stableCanonicalStringify({
    dimension: identity.dimension,
    sourceKind: identity.sourceKind,
    provider: identity.provider,
    scope: identity.scope,
    asOf: identity.asOf,
    canonicalValue: identity.canonicalValue,
  });
}

function observationMetadataScore(evidence: CompanyProfileEvidenceObservation): number {
  return [
    evidence.observationId,
    evidence.observationVersion,
    evidence.canonicalValue,
    evidence.persistenceClass,
    evidence.resolverVersion,
  ].filter((value) => value !== undefined).length;
}

function canonicalizeCompanyProfile(profile: CompanyProfile, touched: ReadonlySet<CriterionDimension>): CompanyProfile {
  const next = cloneValue(profile);
  if (touched.has("industry")) {
    if (next.industries) next.industries = sortUniqueStrings(next.industries);
    if (next.industry_codes) next.industry_codes = sortUniqueStrings(next.industry_codes);
  }
  if (touched.has("founder_trait") && next.traits) next.traits = sortUniqueStrings(next.traits);
  if (touched.has("certification") && next.certs) next.certs = sortUniqueStrings(next.certs);
  if (touched.has("ip") && next.ip) next.ip = sortUniqueStrings(next.ip);
  if (touched.has("target_type") && next.target_types) next.target_types = sortUniqueStrings(next.target_types);
  if (touched.has("prior_award") && next.prior_awards) next.prior_awards = sortUniqueStrings(next.prior_awards);
  if (touched.has("prior_award") && next.prior_award_history) {
    next.prior_award_history.records = [...next.prior_award_history.records]
      .sort((left, right) => stableCanonicalStringify(left).localeCompare(stableCanonicalStringify(right)));
    next.prior_award_history.known_programs = sortUniqueStrings(next.prior_award_history.known_programs);
    next.prior_award_history.known_program_types = sortUniqueStrings(next.prior_award_history.known_program_types);
  }
  for (const field of ["tax_compliance", "credit_status", "sanction"] as const) {
    if (!touched.has(field)) continue;
    const value = next[field];
    if (!value) continue;
    value.flags = sortUniqueStrings(value.flags);
    value.known_flags = sortUniqueStrings(value.known_flags);
    value.exceptions = sortUniqueStrings(value.exceptions);
  }
  if (next.profile_evidence) for (const field of touched) {
    const evidence = next.profile_evidence[field];
    if (evidence?.supplemental) evidence.supplemental = [...evidence.supplemental].sort(compareEvidenceCanonical);
  }
  return canonicalizeObjectKeyOrder(next);
}

function canonicalizeObjectKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => canonicalizeObjectKeyOrder(item)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeObjectKeyOrder(entry)]),
  ) as T;
}

function sortUniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isListDimension(field: CriterionDimension): boolean {
  return field === "industry" || field === "founder_trait" || field === "certification" ||
    field === "prior_award" || field === "ip" || field === "target_type";
}

function isSupplementalMergeDimension(field: CriterionDimension): boolean {
  return isListDimension(field) || field === "tax_compliance" || field === "credit_status" ||
    field === "sanction" || field === "financial_health" || field === "insured_workforce" ||
    field === "investment";
}

function normalizeProvider(value: string): string {
  return value.trim().toLowerCase() || "unknown";
}

function defaultObservationScope(sourceKind: CompanyProfileEvidenceObservation["sourceKind"]): CompanyProfileObservationScope {
  return sourceKind === "self_declared" ? "user" : "shared";
}

function requireIsoTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) throw new Error(`${label}는 유효한 ISO 시각이어야 합니다.`);
  return parsed.toISOString();
}

function normalizeToken(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function stableHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left ^= code;
    left = Math.imul(left, 0x01000193);
    right ^= code + index;
    right = Math.imul(right, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}

function canonicalValue(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (Array.isArray(value)) {
    const items = value.map(canonicalValue);
    return items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cloneValue(entry)]),
  ) as T;
}

function hasObservationMetadata(value: CompanyProfileObservationMetadata): boolean {
  return Boolean(
    value.scope || value.observationId || value.observationVersion || value.canonicalValue ||
    value.persistenceClass || value.resolverVersion
  );
}
