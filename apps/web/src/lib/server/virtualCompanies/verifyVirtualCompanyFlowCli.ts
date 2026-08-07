import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  { loadDraftSourceFile },
  { loadServiceApplySheet, loadServiceGrantUniverse },
  { loadVirtualGrantWorkspaceData },
  { listVirtualCompanyScenarios },
  { verifyVirtualCompanyFlowBaseline },
  { verifyVirtualCompanyMatrix },
] = await Promise.all([
  import("@/app/api/web/company-preview/route"),
  import("@/app/api/web/teaser/route"),
  import("@/lib/server/db/client"),
  import("@/lib/server/documents/draftSourceFile"),
  import("@/lib/server/serviceData"),
  import("@/lib/server/documents/workspaceData"),
  import("@/lib/server/virtualCompanies/catalog"),
  import("@/lib/server/virtualCompanies/verifyVirtualCompanyFlowBaseline"),
  import("@/lib/server/virtualCompanies/verifyVirtualCompanyMatrix"),
]);

let exitCode = 1;
try {
  const asOf = new Date();
  const scenarios = listVirtualCompanyScenarios({ asOf });
  const grants = await loadServiceGrantUniverse({ asOf });
  const matrix = verifyVirtualCompanyMatrix({ grants, scenarios, asOf });
  if (matrix.status !== "pass") {
    console.log(JSON.stringify({
      status: matrix.status,
      phase: "analysis_baseline",
      matrix,
    }, null, 2));
    exitCode = 1;
  } else {
    const previewScenario = scenarios.find((scenario) =>
      scenario.targets.some((target) => target.expectedWritingEntry === "available"));
    assert.ok(previewScenario, "작성 가능 가상 기업 시나리오가 필요합니다.");

    const previewResult = await preview(request("company-preview", { bizNo: previewScenario.bizNo }));
    const previewBody = await previewResult.json() as ActionResult<CompanyPreviewResult>;
    assert.equal(previewResult.status, 200);
    assert.equal(previewBody.ok, true);
    assert.equal(previewBody.data?.name, previewScenario.name);
    assert.equal(previewBody.data?.cacheStatus, "virtual");

    const flowResults: Array<Record<string, unknown>> = [];
    for (const scenario of scenarios) {
      const response = await teaser(request("teaser", { bizNo: scenario.bizNo }));
      const body = await response.json() as ActionResult<ProductTeaserResult>;
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.ok(body.data);
      for (const targetExpectation of scenario.targets) {
        const target: ProductTeaserResult["matches"][number] | undefined = body.data.matches.find((match) =>
          match.source === targetExpectation.source && match.sourceId === targetExpectation.sourceId);
        const expectedVisible = targetExpectation.expected !== "not_recommended";
        assert.equal(Boolean(target), expectedVisible);
        if (expectedVisible) assert.equal(target?.recommendationTier, targetExpectation.expected);
        flowResults.push({
          scenarioId: scenario.id,
          bizNoRef: scenario.bizNo.slice(-1),
          source: targetExpectation.source,
          sourceId: targetExpectation.sourceId,
          expectedTier: targetExpectation.expected,
          expectedWritingEntry: targetExpectation.expectedWritingEntry,
          visible: Boolean(target),
          actualTier: target?.recommendationTier ?? "hidden",
          evaluatedGrantCount: body.data.searchContext?.evaluatedGrantCount ?? 0,
        });
      }
    }

    const sourceCache = new Map<
      string,
      Awaited<ReturnType<typeof loadDraftSourceFile>>
    >();
    const detailResults: Array<Record<string, unknown>> = [];
    const documentSourceResults: Array<Record<string, unknown>> = [];
    const workspaceResults: Array<Record<string, unknown>> = [];
    const baselineResults: Array<{
      scenarioId: string;
      source: string;
      sourceId: string;
      baseline: ReturnType<typeof verifyVirtualCompanyFlowBaseline>;
    }> = [];

    for (const scenario of scenarios) {
      for (const target of scenario.targets) {
        const matrixResult = matrix.results.find((result) =>
          result.scenarioId === scenario.id
          && result.source === target.source
          && result.sourceId === target.sourceId);
        assert.ok(matrixResult?.grantId, `${scenario.id} 목표 공고 ID를 찾지 못했습니다.`);

        const detail = await loadServiceApplySheet(matrixResult.grantId, {
          virtualBizNo: scenario.bizNo,
        });
        assert.ok(detail, `${scenario.id} 공고 상세를 찾지 못했습니다.`);
        detailResults.push({
          scenarioId: scenario.id,
          grantId: detail.grant.id,
          hardSatisfied: detail.satisfied.filter((criterion) =>
            criterion.kind === "required" || criterion.kind === "exclusion").length,
          hardNeedsCheck: detail.needsCheck.filter((criterion) =>
            criterion.kind === "required" || criterion.kind === "exclusion").length,
        });
        if (target.verificationScope === "matching_only") continue;
        assert.ok(target.expectedDocument, `${scenario.id} 작성 기준 문서가 없습니다.`);
        const expectedDocument = target.expectedDocument;
        const sourceDocument = detail.applicationPrep.draftableDocuments.find(
          (document) => document.documentKey === expectedDocument.documentKey,
        );
        const sourceCacheKey = `${matrixResult.grantId}\u0000${expectedDocument.documentKey}`;
        let source = sourceCache.get(sourceCacheKey) ?? null;
        if (!source && sourceDocument) {
          source = await loadDraftSourceFile({
            draft: {
              grantId: detail.grant.id,
              sourceAttachment: sourceDocument.sourceAttachment,
            },
          });
          sourceCache.set(sourceCacheKey, source);
        }
        const sourceSha256 = source
          ? createHash("sha256").update(source.body).digest("hex")
          : null;

        const workspace = target.expectedWritingEntry === "available" && sourceDocument
          ? await loadVirtualGrantWorkspaceData({
              sheet: detail,
              virtualCompany: scenario,
              requestedDocumentKey: expectedDocument.documentKey,
            })
          : null;
        if (workspace) {
          assert.equal(workspace.execution.mode, "virtual_preview");
          assert.equal(workspace.draftId, null, "가상 기업 workspace는 DB draft를 만들면 안 됩니다.");
          assert.deepEqual(workspace.initialDrafts, []);
          assert.deepEqual(workspace.suggestableLabels, [], "가상 기업 workspace는 유료 AI 제안 접점을 열면 안 됩니다.");
          assert.equal(workspace.pollConversion, false, "가상 기업 workspace는 변환 write poll을 실행하면 안 됩니다.");
          assert.ok(workspace.documents.length > 0, "실제 공고의 작성형 문서를 불러와야 합니다.");
        }

        const seededAnswerCount = workspace ? Object.keys(workspace.fieldAnswers).length : 0;
        const authoring = workspace
          ? {
              documentCount: workspace.documents.length,
              connectedFieldCount: workspace.connectedFields.length,
              seededAnswerCount,
              manualQuestionCount: Math.max(0, workspace.connectedFields.length - seededAnswerCount),
              pageCount: workspace.pages.length,
            }
          : null;
        const baseline = verifyVirtualCompanyFlowBaseline({
          target,
          actual: {
            documentKey: sourceDocument?.documentKey ?? null,
            sourceSha256,
            authoring,
          },
        });
        baselineResults.push({
          scenarioId: scenario.id,
          source: target.source,
          sourceId: target.sourceId,
          baseline,
        });
        documentSourceResults.push({
          scenarioId: scenario.id,
          documentKey: sourceDocument?.documentKey ?? null,
          filename: source?.filename ?? null,
          format: source?.format ?? null,
          bytes: source?.body.byteLength ?? null,
          sha256: sourceSha256,
        });
        if (workspace) {
          workspaceResults.push({
            scenarioId: scenario.id,
            mode: workspace.execution.mode,
            ...authoring,
            draftId: workspace.draftId,
            fields: workspace.connectedFields.map((field) => ({
              fieldKey: field.fieldKey,
              label: field.label,
              mappedCompanyField: field.mappedCompanyField,
              fillStrategy: field.fillStrategy,
            })),
          });
        }
      }
    }

    const status = baselineResults.some((result) => result.baseline.status === "needs_rebaseline")
      ? "needs_rebaseline"
      : baselineResults.some((result) => result.baseline.status === "product_regression")
        ? "product_regression"
        : "pass";

    console.log(JSON.stringify({
      status,
      preview: {
        name: previewBody.data?.name,
        cacheStatus: previewBody.data?.cacheStatus,
      },
      flows: flowResults,
      matrix: {
        status: matrix.status,
        evaluatedGrantCount: matrix.evaluatedGrantCount,
        scenarios: matrix.results.map((result) => ({
          scenarioId: result.scenarioId,
          status: result.status,
          tier: result.actualTier,
          nextQuestionDimension: result.nextQuestionDimension,
          revision: result.revision,
        })),
      },
      details: detailResults,
      documentSources: documentSourceResults,
      workspaces: workspaceResults,
      baselines: baselineResults,
    }, null, 2));
    exitCode = status === "pass" ? 0 : 1;
  }
} catch (error) {
  console.error(JSON.stringify({
    status: "infrastructure_error",
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  exitCode = 1;
} finally {
  await closeCunoteDb();
  process.exitCode = exitCode;
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
