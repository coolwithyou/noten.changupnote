import assert from "node:assert/strict";
import type { ApplySheet } from "@cunote/contracts";
import type { GrantPreviewAvailability } from "@/lib/server/documents/documentPreview";
import {
  formatDday,
  formatEligibilitySummary,
  formatSupportAmount,
  grantOverviewCta,
  grantOverviewTraceAction,
  grantOverviewVerdict,
} from "./logic";

function sheetFixture(input: {
  status?: ApplySheet["grant"]["status"];
  applyMethod?: string | null;
  needsCheck?: ApplySheet["needsCheck"];
  documents?: ApplySheet["documents"];
  draftableDocuments?: ApplySheet["applicationPrep"]["draftableDocuments"];
} = {}): ApplySheet {
  return {
    grant: { status: input.status ?? "open" },
    needsCheck: input.needsCheck ?? [],
    documents: input.documents ?? [],
    applicationPrep: { draftableDocuments: input.draftableDocuments ?? [] },
    applyMethod: input.applyMethod ?? null,
  } as ApplySheet;
}

function previewFixture(input: Partial<GrantPreviewAvailability> = {}): GrantPreviewAvailability {
  return {
    surfaceCount: 0,
    readySurfaceCount: 0,
    pendingSurfaceCount: 0,
    pageImageCount: 0,
    ...input,
  };
}

assert.equal(grantOverviewVerdict(sheetFixture()), "open");
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      needsCheck: [
        {
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
      ] as ApplySheet["needsCheck"],
    }),
  ),
  "one_answer",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      status: "upcoming",
      needsCheck: [
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
      ] as ApplySheet["needsCheck"],
    }),
  ),
  "check_source",
);
assert.equal(grantOverviewVerdict(sheetFixture({ status: "upcoming" })), "check_source");
assert.equal(grantOverviewVerdict(sheetFixture({ status: "unknown" })), "check_source");
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      needsCheck: [
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
      ] as ApplySheet["needsCheck"],
    }),
  ),
  "one_answer",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      needsCheck: [
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
        {
          dimension: "region",
          result: "unknown",
          action: { type: "progressive", target: "region", label: "지금 확인" },
        },
      ] as ApplySheet["needsCheck"],
    }),
  ),
  "check_source",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      needsCheck: [
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
        {
          dimension: "region",
          result: "unknown",
          action: { type: "external_link", target: "source", label: "원문 확인" },
        },
      ] as ApplySheet["needsCheck"],
    }),
  ),
  "check_source",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      needsCheck: [
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
      ] as ApplySheet["needsCheck"],
      documents: [{ fromTextOnly: true }] as ApplySheet["documents"],
    }),
  ),
  "check_source",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({ needsCheck: [{ result: "unknown" }] as ApplySheet["needsCheck"] }),
  ),
  "check_source",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({ documents: [{ fromTextOnly: true }] as ApplySheet["documents"] }),
  ),
  "check_source",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({ needsCheck: [{ result: "fail" }] as ApplySheet["needsCheck"] }),
  ),
  "closed",
);

const templateSheet = sheetFixture({
  draftableDocuments: [{ hwpxTemplateAvailable: true }] as ApplySheet["applicationPrep"]["draftableDocuments"],
});
assert.deepEqual(grantOverviewCta(templateSheet, previewFixture()), {
  mode: "template_fill",
  label: "지원서 작성 시작",
  caption: "1개 원본 양식을 확인하며 작성을 시작해요",
  variant: "default",
});

assert.equal(
  grantOverviewCta(sheetFixture(), previewFixture({ pendingSurfaceCount: 2 })).mode,
  "analyzing",
);
assert.equal(
  grantOverviewCta(
    sheetFixture({
      draftableDocuments: [{ hwpxTemplateAvailable: false }] as ApplySheet["applicationPrep"]["draftableDocuments"],
    }),
    previewFixture(),
  ).mode,
  "ai_draft",
);
assert.equal(
  grantOverviewCta(sheetFixture({ applyMethod: "온라인 접수" }), previewFixture()).mode,
  "web_form_guide",
);
assert.equal(grantOverviewCta(sheetFixture(), previewFixture()).mode, "unknown");

assert.deepEqual(
  grantOverviewTraceAction(
    { type: "progressive", target: "industry", label: "지금 확인" },
    "https://example.com/grants/1",
  ),
  { href: "/settings?section=company", external: false },
);
assert.deepEqual(
  grantOverviewTraceAction(
    { type: "external_link", target: "https://other.example/grants/1", label: "원문 확인" },
    "https://example.com/grants/1",
  ),
  { href: "https://example.com/grants/1", external: true },
);
assert.deepEqual(
  grantOverviewTraceAction(
    { type: "prepare", target: "region", label: "준비 조건 보기" },
    "https://example.com/grants/1",
  ),
  { href: "https://example.com/grants/1", external: true },
);
assert.deepEqual(
  grantOverviewTraceAction(
    { type: "verify", target: "region", label: "확인 방법 보기" },
    "javascript:alert(1)",
  ),
  { href: "/settings?section=company", external: false },
);
assert.equal(
  grantOverviewTraceAction(
    { type: "external_link", target: "source", label: "원문 확인" },
    "/legacy-placeholder",
  ),
  null,
);

assert.equal(formatSupportAmount({ max: 30_000_000, unit: "KRW", per: "기업" }), "3,000만 원");
assert.equal(
  formatSupportAmount({ label: "최대 3,000만원", max: null, unit: "KRW", per: "기업" }),
  "최대 3,000만 원",
);
assert.equal(formatDday(21), "D-21");
assert.equal(formatEligibilitySummary(3, 2), "충족 3 · 확인 2");
