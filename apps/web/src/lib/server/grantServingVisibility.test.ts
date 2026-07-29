import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PgDialect } from "drizzle-orm/pg-core";

import {
  grantServingVisiblePredicate,
  isGrantServingVisible,
} from "./grantServingVisibility";

assert.equal(isGrantServingVisible("visible"), true);
assert.equal(isGrantServingVisible("staged"), false);
assert.equal(isGrantServingVisible("suppressed"), false);
assert.equal(isGrantServingVisible("unknown"), false);

const rendered = new PgDialect().sqlToQuery(grantServingVisiblePredicate());
assert.match(rendered.sql, /"grants"\."serving_state" = \$1/);
assert.deepEqual(rendered.params, ["visible"]);

const repositorySource = readFileSync(
  "apps/web/src/lib/server/repositories/drizzle.ts",
  "utf8",
);
const activeListSource = between(
  repositorySource,
  "async listActiveGrants(",
  "async findGrantById(",
);
assert.ok(
  (activeListSource.match(/grantServingVisiblePredicate\(\)/g)?.length ?? 0) >= 2,
  "active candidate and dedup hydration queries must both exclude non-visible grants",
);
assert.match(
  activeListSource,
  /options\.requireDeepAnalysisPromotion/,
  "the active repository must support a deep-analysis-only matching universe",
);
assert.match(
  activeListSource,
  /analysisLabPromotionItems[\s\S]*deepAnalysisRunId[\s\S]*"applied"[\s\S]*\["active", "canary_passed"\]/,
  "deep-analysis-only reads must require applied promotion provenance from an active release",
);
assert.match(
  between(repositorySource, "async findGrantById(", "async listGrantsByIds("),
  /grantServingVisiblePredicate\(\)/,
  "the general serving detail lookup must exclude non-visible grants",
);
assert.doesNotMatch(
  between(
    repositorySource,
    "async listGrantsByIds(",
    "private async hydrateReviewedExtractionManifests(",
  ),
  /grantServingVisiblePredicate\(\)/,
  "the explicit internal ID loader must remain able to inspect staged grants",
);
assert.match(
  between(
    repositorySource,
    "async listDueMatchTransitions(",
    "async saveMatchEvent(",
  ),
  /grantServingVisiblePredicate\(\)/,
  "stale match_state rows for staged or suppressed grants must not emit transitions",
);

const requiredServingReaders = new Map([
  ["apps/web/src/lib/server/landing/landingGrantData.ts", 3],
  ["apps/web/src/lib/server/publicCalendar/publicCalendarData.ts", 1],
  ["apps/web/src/lib/server/archive/grantArchiveData.ts", 2],
]);
for (const [path, minimumCalls] of requiredServingReaders) {
  const source = readFileSync(path, "utf8");
  const callCount = source.match(/grantServingVisiblePredicate\(\)/g)?.length ?? 0;
  assert.ok(
    callCount >= minimumCalls,
    `${path} must call the shared serving predicate at least ${minimumCalls} time(s)`,
  );
}

const activeFunctionMigration = readFileSync(
  "db/migrations/0062_flaky_millenium_guard.sql",
  "utf8",
);
assert.match(
  activeFunctionMigration,
  /CREATE OR REPLACE FUNCTION "cunote_active_deep_analysis_grants"/,
);
assert.match(activeFunctionMigration, /g\.serving_state = 'visible'/);

const inputPreparation = readFileSync(
  "apps/web/src/lib/server/deep-analysis/prepareInput.ts",
  "utf8",
);
assert.doesNotMatch(
  inputPreparation,
  /grantServingVisiblePredicate/,
  "staged child input preparation must remain possible through the internal ID path",
);

const serviceDataSource = readFileSync(
  "apps/web/src/lib/server/serviceData.ts",
  "utf8",
);
assert.match(
  between(
    serviceDataSource,
    "async function loadServiceGrantUniverseUncached(",
    "async function loadServiceGrantsFromSource(",
  ),
  /getRepositoryAdapterName\(\) === "drizzle"[\s\S]*requireDeepAnalysisPromotion: true/,
  "production teaser/dashboard matching must request only promoted deep-analysis grants",
);

console.log("grant serving visibility tests passed");

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `missing source section ${start}..${end}`);
  return source.slice(startIndex, endIndex);
}
