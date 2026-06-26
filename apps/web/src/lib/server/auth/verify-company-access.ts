import type { CompanyRecord } from "@cunote/core";
import {
  CompanyAccessForbiddenError,
  resolveCompanyAccessFromRecords,
} from "./companyAccessPolicy";

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

console.log("Company access verification passed.");

function expectEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
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
