import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migrationPath = "db/migrations/0045_mushy_daimon_hellstrom.sql";
const migration = readFileSync(migrationPath, "utf8");
const webRoute = readFileSync("apps/web/src/app/api/web/profile/field/route.ts", "utf8");
const appRoute = readFileSync("apps/web/src/app/api/app/v1/companies/[companyId]/profile/field/route.ts", "utf8");
const report = readFileSync("apps/web/src/lib/server/matches/report-profile-question-quality.ts", "utf8");

for (const column of [
  "session_id",
  "dimension",
  "evaluated_grant_count",
  "targeted_conditional_count",
  "dimension_resolved_grant_count",
  "eligibility_resolved_count",
  "conditional_resolution_rate",
  "ruleset_ver",
]) {
  assert.match(migration, new RegExp(`"${column}"`), `missing telemetry column ${column}`);
}
for (const forbiddenColumn of ["answer", "answer_value", "biz_no", "profile_value", "source_span"]) {
  assert.doesNotMatch(
    migration,
    new RegExp(`"${forbiddenColumn}"`, "i"),
    `raw or identifying column must not be stored: ${forbiddenColumn}`,
  );
}
assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /FORCE ROW LEVEL SECURITY/);
assert.match(migration, /CREATE POLICY "profile_question_events_member"/);
assert.match(webRoute, /saveProfileQuestionEvent/);
assert.match(webRoute, /cunote_question_session/);
assert.match(appRoute, /saveProfileQuestionEvent/);
assert.match(report, /rawAnswerStored: false/);
assert.match(report, /buildProfileQuestionQualityReport/);

console.log(JSON.stringify({
  ok: true,
  migrationPath,
  rawAnswerStored: false,
  checks: [
    "aggregate_columns_only",
    "company_scoped_rls",
    "web_session_cookie",
    "app_session_contract",
    "monthly_quality_report",
  ],
}, null, 2));
