import assert from "node:assert/strict";
import { webActionError } from "./webActionError";

const unexpected = webActionError(
  new Error('Failed query: insert into "grant_document_agent_runs" ($1, $2)'),
  {
    code: "document_agent_request_failed",
    message: "문서 작성 제안을 생성하지 못했습니다.",
  },
);
assert.equal(unexpected.status, 500);
assert.deepEqual(await unexpected.json(), {
  ok: false,
  error: {
    code: "document_agent_request_failed",
    message: "문서 작성 제안을 생성하지 못했습니다.",
  },
});

const known = webActionError(
  Object.assign(new Error("같은 요청 ID의 문서 결속이 다릅니다."), {
    code: "run_request_binding_conflict",
    status: 409,
    field: "clientRequestId",
    meta: { retryable: false },
  }),
  {
    code: "document_agent_request_failed",
    message: "문서 작성 제안을 생성하지 못했습니다.",
  },
);
assert.equal(known.status, 409);
assert.deepEqual(await known.json(), {
  ok: false,
  error: {
    code: "run_request_binding_conflict",
    message: "같은 요청 ID의 문서 결속이 다릅니다.",
    field: "clientRequestId",
    meta: { retryable: false },
  },
});

const authRequired = webActionError(
  Object.assign(new Error("로그인이 필요합니다."), {
    name: "AuthRequiredError",
    code: "auth_required",
    status: 401,
  }),
  {
    code: "fallback",
    message: "fallback message",
  },
);
assert.equal(authRequired.status, 401);
assert.deepEqual(await authRequired.json(), {
  ok: false,
  error: {
    code: "auth_required",
    message: "로그인이 필요합니다.",
  },
});

console.log("webActionError: unexpected messages are hidden while known domain errors are preserved");
