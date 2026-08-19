import { and, eq } from "drizzle-orm";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadDocumentAgentCore } from "../rhwp/documentAgentCore";
import {
  extractDocumentEditCandidates,
  reservedAnchorsFromExactResolutions,
} from "@/lib/rhwp/documentAgentCandidates";
import type {
  DocumentAgentReservedAnchor,
  DocumentEditAnchor,
  DocumentEditCandidate,
} from "@/lib/rhwp/documentAgentContract";
import { resolveRhwpFieldAnchorsExact } from "@/lib/rhwp/fieldAnchors";
import {
  loadConnectedDocumentFields,
  resolveArchiveStorageKey,
} from "./documentFieldLink";
import {
  getDraftRevisionHead,
  loadExactDraftRevisionFile,
  type ExactDraftRevisionFile,
} from "./documentRevisions";

export class DocumentAgentCandidateAuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "DocumentAgentCandidateAuthorityError";
  }
}

export interface DocumentAgentCandidateAuthorityResult {
  revision: ExactDraftRevisionFile;
  candidate: DocumentEditCandidate;
  reservedAnchors: DocumentAgentReservedAnchor[];
  connectedFieldCount: number;
}

/** client 후보를 권위값으로 쓰지 않고 exact checkpoint 바이트에서 같은 ID를 다시 만든다. */
export async function rebuildDocumentAgentCandidateAuthority(input: {
  draftId: string;
  access: CompanyAccess;
  baseRevisionId: string;
  checkpointRequestId: string;
  selectedPage: number;
  candidateId: string;
  anchor: DocumentEditAnchor;
}): Promise<DocumentAgentCandidateAuthorityResult> {
  const db = getCunoteDb();
  const [draft] = await db
    .select({
      grantId: schema.grantDocumentDrafts.grantId,
      surfaceId: schema.grantDocumentDrafts.surfaceId,
      sourceAttachment: schema.grantDocumentDrafts.sourceAttachment,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
    })
    .from(schema.grantDocumentDrafts)
    .innerJoin(schema.grants, eq(schema.grantDocumentDrafts.grantId, schema.grants.id))
    .where(and(
      eq(schema.grantDocumentDrafts.id, input.draftId),
      eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
    ))
    .limit(1);
  if (!draft) {
    throw new DocumentAgentCandidateAuthorityError("draft_not_found", "문서 초안을 찾지 못했습니다.", 404);
  }

  const head = await getDraftRevisionHead(input.draftId);
  if (!head || head.revisionId !== input.baseRevisionId) {
    throw new DocumentAgentCandidateAuthorityError(
      "revision_conflict",
      "제안 기준 문서가 최신 작업본이 아닙니다.",
      409,
    );
  }
  const revision = await loadExactDraftRevisionFile({
    draftId: input.draftId,
    revisionId: input.baseRevisionId,
    access: input.access,
    requireCreator: true,
  });
  if (
    revision.origin !== "studio_agent_checkpoint"
    || revision.checkpointRequestId !== input.checkpointRequestId
  ) {
    throw new DocumentAgentCandidateAuthorityError(
      "checkpoint_binding_mismatch",
      "AI 제안 기준 checkpoint 결속이 맞지 않습니다.",
      409,
    );
  }

  const archive = !draft.surfaceId && draft.sourceAttachment
    ? await resolveArchiveStorageKey({
        source: draft.source,
        sourceId: draft.sourceId,
        filename: draft.sourceAttachment,
      })
    : null;
  const fields = await loadConnectedDocumentFields({
    source: draft.source,
    sourceId: draft.sourceId,
    ...(draft.surfaceId ? { surfaceId: draft.surfaceId } : {}),
    ...(!draft.surfaceId && archive?.storageKey
      ? { sourceAttachment: archive.storageKey }
      : {}),
  });

  const rhwp = await loadDocumentAgentCore();
  const document = new rhwp.HwpDocument(revision.body);
  try {
    if (document.pageCount() !== revision.pageCount) {
      throw new DocumentAgentCandidateAuthorityError(
        "checkpoint_page_count_mismatch",
        "checkpoint 페이지 수 검증이 맞지 않습니다.",
        409,
      );
    }
    let reservedAnchors: DocumentAgentReservedAnchor[];
    try {
      reservedAnchors = reservedAnchorsFromExactResolutions(
        resolveRhwpFieldAnchorsExact(document, fields),
      );
    } catch (error) {
      throw new DocumentAgentCandidateAuthorityError(
        "reserved_anchor_unresolved",
        error instanceof Error ? error.message : "연결 필드 구조 위치를 확정하지 못했습니다.",
        409,
      );
    }
    const candidates = await extractDocumentEditCandidates({
      document,
      sourceKey: `draft:${input.draftId}`,
      documentSha256: revision.sha256,
      selectedPage: input.selectedPage,
      reservedAnchors,
    });
    const candidate = candidates.find((entry) => entry.candidateId === input.candidateId);
    if (!candidate || !sameAnchor(candidate.anchor, input.anchor)) {
      throw new DocumentAgentCandidateAuthorityError(
        "candidate_binding_mismatch",
        "선택한 작성 위치가 checkpoint 문서의 서버 후보와 일치하지 않습니다.",
        409,
      );
    }
    return {
      revision,
      candidate,
      reservedAnchors,
      connectedFieldCount: fields.length,
    };
  } finally {
    document.free();
  }
}

function sameAnchor(left: DocumentEditAnchor, right: DocumentEditAnchor): boolean {
  return left.kind === right.kind
    && left.section === right.section
    && left.paragraph === right.paragraph
    && left.charOffset === right.charOffset
    && left.length === right.length;
}
