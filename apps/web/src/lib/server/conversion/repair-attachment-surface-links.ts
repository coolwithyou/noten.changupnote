import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { GrantSource } from "@cunote/contracts";
import { closeCunoteDb, getCunoteDb, type CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { registerAttachmentConversions } from "./registerAttachmentConversions";

loadMonorepoEnv();

const write = process.argv.includes("--write");
const source = (readArg("source") ?? "bizinfo") as GrantSource;
const sourceIds = csvArg(readArg("sourceIds"), 100);
const limit = boundedInteger(readArg("limit"), 20, 1, 100);
if (!["bizinfo", "kstartup", "bizinfo_event"].includes(source)) {
  throw new Error(`unsupported source: ${source}`);
}
if (write && readArg("confirm") !== "REPAIR_ATTACHMENT_SURFACE_LINKS") {
  throw new Error("--write requires --confirm=REPAIR_ATTACHMENT_SURFACE_LINKS");
}

const db = getCunoteDb();
try {
  const archives = await db
    .select({
      grantId: schema.grants.id,
      sourceId: schema.grantAttachmentArchives.sourceId,
      filename: schema.grantAttachmentArchives.filename,
      storageKey: schema.grantAttachmentArchives.storageKey,
      archiveUrl: schema.grantAttachmentArchives.archiveUrl,
      sourceUri: schema.grantAttachmentArchives.sourceUri,
      sha256: schema.grantAttachmentArchives.sha256,
    })
    .from(schema.grantAttachmentArchives)
    .innerJoin(schema.grants, and(
      eq(schema.grants.source, schema.grantAttachmentArchives.source),
      eq(schema.grants.sourceId, schema.grantAttachmentArchives.sourceId),
    ))
    .where(and(
      eq(schema.grantAttachmentArchives.source, source),
      isNotNull(schema.grantAttachmentArchives.storageKey),
      isNotNull(schema.grantAttachmentArchives.sha256),
      ...(sourceIds.length ? [inArray(schema.grantAttachmentArchives.sourceId, sourceIds)] : []),
    ));
  const surfaces = await db
    .select({
      id: schema.grantApplicationSurfaces.id,
      sourceId: schema.grantApplicationSurfaces.sourceId,
      title: schema.grantApplicationSurfaces.title,
      sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
      status: schema.grantApplicationSurfaces.extractionStatus,
    })
    .from(schema.grantApplicationSurfaces)
    .where(and(
      eq(schema.grantApplicationSurfaces.source, source),
      ...(sourceIds.length ? [inArray(schema.grantApplicationSurfaces.sourceId, sourceIds)] : []),
    ));
  const candidates = archives.flatMap((archive) => {
    const surface = surfaces.find((candidate) =>
      candidate.sourceId === archive.sourceId &&
      candidate.title === archive.filename &&
      candidate.status === "pending" &&
      candidate.sourceAttachment !== archive.storageKey);
    if (!surface || surface.sourceAttachment !== surface.title || !archive.storageKey || !archive.sha256) return [];
    return [{ archive, surface }];
  }).slice(0, limit);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: write ? "write" : "dry-run",
    source,
    sourceIds,
    limit,
    candidateCount: candidates.length,
    candidates: candidates.map(({ archive, surface }) => ({
      sourceId: archive.sourceId,
      filename: archive.filename,
      surfaceId: surface.id,
      currentSourceAttachment: surface.sourceAttachment,
      nextSourceAttachment: archive.storageKey,
    })),
  };
  if (!write) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const results: Array<Record<string, unknown>> = [];
    for (const { archive } of candidates) {
      const hook = await db.transaction((tx) => registerAttachmentConversions(
        tx as unknown as CunoteDbSession,
        {
          grantId: archive.grantId,
          source,
          sourceId: archive.sourceId,
          attachments: [{
            filename: archive.filename,
            storageKey: archive.storageKey,
            archiveUrl: archive.archiveUrl,
            sourceUri: archive.sourceUri,
            sha256: archive.sha256,
          }],
        },
      ));
      results.push({ sourceId: archive.sourceId, filename: archive.filename, ...hook });
    }
    console.log(JSON.stringify({ ...report, results }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`limit must be ${min}..${max}`);
  return parsed;
}

function csvArg(value: string | undefined, max: number): string[] {
  if (!value) return [];
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.length > max) throw new Error(`sourceIds supports at most ${max} values`);
  return values;
}
