import assert from "node:assert/strict";
import { canVerifySourceCorrection, isVerifiedSourceCurrent, type CompanyProfile, type GrantCriterion, type SourceCorrectionRecord } from "@cunote/contracts";
import { matchGrantCriteria } from "@cunote/core";
import { annotateSourceCorrectionState, sourceCorrectionSnapshot } from "./sourceCorrections";
import { buildMatchingProfileView, type ResolvedProductCompanyProfile } from "./resolveProductCompanyProfile";

const asOf = "2026-09-07T00:00:00Z";
const profile: CompanyProfile = { employees_count: 20, revenue_krw: 100, profile_evidence: {
  employees: { sourceKind: "authoritative_api", provider: "fixture_official", asOf, axisCompleteness: "complete", confidence: 1 },
  revenue: { sourceKind: "self_declared", provider: "user", asOf, axisCompleteness: "complete", confidence: 1 },
} };
const baseline = sourceCorrectionSnapshot(profile, "employees");
const record: SourceCorrectionRecord = { id: "fixture", ticketId: "ticket", userId: "u", companyId: "c", dimension: "employees", baseline,
  statement: "현재 근로자 수가 공식 자료와 다릅니다.", observation: null, status: "open", revision: 1, events: [] };
const resolution: ResolvedProductCompanyProfile = { profile, view: buildMatchingProfileView(profile, asOf), asOf, context: "owned_read", stateScope: "company", decisions: [], sourceReceipts: [], persistence: "none", refreshStatus: "not_requested" };
const disputed = annotateSourceCorrectionState(resolution, [record]);
assert.equal(disputed.profile.employees_count, 20, "원천 사실은 제거하거나 덮어쓰지 않는다");
assert.equal(disputed.view.rows.find((row) => row.dimension === "employees")?.sourceDisputed, true);
const criteria: GrantCriterion[] = [
  { id: "employee", dimension: "employees", operator: "lte", kind: "required", value: { max: 10 }, confidence: 1 },
  { id: "revenue", dimension: "revenue", operator: "lte", kind: "required", value: { max_krw: 200 }, confidence: 1 },
];
const match = matchGrantCriteria(criteria, disputed.profile, { asOf: new Date(asOf) });
assert.equal(match.rule_trace.find((entry) => entry.dimension === "employees")?.result, "unknown");
assert.equal(match.rule_trace.find((entry) => entry.dimension === "revenue")?.result, "pass");
assert.equal(matchGrantCriteria(criteria, disputed.profile, { asOf: new Date(asOf), confirmations: [{ criterion_id: "employee", disqualified: false }] }).rule_trace.find((entry) => entry.dimension === "employees")?.result, "unknown", "기존 자기 확인 답변으로 공식 원천 정정 보류를 우회하지 못한다");
assert.deepEqual(annotateSourceCorrectionState(resolution, [{ ...record, status: "rejected" }]).profile.source_disputes, []);
assert.equal(canVerifySourceCorrection(record), false);
assert.equal(canVerifySourceCorrection({ baseline, observation: baseline }), false);
const updated = sourceCorrectionSnapshot({ ...profile, employees_count: 8 }, "employees");
assert.equal(isVerifiedSourceCurrent(updated, { ...updated, evidence: { ...updated.evidence, asOf: "2026-09-08T00:00:00Z" } }), true);
assert.equal(isVerifiedSourceCurrent(updated, { ...updated, evidence: { ...updated.evidence, asOf: "2026-09-01T00:00:00Z" } }), false);
assert.equal(canVerifySourceCorrection({ baseline, observation: updated }), true, "내부 해석 오류 수정은 원천 날짜가 같아도 검수 가능");
assert.equal(canVerifySourceCorrection({ baseline, observation: { ...updated, evidence: { ...updated.evidence, sourceKind: "self_declared" } } }), false);
assert.equal(canVerifySourceCorrection({ baseline, observation: { ...updated, evidence: { ...updated.evidence, asOf: "2025-01-01" } } }), false);
const resolved = { ...record, status: "resolved" as const, observation: updated };
assert.deepEqual(annotateSourceCorrectionState(resolution, [resolved]).profile.source_disputes, ["employees"], "검수했던 관측값과 현재 값이 다르면 확인 필요 유지");
assert.deepEqual(annotateSourceCorrectionState({ ...resolution, profile: { ...profile, employees_count: 8 } }, [resolved]).profile.source_disputes, []);
assert.throws(() => sourceCorrectionSnapshot({ employees_count: 10 }, "employees"));
console.log("source corrections: original facts preserved, axis-only deferral, official evidence and drift gates passed");
