import assert from "node:assert/strict";
import { mock } from "node:test";
import type { CompanyProfile } from "@cunote/contracts";
import { NextRequest } from "next/server";
import { decodeCompanyProfileRows, encodeCompanyProfileRows, type CompanyProfilePersistenceRow } from "../repositories/drizzle";
import { requestCompanyScope } from "../auth/requestCompanyScope";
import { closeCunoteDb } from "../db/client";

// 운영 DB/인증 서버 없이, 실제 HTTP handler + 소유권 정책 + 영속 row codec을 연결한다.
process.env.CUNOTE_REPOSITORY_ADAPTER = "runtime";
process.env.CUNOTE_WEB_DATA_SOURCE = "sample";
process.env.CUNOTE_AUTH_MODE = "mock";
process.env.CUNOTE_AUTH_REQUIRED = "true";
const owner = "00000000-0000-4000-8000-000000000001";
const colleague = "00000000-0000-4000-8000-000000000002";
process.env.CUNOTE_MOCK_USER_ID = owner;
const a = "00000000-0000-4000-8000-000000000010";
const b = "00000000-0000-4000-8000-000000000011";
const viewerCompany = "00000000-0000-4000-8000-000000000012";
const { getServiceRepositories, loadOwnedCompanyMatching } = await import("../serviceData");
// OAuth provider 설정은 Next 번들러 소유이므로 제외한다. 세션/회사 접근 정책과 HTTP handler는 실제 코드다.
mock.module(new URL("../auth/options.ts", import.meta.url).href, { namedExports: { authOptions: {} } });
const { GET } = await import("@/app/api/web/company-matching/route");
const { POST } = await import("@/app/api/web/profile/field/route");
const exposureRoute = await import("@/app/api/web/company-matching/exposure/route");
const sourceCorrectionsRoute = await import("@/app/api/web/profile/source-corrections/route");
const confirmations = await import("@/app/api/web/matches/[grantId]/confirmations/route");
const repositories = getServiceRepositories();
const saved = {
  list: repositories.companies.listUserCompanies,
  resolve: repositories.companies.resolveCompanyProfile,
  save: repositories.companies.saveCompanyProfile,
  grants: repositories.grants.listActiveGrants,
};
const rows = new Map<string, CompanyProfilePersistenceRow[]>();
let writes = 0;
const companyRecord = (id: string) => ({ id, kind: "active" as const, name: `회사 ${id.slice(-2)}` });
const read = (companyId: string, userId: string) => decodeCompanyProfileRows(companyRecord(companyId), structuredClone(rows.get(`${companyId}:${userId}`) ?? []));
repositories.companies.listUserCompanies = async (userId) => (
  userId === owner ? [a, viewerCompany] : userId === colleague ? [a, b] : []
).map((id) => ({ ...companyRecord(id), profile: read(id, userId), role: id === viewerCompany ? "viewer" : "owner" }));
repositories.companies.resolveCompanyProfile = async (input) => read(input?.companyId ?? a, input?.userId ?? "");
repositories.companies.saveCompanyProfile = async (input) => {
  writes += 1;
  rows.set(`${input.companyId}:${input.userId}`, encodeCompanyProfileRows(input.companyId, input.profile, new Date(), input.userId) as CompanyProfilePersistenceRow[]);
  return read(input.companyId, input.userId ?? "");
};
repositories.grants.listActiveGrants = async () => [];
const get = (id?: string) => GET(new Request(`https://local.test/api/web/company-matching${id === undefined ? "" : `?companyId=${id}`}`));
const post = (body: unknown) => POST(new NextRequest("https://local.test/api/web/profile/field", {
  method: "POST", headers: { "content-type": "application/json", cookie: `cunote_selected_company_id=${b}` },
  body: JSON.stringify(body),
}));

