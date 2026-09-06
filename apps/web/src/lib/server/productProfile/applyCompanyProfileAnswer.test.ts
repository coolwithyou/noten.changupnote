import assert from "node:assert/strict";
import type { NormalizedGrant } from "@cunote/contracts";
import { closeCunoteDb } from "@/lib/server/db/client";

process.env.CUNOTE_REPOSITORY_ADAPTER = "runtime";
process.env.CUNOTE_WEB_DATA_SOURCE = "sample";
process.env.CUNOTE_WEB_INCLUDE_BIZINFO_SAMPLE = "true";

const { getServiceRepositories, loadOwnedCompanyMatching } = await import("@/lib/server/serviceData");
const {
  CompanyProfileAnswerError,
  applyCompanyProfileAnswer,
} = await import("./applyCompanyProfileAnswer");

const userId = "00000000-0000-4000-8000-000000000001";
const asOf = new Date("2026-06-25T15:00:00.000Z");
const company = await getServiceRepositories().companies.createCompany({
  userId,
  profile: {
    name: "답변 명령 검증 기업",
    region: { code: "41", label: "경기" },
    size: "중소",
  },
});

const result = await applyCompanyProfileAnswer({
  companyId: company.id,
  userId,
  answer: {
    field: "revenue",
    value: 900_000_000,
    provider: "forged-client",
  } as unknown as Parameters<typeof applyCompanyProfileAnswer>[0]["answer"],
  asOf,
});
assert.equal(result.profile.revenue_krw, 900_000_000);
assert.equal(result.profile.profile_evidence?.revenue?.sourceKind, "self_declared");
assert.equal(result.profile.profile_evidence?.revenue?.provider, "cunote_profile_question");
assert.equal(result.profileView.rows.length, 19);
assert.equal(result.profileView.rows.find((row) => row.dimension === "revenue")?.status, "known");
assert.equal(result.impact.dimension, "revenue");
assert.ok(result.initialMatch.evaluatedGrantCount > 0);
assert.equal(result.event.sessionId.length > 0, true);
assert.equal(result.refresh.scope, "user_dimension");
assert.equal(result.refresh.status, "no_op");
assert.equal(result.refresh.savedCount, 0);

const persisted = await getServiceRepositories().companies.resolveCompanyProfile({
  companyId: company.id,
  userId,
});
assert.equal(persisted?.revenue_krw, 900_000_000);
assert.equal(persisted?.profile_evidence?.revenue?.provider, "cunote_profile_question");

await assert.rejects(
  () => applyCompanyProfileAnswer({
    companyId: company.id,
    userId,
    answer: { field: "premises", value: {} },
    asOf,
  }),
  (error: unknown) => error instanceof CompanyProfileAnswerError && error.code === "invalid_profile_field",
);

const repositories = getServiceRepositories();
const originalListGrants = repositories.grants.listActiveGrants;
const originalListConfirmations = repositories.matches.listCriterionConfirmations;
const confirmedGrantId = "00000000-0000-4000-8000-000000000099";
const criterionId = "00000000-0000-4000-8000-000000000100";
const fixture: NormalizedGrant<unknown> = {
  grant: {
    id: confirmedGrantId, source: "bizinfo", source_id: "confirmed-profile-answer",
    title: "확인 답변 보존 검증", status: "open", overall_confidence: 1,
    f_regions: [], f_industries: [], f_sizes: [], f_founder_traits: [], f_required_certs: [],
  },
  criteria: [{
    id: criterionId, grant_id: confirmedGrantId, dimension: "prior_award", kind: "exclusion",
    operator: "exists", value: { scope: "self", self_kind: "current_similar", channel: "general" },
    confidence: 1, source_span: "현재 유사 지원사업에 참여 중인 기업은 제외합니다.",
  }],
  extraction_manifest: {
    grantId: confirmedGrantId, revision: "fixture", sourceFieldsSeen: ["criteria"],
    attachmentsExpected: 0, attachmentsFetched: 0, attachmentsConverted: 0,
    sectionsDetected: ["eligibility"], extractorVersion: "fixture", completedAt: asOf.toISOString(),
    warnings: [], readiness: "reviewed", reviewedAt: asOf.toISOString(),
  },
  raw: { source: "bizinfo", source_id: "confirmed-profile-answer", payload: {}, status: "published" },
};
let confirmationReads = 0;
try {
  repositories.grants.listActiveGrants = async () => [fixture] as Awaited<ReturnType<typeof originalListGrants>>;
  repositories.matches.listCriterionConfirmations = async (input) => {
    confirmationReads += 1;
    assert.equal(input.companyId, company.id);
    assert.deepEqual(input.grantIds, [confirmedGrantId]);
    return new Map([[confirmedGrantId, [{ criterion_id: criterionId, disqualified: false }]]]);
  };
  const updated = await applyCompanyProfileAnswer({
    companyId: company.id, userId, answer: { field: "revenue", value: 800_000_000 }, asOf,
  });
  assert.equal(confirmationReads, 1, "한 번 읽은 확인 답변으로 답변 전후와 응답을 계산한다");
  assert.equal(updated.initialMatch.matches[0]?.eligibility, "eligible");
  assert.equal(updated.initialMatch.matches[0]?.userConfirmedCount, 1);
  assert.equal(updated.impact.transitionCounts.eligible_to_eligible, 1);
  assert.equal(updated.refresh.savedCount, 0, "사용자 프로필을 회사 공용 상태에 덮어쓰지 않는다");
  assert.equal(updated.matching.companyId, company.id);
  assert.equal(updated.matching.teaser.matches[0]?.eligibility, "eligible");
  assert.equal(updated.matching.teaser.matches[0]?.userConfirmedCount, 1);
  const reentered = await loadOwnedCompanyMatching({ companyId: company.id, userId, asOf });
  assert.deepEqual(reentered, updated.matching, "저장 응답과 새 소유 프로필 조회는 같은 판정·질문·프로필을 반환한다");

  repositories.matches.listCriterionConfirmations = async () => { throw new Error("fixture confirmations unavailable"); };
  await assert.rejects(() => applyCompanyProfileAnswer({
    companyId: company.id, userId, answer: { field: "revenue", value: 700_000_000 }, asOf,
  }), /fixture confirmations unavailable/);
  const afterFailedRead = await repositories.companies.resolveCompanyProfile({ companyId: company.id, userId });
  assert.equal(afterFailedRead?.revenue_krw, 800_000_000, "확인 답변 조회 실패는 프로필을 부분 갱신하지 않는다");
} finally {
  repositories.grants.listActiveGrants = originalListGrants;
  if (originalListConfirmations) repositories.matches.listCriterionConfirmations = originalListConfirmations;
  else delete repositories.matches.listCriterionConfirmations;
}

console.log("productProfile/applyCompanyProfileAnswer.test.ts: all assertions passed");
await closeCunoteDb();
