import assert from "node:assert/strict";
import {
  issueAppTokens,
  rotateAppRefreshToken,
  revokeAppRefreshToken,
} from "./appIssueToken";
import { requireAppCompanyAccess } from "./appSession";
import { verifyAppJwt } from "./appTokens";
import { CompanyAccessForbiddenError } from "./companyAccessPolicy";
import { mockUserEmail, mockUserId } from "./mockIdentity";
import { demoCompanyId } from "../repositories/runtime";

process.env.CUNOTE_REPOSITORY_ADAPTER = "runtime";
process.env.CUNOTE_AUTH_REQUIRED = "false";
process.env.CUNOTE_DEMO_COMPANY_ID = "00000000-0000-4000-8000-000000000202";

const issued = await issueAppTokens({
  userId: mockUserId(),
  email: mockUserEmail(),
  deviceId: "verify-device",
});

const accessClaims = verifyAppJwt(issued.accessToken, "access");
assert.equal(accessClaims.sub, mockUserId());
assert.equal(accessClaims.deviceId, "verify-device");

const refreshClaims = verifyAppJwt(issued.refreshToken, "refresh");
assert.equal(refreshClaims.sub, mockUserId());
assert.equal(refreshClaims.deviceId, "verify-device");

const rotated = await rotateAppRefreshToken(issued.refreshToken);
assert.equal(rotated.deviceId, "verify-device");
assert.notEqual(rotated.refreshToken, issued.refreshToken);

await assert.rejects(
  () => rotateAppRefreshToken(issued.refreshToken),
  /refresh token이 유효하지 않습니다/,
  "rotated refresh token must not be reusable",
);

await revokeAppRefreshToken(rotated.refreshToken);
await assert.rejects(
  () => rotateAppRefreshToken(rotated.refreshToken),
  /refresh token이 유효하지 않습니다/,
  "revoked refresh token must not be reusable",
);

const demoAccess = await requireAppCompanyAccess(new Request("http://localhost"), demoCompanyId());
assert.equal(demoAccess.companyId, demoCompanyId());
assert.equal(demoAccess.mode, "demo");

await assert.rejects(
  () => requireAppCompanyAccess(new Request("http://localhost"), "00000000-0000-4000-8000-000000000999"),
  (error) => error instanceof CompanyAccessForbiddenError,
  "demo app session must reject outside company ids",
);

console.log(JSON.stringify({
  ok: true,
  checked: ["issue_token_pair", "rotate_refresh", "revoke_refresh", "demo_company_guard"],
  userId: mockUserId(),
  companyId: demoCompanyId(),
  deviceId: issued.deviceId,
}, null, 2));
