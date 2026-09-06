import assert from "node:assert/strict";
import { workspaceReadiness } from "./workspaceReadiness";
import { loadGrantWorkspaceData } from "@/lib/server/documents/workspaceData";
import type { ApplySheet } from "@cunote/contracts";

const base = { execution: { mode: "persistent" as const }, ladder: "b" as const, draftId: "d", headRevision: null, documentAgentAvailable: false, fieldEditorAgentAvailable: false };
assert.match(workspaceReadiness(base).saving, /서버 저장은 아직 확인되지 않음/);
assert.match(workspaceReadiness(base).suggestions, /미제공/);
assert.match(workspaceReadiness({ ...base, ladder: "c", draftId: null }).editing, /원본 양식 편집 미지원/);
assert.match(workspaceReadiness({ ...base, execution: { mode: "virtual_preview", bizNo: "fixture", companyName: "합성 회사" } }).saving, /계정 저장 안 됨/);
assert.match(workspaceReadiness({ ...base, fieldEditorAgentAvailable: true }).suggestions, /선택 후 반영/);
assert.match(workspaceReadiness({ ...base, headRevision: { revisionId: "r", savedAt: "2026-09-06T00:00:00Z", materializedAnswers: {} } }).saving, /서버 저장본으로 재개/);
assert.match(workspaceReadiness(base).finalReview, /제출 완료가 아닙니다/);
await assert.rejects(() => loadGrantWorkspaceData({
  sheet: {} as ApplySheet,
  access: { role: "viewer", userId: "viewer", companyId: "company", mode: "session" },
}), { code: "company_write_forbidden", status: 403 }, "조회·초안 생성·시드 전에 viewer를 거부한다");
console.log("workspace readiness: editing, suggestions, persistence and final submission are separate");
