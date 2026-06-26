#!/usr/bin/env node
/**
 * Popbill checkBizInfo probe.
 *
 * Required env:
 * - POPBILL_API_KEY or POPBILL_SECRET_KEY
 * - POPBILL_LINK_ID
 * - POPBILL_CORP_NUM
 * - POPBILL_CHECK_CORP_NUM
 *
 * Optional env:
 * - POPBILL_USER_ID
 * - POPBILL_IS_TEST=true|false
 * - POPBILL_IP_RESTRICT_ON_OFF=true|false
 * - POPBILL_USE_STATIC_IP=true|false
 * - POPBILL_USE_LOCAL_TIME_YN=true|false
 *
 * Run:
 *   npm exec --package=popbill@1.64.2 -- node poc/popbill_checkbizinfo_probe.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(path = ".env") {
  try {
    const body = readFileSync(resolve(path), "utf8");
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rest] = trimmed.split("=");
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
    // .env is optional; CI can pass env directly.
  }
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

function requireEnv(name, aliases = []) {
  for (const key of [name, ...aliases]) {
    const value = process.env[key];
    if (value) return { key, value };
  }
  return null;
}

loadDotEnv();

const secret = requireEnv("POPBILL_SECRET_KEY", ["POPBILL_API_KEY"]);
const required = {
  POPBILL_LINK_ID: requireEnv("POPBILL_LINK_ID"),
  POPBILL_CORP_NUM: requireEnv("POPBILL_CORP_NUM"),
  POPBILL_CHECK_CORP_NUM: requireEnv("POPBILL_CHECK_CORP_NUM"),
  POPBILL_SECRET_KEY: secret,
};

const missing = Object.entries(required)
  .filter(([, hit]) => !hit)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error("Missing required env keys:", missing.join(", "));
  console.error("Current POPBILL_API_KEY is usable as POPBILL_SECRET_KEY, but LinkID/CorpNum/CheckCorpNum are still required.");
  process.exit(2);
}

const require = createRequire(import.meta.url);
let popbill;
try {
  popbill = require("popbill");
} catch (error) {
  console.error("Missing node package: popbill");
  console.error("Run: npm exec --package=popbill@1.64.2 -- node poc/popbill_checkbizinfo_probe.mjs");
  process.exit(2);
}

popbill.config({
  LinkID: required.POPBILL_LINK_ID.value,
  SecretKey: required.POPBILL_SECRET_KEY.value,
  IsTest: boolEnv("POPBILL_IS_TEST", true),
  IPRestrictOnOff: boolEnv("POPBILL_IP_RESTRICT_ON_OFF", true),
  UseStaticIP: boolEnv("POPBILL_USE_STATIC_IP", false),
  UseLocalTimeYN: boolEnv("POPBILL_USE_LOCAL_TIME_YN", true),
});

const service = popbill.BizInfoCheckService();

function checkBizInfo() {
  return new Promise((resolve, reject) => {
    service.checkBizInfo(
      required.POPBILL_CORP_NUM.value,
      required.POPBILL_CHECK_CORP_NUM.value,
      process.env.POPBILL_USER_ID || "",
      resolve,
      reject,
    );
  });
}

function pickResult(result) {
  return {
    result: result.result,
    resultMessage: result.resultMessage,
    checkDT: result.checkDT,
    hasCorpName: Boolean(result.corpName),
    hasCorpScaleCode: Boolean(result.corpScaleCode),
    hasIndustryCode: Boolean(result.industryCode),
    hasEstablishDate: Boolean(result.establishDate),
    hasAddress: Boolean(result.addr),
    closeDownState: result.closeDownState || null,
    closeDownTaxType: result.closeDownTaxType || null,
  };
}

try {
  const result = await checkBizInfo();
  console.log(JSON.stringify(pickResult(result), null, 2));
} catch (error) {
  console.error(JSON.stringify({
    code: error.code,
    message: error.message,
  }, null, 2));
  process.exit(1);
}
