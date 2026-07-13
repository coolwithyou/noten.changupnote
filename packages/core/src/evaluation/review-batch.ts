import type { V3AnnotationRecord, V3CompanyAnnotation, V3EligibilityPairAnnotation, V3GrantAnnotation } from "./v3-annotations.js";
import type { MatchingV3GrantReviewTask } from "./review-packet.js";
import type { MatchingV3PairReviewTask } from "./pair-review-packet.js";
import { buildMatchingV3PairInputFingerprint } from "./pair-review-packet.js";
import type { MatchingV3CompanyReviewTask } from "./review-workbench.js";
import { validateIndependentAnnotation } from "./review-workbench.js";
import { RULESET_VERSION, SCORING_VERSION } from "../matching/match.js";

export interface MatchingV3ReviewBatchReport {
  stage: "annotated" | "reviewed";
  includeHoldout: boolean;
  companyCount: number;
  grantCount: number;
  pairCount: number;
  developmentPairCount: number;
  holdoutPairCount: number;
  reviewedCount: number;
  errors: string[];
  batchReady: boolean;
  missionReady: boolean;
}

export function validateMatchingV3ReviewBatch(input: {
  companies: V3CompanyAnnotation[];
  grants: V3GrantAnnotation[];
  pairs: V3EligibilityPairAnnotation[];
  companyTasks: MatchingV3CompanyReviewTask[];
  grantTasks: MatchingV3GrantReviewTask[];
  pairTasks: MatchingV3PairReviewTask[];
  stage: "annotated" | "reviewed";
  includeHoldout?: boolean;
}): MatchingV3ReviewBatchReport {
  const includeHoldout = input.includeHoldout === true;
  const expectedPairs = includeHoldout
    ? input.pairTasks
    : input.pairTasks.filter((task) => task.annotationTemplate.split === "development");
  const errors: string[] = [];
  compareIds(input.companyTasks.map((task) => task.companyId), input.companies.map((item) => item.companyId), "company", errors);
  compareIds(input.grantTasks.map((task) => task.grantId), input.grants.map((item) => item.grantId), "grant", errors);
  compareIds(expectedPairs.map((task) => task.pairId), input.pairs.map((item) => item.pairId), "pair", errors);
  const companyTaskById = new Map(input.companyTasks.map((task) => [task.companyId, task]));
  const grantTaskById = new Map(input.grantTasks.map((task) => [task.grantId, task]));
  const pairTaskById = new Map(expectedPairs.map((task) => [task.pairId, task]));
  const grantById = new Map(input.grants.map((grant) => [grant.grantId, grant]));
  const companyById = new Map(input.companies.map((company) => [company.companyId, company]));

  for (const company of input.companies) {
    errors.push(...validateRecord(company, input.stage));
    const task = companyTaskById.get(company.companyId);
    if (!task) continue;
    if (company.businessKind !== task.businessKind) errors.push(`${company.companyId}: businessKind changed`);
    if (company.sourceFixture !== task.sourceFixture) errors.push(`${company.companyId}: sourceFixture changed`);
  }
  for (const grant of input.grants) {
    errors.push(...validateRecord(grant, input.stage));
    const task = grantTaskById.get(grant.grantId);
    if (!task) continue;
    if (grant.source !== task.source || grant.sourceId !== task.sourceId || grant.title !== task.title) {
      errors.push(`${grant.grantId}: source identity/title changed`);
    }
    if (grant.sourceRevision !== task.annotationTemplate.sourceRevision) errors.push(`${grant.grantId}: sourceRevision changed`);
  }
  for (const pair of input.pairs) {
    errors.push(...validateRecord(pair, input.stage));
    const task = pairTaskById.get(pair.pairId);
    if (!task) continue;
    if (pair.grantId !== task.grantId || pair.companyId !== task.companyId) errors.push(`${pair.pairId}: pair references changed`);
    if (pair.split !== task.annotationTemplate.split) errors.push(`${pair.pairId}: preassigned split changed`);
    const grant = grantById.get(pair.grantId);
    const company = companyById.get(pair.companyId);
    validatePairCriterionReferences(pair, grant, errors);
    validatePairProvenance(pair, task, grant, company, errors);
  }
  if (input.stage === "reviewed") {
    const reviewedGrantIds = new Set(input.grants.filter((grant) => grant.labelStatus === "reviewed").map((grant) => grant.grantId));
    const reviewedCompanyIds = new Set(input.companies.filter((company) => company.labelStatus === "reviewed").map((company) => company.companyId));
    for (const pair of input.pairs) {
      if (!reviewedGrantIds.has(pair.grantId)) errors.push(`${pair.pairId}: related grant is not reviewed`);
      if (!reviewedCompanyIds.has(pair.companyId)) errors.push(`${pair.pairId}: related company is not reviewed`);
    }
  }
  const records: V3AnnotationRecord[] = [...input.companies, ...input.grants, ...input.pairs];
  const reviewedCount = records.filter((record) => record.labelStatus === "reviewed").length;
  return {
    stage: input.stage,
    includeHoldout,
    companyCount: input.companies.length,
    grantCount: input.grants.length,
    pairCount: input.pairs.length,
    developmentPairCount: input.pairs.filter((pair) => pair.split === "development").length,
    holdoutPairCount: input.pairs.filter((pair) => pair.split === "holdout").length,
    reviewedCount,
    errors: unique(errors),
    batchReady: errors.length === 0,
    missionReady: errors.length === 0 && input.stage === "reviewed" && input.grants.length >= 100 &&
      input.companies.length >= 30 && input.pairs.length >= 500,
  };
}
function validatePairProvenance(
  pair: V3EligibilityPairAnnotation,
  task: MatchingV3PairReviewTask,
  grant: V3GrantAnnotation | undefined,
  company: V3CompanyAnnotation | undefined,
  errors: string[],
): void {
  const prefix = pair.pairId;
  if (!clean(task.rulesetVer) || !clean(task.scoringVer) || !validFingerprint(task.inputFingerprint)) {
    errors.push(`${prefix}: pair task engine provenance missing`);
  }
  if (task.rulesetVer !== RULESET_VERSION || task.scoringVer !== SCORING_VERSION) {
    errors.push(`${prefix}: pair task engine drift (task=${task.rulesetVer ?? "missing"}/${task.scoringVer ?? "missing"}, current=${RULESET_VERSION}/${SCORING_VERSION})`);
  }
  if (
    pair.rulesetVer !== task.rulesetVer ||
    pair.scoringVer !== task.scoringVer ||
    pair.inputFingerprint !== task.inputFingerprint
  ) {
    errors.push(`${prefix}: annotation engine provenance changed or missing`);
  }
  if (!grant || !company || !validFingerprint(task.inputFingerprint)) return;
  const currentFingerprint = buildMatchingV3PairInputFingerprint({ grant, company });
  if (currentFingerprint !== task.inputFingerprint) {
    errors.push(`${prefix}: pair evaluation input drift; regenerate pair task from the reviewed grant/company inputs`);
  }
}

