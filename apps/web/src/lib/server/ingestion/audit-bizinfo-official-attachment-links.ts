/** Compare current BizInfo detail download identities with the API snapshot, without writes. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

const OFFICIAL_ORIGIN = "https://www.bizinfo.go.kr";

export function attachmentIdentityPairsFromApi(payload: Record<string, unknown>): string[] {
  return [...new Set([payload.printFlpthNm, payload.flpthNm]
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => [...value.matchAll(/atchFileId=([^&\s]+)&(?:amp;)?fileSn=(\d+)/g)]
      .map((match) => `${match[1]}:${match[2]}`)))];
}

export function attachmentIdentityPairsFromDetail(html: string): string[] {
  return [...new Set([...html.matchAll(/href=["']([^"']*\/cmm\/fms\/fileDown\.do\?[^"']+)["']/gi)]
    .flatMap((match) => {
      const url = new URL(match[1]!.replaceAll("&amp;", "&"), OFFICIAL_ORIGIN);
      if (url.origin !== OFFICIAL_ORIGIN || url.pathname !== "/cmm/fms/fileDown.do") return [];
      const fileId = url.searchParams.get("atchFileId");
      const sequence = url.searchParams.get("fileSn");
      return fileId && sequence !== null ? [`${fileId}:${sequence}`] : [];
    }))];
}

async function main() {
  const classificationArg = process.argv.find((argument) => argument.startsWith("--classification="))
    ?.slice("--classification=".length);
  if (!classificationArg) throw new Error("--classification=<sha256-named campaign classification JSON> required");
  const path = resolve(classificationArg);
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (basename(path) !== `${sha256}.json`) throw new Error("classification bytes SHA mismatch");
  const classification = JSON.parse(bytes.toString("utf8")) as {
    entries: Array<{ grantId: string }>;
  };
  const grantIds = [...new Set(classification.entries.map((entry) => entry.grantId))];
  if (grantIds.length === 0) throw new Error("classification has no grant IDs");
  loadMonorepoEnv();
  const db = getCunoteDb();
  try {
    const grants = await db.select({ sourceId: schema.grants.sourceId })
      .from(schema.grants).where(and(eq(schema.grants.source, "bizinfo"),
        inArray(schema.grants.id, grantIds)));
    const sourceIds = [...new Set(grants.map((grant) => grant.sourceId))].sort();
    const raws = await db.select({ sourceId: schema.grantRaw.sourceId,
      rawHash: schema.grantRaw.rawHash, payload: schema.grantRaw.payload })
      .from(schema.grantRaw).where(and(eq(schema.grantRaw.source, "bizinfo"),
        inArray(schema.grantRaw.sourceId, sourceIds)));
    const rawById = new Map(raws.map((row) => [row.sourceId, row]));
    const mismatches: Array<Record<string, unknown>> = [];
    const errors: Array<{ sourceId: string; reason: string }> = [];
    let matched = 0;
    for (const sourceId of sourceIds) {
      const raw = rawById.get(sourceId);
      if (!raw) { errors.push({ sourceId, reason: "raw_missing" }); continue; }
      const url = `${OFFICIAL_ORIGIN}/sii/siia/selectSIIA200Detail.do?pblancId=${encodeURIComponent(sourceId)}`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok || new URL(response.url).origin !== OFFICIAL_ORIGIN) {
          throw new Error(`detail response ${response.status} or unexpected origin`);
        }
        const html = await response.text();
        const api = attachmentIdentityPairsFromApi(raw.payload);
        const detail = attachmentIdentityPairsFromDetail(html);
        if (api.length > 0 && detail.length === 0) {
          errors.push({ sourceId, reason: "detail_links_unreadable" }); continue;
        }
        const missingFromDetail = api.filter((identity) => !detail.includes(identity));
        const newOnDetail = detail.filter((identity) => !api.includes(identity));
        if (missingFromDetail.length === 0 && newOnDetail.length === 0) { matched++; continue; }
        mismatches.push({ sourceId, rawHash: raw.rawHash,
          detailHtmlSha256: createHash("sha256").update(html).digest("hex"),
          api, detail, missingFromDetail, newOnDetail, url });
      } catch (error) {
        errors.push({ sourceId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    console.log(JSON.stringify({ schema: "bizinfo-official-attachment-link-audit-v1",
      generatedAt: new Date().toISOString(), classificationSha256: sha256,
      population: sourceIds.length, matched, mismatched: mismatches.length,
      errors: errors.length, mismatches, errorDetails: errors }, null, 2));
    if (errors.length > 0) process.exitCode = 2;
  } finally { await closeCunoteDb(); }
}

if (process.argv[1]?.endsWith("audit-bizinfo-official-attachment-links.ts")) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
