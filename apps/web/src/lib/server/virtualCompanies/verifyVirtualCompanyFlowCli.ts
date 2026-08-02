import assert from "node:assert/strict";
import type {
  ActionResult,
  CompanyPreviewResult,
  ProductTeaserResult,
} from "@cunote/contracts";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";

loadMonorepoEnv();
process.env.CUNOTE_REPOSITORY_ADAPTER = "drizzle";
process.env.CUNOTE_VIRTUAL_COMPANY_ENABLED = "true";

const [
  { POST: preview },
  { POST: teaser },
  { closeCunoteDb },
  { loadServiceApplySheet },
  { loadVirtualGrantWorkspaceData },
  { resolveVirtualCompanyScenario },
] = await Promise.all([
  import("@/app/api/web/company-preview/route"),
  import("@/app/api/web/teaser/route"),
  import("@/lib/server/db/client"),
  import("@/lib/server/serviceData"),
  import("@/lib/server/documents/workspaceData"),
  import("@/lib/server/virtualCompanies/catalog"),
]);

try {
  const previewResult = await preview(request("company-preview", { bizNo: "0000000001" }));
  const previewBody = await previewResult.json() as ActionResult<CompanyPreviewResult>;
  assert.equal(previewResult.status, 200);
  assert.equal(previewBody.ok, true);
  assert.equal(previewBody.data?.name, "창업노트 가상기업 — 충남 장애인기업");
  assert.equal(previewBody.data?.cacheStatus, "virtual");

  const expected = [
    { bizNo: "0000000001", tier: "recommendable", visible: true },
    { bizNo: "0000000002", tier: "not_recommended", visible: false },
    { bizNo: "0000000003", tier: "needs_profile_input", visible: true },
  ] as const;
  const flowResults: Array<Record<string, unknown>> = [];
  for (const scenario of expected) {
    const response = await teaser(request("teaser", { bizNo: scenario.bizNo }));
    const body = await response.json() as ActionResult<ProductTeaserResult>;
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.data);
    const target = body.data.matches.find((match) =>
      match.source === "bizinfo" && match.sourceId === "PBLN_000000000124754");
    assert.equal(Boolean(target), scenario.visible);
    if (scenario.visible) assert.equal(target?.recommendationTier, scenario.tier);
    flowResults.push({
      bizNoRef: scenario.bizNo.slice(-1),
      expectedTier: scenario.tier,
      visible: Boolean(target),
      actualTier: target?.recommendationTier ?? "hidden",
      evaluatedGrantCount: body.data.searchContext?.evaluatedGrantCount ?? 0,
    });
  }

  const detail = await loadServiceApplySheet("a66f875d-e873-4166-ace6-27348e4c4b10", {
    virtualBizNo: "0000000001",
  });
  assert.ok(detail);
  assert.equal(detail.satisfied.filter((criterion) =>
    criterion.kind === "required" || criterion.kind === "exclusion").length, 3);
  assert.equal(detail.needsCheck.filter((criterion) =>
    criterion.kind === "required" || criterion.kind === "exclusion").length, 0);
  const scenario = resolveVirtualCompanyScenario("0000000001");
  assert.ok(scenario);
  const workspace = await loadVirtualGrantWorkspaceData({
    sheet: detail,
    virtualCompany: scenario,
  });
  assert.equal(workspace.execution.mode, "virtual_preview");
  assert.equal(workspace.draftId, null, "가상 기업 workspace는 DB draft를 만들면 안 됩니다.");
  assert.deepEqual(workspace.initialDrafts, []);
  assert.deepEqual(workspace.suggestableLabels, [], "가상 기업 workspace는 유료 AI 제안 접점을 열면 안 됩니다.");
  assert.equal(workspace.pollConversion, false, "가상 기업 workspace는 변환 write poll을 실행하면 안 됩니다.");
  assert.ok(workspace.documents.length > 0, "실제 공고의 작성형 문서를 불러와야 합니다.");

  console.log(JSON.stringify({
    status: "pass",
    preview: {
      name: previewBody.data?.name,
      cacheStatus: previewBody.data?.cacheStatus,
    },
    flows: flowResults,
    detail: {
      grantId: detail.grant.id,
      hardSatisfied: detail.satisfied.filter((criterion) =>
        criterion.kind === "required" || criterion.kind === "exclusion").length,
      hardNeedsCheck: detail.needsCheck.filter((criterion) =>
        criterion.kind === "required" || criterion.kind === "exclusion").length,
    },
    workspace: {
      mode: workspace.execution.mode,
      documentCount: workspace.documents.length,
      connectedFieldCount: workspace.connectedFields.length,
      seededAnswerCount: Object.keys(workspace.fieldAnswers).length,
      pageCount: workspace.pages.length,
      draftId: workspace.draftId,
      fields: workspace.connectedFields.map((field) => ({
        fieldKey: field.fieldKey,
        label: field.label,
        mappedCompanyField: field.mappedCompanyField,
        fillStrategy: field.fillStrategy,
      })),
    },
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function request(
  path: "company-preview" | "teaser",
  body: unknown,
): Request {
  const url = `http://127.0.0.1:4010/api/web/${path}`;
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:4010",
    },
    body: JSON.stringify(body),
  });
}
