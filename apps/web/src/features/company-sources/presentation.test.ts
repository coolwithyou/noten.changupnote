import assert from "node:assert/strict";
import { COMPANY_SOURCES_COPY, sourceCountLabel, sourceMetaLine, sourceScopeLabel, workspaceHrefFor } from "./presentation";

const base = { scope: "company" as const, observedDate: "2026-06-30", characters: 1840, usedByDrafts: 2, application: null };
assert.equal(sourceMetaLine({ ...base, originalPdf: { filename: "a.pdf", pages: 12, sha256: "x" } }), "2026-06-30 기준 · PDF 12쪽 · 사용 중인 문서 2건");
assert.equal(sourceMetaLine({ ...base, observedDate: "2025-12-31", usedByDrafts: 1 }), "2025-12-31 기준 · 텍스트 1,840자 · 사용 중인 문서 1건");
assert.equal(sourceMetaLine({ ...base, observedDate: null, usedByDrafts: 0, characters: 0 }), "기준일 미입력 · 텍스트 0자 · 사용 중인 문서 0건");
const application = { draftId: "d", grantId: "g 1", grantTitle: "부산 청년기업 스케일업", documentKey: "plan/form", documentName: "사업계획서" };
assert.equal(sourceMetaLine({ ...base, scope: "application", observedDate: "2026-09-28", characters: 620, application }),
  "부산 청년기업 스케일업 · 2026-09-28 기준 · 텍스트 620자");
assert.equal(sourceMetaLine({ ...base, scope: "application", observedDate: null, characters: 5, application: { ...application, grantTitle: null } }),
  "사업계획서 · 기준일 미입력 · 텍스트 5자");
assert.equal(sourceScopeLabel("company"), COMPANY_SOURCES_COPY.scopeCompany);
assert.equal(sourceScopeLabel("application"), COMPANY_SOURCES_COPY.scopeApplication);
assert.equal(sourceCountLabel([{ scope: "company" }, { scope: "company" }, { scope: "application" }]), "회사 공통 자료 2 · 이번 신청 전용 1");
assert.equal(sourceCountLabel([]), "회사 공통 자료 0 · 이번 신청 전용 0");
assert.equal(workspaceHrefFor(application, "c-1"), "/grants/g%201/workspace?document=plan%2Fform&companyId=c-1");
for (const value of Object.values(COMPANY_SOURCES_COPY)) {
  assert.doesNotMatch(value, /지원 가능|매칭률|%|선정 확률|자동으로 완성/, `금지 문구: ${value}`);
}
console.log("PASS: company source meta/count/workspace href match design vocabulary; copy has no forbidden phrases");
