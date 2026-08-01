import type {
  CompanyProfile,
  CriterionDimension,
} from "@cunote/contracts";
import { isValidBizNoChecksum } from "@cunote/contracts";
import {
  VIRTUAL_COMPANY_IDENTITIES,
  isEnabledFlag,
  normalizeVirtualCompanyBizNo,
  type VirtualCompanyId,
} from "@/lib/virtualCompanies";

export type VirtualCompanyExpectedTier =
  | "recommendable"
  | "not_recommended"
  | "needs_profile_input";

export type VirtualCompanyCriterionResult = "pass" | "fail" | "unknown" | "text_only";

export interface VirtualCompanyTarget {
  source: "bizinfo" | "kstartup";
  sourceId: string;
  expectedExtractorVersion: string;
  expectedRevision: string;
  expected: VirtualCompanyExpectedTier;
  expectedCriterionResults?: Partial<Record<CriterionDimension, VirtualCompanyCriterionResult>>;
}

export interface VirtualCompanyScenario {
  id: VirtualCompanyId;
  bizNo: string;
  name: string;
  purpose: string;
  profile: CompanyProfile;
  targets: VirtualCompanyTarget[];
}

interface VirtualCompanyDefinition {
  id: VirtualCompanyId;
  name: string;
  purpose: string;
  profile: Omit<CompanyProfile, "profile_evidence">;
  completeEvidenceDimensions: CriterionDimension[];
  targets: VirtualCompanyTarget[];
}

const TARGET_GRANT = {
  source: "bizinfo" as const,
  sourceId: "PBLN_000000000124754",
  expectedExtractorVersion: "deep-analysis-v11/deep-analysis-model-policy-v24",
  expectedRevision: "3acb65efebc57b7e28afae05c7f0ea8de307d94692068e5ec8386b3c4e026cbd",
};

const DEFINITIONS: readonly VirtualCompanyDefinition[] = [
  {
    id: "virtual-chungnam-disabled-perfect",
    name: "창업노트 가상기업 — 충남 장애인기업",
    purpose: "충남 장애인기업 지원 공고의 필수조건을 모두 만족하는 기준 시나리오",
    profile: disabledCompanyProfile({ regionCode: "44", regionLabel: "충남", includeCertification: true }),
    completeEvidenceDimensions: ["region", "founder_trait", "certification", "business_status"],
    targets: [{
      ...TARGET_GRANT,
      expected: "recommendable",
      expectedCriterionResults: {
        region: "pass",
        founder_trait: "pass",
        certification: "pass",
      },
    }],
  },
  {
    id: "virtual-chungnam-disabled-region-fail",
    name: "창업노트 가상기업 — 서울 장애인기업",
    purpose: "나머지 조건을 만족해도 지역 필수조건에서 명확히 제외되는 시나리오",
    profile: disabledCompanyProfile({ regionCode: "11", regionLabel: "서울", includeCertification: true }),
    completeEvidenceDimensions: ["region", "founder_trait", "certification", "business_status"],
    targets: [{
      ...TARGET_GRANT,
      expected: "not_recommended",
      expectedCriterionResults: {
        region: "fail",
        founder_trait: "pass",
        certification: "pass",
      },
    }],
  },
  {
    id: "virtual-chungnam-disabled-cert-missing",
    name: "창업노트 가상기업 — 확인서 미확인 장애인기업",
    purpose: "지역·대표자 속성은 충족하지만 필수 인증 정보가 없어 사용자 입력이 필요한 시나리오",
    profile: disabledCompanyProfile({ regionCode: "44", regionLabel: "충남", includeCertification: false }),
    completeEvidenceDimensions: ["region", "founder_trait", "business_status"],
    targets: [{
      ...TARGET_GRANT,
      expected: "needs_profile_input",
      expectedCriterionResults: {
        region: "pass",
        founder_trait: "pass",
        certification: "unknown",
      },
    }],
  },
] as const;

const IDENTITY_IDS = new Set<VirtualCompanyId>(
  VIRTUAL_COMPANY_IDENTITIES.map((identity) => identity.id),
);

validateVirtualCompanyIdentityEntries(VIRTUAL_COMPANY_IDENTITIES);
validateDefinitions(DEFINITIONS);

const IDENTITY_BY_ID = new Map(
  VIRTUAL_COMPANY_IDENTITIES.map((identity) => [identity.id, identity]),
);

export function isVirtualCompanyServerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabledFlag(env.CUNOTE_VIRTUAL_COMPANY_ENABLED);
}

