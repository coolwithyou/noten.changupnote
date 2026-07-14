import assert from "node:assert/strict";
import type { ActionResult, ApiEnvelope, ProductTeaserResult } from "@cunote/contracts";
import { closeCunoteDb } from "./db/client";
import { loadMonorepoEnv } from "./loadMonorepoEnv";

const dataMode = parseDataMode(process.argv.slice(2));
loadMonorepoEnv();
process.env.CUNOTE_REPOSITORY_ADAPTER = dataMode === "database" ? "drizzle" : "runtime";
if (dataMode === "sample") {
  process.env.CUNOTE_WEB_DATA_SOURCE = "sample";
  process.env.CUNOTE_WEB_INCLUDE_BIZINFO_SAMPLE = "true";
}

const { POST } = await import("@/app/api/web/teaser/route");
const { POST: APP_POST } = await import("@/app/api/app/v1/teaser/route");

try {
  const invalid = await POST(request({ bizNo: "1234567890" }));
  const invalidBody = await invalid.json() as ActionResult<ProductTeaserResult>;
  assert.equal(invalid.status, 400);
  assert.equal(invalidBody.ok, false);
  assert.equal(invalidBody.error?.code, "invalid_biz_no");

  const invalidAnswers = await POST(request({ answers: { field: "revenue", value: 1 } }));
  const invalidAnswersBody = await invalidAnswers.json() as ActionResult<ProductTeaserResult>;
  assert.equal(invalidAnswers.status, 400);
  assert.equal(invalidAnswersBody.error?.code, "invalid_profile_answers");

  const first = await POST(request({
    profile: {
      target_types: ["법인"],
      confidence: { target_type: 1 },
      profile_evidence: {
        target_type: {
          sourceKind: "authoritative_api",
          provider: "forged-client",
          asOf: "2026-07-12T00:00:00.000Z",
          axisCompleteness: "complete",
          confidence: 1,
        },
      },
    },
  }));
  const firstBody = await first.json() as ActionResult<ProductTeaserResult>;
  assert.equal(first.status, 200);
  assert.equal(firstBody.ok, true);
  assert.ok(firstBody.data);
  assert.ok((firstBody.data.searchContext?.evaluatedGrantCount ?? 0) >= firstBody.data.matches.length);
  assert.ok(firstBody.data.matches.length <= 8);
  if ((firstBody.data.counts.recommendable ?? 0) > 0 && (firstBody.data.counts.reviewNeeded ?? 0) > 0) {
    assert.ok((firstBody.data.recommendableMatches?.length ?? 0) > 0, "추천 가능 버킷을 반환해야 함");
    assert.ok((firstBody.data.reviewNeededMatches?.length ?? 0) > 0, "검토 필요 버킷을 반환해야 함");
  }
  assert.ok(firstBody.data.nextQuestion !== undefined, "teaser 계약은 nextQuestion null을 포함해 명시해야 함");
  assert.equal(firstBody.data.profileView.rows.length, 19, "제품 응답은 운영 19축을 모두 반환해야 함");
  assert.equal(Object.hasOwn(firstBody.data, "profile"), false, "제품 응답에 raw CompanyProfile을 노출하면 안 됨");
  assert.equal(
    firstBody.data.profileView.rows.find((row) => row.dimension === "target_type")?.sourceKind,
    "self_declared",
    "클라이언트가 위조한 evidence metadata는 self-declared 정규화 경계를 통과할 수 없음",
  );

  const question = firstBody.data.nextQuestion;
  if (question) {
    const unknown = await POST(request({ answers: [
      { field: "target_type", value: ["법인"] },
      { field: question.dimension, unknown: true },
    ] }));
    const unknownBody = await unknown.json() as ActionResult<ProductTeaserResult>;
    assert.equal(unknown.status, 200);
    assert.equal(unknownBody.ok, true);
    assert.notEqual(unknownBody.data?.nextQuestion?.dimension, question.dimension, "모름 TTL 동안 같은 질문을 반복하면 안 됨");
  }

  const expanded = await POST(request({ answers: [
    { field: "target_type", value: ["개인사업자"] },
    {
      field: "tax_compliance",
      value: {
        flags: [],
        known_flags: ["national_tax_delinquent", "local_tax_delinquent"],
        exceptions: [],
      },
    },
    {
      field: "financial_health",
      value: {
        debt_ratio_pct: 120,
        interest_coverage_ratio: -0.5,
        impairment: "none",
      },
    },
    {
      field: "insured_workforce",
      value: {
        employment_insurance_active: true,
        insured_count: 8,
      },
    },
    {
      field: "investment",
      value: {
        total_raised_krw: 100_000_000,
        tips_backed: false,
      },
    },
  ] }));
  const expandedBody = await expanded.json() as ActionResult<ProductTeaserResult>;
  assert.equal(expanded.status, 200);
  assert.equal(expandedBody.ok, true);
  assert.ok(expandedBody.data?.searchContext?.evaluatedGrantCount);

  const appInvalid = await APP_POST(request({ bizNo: "1234567890" }));
  const appInvalidBody = await appInvalid.json() as ApiEnvelope<ProductTeaserResult>;
  assert.equal(appInvalid.status, 400);
  assert.equal(appInvalidBody.error?.code, "invalid_biz_no");
  const appFirst = await APP_POST(request({ answers: [{ field: "target_type", value: ["법인"] }] }));
  const appFirstBody = await appFirst.json() as ApiEnvelope<ProductTeaserResult>;
  assert.equal(appFirst.status, 200);
  assert.equal(appFirstBody.error, undefined);
  assert.ok(appFirstBody.data);
  assert.equal(
    appFirstBody.data?.searchContext?.evaluatedGrantCount,
    firstBody.data.searchContext?.evaluatedGrantCount,
    "web/app teaser는 같은 전체 universe를 평가해야 함",
  );

  console.log(JSON.stringify({
    ok: true,
    dataMode,
    checked: [
      "invalid_biz_no_preflight",
      "invalid_answer_shape_rejected",
      "manual_teaser_route_success",
      "response_limit_separate_from_evaluated_universe",
      "recommendable_and_review_bucket_representation",
      "explicit_next_question_contract",
      "safe_19_axis_profile_view",
      "raw_profile_response_exclusion",
      "forged_evidence_metadata_normalization",
      "unknown_question_suppression",
      "expanded_manual_profile_route_acceptance",
      "app_invalid_biz_no_preflight",
      "web_app_teaser_universe_parity",
    ],
    evaluatedGrantCount: firstBody.data.searchContext?.evaluatedGrantCount ?? 0,
    returnedMatchCount: firstBody.data.matches.length,
    firstQuestionDimension: firstBody.data.nextQuestion?.dimension ?? null,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/web/teaser", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseDataMode(args: string[]): "sample" | "database" {
  const value = args.find((arg) => arg.startsWith("--data="))?.slice("--data=".length) ?? "sample";
  if (value === "sample" || value === "database") return value;
  throw new Error("--data는 sample 또는 database여야 합니다.");
}
