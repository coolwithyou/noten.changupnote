import { and, eq } from "drizzle-orm";
import type { CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { listVerifiedArchiveMaterialEntries } from "@/lib/server/ingestion/archiveContainerInspection";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import {
  buildDeepAnalysisSourceRevision,
  sha256Hex,
  stableJson,
} from "./sourceRevision";
import {
  sealDeepAnalysisInput,
  type DeepAnalysisInputAttachment,
  type DeepAnalysisInputSeal,
} from "./inputManifest";

export async function prepareDeepAnalysisInput(input: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
  grantId: string;
  chunkChars?: number;
  maxTotalChars?: number;
}): Promise<DeepAnalysisInputSeal> {
  const [grant] = await input.db.select().from(schema.grants)
    .where(eq(schema.grants.id, input.grantId)).limit(1);
  if (!grant) throw new Error(`Grant not found: ${input.grantId}`);
  const [raw] = await input.db.select().from(schema.grantRaw).where(and(
    eq(schema.grantRaw.source, grant.source),
    eq(schema.grantRaw.sourceId, grant.sourceId),
  )).limit(1);
  const archives = await input.db.select().from(schema.grantAttachmentArchives).where(and(
    eq(schema.grantAttachmentArchives.source, grant.source),
    eq(schema.grantAttachmentArchives.sourceId, grant.sourceId),
  ));
  const convertedArtifacts = await input.db.select({
    sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
    title: schema.grantApplicationSurfaces.title,
    storageKey: schema.documentArtifacts.storageKey,
    sha256: schema.documentArtifacts.sha256,
  }).from(schema.grantApplicationSurfaces).innerJoin(
    schema.documentArtifacts,
    eq(schema.documentArtifacts.surfaceId, schema.grantApplicationSurfaces.id),
  ).where(and(
    eq(schema.grantApplicationSurfaces.grantId, grant.id),
    eq(schema.documentArtifacts.kind, "markdown"),
  ));

  const inventory = applyVerifiedConversionArtifacts(
    mergeAttachmentInventory(raw?.attachments ?? [], archives),
    convertedArtifacts,
  );
  await applyVerifiedAttachmentWaivers(inventory, input.storage);
  const hydrated = await Promise.all(inventory.map(async (attachment) => {
    if (!attachment.markdownStorageKey) return attachment;
    try {
      const storedText = await input.storage.getObjectText(attachment.markdownStorageKey);
      const storedSha256 = sha256Hex(storedText);
      if (!attachment.markdownSha256) {
        return { ...attachment, loadError: "markdown SHA-256 missing" };
      }
      if (storedSha256 !== attachment.markdownSha256) {
        return {
          ...attachment,
          loadError: `markdown SHA-256 mismatch (${storedSha256.slice(0, 12)})`,
        };
      }
      return {
        ...attachment,
        markdownText: stripArchiveFrontmatter(storedText),
        loadError: null,
      };
    } catch (error) {
      return {
        ...attachment,
        loadError: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  const grantSourceFields = {
    source: grant.source,
    sourceId: grant.sourceId,
    title: grant.title,
    url: grant.url,
    agencyJurisdiction: grant.agencyJurisdiction,
    agencyOperator: grant.agencyOperator,
    agencyPrimary: grant.agencyPrimary,
    categoryL1: grant.categoryL1,
    categoryL2: grant.categoryL2,
    applyStart: grant.applyStart?.toISOString() ?? null,
    applyEnd: grant.applyEnd?.toISOString() ?? null,
    applyMethod: grant.applyMethod,
    supportAmount: grant.supportAmount,
    benefits: grant.benefits,
    requiredDocuments: grant.requiredDocuments,
    status: grant.status,
  };
  const sourceRevision = buildDeepAnalysisSourceRevision({
    grant: grantSourceFields,
    rawHash: raw?.rawHash ?? null,
    attachments: hydrated.map((attachment) => ({
      sourceUri: attachment.sourceUri,
      filename: attachment.filename,
      sha256: attachment.sha256,
      markdownSha256: attachment.markdownSha256,
      conversionStatus: attachment.conversionStatus,
    })),
  });
  const structuredText = stableJson({
    schema: "deep-analysis-structured-source-v1",
    grant: grantSourceFields,
    rawPayload: raw?.payload ?? null,
  });
  return sealDeepAnalysisInput({
    grantId: grant.id,
    sourceRevisionSha256: sourceRevision.sha256,
    structuredText,
    attachments: hydrated,
    ...(input.chunkChars !== undefined ? { chunkChars: input.chunkChars } : {}),
    ...(input.maxTotalChars !== undefined ? { maxTotalChars: input.maxTotalChars } : {}),
  });
}

function mergeAttachmentInventory(
  rawAttachments: Array<Record<string, unknown>>,
  archives: Array<typeof schema.grantAttachmentArchives.$inferSelect>,
): DeepAnalysisInputAttachment[] {
  const archiveByExactKey = new Map(
    archives.map((archive) => [attachmentKey(archive.filename, archive.sourceUri), archive]),
  );
  const archiveByFilename = new Map<string, Array<typeof schema.grantAttachmentArchives.$inferSelect>>();
  for (const archive of archives) {
    archiveByFilename.set(archive.filename, [
      ...(archiveByFilename.get(archive.filename) ?? []),
      archive,
    ]);
  }
  const consumed = new Set<string>();
  const inventory: DeepAnalysisInputAttachment[] = rawAttachments.map((raw, index) => {
    const filename = textValue(raw.filename) ?? `unnamed-${index + 1}`;
    const sourceUri = textValue(raw.source_uri) ?? textValue(raw.url) ?? "";
    const exact = archiveByExactKey.get(attachmentKey(filename, sourceUri));
    const filenameCandidates = archiveByFilename.get(filename) ?? [];
    const archive = exact ?? (filenameCandidates.length === 1 ? filenameCandidates[0] : undefined);
    if (archive) consumed.add(archive.id);
    return toInputAttachment({
      id: archive?.id ?? `raw:${index}:${sha256Hex(`${filename}\u0000${sourceUri}`).slice(0, 16)}`,
      filename,
      sourceUri,
      ...(archive ? { archive } : {}),
    });
  });
  for (const archive of archives) {
    if (consumed.has(archive.id)) continue;
    inventory.push(toInputAttachment({
      id: archive.id,
      filename: archive.filename,
      sourceUri: archive.sourceUri,
      archive,
    }));
  }
  return inventory.sort((left, right) => (
    `${left.sourceUri}\u0000${left.filename}`.localeCompare(
      `${right.sourceUri}\u0000${right.filename}`,
    )
  ));
}

function applyVerifiedConversionArtifacts(
  inventory: DeepAnalysisInputAttachment[],
  artifacts: Array<{
    sourceAttachment: string | null;
    title: string;
    storageKey: string;
    sha256: string | null;
  }>,
): DeepAnalysisInputAttachment[] {
  return inventory.map((attachment) => {
    if (attachment.markdownStorageKey && attachment.markdownSha256) return attachment;
    const exact = artifacts.find((artifact) => (
      attachment.storageKey !== null
      && artifact.sourceAttachment === attachment.storageKey
    ));
    const titleMatches = artifacts.filter((artifact) => artifact.title === attachment.filename);
    const artifact = exact ?? (titleMatches.length === 1 ? titleMatches[0] : undefined);
    if (!artifact?.sha256) return attachment;
    return {
      ...attachment,
      conversionStatus: "converted",
      markdownStorageKey: artifact.storageKey,
      markdownSha256: artifact.sha256,
    };
  });
}

/**
 * 비텍스트 첨부를 이름만 보고 버리지 않는다.
 *
 * - 이미지에는 동일 source URI 또는 같은 stem의 기존 검증된 OCR TXT sidecar가 있을
 *   때만 그 SHA를 proof로 연결한다. 별도 HWP/HWPX가 이름만 비슷한 경우는 면제하지 않는다.
 * - ZIP에는 보관된 parent 실제 바이트의 모든 material entry가 지원 문서이고, 그 전부가
 *   현재 inventory child와 일대일 대응하며 원본+전문 검증을 통과했을 때만 면제한다.
 */
export async function applyVerifiedAttachmentWaivers(
  inventory: DeepAnalysisInputAttachment[],
  storage: R2ObjectStorage,
): Promise<void> {
  const textSidecars = inventory.filter((attachment) => (
    /\.txt$/i.test(attachment.filename)
    && attachment.storageKey
    && attachment.sha256
    && attachment.markdownStorageKey
    && attachment.markdownSha256
    && attachment.conversionStatus === "converted"
  ));
  for (const attachment of inventory) {
    if (!/\.(?:png|jpe?g|gif|webp|tiff?)$/i.test(attachment.filename)) continue;
    const sidecar = textSidecars.find((candidate) => (
      Boolean(attachment.sourceUri)
      && candidate.sourceUri === attachment.sourceUri
    )) ?? textSidecars.find((candidate) => (
      normalizedStem(candidate.filename) === normalizedStem(attachment.filename)
    ));
    if (!sidecar?.markdownSha256) continue;
    attachment.waiver = {
      disposition: "waived_non_text",
      reason: `검증된 OCR sidecar ${sidecar.id}가 included 입력으로 연결됨`,
      proofSha256: sidecar.markdownSha256,
    };
  }

  for (const attachment of inventory) {
    if (
      !/\.zip$/i.test(attachment.filename)
      || !attachment.sourceUri
      || !attachment.storageKey
      || !attachment.sha256
    ) {
      continue;
    }
    const childPrefix = `zip:${attachment.sourceUri}#`;
    const inventoryChildren = inventory
      .filter((candidate) => candidate.sourceUri.startsWith(childPrefix))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (inventoryChildren.length === 0) continue;
    try {
      const parent = await storage.getObjectBytes(attachment.storageKey);
      if (sha256Hex(parent.body) !== attachment.sha256) continue;
      const materialEntries = listVerifiedArchiveMaterialEntries(
        attachment.filename,
        parent.body,
      );
      const children = materialEntries.map((entry) => {
        const expectedSourceUri = `${childPrefix}${encodeURIComponent(entry.filename)}`;
        const candidates = inventoryChildren.filter((candidate) => (
          candidate.sourceUri === expectedSourceUri
        ));
        return {
          entry,
          child: candidates.find((candidate) => (
            candidate.storageKey
            && candidate.sha256
            && candidate.conversionStatus === "converted"
            && candidate.markdownStorageKey
            && candidate.markdownSha256
          )) ?? candidates[0],
        };
      });
      if (
        children.some(({ child }) => (
          !child
          || !child.storageKey
          || !child.sha256
          || child.conversionStatus !== "converted"
          || !child.markdownStorageKey
          || !child.markdownSha256
        ))
      ) {
        continue;
      }
      attachment.waiver = {
        disposition: "waived_non_material",
        reason: `ZIP 실제 바이트의 material entry ${children.length}건 전부가 검증된 current child 입력으로 연결됨`,
        proofSha256: sha256Hex(stableJson({
          parentSha256: attachment.sha256,
          entries: children.map(({ entry, child }) => ({
            filename: entry.filename,
            originalSize: entry.originalSize,
            id: child?.id,
            sourceUri: child?.sourceUri,
            sha256: child?.sha256,
            markdownSha256: child?.markdownSha256,
          })),
        })),
      };
    } catch {
      // byte inspection 또는 entry 완전성 증명이 실패하면 waiver를 만들지 않고 seal이 막는다.
      continue;
    }
  }
}

function toInputAttachment(input: {
  id: string;
  filename: string;
  sourceUri: string;
  archive?: typeof schema.grantAttachmentArchives.$inferSelect;
}): DeepAnalysisInputAttachment {
  return {
    id: input.id,
    filename: input.filename,
    sourceUri: input.sourceUri,
    contentType: input.archive?.contentType ?? null,
    bytes: input.archive?.bytes ?? null,
    storageKey: input.archive?.storageKey ?? null,
    sha256: input.archive?.sha256 ?? null,
    conversionStatus: input.archive?.conversionStatus ?? null,
    markdownStorageKey: input.archive?.markdownStorageKey ?? null,
    markdownSha256: input.archive?.markdownSha256 ?? null,
    markdownText: null,
    loadError: null,
  };
}

function attachmentKey(filename: string, sourceUri: string): string {
  return `${filename}\u0000${sourceUri}`;
}

function normalizedStem(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/(?:대체\s*텍스트|포스터|ocr)/gi, "")
    .replace(/[^0-9a-z가-힣]/gi, "")
    .toLowerCase();
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stripArchiveFrontmatter(text: string): string {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return text;
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return match ? text.slice(match[0].length) : text;
}
