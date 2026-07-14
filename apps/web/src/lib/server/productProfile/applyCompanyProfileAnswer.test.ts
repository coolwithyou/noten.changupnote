import assert from "node:assert/strict";
import { closeCunoteDb } from "@/lib/server/db/client";

process.env.CUNOTE_REPOSITORY_ADAPTER = "runtime";
process.env.CUNOTE_WEB_DATA_SOURCE = "sample";
process.env.CUNOTE_WEB_INCLUDE_BIZINFO_SAMPLE = "true";

const { getServiceRepositories } = await import("@/lib/server/serviceData");
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

console.log("productProfile/applyCompanyProfileAnswer.test.ts: all assertions passed");
await closeCunoteDb();
