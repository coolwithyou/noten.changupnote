import type { CompanyRecord } from "@cunote/core";
import {
  CompanyAccessForbiddenError,
  resolveCompanyAccessFromRecords,
} from "./companyAccessPolicy";
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
