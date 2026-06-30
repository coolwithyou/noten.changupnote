import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_ANTHROPIC_MODEL,
  readPopbillEnvConfig,
  runLiveCompanyMatch,
  sanitizeCorpNum,
} from "../src/index.js";

loadDotEnv(".env.local");
loadDotEnv(".env");

const popbill = readPopbillEnvConfig();
const overrideBizNo = readArg("bizNo");
const checkCorpNum = overrideBizNo ? sanitizeCorpNum(overrideBizNo) : popbill.checkCorpNum;
const kstartupLimit = readPositiveIntArg("kstartupLimit", 10, 1, 100);
const bizinfoLimit = readPositiveIntArg("bizinfoLimit", 1, 0, 20);
const bizinfoLlm = readArg("bizinfoLlm") !== "false" && bizinfoLimit > 0;

const report = await runLiveCompanyMatch({
  kstartupServiceKey: requiredEnv("KSTARTUP_SERVICE_KEY"),
  bizinfoServiceKey: requiredEnv("BIZINFO_SERVICE_KEY"),
  popbillCredentials: popbill.credentials,
  checkCorpNum,
  anthropicApiKey: bizinfoLlm ? requiredEnv("ANTHROPIC_API_KEY") : null,
  anthropicModel: readArg("anthropicModel") ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
  kstartupLimit,
  bizinfoLimit,
  bizinfoLlm,
});

console.log(JSON.stringify(report, null, 2));

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

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env key: ${name}`);
  return value;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readPositiveIntArg(name: string, fallback: number, min: number, max: number): number {
  const raw = readArg(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid --${name}: ${raw ?? fallback}. Use ${min}..${max}.`);
  }
  return value;
}
