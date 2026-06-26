import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BizInfoEvent, BizInfoProgram } from "../src/index.js";
import { fetchBizInfoEvents, fetchBizInfoPrograms } from "../src/index.js";

loadDotEnv();

const serviceKey = process.env.BIZINFO_SERVICE_KEY;
if (!serviceKey) {
  console.error("Missing BIZINFO_SERVICE_KEY. Set it in the environment or .env.");
  process.exit(2);
}

const kind = readArg("kind") ?? "both";
const limit = Number(readArg("limit") ?? 5);
if (!["program", "event", "both"].includes(kind)) {
  throw new Error("Invalid --kind. Use program, event, or both.");
}
if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
  throw new Error("Invalid --limit. Use 1..20.");
}

const result: Record<string, unknown> = {};

if (kind === "program" || kind === "both") {
  const programs = await fetchBizInfoPrograms({ serviceKey });
  result.programs = summarizePrograms(programs.jsonArray, limit);
}

if (kind === "event" || kind === "both") {
  const events = await fetchBizInfoEvents({ serviceKey });
  result.events = summarizeEvents(events.jsonArray, limit);
}

console.log(JSON.stringify(result, null, 2));

function summarizePrograms(rows: BizInfoProgram[], limit: number) {
  return {
    count: rows.length,
    with_summary_html: rows.filter((row) => Boolean(row.bsnsSumryCn)).length,
    with_hwp_attachment: rows.filter((row) => hasHwp(row.fileNm) || hasHwp(row.printFileNm)).length,
    with_apply_period: rows.filter((row) => Boolean(row.reqstBeginEndDe)).length,
    examples: rows.slice(0, limit).map((row) => ({
      source_id: row.pblancId,
      title: row.pblancNm,
      target: row.trgetNm,
      period: row.reqstBeginEndDe,
      url: row.pblancUrl,
      has_summary_html: Boolean(row.bsnsSumryCn),
      attachment: row.fileNm ?? row.printFileNm ?? null,
    })),
  };
}

function summarizeEvents(rows: BizInfoEvent[], limit: number) {
  return {
    count: rows.length,
    with_content_html: rows.filter((row) => Boolean(row.nttCn)).length,
    with_area: rows.filter((row) => Boolean(row.areaNm)).length,
    examples: rows.slice(0, limit).map((row) => ({
      source_id: row.eventInfoId,
      title: row.nttNm,
      area: row.areaNm,
      period: row.eventBeginEndDe,
      reception: row.rceptPd,
      url: row.bizinfoUrl ?? row.orginlUrlAdres ?? null,
    })),
  };
}

function hasHwp(value: string | null | undefined): boolean {
  return /hwp|hwpx/i.test(value ?? "");
}

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