export function resolveVirtualCompanyScenario(
  value: string,
  options: { asOf?: Date } = {},
): VirtualCompanyScenario | null {
  const bizNo = normalizeVirtualCompanyBizNo(value);
  const identity = VIRTUAL_COMPANY_IDENTITIES.find((entry) => entry.bizNo === bizNo);
  if (!identity) return null;
  const definition = DEFINITIONS.find((entry) => entry.id === identity.id);
  if (!definition) throw new Error(`가상 기업 정의가 없습니다: ${identity.id}`);
  return materializeScenario(definition, identity.bizNo, options.asOf ?? new Date());
}

export function listVirtualCompanyScenarios(
  options: { asOf?: Date } = {},
): readonly VirtualCompanyScenario[] {
  const asOf = options.asOf ?? new Date();
  return DEFINITIONS.map((definition) => {
    const identity = IDENTITY_BY_ID.get(definition.id);
    if (!identity) throw new Error(`가상 기업 번호가 없습니다: ${definition.id}`);
    return materializeScenario(definition, identity.bizNo, asOf);
  });
}

export function validateVirtualCompanyIdentityEntries(
  entries: readonly { id: string; bizNo: string }[],
): void {
  const ids = new Set<string>();
  const bizNos = new Set<string>();
  for (const entry of entries) {
    const bizNo = normalizeVirtualCompanyBizNo(entry.bizNo);
    if (!entry.id.trim()) throw new Error("가상 기업 ID가 비어 있습니다.");
    if (bizNo.length !== 10) throw new Error(`가상 사업자번호는 숫자 10자리여야 합니다: ${entry.bizNo}`);
    if (isValidBizNoChecksum(bizNo)) {
      throw new Error(`가상 사업자번호가 실제 체크섬을 통과하면 안 됩니다: ${bizNo}`);
    }
    if (ids.has(entry.id)) throw new Error(`가상 기업 ID가 중복되었습니다: ${entry.id}`);
    if (bizNos.has(bizNo)) throw new Error(`가상 사업자번호가 중복되었습니다: ${bizNo}`);
    ids.add(entry.id);
    bizNos.add(bizNo);
  }
}

function validateDefinitions(definitions: readonly VirtualCompanyDefinition[]): void {
  const definitionIds = new Set<VirtualCompanyId>();
  for (const definition of definitions) {
    if (definitionIds.has(definition.id)) throw new Error(`가상 기업 정의가 중복되었습니다: ${definition.id}`);
    if (!IDENTITY_IDS.has(definition.id)) throw new Error(`등록되지 않은 가상 기업 정의입니다: ${definition.id}`);
    if (definition.targets.length === 0) throw new Error(`가상 기업 목표 공고가 없습니다: ${definition.id}`);
    definitionIds.add(definition.id);
  }
  if (definitionIds.size !== VIRTUAL_COMPANY_IDENTITIES.length) {
    throw new Error("가상 기업 번호와 정의 수가 일치하지 않습니다.");
  }
}

function disabledCompanyProfile(input: {
  regionCode: string;
  regionLabel: string;
  includeCertification: boolean;
}): Omit<CompanyProfile, "profile_evidence"> {
  return {
    region: { code: input.regionCode, label: input.regionLabel },
    traits: ["장애인기업"],
    ...(input.includeCertification ? { certs: ["장애인기업 확인서"] } : {}),
    business_status: { active: true, label: "계속사업자" },
    list_completeness: {
      founder_trait: "complete",
      ...(input.includeCertification ? { certification: "complete" } : {}),
    },
    confidence: {
      region: 1,
      founder_trait: 1,
      ...(input.includeCertification ? { certification: 1 } : {}),
      business_status: 1,
    },
  };
}

function materializeScenario(
  definition: VirtualCompanyDefinition,
  bizNo: string,
  asOf: Date,
): VirtualCompanyScenario {
  const asOfIso = asOf.toISOString();
  const profile: CompanyProfile = {
    ...structuredClone(definition.profile),
    name: definition.name,
    profile_evidence: {},
  };
  for (const dimension of definition.completeEvidenceDimensions) {
    profile.profile_evidence![dimension] = {
      sourceKind: "self_declared",
      provider: "cunote_virtual_company",
      asOf: asOfIso,
      axisCompleteness: "complete",
      confidence: 1,
    };
  }
  return {
    id: definition.id,
    bizNo,
    name: definition.name,
    purpose: definition.purpose,
    profile,
    targets: structuredClone(definition.targets),
  };
}
