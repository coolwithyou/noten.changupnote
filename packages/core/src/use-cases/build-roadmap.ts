import type { MatchCard, RoadmapNode } from "@cunote/contracts";

export interface BuildRoadmapOptions {
  matches: MatchCard[];
  limit?: number;
}

export function buildRoadmap({
  matches,
  limit = 12,
}: BuildRoadmapOptions): RoadmapNode[] {
  return matches.slice(0, limit).map((match) => {
    const node: RoadmapNode = {
      bucket: match.bucket,
      grantId: match.grantId,
      title: match.title,
    };

    const firstTimeUnlock = match.ruleTrace.find((trace) => trace.unlock?.kind === "time");
    if (firstTimeUnlock?.unlock) {
      node.unlock = {
        dimension: firstTimeUnlock.dimension,
        kind: "time",
        detail: firstTimeUnlock.unlock.detail,
        ...(firstTimeUnlock.unlock.etaDate ? { etaDate: firstTimeUnlock.unlock.etaDate } : {}),
      };
      return node;
    }

    const firstActionable = match.ruleTrace.find((trace) =>
      trace.result === "unknown" || trace.result === "fail" || trace.result === "text_only"
    );
    if (firstActionable) {
      node.unlock = {
        dimension: firstActionable.dimension,
        kind: "attribute",
        detail: firstActionable.label,
      };
    }

    return node;
  });
}
