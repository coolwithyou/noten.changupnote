import assert from "node:assert/strict";
import type { BenefitBadge, MatchCard, SupportAmount } from "@cunote/contracts";
import { buildSupportSummary, supportAmountText } from "./support-summary";

const emptyAmount: SupportAmount = { unit: "KRW", per: "기업" };

function summary(
  supportAmount: SupportAmount = emptyAmount,
  benefits: BenefitBadge[] = [],
) {
  return buildSupportSummary({ supportAmount, benefits } as Pick<MatchCard, "supportAmount" | "benefits">);
}

assert.deepEqual(summary({ ...emptyAmount, label: "최대 1억 원" }), {
  kind: "amount",
  text: "최대 1억 원",
  accessibleText: "지원 금액: 최대 1억 원",
});
assert.equal(supportAmountText({ ...emptyAmount, label: "바우처" }), null);
assert.equal(supportAmountText({ ...emptyAmount, min: 50_000_000, max: 100_000_000 }), "5,000만 원~1억 원");
assert.equal(supportAmountText({ ...emptyAmount, min: 30_000_000, max: 30_000_000 }), "3,000만 원");
assert.equal(supportAmountText({ ...emptyAmount, max: 100_000_000 }), "최대 1억 원");
assert.equal(supportAmountText({ ...emptyAmount, min: 10_000_000 }), "최소 1,000만 원");
assert.equal(supportAmountText({ ...emptyAmount, min: Number.NaN, max: -1 }), null);

const benefitSummary = summary(emptyAmount, [
  { family: "network", label: "투자 연계", source: "title", confidence: 0.9 },
  { family: "capability", label: "교육", source: "structured", confidence: 0.95 },
  { family: "capability", label: "컨설팅", source: "support_amount", confidence: 0.9 },
  { family: "funding", label: "자금", source: "category", confidence: 0.99 },
]);
assert.deepEqual(benefitSummary, {
  kind: "benefit",
  text: "교육·컨설팅 +1",
  accessibleText: "지원 혜택: 교육·컨설팅 외 1개",
});

assert.deepEqual(
  summary(emptyAmount, [
    { family: "funding", label: "자금", source: "title", confidence: 0.79 },
    { family: "market", label: "해외", source: "apply_method", confidence: 1 },
  ]),
  {
    kind: "fallback",
    text: "공고문 확인 필요",
    accessibleText: "지원 내용: 공고문 확인 필요",
  },
);

console.log("support summary: ok");
