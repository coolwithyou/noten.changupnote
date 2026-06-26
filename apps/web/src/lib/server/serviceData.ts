import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCompanyProfileFromPopbill,
  checkPopbillBizInfo,
  fetchKStartupPage,
  normalizeKStartupPayload,
  readPopbillEnvConfig,
  sanitizeCorpNum,
} from "@cunote/core";
import type { CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import type { KStartupAnnouncement, KStartupApiResponse } from "@cunote/core";
import { loadMonorepoEnv } from "./loadMonorepoEnv";

const SAMPLE_PATH = "samples/kstartup_announcement_sample.json";

export interface LoadServiceGrantsOptions {
  limit?: number;
  asOf?: Date;
}

export async function loadServiceGrants({
  limit = 20,
  asOf = new Date(),
}: LoadServiceGrantsOptions = {}): Promise<Array<NormalizedGrant<KStartupAnnouncement>>> {
  loadEnvInDevelopment();

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
  loadEnvInDevelopment();

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

function loadEnvInDevelopment() {
  if (process.env.NODE_ENV !== "production") {
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

function sampleCompanyProfile(): CompanyProfile {
  return {
    name: "샘플 기업",
    region: { code: "경기", label: "경기" },
    biz_age_months: 26,
    founder_age: 35,
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
