import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildApplySheet,
  buildDashboard,
  buildCompanyProfileFromPopbill,
  checkPopbillBizInfo,
  fetchKStartupPage,
  grantKey,
  normalizeKStartupPayload,
  readPopbillEnvConfig,
  sanitizeCorpNum,
} from "@cunote/core";
import type { ApplySheet, CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import type { DashboardResult } from "@cunote/contracts";
import type { KStartupAnnouncement, KStartupApiResponse } from "@cunote/core";
import { createServiceRepositories } from "./repositories/factory";

const SAMPLE_PATH = "samples/kstartup_announcement_sample.json";

const repositories = createServiceRepositories({
  loadGrants: loadServiceGrantsFromSource,
  loadCompanyProfile: loadCompanyProfileFromSource,
});

export interface LoadServiceGrantsOptions {
  limit?: number;
  asOf?: Date;
}

export async function loadServiceGrants({
  limit = 20,
  asOf = new Date(),
}: LoadServiceGrantsOptions = {}): Promise<Array<NormalizedGrant<KStartupAnnouncement>>> {
  return repositories.grants.listActiveGrants({ limit, asOf });
}

async function loadServiceGrantsFromSource({
  limit = 20,
  asOf = new Date(),
}: LoadServiceGrantsOptions = {}): Promise<Array<NormalizedGrant<KStartupAnnouncement>>> {
  await loadEnvInDevelopment();

  const source = process.env.CUNOTE_WEB_DATA_SOURCE?.trim().toLowerCase();
  const serviceKey = process.env.KSTARTUP_SERVICE_KEY?.trim();
  if (source !== "sample" && serviceKey) {
    try {
      const payload = await fetchKStartupPage({
        serviceKey,
        page: 1,
        perPage: limit,
      });
      return normalizeKStartupPayload(payload, { asOf });
    } catch (error) {
      console.warn(`K-Startup live fetch failed. Falling back to sample data: ${errorMessage(error)}`);
    }
  }

  const sample = readKStartupSample();
  const rows = sample.data.slice(0, limit);
  return normalizeKStartupPayload(rows, { asOf });
}

export async function loadCompanyProfileForTeaser(bizNo?: string): Promise<CompanyProfile> {
  const profile = await repositories.companies.resolveCompanyProfile(bizNo ? { bizNo } : {});
  if (!profile) {
    throw new Error("회사 프로필을 찾지 못했습니다.");
  }
  return profile;
}

async function loadCompanyProfileFromSource(bizNo?: string): Promise<CompanyProfile> {
  await loadEnvInDevelopment();

  const requestedBizNo = bizNo ? sanitizeCorpNum(bizNo) : null;
  try {
    const popbill = readPopbillEnvConfig();
    const checkCorpNum = requestedBizNo ?? popbill.checkCorpNum;
    const info = await checkPopbillBizInfo({
      credentials: popbill.credentials,
      checkCorpNum,
    });
    if (String(info.result) === "100") {
      return buildCompanyProfileFromPopbill(info).profile;
    }
    console.warn(`Popbill checkBizInfo returned non-success result: ${info.result ?? "unknown"}`);
  } catch (error) {
    if (requestedBizNo) throw error;
    console.warn(`Popbill profile fetch failed. Falling back to sample company: ${errorMessage(error)}`);
  }

  return sampleCompanyProfile();
}

export async function loadServiceDashboard(options: {
  companyId?: string;
  limit?: number;
  asOf?: Date;
} = {}): Promise<DashboardResult> {
  const asOf = options.asOf ?? new Date();
  const [company, grants] = await Promise.all([
    resolveDashboardCompany(options.companyId),
    repositories.grants.listActiveGrants({ asOf, limit: options.limit ?? 40 }),
  ]);
  const stateCompanyId = options.companyId ?? company.id;
  await persistMatchStates({
    ...(stateCompanyId ? { companyId: stateCompanyId } : {}),
    company,
    grants,
  });

  return buildDashboard({ company, grants, asOf, limit: options.limit ?? 24 });
}

export async function loadServiceApplySheet(
  grantIdSegment: string,
  options: {
    companyId?: string;
    limit?: number;
    asOf?: Date;
  } = {},
): Promise<ApplySheet | null> {
  const asOf = options.asOf ?? new Date();
  const grantId = decodeGrantIdSegment(grantIdSegment);
  const [company, grants] = await Promise.all([
    resolveDashboardCompany(options.companyId),
    repositories.grants.findGrantById(grantId, { asOf, limit: options.limit ?? 80 }),
  ]);
  if (!grants) return null;
  const match = await repositories.matches.calculateGrantMatch({ company, grant: grants });

  return buildApplySheet({
    entry: {
      item: grants,
      match,
    },
    asOf,
  });
}

export function getServiceRepositories() {
  return repositories;
}

async function resolveDashboardCompany(companyId?: string): Promise<CompanyProfile> {
  if (!companyId) return repositories.companies.getDefaultCompanyProfile();
  const company = await repositories.companies.resolveCompanyProfile({ companyId });
  if (!company) throw new Error("회사 프로필을 찾지 못했습니다.");
  return company;
}

async function persistMatchStates(input: {
  companyId?: string;
  company: CompanyProfile;
  grants: Array<NormalizedGrant<KStartupAnnouncement>>;
}) {
  if (!input.companyId) return;
  const matchStates = await repositories.matches.calculateGrantMatches({
    company: input.company,
    grants: input.grants,
  });
  await Promise.all(matchStates.map((state) =>
    repositories.matches.saveMatchState({
      companyId: input.companyId!,
      grantId: grantKey(state.grant.grant),
      match: state.match,
    })
  ));
}

async function loadEnvInDevelopment() {
  if (process.env.NODE_ENV !== "production") {
    const { loadMonorepoEnv } = await import("./loadMonorepoEnv");
    loadMonorepoEnv();
  }
}

function readKStartupSample(): KStartupApiResponse {
  const path = findProjectFile(SAMPLE_PATH);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as KStartupApiResponse;
  if (!Array.isArray(parsed.data)) {
    throw new Error(`Invalid K-Startup sample shape: ${path}`);
  }
  return parsed;
}

function findProjectFile(relativePath: string): string {
  const candidates = [
    resolve(/*turbopackIgnore: true*/ process.cwd(), relativePath),
    resolve(/*turbopackIgnore: true*/ process.cwd(), "../..", relativePath),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Missing project file: ${relativePath}`);
  }
  return found;
}

function decodeGrantIdSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sampleCompanyProfile(): CompanyProfile {
  return {
    name: "샘플 기업",
    region: { code: "경기", label: "경기" },
    biz_age_months: 26,
    founder_age: null,
    industries: ["기술기반"],
    size: "중소",
    business_status: { active: true, label: "정상" },
    confidence: {
      region: 0.7,
      biz_age: 0.7,
      founder_age: 0.5,
      industry: 0.4,
      size: 0.4,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
