import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { matchGrantCriteria, normalizeKStartupPayload } from "../src/index.js";
import type { CompanyProfile } from "@cunote/contracts";
import { fetchKStartupPage } from "../src/index.js";

loadDotEnv();

const serviceKey = process.env.KSTARTUP_SERVICE_KEY;
if (!serviceKey) {
  console.error("Missing KSTARTUP_SERVICE_KEY. Set it in the environment or .env.");
  process.exit(2);
}

const page = Number(readArg("page") ?? process.env.KSTARTUP_PAGE ?? 1);
const perPage = Number(readArg("perPage") ?? process.env.KSTARTUP_PER_PAGE ?? 20);

if (!Number.isInteger(page) || page < 1) {
  throw new Error(`Invalid page: ${page}`);
}
if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
  throw new Error(`Invalid perPage: ${perPage}. Use 1..100.`);
}

const payload = await fetchKStartupPage({ serviceKey, page, perPage });
const normalized = normalizeKStartupPayload(payload);
const demoCompany: CompanyProfile = {
  id: "demo-company",
  name: "(가칭)테크스타트",
  region: { code: "41", label: "경기" },
  biz_age_months: 26,
  founder_age: 35,
  is_preliminary: false,
  industries: ["ICT", "SW"],
  size: "중소",
};

const matchCounts = normalized.reduce<Record<string, number>>((acc, item) => {
  const match = matchGrantCriteria(item.criteria, demoCompany);
  acc[match.eligibility] = (acc[match.eligibility] ?? 0) + 1;
  return acc;
}, {});

console.log(JSON.stringify({
  page: payload.page ?? page,
  perPage: payload.perPage ?? perPage,
  currentCount: payload.currentCount ?? payload.data.length,
  totalCount: payload.totalCount ?? payload.matchCount ?? null,
  normalized_count: normalized.length,
  criteria_count: normalized.reduce((sum, item) => sum + item.criteria.length, 0),
  match_counts: matchCounts,
  examples: normalized.slice(0, 5).map((item) => ({
    source_id: item.grant.source_id,
    title: item.grant.title,
    status: item.grant.status,
    criteria_count: item.criteria.length,
  })),
}, null, 2));

function loadDotEnv(path = ".env") {
  try {
    const body = readFileSync(resolve(path), "utf8");
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rest] = trimmed.split("=");
      if (!rawKey) continue;
      const key = rawKey.trim();
      if (process.env[key] !== undefined) continue;
      let value = rest.join("=").trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // .env is optional in CI.
  }
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
