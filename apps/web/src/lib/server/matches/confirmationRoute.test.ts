import assert from "node:assert/strict";
import { mock } from "node:test";
import type { CompanyRole } from "@cunote/contracts";
import { CompanyAccessForbiddenError } from "../auth/companyAccessPolicy";

let role: CompanyRole = "owner";
let submitCalls = 0;
const access = () => ({
  companyId: "company-a",
  userId: "user-a",
  role,
  mode: "session" as const,
});

mock.module(new URL("../auth/options.ts", import.meta.url).href, {
  namedExports: { authOptions: {} },
});
mock.module(new URL("../auth/companyGuard.ts", import.meta.url).href, {
  namedExports: {
    requireCompanyAccess: async (options: { permission?: "read" | "write" } = {}) => {
      if (options.permission === "write" && role === "viewer") {
        throw new CompanyAccessForbiddenError(
          "해당 회사 정보를 수정할 권한이 없습니다.",
          "company_write_forbidden",
        );
      }
      return access();
    },
  },
});

class TestConfirmationRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly field?: string;

  constructor(code: string, message: string, status: number, field?: string) {
    super(message);
    this.code = code;
    this.status = status;
    if (field) this.field = field;
  }
}

mock.module(new URL("./grantConfirmations.ts", import.meta.url).href, {
  namedExports: {
    ConfirmationRequestError: TestConfirmationRequestError,
    listGrantConfirmations: async ({ companyId, grantId }: { companyId: string; grantId: string }) => ({
      grantId,
      questions: [],
      answers: [],
      companyId,
    }),
    submitGrantConfirmations: async () => {
      submitCalls += 1;
      return {
        grantId: "grant-a",
        saved: [],
        match: null,
        refresh: { plannedCount: 0, savedCount: 0, status: "not_persisted_user_scope" as const },
      };
    },
  },
});

const route = await import("@/app/api/web/matches/[grantId]/confirmations/route");
const context = { params: Promise.resolve({ grantId: "grant-a" }) };
const request = () => new Request("https://local.test/api/web/matches/grant-a/confirmations?companyId=company-a");

for (const allowedRole of ["owner", "admin", "member"] as const) {
  role = allowedRole;
  const response = await route.GET(request(), context);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(payload.data.canSubmit, true, `${allowedRole}는 저장 가능하다`);
}

role = "viewer";
const viewer = await route.GET(request(), context);
assert.equal(viewer.status, 200, "viewer도 질문과 기존 답변은 읽는다");
assert.equal((await viewer.json()).data.canSubmit, false);

role = "member";
assert.equal((await (await route.GET(request(), context)).json()).data.canSubmit, true);
role = "viewer";
assert.equal(
  (await (await route.GET(request(), context)).json()).data.canSubmit,
  false,
  "같은 사용자의 역할 강등은 다음 GET에서 최신값으로 반영된다",
);

const forbiddenPut = await route.PUT(new Request(request(), {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ answers: [] }),
}), context);
assert.equal(forbiddenPut.status, 403);
assert.equal((await forbiddenPut.json()).error.code, "company_write_forbidden");
assert.equal(submitCalls, 0, "viewer PUT은 답변 저장 seam 호출 전에 거부한다");

console.log("confirmation-route: latest role canSubmit projection and server PUT guard passed");
