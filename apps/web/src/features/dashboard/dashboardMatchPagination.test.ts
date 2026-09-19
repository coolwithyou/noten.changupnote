import assert from "node:assert/strict";
import {
  dashboardMatchesPagePath,
  initialDashboardMatchCursor,
  mergeUniqueMatches,
} from "./dashboardMatchPagination";

assert.equal(initialDashboardMatchCursor(40, 1_508), "40");
assert.equal(initialDashboardMatchCursor(40, 40), null);
assert.equal(initialDashboardMatchCursor(0, 1_508), null);

assert.equal(
  dashboardMatchesPagePath("40"),
  "/api/web/matches?status=all&sort=recommended&limit=40&cursor=40",
);

assert.deepEqual(
  mergeUniqueMatches(
    [{ grantId: "a", title: "A" }, { grantId: "b", title: "B" }],
    [{ grantId: "b", title: "duplicate" }, { grantId: "c", title: "C" }],
  ),
  [{ grantId: "a", title: "A" }, { grantId: "b", title: "B" }, { grantId: "c", title: "C" }],
);

console.log("dashboard match pagination tests passed");
