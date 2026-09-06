import assert from "node:assert/strict";
import type { MatchingProfileViewRow, MatchingProfileView } from "@cunote/contracts";
import { BASIC_PROFILE_DIMENSIONS, buildProfileCompletion, profileInputState } from "./profileCompletion";

const row = (dimension: MatchingProfileViewRow["dimension"], status: MatchingProfileViewRow["status"] = "known"): MatchingProfileViewRow => ({
  dimension, status, displayValue: "입력값", sourceKind: "self_declared", sourceLabel: "직접 입력",
  asOf: "2026-09-06T00:00:00Z", completeness: status === "known" ? "complete" : "partial",
  editMode: "direct", action: { kind: "answer", label: "입력하기" },
});
const view = (rows: MatchingProfileViewRow[]): MatchingProfileView => ({
  rows, asOf: "2026-09-06T00:00:00Z", knownCount: 999, partialCount: 0, unknownCount: 0,
});

assert.deepEqual(buildProfileCompletion(view([])), { total: 4, completed: 0, percent: 0, remaining: [...BASIC_PROFILE_DIMENSIONS] });
const basics = BASIC_PROFILE_DIMENSIONS.map((key) => row(key));
assert.equal(buildProfileCompletion(view(basics)).percent, 100);
assert.equal(buildProfileCompletion(view([...basics, row("tax_compliance", "unknown")])).percent, 100,
  "결격·공고별 추가정보는 기본정보 완료율과 분리한다");
assert.equal(buildProfileCompletion(view([row("region"), row("industry", "partial"), row("employees")])).percent, 25,
  "일부 확인이나 무관한 추가 정보는 완료로 세지 않는다");
assert.equal(profileInputState(row("employees")), "entered");
assert.equal(profileInputState({ ...row("employees"), displayValue: "0명" }), "entered");
assert.equal(profileInputState({ ...row("region"), sourceKind: "authoritative_api" }), "automatic");
assert.equal(profileInputState({ ...row("certification"), displayValue: "해당 없음" }), "absent");
assert.equal(profileInputState(row("industry", "partial")), "partial");
assert.equal(profileInputState(row("size", "unknown")), "missing");
assert.equal(profileInputState(row("size", "unknown"), [{ field: "size", unknown: true }]), "unknown");
assert.equal(profileInputState(row("size", "unknown"), [{ field: "size", unknown: true }, { field: "size", value: "중소기업" }]), "missing");
assert.equal(profileInputState(row("region"), [{ field: "region", unknown: true }]), "entered",
  "모름 상태는 기존 확인값을 지우지 않는 서버 계약과 일치한다");
console.log("profile completion: ok");
