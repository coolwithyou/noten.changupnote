import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { emptyWritingBrief } from "@/lib/documents/writingContext";
import { writingGroundingSources } from "./writingGroundingSources";
const content = "2025년 고객 3곳. 이후의 회사 현황은 확인 필요.";
const source = { id: crypto.randomUUID(), title: "과거 소개서", scope: "company" as const, kind: "company_document" as const,
  sha256: createHash("sha256").update(content).digest("hex"), observedDate: "2025-12-31", createdAt: new Date().toISOString(), withdrawn: false, content };
const input = { companyId: crypto.randomUUID(), draftId: crypto.randomUUID(), revision: 1, brief: { ...emptyWritingBrief(), goals: "2027년 고객 10곳 목표" }, sources: [source] };
const result = writingGroundingSources(input);
assert.equal(result[0]!.kind, "company_material");
assert.equal(result[0]!.provenance.verification, "user_provided");
assert.equal(result[0]!.content, content);
assert.equal(result[1]!.kind, "application_plan");
assert.match(result[1]!.content, /달성한 회사 실적이 아님/);
assert.notEqual(writingGroundingSources({ ...input, revision: 2 })[1]!.sourceId, result[1]!.sourceId);
assert.throws(() => writingGroundingSources({ ...input, sources: [{ ...source, withdrawn: true }] }));
assert.throws(() => writingGroundingSources({ ...input, sources: [{ ...source, content: "조작" }] }));
assert.deepEqual(writingGroundingSources({ ...input, sources: [], brief: emptyWritingBrief() }), []);
console.log("PASS: company materials retain unverified provenance and dates; application plans and source revisions remain distinct; withdrawn/tampered evidence rejected");
