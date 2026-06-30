import type { ApplySheet, GrantPreparationResult } from "@cunote/contracts";
import type { CompanyAccess } from "../auth/companyGuard";
import { loadServiceApplySheet } from "../serviceData";
import { listGrantDocumentFormFields } from "./grantDocumentFields";
import { listGrantDocumentDraftsForGrant } from "./grantDocumentDrafts";

export class GrantPreparationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
    this.name = "GrantPreparationError";
  }
}

export async function loadGrantPreparation(input: {
  grantId: string;
  access: CompanyAccess;
  sheet?: ApplySheet;
}): Promise<GrantPreparationResult> {
  const sheet = input.sheet ?? await loadServiceApplySheet(input.grantId, {
    companyId: input.access.companyId,
    userId: input.access.userId,
  });
  if (!sheet) throw new GrantPreparationError("grant_not_found", "공고를 찾지 못했습니다.", 404, "grantId");

  const [drafts, formFields] = await Promise.all([
    listGrantDocumentDraftsForGrant({ grantId: sheet.grant.id, access: input.access }),
    listGrantDocumentFormFields({ grantId: sheet.grant.id, access: input.access }),
  ]);

  const encodedGrantId = encodeURIComponent(sheet.grant.id);
  return {
    grant: sheet.grant,
    documents: sheet.documents,
    sourceAttachments: sheet.sourceAttachments,
    applicationPrep: sheet.applicationPrep,
    drafts,
    formFields,
    exportUrls: {
      packageMarkdown: `/api/web/grants/${encodedGrantId}/package`,
      attachmentBundleMarkdown: `/api/web/grants/${encodedGrantId}/package?format=attachments`,
    },
  };
}
