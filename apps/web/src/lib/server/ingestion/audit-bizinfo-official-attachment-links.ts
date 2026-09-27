/** Compare current BizInfo detail links with both the API and stored source, without writes. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

const OFFICIAL_ORIGIN = "https://www.bizinfo.go.kr";

export interface BizInfoOfficialAttachmentRow {
  kind: "attachment" | "print";
  filename: string;
  url: string;
  identity: string;
}

export function attachmentIdentityPairsFromApi(payload: Record<string, unknown>): string[] {
  return [...new Set([payload.printFlpthNm, payload.flpthNm]
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => [...value.matchAll(/atchFileId=([^&\s]+)&(?:amp;)?fileSn=(\d+)/g)]
      .map((match) => `${match[1]}:${match[2]}`)))];
}

/** The stored source links are what extraction and later analysis actually consume. */
export function attachmentIdentityPairsFromStored(
  attachments: readonly Record<string, unknown>[] | null,
): string[] {
  return [...new Set((attachments ?? []).flatMap((attachment) => {
    const source = attachment.source_uri ?? attachment.url;
    if (typeof source !== "string") return [];
    try {
      const url = new URL(source);
      if (url.origin !== OFFICIAL_ORIGIN ||
        (url.pathname !== "/cmm/fms/fileDown.do" &&
          url.pathname !== "/cmm/fms/getImageFile.do")) return [];
      const fileId = url.searchParams.get("atchFileId");
      const sequence = url.searchParams.get("fileSn");
      return fileId && sequence !== null && /^\d+$/u.test(sequence)
        ? [`${fileId}:${sequence}`] : [];
    } catch { return []; }
  }))];
}

export function compareBizInfoOfficialAttachmentIdentities(input: {
  api: readonly string[];
  current: readonly string[];
  detail: readonly string[];
}): {
  apiMatches: boolean;
  currentMatches: boolean;
  apiMissingFromDetail: string[];
  apiNewOnDetail: string[];
  currentMissingFromDetail: string[];
  currentNewOnDetail: string[];
} {
  const difference = (left: readonly string[], right: readonly string[]) =>
    left.filter((identity) => !right.includes(identity));
  const apiMissingFromDetail = difference(input.api, input.detail);
  const apiNewOnDetail = difference(input.detail, input.api);
  const currentMissingFromDetail = difference(input.current, input.detail);
  const currentNewOnDetail = difference(input.detail, input.current);
  return {
    apiMatches: apiMissingFromDetail.length === 0 && apiNewOnDetail.length === 0,
    currentMatches: currentMissingFromDetail.length === 0 && currentNewOnDetail.length === 0,
    apiMissingFromDetail, apiNewOnDetail,
    currentMissingFromDetail, currentNewOnDetail,
  };
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

/** Exact official filename, section and download identity for a source review packet. */
export function attachmentRowsFromDetail(html: string): BizInfoOfficialAttachmentRow[] {
  const rows: BizInfoOfficialAttachmentRow[] = [];
  const headings = [...html.matchAll(/<h3>\s*(첨부파일|본문출력파일)\s*<\/h3>/giu)];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    const start = heading.index! + heading[0].length;
    const nextHeading = headings[index + 1]?.index ?? html.length;
    const endOfList = html.indexOf("</ul>", start);
    const end = endOfList >= 0 ? Math.min(nextHeading, endOfList) : nextHeading;
    const section = html.slice(start, end);
    for (const item of section.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/giu)) {
      const content = item[1]!;
      const filenameMatch = /<div\b[^>]*class=["'][^"']*\bfile_name\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu.exec(content);
      const linkMatch = /href=["']([^"']*\/cmm\/fms\/fileDown\.do\?[^"']+)["']/iu.exec(content);
      if (!linkMatch) continue;
      if (!filenameMatch) throw new Error("official detail download has no filename");
      const filename = decodeDetailText(filenameMatch[1]!);
      if (!filename) throw new Error("official detail download filename is empty");
      const url = new URL(linkMatch[1]!.replaceAll("&amp;", "&"), OFFICIAL_ORIGIN);
      if (url.origin !== OFFICIAL_ORIGIN || url.pathname !== "/cmm/fms/fileDown.do") {
        throw new Error("official detail download has unexpected origin or path");
      }
      const fileId = url.searchParams.get("atchFileId");
      const fileSn = url.searchParams.get("fileSn");
      if (!fileId || fileSn === null || !/^\d+$/u.test(fileSn)) {
        throw new Error("official detail download identity is incomplete");
      }
      rows.push({ kind: heading[1] === "본문출력파일" ? "print" : "attachment",
        filename, url: url.toString(), identity: `${fileId}:${fileSn}` });
    }
  }
  if (new Set(rows.map((row) => row.identity)).size !== rows.length) {
    throw new Error("official detail has duplicate download identities");
  }
  return rows;
}

function decodeDetailText(html: string): string {
  return html.replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<").replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (_, value: string) => String.fromCodePoint(Number(value)))
    .replace(/\s+/gu, " ").trim();
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
      rawHash: schema.grantRaw.rawHash, payload: schema.grantRaw.payload,
      attachments: schema.grantRaw.attachments })
      .from(schema.grantRaw).where(and(eq(schema.grantRaw.source, "bizinfo"),
        inArray(schema.grantRaw.sourceId, sourceIds)));
    const rawById = new Map(raws.map((row) => [row.sourceId, row]));
    const mismatches: Array<Record<string, unknown>> = [];
    const errors: Array<{ sourceId: string; reason: string }> = [];
    let matched = 0;
    let apiMatched = 0;
    let currentMatched = 0;
    let apiMismatched = 0;
    let currentMismatched = 0;
    let currentMissing = 0;
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
        const current = attachmentIdentityPairsFromStored(raw.attachments);
        const detail = attachmentIdentityPairsFromDetail(html);
        if ((api.length > 0 || current.length > 0) && detail.length === 0) {
          errors.push({ sourceId, reason: "detail_links_unreadable" }); continue;
        }
        const comparison = compareBizInfoOfficialAttachmentIdentities({ api, current, detail });
        if (comparison.apiMatches) apiMatched += 1;
        else apiMismatched += 1;
        if (comparison.currentMatches) currentMatched += 1;
        if (!raw.attachments?.length && detail.length > 0) currentMissing += 1;
        else if (!comparison.currentMatches) currentMismatched += 1;
        if (comparison.apiMatches && comparison.currentMatches) { matched++; continue; }
        const detailAttachments = attachmentRowsFromDetail(html);
        if (detailAttachments.length !== detail.length) {
          throw new Error("detail section filename/link parsing is incomplete");
        }
        mismatches.push({ sourceId, rawHash: raw.rawHash,
          detailHtmlSha256: createHash("sha256").update(html).digest("hex"),
          api, current, detail, detailAttachments,
          currentAttachmentMetadataMissing: !raw.attachments?.length && detail.length > 0,
          ...comparison, url });
      } catch (error) {
        errors.push({ sourceId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    console.log(JSON.stringify({ schema: "bizinfo-official-attachment-link-audit-v2",
      generatedAt: new Date().toISOString(), classificationSha256: sha256,
      population: sourceIds.length, matched, mismatched: mismatches.length,
      apiMatched, apiMismatched, currentMatched, currentMismatched, currentMissing,
      errors: errors.length, mismatches, errorDetails: errors }, null, 2));
    if (errors.length > 0) process.exitCode = 2;
  } finally { await closeCunoteDb(); }
}

if (process.argv[1]?.endsWith("audit-bizinfo-official-attachment-links.ts")) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
