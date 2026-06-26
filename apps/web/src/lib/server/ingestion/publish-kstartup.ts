import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fetchKStartupPage,
  normalizeKStartupPayload,
  type KStartupApiResponse,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { planKStartupPublication, publishKStartupGrants } from "./kstartupPublisher";

loadMonorepoEnv();

const source = readArg("source") ?? process.env.CUNOTE_INGEST_SOURCE ?? "sample";
const page = positiveInteger(readArg("page") ?? process.env.KSTARTUP_PAGE, 1);
const limit = boundedInteger(readArg("limit") ?? readArg("perPage") ?? process.env.KSTARTUP_PER_PAGE, 20, 1, 100);
const dryRun = hasFlag("dry-run") || process.env.CUNOTE_INGEST_DRY_RUN === "true";
const collectedAt = new Date();

try {
  const payload = source === "live"
    ? await readLivePayload(page, limit)
    : readSamplePayload(limit);
  const entries = normalizeKStartupPayload(payload, { collectedAt });
  const plan = planKStartupPublication(entries);

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      page,
      limit,
      ...plan,
    }, null, 2));
  } else {
    const result = await publishKStartupGrants(getCunoteDb(), entries, { page, collectedAt });
    console.log(JSON.stringify({
      dryRun: false,
      page,
      limit,
      ...result,
    }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

async function readLivePayload(page: number, perPage: number): Promise<KStartupApiResponse> {
  const serviceKey = process.env.KSTARTUP_SERVICE_KEY?.trim();
  if (!serviceKey) throw new Error("KSTARTUP_SERVICE_KEY가 필요합니다.");
  return fetchKStartupPage({ serviceKey, page, perPage });
}

function readSamplePayload(limit: number): KStartupApiResponse {
  const path = findProjectFile("samples/kstartup_announcement_sample.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as KStartupApiResponse;
  return {
    ...parsed,
    data: parsed.data.slice(0, limit),
    currentCount: Math.min(parsed.data.length, limit),
  };
}

function findProjectFile(relativePath: string): string {
  const candidates = [
    resolve(process.cwd(), relativePath),
    resolve(process.cwd(), "../..", relativePath),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Missing project file: ${relativePath}`);
  return found;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = positiveInteger(value, fallback);
  if (parsed < min || parsed > max) throw new Error(`Invalid bounded integer: ${value}. Use ${min}..${max}.`);
  return parsed;
}
