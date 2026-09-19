import type { MatchCard } from "@cunote/contracts";

export function isReviewNeededMatchCard(
  match: Pick<MatchCard, "eligibility" | "recommendationTier">,
): boolean {
  const tier = match.recommendationTier ?? (
    match.eligibility === "eligible"
      ? "recommendable"
      : match.eligibility === "ineligible"
        ? "not_recommended"
        : "needs_profile_input"
  );
  return tier === "needs_profile_input" || tier === "needs_core_review";
}
