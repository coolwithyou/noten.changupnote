import type { CompanyRecord } from "@cunote/core";
import assert from "node:assert/strict";
import {
  CompanyAccessForbiddenError,
  resolveCompanyAccessFromRecords,
  resolveCompanyAccessWithFallback,
  resolveDemoCompanyAccess,
} from "./companyAccessPolicy";
import { isAuthEnforced, isDevelopmentAuthAllowed, isMockAuthEnabled } from "./runtimePolicy";
import { DEFAULT_MOCK_USER_ID } from "./mockIdentity";
import { DEFAULT_DEMO_COMPANY_ID } from "../repositories/runtime";

expectMatch(
  DEFAULT_MOCK_USER_ID,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "default mock user id is uuid-compatible",
);

expectMatch(
  DEFAULT_DEMO_COMPANY_ID,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "default demo company id is uuid-compatible",
);

const companies: CompanyRecord[] = [
  {
    id: "company-a",
    name: "A",
    profile: { id: "company-a", confidence: {} },
    role: "owner",
  },
  {
    id: "company-b",
    name: "B",
    profile: { id: "company-b", confidence: {} },
    role: "viewer",
  },
  {
    id: "company-c",
    name: "C",
    profile: { id: "company-c", confidence: {} },
    role: "admin",
  },
];

expectEqual(
  resolveCompanyAccessFromRecords({
    companies,
    userId: "user-1",
    mode: "session",
  }).companyId,
  "company-a",
  "default company resolves to first membership",
);

expectEqual(
  resolveCompanyAccessFromRecords({
    companies,
    userId: "user-1",
    mode: "token",
    companyId: "company-b",
  }).role,
  "viewer",
  "explicit company resolves matching membership",
);

expectThrows(
  () => resolveCompanyAccessFromRecords({
    companies,
    userId: "user-1",
    mode: "token",
    companyId: "company-x",
  }),
  "company_forbidden",
  "outside company is rejected",
);

expectThrows(
  () => resolveCompanyAccessFromRecords({
    companies,
    userId: "user-1",
    mode: "session",
    companyId: "company-b",
    permission: "write",
  }),
  "company_write_forbidden",
  "viewer write access is rejected",
);

expectEqual(
  resolveCompanyAccessFromRecords({
    companies,
    userId: "user-1",
    mode: "session",
    companyId: "company-c",
    permission: "write",
  }).role,
  "admin",
  "admin write access is allowed",
);

for (const productionEnv of [{ NODE_ENV: "production" }, { NODE_ENV: "development", VERCEL_ENV: "production" }] as const) {
  const env = {
    ...productionEnv,
    CUNOTE_AUTH_REQUIRED: "false",
    CUNOTE_AUTH_MODE: "mock",
    CUNOTE_APP_AUTH_ALLOW_DEV_LOGIN: "true",
    CUNOTE_APP_AUTH_ALLOW_DEV_OAUTH: "true",
    CUNOTE_COMPANY_VERIFY_ALLOW_DEV: "true",
  };
  assert.equal(isAuthEnforced(productionEnv), true, "운영은 인증 플래그가 없어도 인증을 강제한다");
  assert.equal(isAuthEnforced(env), true, "개발 플래그가 운영 인증을 해제할 수 없다");
  assert.equal(isMockAuthEnabled(env), false);
  assert.equal(isDevelopmentAuthAllowed(env), false);
}
assert.equal(isAuthEnforced({ NODE_ENV: "development" }), false);
assert.equal(isMockAuthEnabled({ NODE_ENV: "development", CUNOTE_AUTH_MODE: "mock" }), true);
assert.equal(isAuthEnforced({ NODE_ENV: "development", CUNOTE_AUTH_REQUIRED: "true" }), true);

const demoInput = { userId: "demo-user", defaultCompanyId: "demo-company" };
assert.equal(resolveDemoCompanyAccess(demoInput).role, "viewer");
expectThrows(() => resolveDemoCompanyAccess({ ...demoInput, companyId: "foreign-cookie-company" }),
  "company_forbidden", "쿠키 출처와 무관하게 데모 외 회사는 거부한다");
expectThrows(() => resolveDemoCompanyAccess({ ...demoInput, permission: "write" }),
  "company_write_forbidden", "익명 데모는 쓰기가 불가능하다");
assert.equal(resolveDemoCompanyAccess({ ...demoInput, permission: "write", allowMockWrite: true }).role, "owner");
expectThrows(() => resolveDemoCompanyAccess({ ...demoInput, companyId: "foreign-company", allowMockWrite: true }),
  "company_forbidden", "명시적 개발 mock도 다른 회사에는 접근할 수 없다");

const cookieSelection = { companies, userId: "user-1", companyId: "company-x", selectedFromCookie: true };
assert.equal(resolveCompanyAccessWithFallback(cookieSelection).companyId, "company-a");
expectThrows(() => resolveCompanyAccessWithFallback({ ...cookieSelection, permission: "write" }),
  "company_forbidden", "만료된 회사 선택으로 다른 회사에 쓰지 않는다");
expectThrows(() => resolveCompanyAccessWithFallback({ ...cookieSelection, companyId: "company-b", permission: "write" }),
  "company_write_forbidden", "viewer 권한 오류를 첫 회사 owner 권한으로 우회하지 않는다");
expectThrows(() => resolveCompanyAccessWithFallback({ ...cookieSelection, selectedFromCookie: false }),
  "company_forbidden", "명시적인 다른 회사 선택은 읽기에서도 거부한다");

console.log("Company access verification passed.");

function expectEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function expectMatch(actual: string, pattern: RegExp, label: string) {
  if (!pattern.test(actual)) {
    throw new Error(`${label}: ${actual}`);
  }
}

function expectThrows(fn: () => unknown, code: string, label: string) {
  try {
    fn();
  } catch (error) {
    if (error instanceof CompanyAccessForbiddenError && error.code === code) return;
    throw new Error(`${label}: expected ${code}, got ${String(error)}`);
  }
  throw new Error(`${label}: expected throw`);
}
