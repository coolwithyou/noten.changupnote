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

const [{ POST: preview }, { POST: teaser }, { closeCunoteDb }] = await Promise.all([
  import("@/app/api/web/company-preview/route"),
  import("@/app/api/web/teaser/route"),
  import("@/lib/server/db/client"),
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

  console.log(JSON.stringify({
    status: "pass",
    preview: {
      name: previewBody.data?.name,
      cacheStatus: previewBody.data?.cacheStatus,
    },
    flows: flowResults,
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
