import assert from "node:assert/strict";
import { issueProductExposureTokens, signExposureBinding, verifyExposureBinding } from "./exposure";
import type { NormalizedGrant } from "@cunote/contracts";
import type { CunoteDb } from "../db/client";

const secret = "local-fixture-secret-not-for-production";
const now = new Date("2026-09-06T00:10:00Z");
const binding = { version: 1 as const, itemId: crypto.randomUUID(), grantId: crypto.randomUUID(), companyId: "company-a", userId: "user-a", issuedAt: now.getTime() };
const token = signExposureBinding(binding, secret);
assert.deepEqual(verifyExposureBinding(token, { ...binding, now, secret }), binding);
for (const invalid of [null, "", `${token}x`, `${token}.extra`, token.slice(0, -4)]) {
  assert.throws(() => verifyExposureBinding(invalid, { ...binding, now, secret }), { code: "invalid_exposure_receipt" });
}
for (const context of [
  { companyId: "company-b" }, { userId: "user-b" },
  { now: new Date(now.getTime() + 15 * 60_000 + 1) }, { now: new Date(now.getTime() - 1) },
]) assert.throws(() => verifyExposureBinding(token, { ...binding, now, secret, ...context }), { code: "invalid_exposure_receipt" });

const fixture: NormalizedGrant = {
  grant: { id: binding.grantId, source: "bizinfo", source_id: binding.grantId, f_authoring_mode: "web_form", title: "합성 공고",
    status: "open", apply_method: {}, f_regions: [], f_industries: [], f_sizes: [], f_founder_traits: [], f_required_certs: [], overall_confidence: 1 },
  raw: { source: "bizinfo", source_id: binding.grantId, collected_at: now.toISOString(), payload: {}, status: "published" }, criteria: [],
};
const criterionId = crypto.randomUUID();
const criterion = { id: criterionId, dimension: "region" as const, operator: "in" as const, value: { regions: ["서울"] }, kind: "required" as const, confidence: 1 };
const entry = { ...fixture, grant: { ...fixture.grant, id: binding.grantId }, criteria: [criterion] };
const snapshot = { grantId: binding.grantId, criteria: [{ ...criterion, sourceSpan: null, rawText: null, parserVersion: null, needsReview: false, weight: null }] };
let rows = [{ itemId: binding.itemId, grantId: binding.grantId, runId: "fixture", planSha256: "a".repeat(64), deepAnalysisRunId: crypto.randomUUID(),
  releaseManifestSha256: "b".repeat(64), manifest: {}, afterSnapshot: snapshot, appliedAt: new Date(now.getTime() - 60_000) }];
const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, orderBy: () => chain, limit: async () => rows };
const db = { select: () => chain } as unknown as CunoteDb;
const input = { companyId: binding.companyId, userId: binding.userId, grants: [entry], displayedGrantIds: [binding.grantId] };
const dependencies = { db, secret, enabled: true, now };
const issued = await issueProductExposureTokens(input, dependencies);
assert.equal(issued.size, 1);
assert.equal(verifyExposureBinding(issued.get(binding.grantId), { ...binding, now, secret }).itemId, binding.itemId);
assert.equal((await issueProductExposureTokens(input, { ...dependencies, enabled: false })).size, 0);
assert.equal((await issueProductExposureTokens(input, { ...dependencies, secret: "" })).size, 0);
assert.equal((await issueProductExposureTokens({ ...input, displayedGrantIds: [] }, dependencies)).size, 0);
rows = [{ ...rows[0]!, afterSnapshot: { ...snapshot, criteria: [] } }];
assert.equal((await issueProductExposureTokens(input, dependencies)).size, 0, "다른 criterion snapshot을 최신 승격으로 표시하지 않는다");
rows = [{ ...rows[0]!, afterSnapshot: snapshot }, { ...rows[0]!, itemId: crypto.randomUUID(), afterSnapshot: snapshot }];
assert.equal((await issueProductExposureTokens(input, dependencies)).size, 0, "최신 시각이 동률인 승격을 임의 선택하지 않는다");
console.log("exposure: signed company/user binding, expiry, exact criteria, feature-off and ambiguous revisions passed");
