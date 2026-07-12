import type { MatchCard } from "@cunote/contracts";

export const PROFILE_QUESTION_MATCH_ANNOTATION_ERROR_CODE = "profile_question_match_annotation_failed";

export async function bestEffortMatchCardAnnotation(
  cards: MatchCard[],
  annotate: (cards: MatchCard[]) => Promise<MatchCard[]>,
  log: (code: string) => void = console.warn,
): Promise<MatchCard[]> {
  try {
    return await annotate(cards);
  } catch {
    log(PROFILE_QUESTION_MATCH_ANNOTATION_ERROR_CODE);
    return cards;
  }
}
