import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildBizInfoProgramExtractionInput,
  fetchBizInfoPrograms,
} from "../src/index.js";

loadDotEnv();

const serviceKey = process.env.BIZINFO_SERVICE_KEY;
if (!serviceKey) {
  console.error("Missing BIZINFO_SERVICE_KEY. Set it in the environment or .env.");
  process.exit(2);
}

const sourceId = readArg("sourceId");
const limit = Number(readArg("limit") ?? 1);
const includeSampleAttachment = readArg("includeSampleAttachment") === "true";
const full = readArg("full") === "true";
if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
  throw new Error("Invalid --limit. Use 1..10.");
}

const payload = await fetchBizInfoPrograms({ serviceKey });
const rows = sourceId
  ? payload.jsonArray.filter((row) => row.pblancId === sourceId)
  : payload.jsonArray;

if (rows.length === 0) {
  throw new Error(sourceId ? `No Bizinfo program found for ${sourceId}` : "No Bizinfo programs found");
}

const sampleAttachmentMarkdowns = includeSampleAttachment
  ? [{
      filename: "samples/bizinfo_hwp_converted.md",
      markdown: readFileSync("samples/bizinfo_hwp_converted.md", "utf8"),
      source_uri: "samples/bizinfo_hwp_converted.md",
    }]
  : [];

const inputs = rows.slice(0, limit).map((row) => {
  const input = buildBizInfoProgramExtractionInput(row, {
    attachmentMarkdowns: sampleAttachmentMarkdowns,
  });
  return {
    source_id: input.source_id,
    title: input.title,
    url: input.url,
    metadata: input.metadata,
    block_count: input.blocks.length,
    text_length: input.text.length,
    text: full ? input.text : `${input.text.slice(0, 1200)}${input.text.length > 1200 ? "\n..." : ""}`,
  };
});

console.log(JSON.stringify({ count: inputs.length, inputs }, null, 2));

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
