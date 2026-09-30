import type { MatchCard } from "@cunote/contracts";
import { projectDiscoveryCard } from "@cunote/core";
import { z } from "zod";

export const discoverySelectionSchema = z.object({
  grantId: z.string().uuid(), restored: z.boolean(), expectedRevision: z.number().int().min(0),
}).strict();
export const discoveryListSchema = z.object({
  view: z.enum(["excluded", "restored"]).default("excluded"),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(40).default(20),
}).strict();
export interface DiscoverySelection { grantId: string; restored: boolean; revision: number }
export interface DiscoveryRow { match: MatchCard; selection: DiscoverySelection; decision: ReturnType<typeof projectDiscoveryCard> }
export interface DiscoveryPage {
  rows: DiscoveryRow[]; total: number; nextOffset: number | null; asOf: string; canWrite: boolean;
}

/** 추천 페이지를 자르기 전의 전체 활성 공고를 소비한다. 마감은 사용자 복원보다 우선한다. */
export function selectDiscoveryPage(cards: readonly MatchCard[], selections: readonly DiscoverySelection[],
  input: z.infer<typeof discoveryListSchema>, asOf: Date): Omit<DiscoveryPage, "canWrite"> {
  const preferences = new Map(selections.map((item) => [item.grantId, item]));
  const rows = cards.flatMap((match): DiscoveryRow[] => {
    const decision = projectDiscoveryCard(match, { asOf });
    if (decision.reason === "closed") return [];
    const selection = preferences.get(match.grantId) ?? { grantId: match.grantId, restored: false, revision: 0 };
    if (input.view === "restored" ? !selection.restored : decision.state !== "excluded" || selection.restored) return [];
    return [{ match, selection, decision }];
  });
  // 안정적인 페이지 순서. 순위 변경으로 같은 공고가 다음 페이지에 반복되는 것을 줄인다.
  rows.sort((a, b) => a.match.grantId.localeCompare(b.match.grantId));
  const end = input.offset + input.limit;
  return { rows: rows.slice(input.offset, end), total: rows.length,
    nextOffset: end < rows.length ? end : null, asOf: asOf.toISOString() };
}
