import type {
  BenefitBadge,
  GrantBenefitFamily,
  GrantBenefitSource,
  MatchCard,
  SupportAmount,
} from "@cunote/contracts";

const TRUSTED_BENEFIT_SOURCES = new Set<GrantBenefitSource>([
  "structured",
  "support_amount",
  "title",
]);
const MIN_TRUSTED_BENEFIT_CONFIDENCE = 0.8;
const MONETARY_LABEL_PATTERN =
  /(?:₩\s*\d|KRW\s*\d|\d[\d,.]*\s*(?:KRW|원|만\s*원|억(?:\s*원)?|[천백]\s*만?\s*원))/i;

const BENEFIT_FAMILY_ORDER: readonly GrantBenefitFamily[] = [
  "funding",
  "loan",
  "capability",
  "space",
  "market",
  "certification",
  "network",
];

const BENEFIT_FAMILY_LABELS: Record<GrantBenefitFamily, string> = {
  funding: "자금지원",
  loan: "융자·보증",
  capability: "교육·컨설팅",
  space: "공간·입주",
  market: "판로·해외",
  certification: "인증·IP",
  network: "네트워킹·투자",
};

export type SupportSummaryKind = "amount" | "benefit" | "fallback";

export interface SupportSummary {
  kind: SupportSummaryKind;
  text: string;
  accessibleText: string;
}

export function buildSupportSummary(
  match: Pick<MatchCard, "supportAmount" | "benefits">,
): SupportSummary {
  const amountText = supportAmountText(match.supportAmount);
  if (amountText) {
    return {
      kind: "amount",
      text: amountText,
      accessibleText: `지원 금액: ${amountText}`,
    };
  }

  const benefitFamilies = trustedBenefitFamilies(match.benefits);
  if (benefitFamilies.length > 0) {
    const firstLabel = BENEFIT_FAMILY_LABELS[benefitFamilies[0]!];
    const additionalCount = benefitFamilies.length - 1;
    return {
      kind: "benefit",
      text: additionalCount > 0 ? `${firstLabel} +${additionalCount}` : firstLabel,
      accessibleText:
        additionalCount > 0
          ? `지원 혜택: ${firstLabel} 외 ${additionalCount}개`
          : `지원 혜택: ${firstLabel}`,
    };
  }

  return {
    kind: "fallback",
    text: "공고문 확인 필요",
    accessibleText: "지원 내용: 공고문 확인 필요",
  };
}

export function supportAmountText(amount: SupportAmount): string | null {
  const label = amount.label?.trim();
  if (label && MONETARY_LABEL_PATTERN.test(label)) return label;

  const min = positiveFiniteNumber(amount.min);
  const max = positiveFiniteNumber(amount.max);

  if (min !== null && max !== null) {
    if (min === max) return formatKrwAmount(min);
    if (min < max) return `${formatKrwAmount(min)}~${formatKrwAmount(max)}`;
    return `최대 ${formatKrwAmount(max)}`;
  }
  if (max !== null) return `최대 ${formatKrwAmount(max)}`;
  if (min !== null) return `최소 ${formatKrwAmount(min)}`;
  return null;
}

export function formatKrwAmount(value: number): string {
  if (value >= 100_000_000 && value % 10_000_000 === 0) {
    const eok = value / 100_000_000;
    const label = Number.isInteger(eok) ? eok.toLocaleString("ko-KR") : eok.toFixed(1);
    return `${label}억 원`;
  }
  if (value >= 10_000 && value % 10_000 === 0) {
    return `${(value / 10_000).toLocaleString("ko-KR")}만 원`;
  }
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function positiveFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function trustedBenefitFamilies(benefits: readonly BenefitBadge[]): GrantBenefitFamily[] {
  const trustedFamilies = new Set<GrantBenefitFamily>();
  for (const benefit of benefits) {
    if (
      TRUSTED_BENEFIT_SOURCES.has(benefit.source)
      && Number.isFinite(benefit.confidence)
      && benefit.confidence >= MIN_TRUSTED_BENEFIT_CONFIDENCE
    ) {
      trustedFamilies.add(benefit.family);
    }
  }
  return BENEFIT_FAMILY_ORDER.filter((family) => trustedFamilies.has(family));
}
