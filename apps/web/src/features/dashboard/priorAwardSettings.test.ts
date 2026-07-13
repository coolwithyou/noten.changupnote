import assert from "node:assert/strict";
import type { CompanyProfile } from "@cunote/contracts";
import {
  buildPriorAwardProfileValue,
  emptyPriorAwardSettingsDraft,
  priorAwardDraftFromProfile,
  setCanonicalProgramKnown,
} from "./priorAwardSettings";

const profile: CompanyProfile = {
  prior_award_history: {
    records: [
      { program: "startup_nest", agency: "신용보증기금", state: "graduated", year: 2024 },
      { program: "지역특화사업", state: "completed" },
    ],
    self_flags: { current_similar: false, same_project: true },
    has_incubation_tenancy: false,
    known_programs: ["tips"],
    known_program_types: ["startup_nest"],
  },
  confidence: { prior_award: 0.6 },
};

const draft = priorAwardDraftFromProfile(profile);
assert.equal(draft.self.current_similar, "no");
assert.equal(draft.self.same_project, "yes");
assert.equal(draft.self.same_business_prior, "unknown");
assert.equal(draft.incubationTenancy, "no");
assert.equal(draft.records.length, 2);

const rebuilt = buildPriorAwardProfileValue(draft);
assert.deepEqual(rebuilt.self_flags, { current_similar: false, same_project: true });
assert.equal(rebuilt.has_incubation_tenancy, false);
assert.deepEqual(rebuilt.records, profile.prior_award_history?.records);
assert.deepEqual(new Set(rebuilt.known_programs), new Set(["tips", "지역특화사업"]));
assert.deepEqual(rebuilt.known_program_types, ["startup_nest"]);

const negative = setCanonicalProgramKnown(emptyPriorAwardSettingsDraft(), "chogi_startup_package", true);
const negativeValue = buildPriorAwardProfileValue(negative);
assert.deepEqual(negativeValue.records, []);
assert.deepEqual(negativeValue.known_programs, ["chogi_startup_package"]);

const legacy = priorAwardDraftFromProfile({ prior_awards: ["2024년 초기창업패키지"] });
assert.equal(legacy.records.length, 1);
assert.equal(legacy.records[0]?.state, "completed");
assert.deepEqual(buildPriorAwardProfileValue(legacy).known_programs, ["chogi_startup_package"]);

const invalid = emptyPriorAwardSettingsDraft();
invalid.records = [{ id: "x", program: "TIPS", agency: "", state: "completed", year: "1899" }];
assert.throws(() => buildPriorAwardProfileValue(invalid), /1900~2100/);

console.log("priorAwardSettings.test.ts: all assertions passed");
