import type { BizInfoProgram } from "@cunote/core";
import { attachmentIdentityPairsFromDetail, attachmentRowsFromDetail } from "./audit-bizinfo-official-attachment-links";
import { hashGrantRawPayload } from "./grantRawHash";

const OFFICIAL_ORIGIN = "https://www.bizinfo.go.kr";

export function bizInfoApiAttachmentFieldsSha256(program: BizInfoProgram): string {
  return hashGrantRawPayload({ fileNm: program.fileNm ?? null,
    flpthNm: program.flpthNm ?? null, printFileNm: program.printFileNm ?? null,
    printFlpthNm: program.printFlpthNm ?? null });
}

export function buildBizInfoOfficialDetailAttachmentSnapshot(
  program: BizInfoProgram,
  html: string,
): NonNullable<BizInfoProgram["officialDetailAttachmentSnapshot"]> {
  const sourceUrl = officialBizInfoDetailUrl(program.pblancId);
  const rows = attachmentRowsFromDetail(html);
  const identities = attachmentIdentityPairsFromDetail(html);
  if (rows.length === 0 || rows.length !== identities.length ||
    rows.some((row) => !identities.includes(row.identity))) {
    throw new Error(`official detail attachments are incomplete: ${program.pblancId}`);
  }
  const attachments = rows.map(({ kind, filename, url }) => ({ kind, filename, url }));
  return {
    sourceUrl,
    apiAttachmentFieldsSha256: bizInfoApiAttachmentFieldsSha256(program),
    attachmentListSha256: hashGrantRawPayload(attachments),
    attachments,
  };
}

export function carryBizInfoOfficialDetailAttachmentSnapshot(
  program: BizInfoProgram,
  existing: BizInfoProgram | null | undefined,
): BizInfoProgram {
  const snapshot = existing?.officialDetailAttachmentSnapshot;
  if (!snapshot || existing?.pblancId !== program.pblancId ||
    snapshot.sourceUrl !== officialBizInfoDetailUrl(program.pblancId) ||
    snapshot.apiAttachmentFieldsSha256 !== bizInfoApiAttachmentFieldsSha256(program) ||
    snapshot.attachmentListSha256 !== hashGrantRawPayload(snapshot.attachments) ||
    snapshot.attachments.length === 0 || snapshot.attachments.some((attachment) => {
      const url = new URL(attachment.url);
      return url.origin !== OFFICIAL_ORIGIN || url.pathname !== "/cmm/fms/fileDown.do";
    })) return program;
  return { ...program, officialDetailAttachmentSnapshot: snapshot };
}

export async function fetchBizInfoOfficialDetailAttachmentSnapshot(
  program: BizInfoProgram,
  fetchImpl: typeof fetch = fetch,
): Promise<NonNullable<BizInfoProgram["officialDetailAttachmentSnapshot"]>> {
  const sourceUrl = officialBizInfoDetailUrl(program.pblancId);
  const response = await fetchImpl(sourceUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok || response.url !== sourceUrl) {
    throw new Error(`official detail response invalid: ${program.pblancId} / ${response.status}`);
  }
  return buildBizInfoOfficialDetailAttachmentSnapshot(program, await response.text());
}

function officialBizInfoDetailUrl(sourceId: string): string {
  if (!/^PBLN_[A-Z0-9_]+$/u.test(sourceId)) throw new Error("invalid BizInfo source ID");
  return `${OFFICIAL_ORIGIN}/sii/siia/selectSIIA200Detail.do?pblancId=${sourceId}`;
}
