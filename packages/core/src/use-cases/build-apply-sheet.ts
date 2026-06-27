import type {
  ApplicationPrep,
  ApplySheet,
  CompanyProfile,
  NormalizedGrant,
  PlanDraftPrompt,
  ProfileCopyField,
  RequiredDocument,
  RuleTraceChip,
} from "@cunote/contracts";
import {
  normalizeRequiredDocuments,
  normalizeSupportAmount,
  deriveGrantBenefits,
  toRuleTraceChip,
  grantKey,
  daysUntil,
} from "./match-card.js";
import type { MatchedGrant } from "./match-card.js";

export interface BuildApplySheetOptions<TPayload = unknown> {
  entry: MatchedGrant<TPayload>;
  company?: CompanyProfile;
  asOf?: Date;
}

export function buildApplySheet<TPayload>({
  entry,
  company,
  asOf = new Date(),
}: BuildApplySheetOptions<TPayload>): ApplySheet {
  const { grant } = entry.item as NormalizedGrant<TPayload>;
  const chips = entry.match.rule_trace.map((trace) => toRuleTraceChip(trace, { asOf }));
  const textOnlyDocuments = chips
    .filter((chip) => chip.result === "text_only")
    .map((chip) => {
      const document = {
        name: chip.label,
        required: chip.kind === "required",
        source: "portal" as const,
        fromTextOnly: true,
      };
      return chip.sourceSpan ? { ...document, sourceSpan: chip.sourceSpan } : document;
    });

  const documents = [...normalizeRequiredDocuments(grant), ...textOnlyDocuments];
  const satisfied = chips.filter((chip) => chip.checklistSection === "satisfied");
  const needsCheck = chips.filter((chip) => chip.checklistSection === "needs_check");
  const applicationPrepInput = {
    grantTitle: grant.title,
    agency: grant.agency_operator ?? grant.agency_jurisdiction ?? null,
    applyMethod: summarizeApplyMethod(grant.apply_method),
    satisfied,
    needsCheck,
    documents,
    ...(company ? { company } : {}),
  };

  return {
    grant: {
      id: grantKey(grant),
      source: grant.source,
      sourceId: grant.source_id,
      title: grant.title,
      agency: grant.agency_operator ?? grant.agency_jurisdiction ?? null,
      supportAmount: normalizeSupportAmount(grant.support_amount),
      benefits: deriveGrantBenefits(grant),
      status: grant.status,
    },
    satisfied,
    needsCheck,
    documents,
    applicationPrep: buildApplicationPrep(applicationPrepInput),
    applyMethod: summarizeApplyMethod(grant.apply_method),
    deepLink: grant.url ?? null,
    schedule: {
      applyStart: grant.apply_start ?? null,
      applyEnd: grant.apply_end ?? null,
      dDay: daysUntil(grant.apply_end ?? null, asOf),
    },
  };
}

function buildApplicationPrep(input: {
  company?: CompanyProfile;
  grantTitle: string;
  agency: string | null;
  applyMethod: string | null;
  satisfied: RuleTraceChip[];
  needsCheck: RuleTraceChip[];
  documents: RequiredDocument[];
}): ApplicationPrep {
  return {
    autoSubmitSupported: false,
    profileCopyFields: buildProfileCopyFields(input.company, input),
    planDraftPrompts: buildPlanDraftPrompts(input),
  };
}

function buildProfileCopyFields(
  company: CompanyProfile | undefined,
  context: {
    grantTitle: string;
    agency: string | null;
    applyMethod: string | null;
  },
): ProfileCopyField[] {
  const fields: ProfileCopyField[] = [];
  const pushCompany = (label: string, value: string | null | undefined) => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    fields.push({ label, value: cleaned, source: "company_profile" });
  };

  pushCompany("기업명", company?.name);
  pushCompany("소재지", company?.region?.label ?? company?.region?.code);
  pushCompany("창업 상태", company?.is_preliminary ? "예비창업" : formatBizAge(company?.biz_age_months));
  pushCompany("대표자 나이", company?.founder_age === null || company?.founder_age === undefined ? null : `${company.founder_age}세`);
  pushCompany("업종/분야", company?.industries?.join(", "));
  pushCompany("기업규모", company?.size ?? null);
  pushCompany("매출", formatKrw(company?.revenue_krw));
  pushCompany("상시근로자 수", company?.employees_count === null || company?.employees_count === undefined ? null : `${company.employees_count}명`);
  pushCompany("인증/특허", [...(company?.certs ?? []), ...(company?.ip ?? [])].join(", "));
  pushCompany("신청대상 유형", company?.target_types?.join(", "));

  fields.push({ label: "지원사업명", value: context.grantTitle, source: "grant_context" });
  if (context.agency) fields.push({ label: "운영기관", value: context.agency, source: "grant_context" });
  if (context.applyMethod) fields.push({ label: "접수 방법", value: context.applyMethod, source: "grant_context" });

  return fields;
}

function buildPlanDraftPrompts(input: {
  grantTitle: string;
  satisfied: RuleTraceChip[];
  needsCheck: RuleTraceChip[];
  documents: RequiredDocument[];
}): PlanDraftPrompt[] {
  const satisfiedEvidence = input.satisfied.slice(0, 5).map((trace) => trace.label);
  const needsCheckEvidence = input.needsCheck.slice(0, 5).map((trace) => trace.label);
  const documentEvidence = input.documents.slice(0, 5).map((document) => document.name);

  return [
    {
      title: "지원 동기와 적합성",
      prompt: `${input.grantTitle}의 신청대상 조건과 우리 회사 프로필이 맞는 지점을 근거 중심으로 정리하세요.`,
      evidence: satisfiedEvidence.length > 0 ? satisfiedEvidence : ["충족 조건은 원문에서 다시 확인하세요."],
    },
    {
      title: "보완 필요 조건",
      prompt: "확인 필요 조건을 신청 전 체크리스트로 바꾸고, 확인 방법과 책임자를 한 줄씩 적으세요.",
      evidence: needsCheckEvidence.length > 0 ? needsCheckEvidence : ["추가 확인 조건이 없으면 서류와 일정 중심으로 정리하세요."],
    },
    {
      title: "제출 서류 준비",
      prompt: "필수 서류별 보유 여부, 발급처, 제출 파일명을 표 형태로 정리하세요.",
      evidence: documentEvidence.length > 0 ? documentEvidence : ["공고 원문에서 제출 서류를 확인하세요."],
    },
  ];
}

function summarizeApplyMethod(value: Record<string, string | null> | undefined): string | null {
  if (!value) return null;
  const enabled = Object.entries(value)
    .filter(([, method]) => Boolean(method))
    .map(([key, method]) => method ?? key);
  if (enabled.length === 0) return null;
  return enabled.join(" · ");
}

function formatBizAge(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const years = Math.floor(value / 12);
  const months = value % 12;
  if (years === 0) return `${months}개월`;
  if (months === 0) return `${years}년`;
  return `${years}년 ${months}개월`;
}

function formatKrw(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return `${new Intl.NumberFormat("ko-KR").format(value)}원`;
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}