function validateRecord(record: V3AnnotationRecord, stage: "annotated" | "reviewed"): string[] {
  const errors = validateIndependentAnnotation(record).map((error) => `${recordId(record)}: ${error}`);
  if (!clean(record.annotatorId) || !validDate(record.annotatedAt)) errors.push(`${recordId(record)}: annotatorId/annotatedAt required`);
  if (stage === "reviewed" && record.labelStatus !== "reviewed") errors.push(`${recordId(record)}: labelStatus must be reviewed`);
  return errors;
}
function validatePairCriterionReferences(pair: V3EligibilityPairAnnotation, grant: V3GrantAnnotation | undefined, errors: string[]): void {
  if (!grant) {
    errors.push(`${pair.pairId}: related grant annotation missing`);
    return;
  }
  const criterionIds = new Set(grant.criteria.map((criterion) => criterion.criterionId));
  const hardFails = new Set(pair.hardFailCriterionIds);
  for (const id of [...pair.hardFailCriterionIds, ...pair.unknownCriterionIds]) {
    if (!criterionIds.has(id)) errors.push(`${pair.pairId}: unknown criterion reference ${id}`);
  }
  for (const id of pair.unknownCriterionIds) if (hardFails.has(id)) errors.push(`${pair.pairId}: criterion both hard-fail and unknown ${id}`);
  if (pair.expectedEligibility === "eligible" && (pair.hardFailCriterionIds.length > 0 || pair.unknownCriterionIds.length > 0)) {
    errors.push(`${pair.pairId}: eligible pair cannot contain hard-fail/unknown criteria`);
  }
  if (pair.expectedEligibility === "ineligible" && pair.hardFailCriterionIds.length === 0) errors.push(`${pair.pairId}: ineligible pair requires hard-fail criterion`);
  if (pair.expectedEligibility === "conditional" && pair.unknownCriterionIds.length === 0) errors.push(`${pair.pairId}: conditional pair requires unknown criterion`);
}
function compareIds(expected: string[], actual: string[], label: string, errors: string[]): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const id of expectedSet) if (!actualSet.has(id)) errors.push(`${label}: missing ${id}`);
  for (const id of actualSet) if (!expectedSet.has(id)) errors.push(`${label}: unexpected ${id}`);
  if (actual.length !== actualSet.size) errors.push(`${label}: duplicate IDs`);
}
function recordId(record: V3AnnotationRecord): string {
  return record.recordType === "company" ? record.companyId : record.recordType === "grant" ? record.grantId : record.pairId;
}
function clean(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function validDate(value: string | null | undefined): boolean {
  const parsed = clean(value) ? new Date(value!) : null;
  return parsed !== null && !Number.isNaN(parsed.getTime());
}
function validFingerprint(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function unique(values: string[]): string[] {
  return [...new Set(values)];
}