try {
  process.env.CUNOTE_SOURCE_CORRECTIONS_ENABLED = "true";
  const correctionRequest = (companyId: unknown) => sourceCorrectionsRoute.POST(new Request("https://local.test/api/web/profile/source-corrections", {
    method: "POST", body: JSON.stringify({ companyId, action: "submit", dimension: "employees", statement: "실제 근로자 정보가 원천과 다릅니다." }),
  }));
  assert.equal((await correctionRequest(b)).status, 403);
  assert.equal((await correctionRequest(null)).status, 400);
  assert.equal((await correctionRequest(viewerCompany)).status, 403);
  assert.equal((await sourceCorrectionsRoute.GET(new Request(`https://local.test/api/web/profile/source-corrections?companyId=${b}`))).status, 403);
  process.env.CUNOTE_SOURCE_CORRECTIONS_ENABLED = "false";
  process.env.CUNOTE_PRODUCT_EXPOSURE_ENABLED = "true";
  const exposure = (companyId: unknown) => exposureRoute.POST(new Request("https://local.test/api/web/company-matching/exposure", {
    method: "POST", body: JSON.stringify({ companyId, token: "invalid-fixture" }),
  }));
  assert.equal((await exposure(b)).status, 403, "노출 신호도 명시한 회사 소속을 확인한다");
  assert.equal((await exposure(null)).status, 400);
  assert.equal((await exposure(a)).status, 400, "서명 없는 신호는 DB 기록 전에 차단한다");
  assert.equal((await exposure(viewerCompany)).status, 400, "읽기 사용자의 회사 접근 뒤 서명 검증까지 진행한다");
  process.env.CUNOTE_PRODUCT_EXPOSURE_ENABLED = "false";
  assert.deepEqual(requestCompanyScope(undefined), {});
  for (const invalid of [null, "", " ", 1, [], {}, " a", "a".repeat(129)]) {
    assert.throws(() => requestCompanyScope(invalid), { code: "invalid_company_id" });
  }
  for (const answer of [
    { field: "employees", value: 0 },
    { field: "certification", value: [] },
    { field: "industry", unknown: true },
    { field: "revenue", range: { min: 0, max: 100_000_000, unit: "krw" } },
    {
      field: "premises",
      mode: "replace",
      value: {
        schemaVersion: "premises-v1",
        locations: [{
          locationId: "00000000-0000-4000-8000-000000000201",
          facilityType: "headquarters",
          sidoCode: "11",
          validFrom: "2025-01-01",
          validTo: null,
        }],
        coverage: {
          facilityTypes: ["headquarters"],
          validFrom: "2025-01-01",
          validTo: "2026-01-01",
          completeness: "complete",
        },
      },
    },
  ]) {
    const beforeAnswer = await loadOwnedCompanyMatching({ companyId: a, userId: owner });
    const response = await post({ ...answer, companyId: a, expectedProfileRevision: beforeAnswer.profileRevision });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const savedResult = (await response.json()).data;
    const savedMatching = savedResult.matching;
    assert.equal(savedMatching.companyId, a);
    assert.equal(savedMatching.profileWriteAllowed, true);
    const reopenedMatching = await loadOwnedCompanyMatching({ companyId: a, userId: owner });
    assert.equal(savedMatching.profileRevision, reopenedMatching.profileRevision, `${answer.field}: 저장 응답 토큰으로 재개 가능`);
  }
  assert.equal(writes, 5);
  const stale = await post({ companyId: a, field: "employees", value: 999, expectedProfileRevision: "0".repeat(64) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "company_profile_conflict");
  assert.equal(writes, 5, "오래된 화면은 저장 및 파생 상태 쓰기 전에 거부한다");
  const malformedRevision = await post({ companyId: a, field: "employees", value: 999, expectedProfileRevision: null });
  assert.equal(malformedRevision.status, 400);
  // 새 객체로 decode해 재조회. 브라우저 draft나 직전 응답 profile 객체에 의존하지 않는다.
  const snapshot = await loadOwnedCompanyMatching({ companyId: a, userId: owner });
  assert.match(snapshot.profileRevision!, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.companyName, companyRecord(a).name);
  assert.deepEqual(snapshot.unknownDimensions, ["industry"]);
  assert.equal(snapshot.teaser.profileView.rows.find((row) => row.dimension === "employees")?.status, "known");
  assert.equal(snapshot.teaser.profileView.rows.find((row) => row.dimension === "certification")?.displayValue, "해당 없음");
  assert.equal(snapshot.teaser.profileView.rows.find((row) => row.dimension === "premises")?.premisesValue?.locations.length, 1);
  const persisted: CompanyProfile = read(a, owner);
  assert.equal(persisted.employees_count, 0);
  assert.deepEqual(persisted.certs, []);
  assert.equal(persisted.question_answer_state?.revenue?.status, "range");
  const response = await get(a);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.clone().json()).data.profileWriteAllowed, true);
  assert.equal((await get()).status, 200, "선택 회사가 없으면 접근 가능한 첫 회사로 재진입한다");
  assert.equal((await get("")).status, 400, "명시한 빈 회사는 기본 회사로 후퇴하지 않는다");
  assert.equal((await get(b)).status, 403);
  assert.equal((await post({ companyId: b, field: "employees", value: 99 })).status, 403);
  assert.equal((await post({ companyId: viewerCompany, field: "employees", value: 99 })).status, 403);
  assert.equal((await post({ companyId: null, field: "employees", value: 99 })).status, 400);
  const confirmationContext = { params: Promise.resolve({ grantId: "grant-1" }) };
  assert.equal((await confirmations.GET(new Request(`https://local.test/confirmations?companyId=${b}`), confirmationContext)).status, 403);
  assert.equal((await confirmations.PUT(new Request(`https://local.test/confirmations?companyId=${b}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: [] }),
  }), confirmationContext)).status, 403);
  assert.equal(writes, 5, "잘못된 회사·viewer 요청은 아무 프로필도 저장하지 않는다");

  const beforeCorrection = read(a, owner);
  rows.set(`${a}:${owner}`, encodeCompanyProfileRows(a, {
    ...beforeCorrection, certs: ["창업기업확인서"], list_completeness: { ...beforeCorrection.list_completeness, certification: "complete" },
    profile_evidence: { ...beforeCorrection.profile_evidence, certification: {
      sourceKind: "public_registry", provider: "startup_confirmation", asOf: new Date().toISOString(),
      axisCompleteness: "complete", confidence: 0.9, scope: "user",
    } },
  }, new Date(), owner) as CompanyProfilePersistenceRow[]);
  const correction = await post({ companyId: a, field: "certification", value: [], allowAuthoritativeOverride: true });
  assert.equal(correction.status, 400, "원천 확인값은 클라이언트 override 플래그로 우회하지 못한다");
  assert.deepEqual(read(a, owner).certs, ["창업기업확인서"]);
  assert.equal(writes, 5, "정정 문의 전에는 원천 확인값을 바꾸지 않는다");

  const viewerResponse = await get(viewerCompany);
  assert.equal(viewerResponse.status, 200);
  assert.equal((await viewerResponse.json()).data.profileWriteAllowed, false, "viewer 조회는 쓰기 가능 플래그를 열지 않는다");

  process.env.CUNOTE_MOCK_USER_ID = colleague;
  const otherUser = await (await get(a)).json();
  assert.deepEqual(otherUser.data.unknownDimensions, []);
  assert.equal(otherUser.data.teaser.profileView.rows.find((row: { dimension: string }) => row.dimension === "employees")?.status, "unknown", "같은 회사 다른 사용자의 비공개 답변을 가져오지 않는다");
  assert.equal((await get(b)).status, 200);
  process.env.CUNOTE_AUTH_MODE = "";
  assert.equal((await get(a)).status, 401, "세션 없는 저장 프로필 조회는 데모/익명으로 후퇴하지 않는다");
  assert.equal((await exposure(a)).status, 401, "관측이 꺼져 있어도 익명 신호를 인증된 관측으로 받지 않는다");
  assert.equal((await correctionRequest(a)).status, 401, "기능 비활성도 익명 정정 요청을 허용하지 않는다");
  process.env.CUNOTE_AUTH_MODE = "mock";
  process.env.CUNOTE_MOCK_USER_ID = owner;
  const resumed = await (await get(a)).json();
  assert.deepEqual(resumed.data.unknownDimensions, ["industry"]);
  assert.equal(writes, 5, "재진입·사용자 전환·읽기 요청은 저장하지 않는다");
} finally {
  process.env.CUNOTE_SOURCE_CORRECTIONS_ENABLED = "false";
  repositories.companies.listUserCompanies = saved.list;
  repositories.companies.resolveCompanyProfile = saved.resolve;
  repositories.companies.saveCompanyProfile = saved.save;
  repositories.grants.listActiveGrants = saved.grants;
  await closeCunoteDb();
}
console.log("ownedCompanyMatching.test.ts: HTTP scope, persisted reentry, unknown/none/zero/range and user isolation passed (offline)");
