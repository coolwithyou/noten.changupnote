import assert from "node:assert/strict";
import type { ActionQueueItem, MatchingProfileView } from "@cunote/contracts";
import { dashboardActionHref, dashboardPrecision } from "./dashboardPresentation";

const baseAction: ActionQueueItem = {
  id: "action",
  kind: "apply",
  title: "지원사업 신청 일정 확인",
  reason: "마감 D-7",
  ctaLabel: "신청 준비",
  target: "grant-1",
  affectedGrantIds: ["grant/1"],
  affectedGrantCount: 1,
  leverageAmount: 0,
  urgency: "high",
  effort: "long",
  score: 100,
};

assert.equal(
  dashboardActionHref({ ...baseAction, kind: "input", target: "region" }),
  "/settings#company-settings",
);
assert.equal(
  dashboardActionHref({ ...baseAction, kind: "enrich", target: "#company-settings" }),
  "/settings#company-settings",
);
assert.equal(
  dashboardActionHref({ ...baseAction, kind: "acquire", target: "certification" }),
  "/grants/grant%2F1",
);
assert.equal(
  dashboardActionHref({ ...baseAction, kind: "review", target: "https://example.com/grant" }),
  "https://example.com/grant",
);

const profileView: MatchingProfileView = {
  asOf: "2026-07-15T00:00:00.000Z",
  knownCount: 7,
  partialCount: 1,
  unknownCount: 2,
  rows: Array.from({ length: 10 }, (_, index) => ({
    dimension: index === 0 ? "region" : "industry",
    status: index < 7 ? "known" : index === 7 ? "partial" : "unknown",
    displayValue: index < 7 ? "확인됨" : null,
    sourceKind: index < 7 ? "authoritative_api" : null,
    sourceLabel: null,
    asOf: null,
    completeness: index < 7 ? "complete" : "not_covered",
    editMode: "direct",
    action: { kind: "answer", label: "입력" },
  })),
};
assert.deepEqual(dashboardPrecision(profileView), { pct: 70, known: 7, remaining: 3 });

console.log("dashboard presentation tests passed");
