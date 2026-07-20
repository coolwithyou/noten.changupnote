import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, desc, eq, ilike, isNotNull, or } from "drizzle-orm";
import { isFormLikeFilename } from "@cunote/core";
import { getCunoteDb } from "@/lib/server/db/client";
import { grantAttachmentArchives, grants } from "@/lib/server/db/schema";
import { HwpPreviewLab, type LabNotice } from "@/features/dev/hwp-preview/HwpPreviewLab";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "HWP 미리보기 실험실 (dev)",
  robots: { index: false, follow: false },
};

const MAX_NOTICES = 40;

async function loadNotices(): Promise<LabNotice[]> {
  const db = getCunoteDb();
  const rows = await db
    .select({
      grantId: grants.id,
      title: grants.title,
      source: grants.source,
      agencyPrimary: grants.agencyPrimary,
      applyEnd: grants.applyEnd,
      attachmentId: grantAttachmentArchives.id,
      filename: grantAttachmentArchives.filename,
      bytes: grantAttachmentArchives.bytes,
    })
    .from(grants)
    .innerJoin(
      grantAttachmentArchives,
      and(
        eq(grantAttachmentArchives.source, grants.source),
        eq(grantAttachmentArchives.sourceId, grants.sourceId),
      ),
    )
    .where(
      and(
        eq(grants.status, "open"),
        isNotNull(grantAttachmentArchives.storageKey),
        or(
          ilike(grantAttachmentArchives.filename, "%.hwp"),
          ilike(grantAttachmentArchives.filename, "%.hwpx"),
        ),
      ),
    )
    .orderBy(desc(grants.updatedAt))
    .limit(600);

  const byGrant = new Map<string, LabNotice>();
  for (const row of rows) {
    if (!isFormLikeFilename(row.filename)) continue;
    let notice = byGrant.get(row.grantId);
    if (!notice) {
      if (byGrant.size >= MAX_NOTICES) continue;
      notice = {
        grantId: row.grantId,
        title: row.title,
        source: row.source,
        agencyPrimary: row.agencyPrimary,
        applyEnd: row.applyEnd ? row.applyEnd.toISOString().slice(0, 10) : null,
        attachments: [],
      };
      byGrant.set(row.grantId, notice);
    }
    notice.attachments.push({
      id: row.attachmentId,
      filename: row.filename,
      bytes: row.bytes,
    });
  }
  return [...byGrant.values()];
}

export default async function DevHwpPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  let notices: LabNotice[] = [];
  let loadError: string | null = null;
  try {
    notices = await loadNotices();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }
  return <HwpPreviewLab notices={notices} loadError={loadError} />;
}
