import assert from "node:assert/strict";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { DraftFieldAnswers } from "@/lib/server/documents/fieldAnswers";
import type { FieldLessonTip } from "@/lib/server/knowledge/lessonContext";
import {
  buildInstitutionContact,
  computeWorkspaceProgress,
  confirmedFieldLabels,
  contactPhoneHref,
  countUnconfirmedFields,
  fieldDescriptionLine,
  fieldPositionCaption,
  workspaceFieldState,
} from "./workspacePresentation";

assert.equal(workspaceFieldState(undefined), "empty");
assert.equal(workspaceFieldState({ value: "", status: "dismissed", source: "user", updatedAt: "now" }), "empty");
assert.equal(workspaceFieldState({ value: "제안", status: "suggested", source: "llm", updatedAt: "now" }), "reviewing");
assert.equal(workspaceFieldState({ value: "확정", status: "accepted", source: "profile", updatedAt: "now" }), "filled");
assert.equal(workspaceFieldState({ value: "수정", status: "edited", source: "user", updatedAt: "now" }), "filled");

// ── 진행/카운트/축약 리스트 ─────────────────────────────
function connectedField(overrides: Partial<ConnectedDocumentField> & { label: string }): ConnectedDocumentField {
  return {
    fieldId: overrides.label,
    fieldKey: overrides.fieldKey ?? overrides.label,
    label: overrides.label,
    section: overrides.section ?? null,
    fieldType: overrides.fieldType ?? "text",
    required: overrides.required ?? false,
    sourceSpan: overrides.sourceSpan ?? null,
    mappedCompanyField: overrides.mappedCompanyField ?? null,
    fillStrategy: overrides.fillStrategy ?? "copy",
    position: overrides.position ?? null,
    visualEvidence: overrides.visualEvidence ?? null,
  };
}

const progressFields = [
  connectedField({ label: "상호명" }),
  connectedField({ label: "대표자명" }),
  connectedField({ label: "매출액" }),
];
const progressAnswers: DraftFieldAnswers = {
  상호명: { value: "확정", status: "accepted", source: "profile", updatedAt: "now" },
  대표자명: { value: "수정", status: "edited", source: "user", updatedAt: "now" },
  매출액: { value: "제안", status: "suggested", source: "llm", updatedAt: "now" },
};

assert.deepEqual(computeWorkspaceProgress(progressFields, progressAnswers, new Set()), { total: 3, confirmed: 2 });
// 패치 진행 중인 필드는 아직 확정으로 세지 않는다.
assert.deepEqual(
  computeWorkspaceProgress(progressFields, progressAnswers, new Set(["상호명"])),
  { total: 3, confirmed: 1 },
);
assert.equal(countUnconfirmedFields(progressFields, progressAnswers), 1);
assert.deepEqual(confirmedFieldLabels(progressFields, progressAnswers), ["상호명", "대표자명"]);

// ── 위치 캡션 ─────────────────────────────
assert.equal(fieldPositionCaption({ page: 2 }, "기업 현황"), "신청서 2쪽 · '기업 현황' 표");
assert.equal(fieldPositionCaption({ page: 3 }, null), "신청서 3쪽");
assert.equal(fieldPositionCaption({ page: 3 }, "   "), "신청서 3쪽");
assert.equal(fieldPositionCaption(null, "기업 현황"), null);
assert.equal(fieldPositionCaption({ bbox: [0, 0, 1, 1] }, "표"), null);

// ── 설명 한 줄(팁 첫 문장 → mappedCompanyField → null) ─────────────────────────────
const tip: FieldLessonTip = {
  id: "t1",
  instruction: "직전 회계연도 매출액을 기입합니다. 부가세 신고 기준으로 적으세요.",
  rationale: "근거",
  target: "fill_value",
  evidenceTier: "official_document",
  needsReview: false,
};
assert.equal(fieldDescriptionLine({ mappedCompanyField: "revenue" }, [tip]), "직전 회계연도 매출액을 기입합니다.");
assert.equal(fieldDescriptionLine({ mappedCompanyField: "revenue" }, []), "직전 회계연도 매출액을 적는 칸이에요.");
assert.equal(fieldDescriptionLine({ mappedCompanyField: "unknown_field" }, []), null);
assert.equal(fieldDescriptionLine({ mappedCompanyField: null }, []), null);

assert.deepEqual(
  buildInstitutionContact({
    agency: "창업진흥원",
    applyMethod: "문의 02-1234-5678 / apply@example.or.kr",
    deepLink: "https://example.or.kr/grants/1",
  }),
  {
    name: "창업진흥원",
    phone: "02-1234-5678",
    email: "apply@example.or.kr",
    sourceUrl: "https://example.or.kr/grants/1",
  },
);
assert.equal(
  buildInstitutionContact({ agency: "창업진흥원", applyMethod: "온라인 접수", deepLink: null }),
  null,
);
assert.equal(contactPhoneHref("02-1234-5678"), "tel:0212345678");
assert.equal(
  buildInstitutionContact({ agency: "수출바우처 사무국", applyMethod: "문의 1600-7119", deepLink: null })?.phone,
  "1600-7119",
);

console.log("apply-workspace presentation tests passed");
