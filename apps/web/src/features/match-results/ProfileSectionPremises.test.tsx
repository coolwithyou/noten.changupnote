import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { MatchingProfileViewRow, ProductTeaserResult } from "@cunote/contracts";
import { PROFILE_SHEET_DIMENSIONS, buildProfileSheetRows } from "./ProfileSection";
import { buildProfileFields } from "./logic";

const premisesRow: MatchingProfileViewRow = {
  dimension: "premises",
  status: "known",
  displayValue: "본사 · 서울",
  sourceKind: "self_declared",
  sourceLabel: "직접 답변",
  asOf: "2026-09-08T15:30:00.000Z",
  completeness: "complete",
  editMode: "direct",
  action: { kind: "none", label: "확인됨" },
  premisesValue: {
    schemaVersion: "premises-v1",
    locations: [{
      locationId: "00000000-0000-4000-8000-000000000301",
      facilityType: "headquarters",
      sidoCode: "11",
      validFrom: "2026-01-01",
      validTo: null,
    }],
    coverage: {
      facilityTypes: ["headquarters"],
      validFrom: "2026-01-01",
      validTo: "2026-09-09",
      asOf: "2026-09-08T15:30:00.000Z",
      completeness: "complete",
    },
  },
};

const teaser = {
  profileView: {
    asOf: "2026-09-08T15:30:00.000Z",
    knownCount: 1,
    partialCount: 0,
    unknownCount: 19,
    rows: [premisesRow],
  },
  matches: [],
  privacyNote: "fixture",
} as unknown as ProductTeaserResult;

assert.ok(PROFILE_SHEET_DIMENSIONS.some((entry) => entry.key === "premises" && entry.label === "등록 사업장"));
const rows = buildProfileSheetRows(teaser, buildProfileFields(teaser), []);
const row = rows.find((entry) => entry.key === "premises");
assert.equal(row?.label, "등록 사업장", "typed premises must be reachable from the dedicated additional profile row");
assert.equal(row?.value, "본사 · 서울");
assert.equal(row?.state, "direct");
assert.deepEqual(row?.field?.premisesValue, premisesRow.premisesValue, "reopen input must carry the exact private typed value");

const source = readFileSync(new URL("./ProfileSection.tsx", import.meta.url), "utf8");
assert.ok(source.includes('key={companyId ?? "anonymous"}'), "company switch must remount the premise editor without keying dirty drafts to background asOf");
assert.equal(source.includes("field.premisesValue?.coverage.asOf ?? \"new\""), false);
assert.ok(source.includes('setActiveFieldKey((current) => current === "premises" ? current : null)'),
  "same-company role downgrade keeps only the premise inspector and closes writable generic editors");
assert.ok(source.includes('setView("profile")'), "company or role context changes must leave writable verification subviews");

console.log("ProfileSection premises dedicated entry and exact reopen value passed");
