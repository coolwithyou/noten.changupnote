import assert from "node:assert/strict";
import type { LabAttachmentPreparationDiagnostic } from "./input";
import {
  assertMatchingAnnouncementCoverage,
  MatchingAnnouncementInputMissingError,
} from "./matching-announcement-coverage";

const attachment = (
  filename: string,
  documentRole: LabAttachmentPreparationDiagnostic["documentRole"],
  inputOutcome: LabAttachmentPreparationDiagnostic["inputOutcome"],
): LabAttachmentPreparationDiagnostic => ({
  filename, documentRole, inputOutcome,
  roleBasis: "explicit_filename_hint",
  conversionStatus: null,
  missingReason: inputOutcome === "loaded" ? null : "cap_exceeded",
  relatedDimensions: [],
  recovery: { possible: false, mode: "none", requiresSourceWrite: false, reason: "test" },
});

assert.doesNotThrow(() => assertMatchingAnnouncementCoverage([
  attachment("공고문.pdf", "announcement", "loaded"),
  attachment("신청서.hwp", "application_form", "unavailable"),
]));
assert.doesNotThrow(() => assertMatchingAnnouncementCoverage([
  attachment("공고문.zip", "announcement", "covered_by_children"),
]));
assert.throws(
  () => assertMatchingAnnouncementCoverage([
    attachment("통합공고문.pdf", "announcement", "unavailable"),
    attachment("통합공고문.hwpx", "announcement", "truncated"),
  ]),
  (error) => error instanceof MatchingAnnouncementInputMissingError
    && error.code === "matching_announcement_input_missing"
    && error.message.includes("통합공고문.pdf")
    && error.message.includes("통합공고문.hwpx"),
);
assert.throws(() => assertMatchingAnnouncementCoverage(undefined), MatchingAnnouncementInputMissingError);

console.log("matching announcement coverage gate tests passed");
