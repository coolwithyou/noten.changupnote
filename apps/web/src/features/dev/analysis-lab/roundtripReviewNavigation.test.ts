import assert from "node:assert/strict";
import {
  adminGrantSimulationHref,
  adminGrantSimulationListHref,
  readRoundtripReviewTarget,
  roundtripReviewHref,
} from "./roundtripReviewNavigation";

const grantId = "grant/with space";
const runId = "roundtrip:stored/run";
const href = roundtripReviewHref(grantId, runId);
assert.equal(
  href,
  "/dev/analysis-lab?roundtripGrantId=grant%2Fwith+space&roundtripRunId=roundtrip%3Astored%2Frun#application-roundtrip",
);
assert.deepEqual(readRoundtripReviewTarget(new URL(href, "http://127.0.0.1:4010").search), {
  grantId,
  runId,
});
assert.equal(readRoundtripReviewTarget("?roundtripGrantId=only-grant"), null);
assert.equal(
  adminGrantSimulationHref("grant/with space"),
  "https://dev.changupnote.com/grants/grant%2Fwith%20space?adminPreview=1",
);
assert.equal(
  adminGrantSimulationListHref(),
  "https://dev.changupnote.com/internal/review/grants",
);

console.log("roundtrip review navigation regression passed");
