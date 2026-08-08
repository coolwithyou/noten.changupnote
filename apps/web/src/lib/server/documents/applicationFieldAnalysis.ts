import { createHash } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import type { DocumentFieldType } from "@cunote/contracts";
import type { ReconciledField } from "@cunote/core";
import type { RoundtripParsedDocument } from "@/features/dev/analysis-lab/application-roundtrip-contract";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb, type CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { analyzeRoundtripDocument } from "../analysis-lab/application-roundtrip/analyze-document";
import { likelyApplicationRole, normalizeRoundtripLabel } from "../analysis-lab/application-roundtrip/core";
import { applyReconciledFields } from "./applyReconciledFields";
import {
  APPLICATION_FIELD_PARSER_PREFIX,
  APPLICATION_FIELD_PARSER_VERSION,
  classifyApplicationFieldMap,
  isAutomatedApplicationFieldParserVersion,
} from "./applicationFieldVersion";
import { loadDraftSourceFile } from "./draftSourceFile";
import { getGrantDocumentDraft } from "./grantDocumentDrafts";
import { resolveReviewFieldFillPlan, slugFieldKey } from "./reviewFieldMapping";

export { APPLICATION_FIELD_PARSER_VERSION } from "./applicationFieldVersion";

export interface ApplicationFieldAnalysisResult {
  status: "ready" | "already_ready";
  draftId: string;
  surfaceId: string;
  fieldCount: number;
  role: RoundtripParsedDocument["role"] | null;
  planning: RoundtripParsedDocument["fieldPlanning"] | null;
  coverage: RoundtripParsedDocument["fieldCoverage"] | null;
  parserVersion: typeof APPLICATION_FIELD_PARSER_VERSION;
}

export class ApplicationFieldAnalysisError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ApplicationFieldAnalysisError";
  }
}

/**
 * 소유권이 검증된 draft 하나를 production field map으로 준비한다.
 * 호출자는 draftId 외에 surface/R2/KorDoc/저장 규칙을 알 필요가 없다.
 */
export async function ensureDraftApplicationFields(input: {
  draftId: string;
  access: CompanyAccess;
}): Promise<ApplicationFieldAnalysisResult> {
  const draft = await getGrantDocumentDraft(input);
  const db = getCunoteDb();
  const [linkedDraft] = await db
    .select({ surfaceId: schema.grantDocumentDrafts.surfaceId })
    .from(schema.grantDocumentDrafts)
    .where(and(
      eq(schema.grantDocumentDrafts.id, draft.id),
      eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
    ))
    .limit(1);
  if (!linkedDraft?.surfaceId) {
    throw new ApplicationFieldAnalysisError(
      "application_surface_missing",
      "이 지원서 초안에 분석할 원본 문서가 연결돼 있지 않습니다.",
      409,
    );
  }

  const [surface] = await db
    .select({
      id: schema.grantApplicationSurfaces.id,
      grantId: schema.grantApplicationSurfaces.grantId,
      type: schema.grantApplicationSurfaces.type,
      title: schema.grantApplicationSurfaces.title,
      format: schema.grantApplicationSurfaces.format,
      sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
      extractionStatus: schema.grantApplicationSurfaces.extractionStatus,
    })
    .from(schema.grantApplicationSurfaces)
    .where(and(
      eq(schema.grantApplicationSurfaces.id, linkedDraft.surfaceId),
      eq(schema.grantApplicationSurfaces.grantId, draft.grantId),
    ))
    .limit(1);
  if (!surface) {
    throw new ApplicationFieldAnalysisError("application_surface_not_found", "지원서 원본 정보를 찾지 못했습니다.", 404);
  }

  const existingMap = await loadSurfaceFieldMapState(db, surface.id);
  if (shouldReuseExistingFieldMap(surface.extractionStatus, existingMap.parserVersions)) {
    return result("already_ready", draft.id, surface.id, existingMap.parserVersions.length, null);
  }
  if (surface.type !== "file_template" || (surface.format !== "hwp" && surface.format !== "hwpx")) {
    throw new ApplicationFieldAnalysisError(
      "application_surface_unsupported",
      "KorDoc 필드 분석은 HWP/HWPX 신청 양식만 지원합니다.",
      415,
    );
  }
  if (surface.extractionStatus !== "preview_ready" && surface.extractionStatus !== "fields_ready") {
    throw new ApplicationFieldAnalysisError(
      "application_surface_not_ready",
      "문서 미리보기가 준비된 뒤 작성 항목을 분석할 수 있습니다.",
      409,
    );
  }

  const source = await loadDraftSourceFile({ draft });
  const sourceSha256 = createHash("sha256").update(source.body).digest("hex");
  if (surface.sourceAttachment) {
    const [archive] = await db
      .select({ sha256: schema.grantAttachmentArchives.sha256 })
      .from(schema.grantAttachmentArchives)
      .where(and(
        eq(schema.grantAttachmentArchives.source, source.grant.source),
        eq(schema.grantAttachmentArchives.sourceId, source.grant.sourceId),
        eq(schema.grantAttachmentArchives.storageKey, surface.sourceAttachment),
      ))
      .limit(1);
    if (archive?.sha256 && /^[a-f0-9]{64}$/i.test(archive.sha256) && archive.sha256 !== sourceSha256) {
      throw new ApplicationFieldAnalysisError(
        "application_source_sha_mismatch",
        "보관된 지원서 원본과 분석 대상 파일의 SHA-256이 일치하지 않습니다.",
        409,
      );
    }
  }

  const analyzed = await analyzeRoundtripDocument({
    attachmentId: createHash("sha256").update(`${surface.id}:${sourceSha256}`).digest("hex").slice(0, 20),
    filename: source.filename,
    declaredFormat: source.format,
    sourceSha256,
    body: source.body,
    apiKey: fieldPlanningApiKey(),
  });
  if (!likelyApplicationRole(analyzed.document.role)) {
    throw new ApplicationFieldAnalysisError(
      "not_application_document",
      `선택한 문서는 작성형 신청서로 판정되지 않았습니다(role=${analyzed.document.role}).`,
      409,
    );
  }
  const fields = buildReconciledApplicationFields(analyzed.document);
  if (analyzed.document.fieldCoverage.status === "review_required" && fields.length === 0) {
    const labels = analyzed.document.fieldCoverage.unresolvedCandidates
      .slice(0, 5)
      .map((candidate) => candidate.label)
      .join(", ");
    throw new ApplicationFieldAnalysisError(
      "application_field_coverage_incomplete",
      `작성 여부를 확정하지 못한 빈 셀이 있어 자동 필드맵을 완료하지 않았습니다: ${labels}`,
      422,
    );
  }
  if (fields.length === 0) {
    throw new ApplicationFieldAnalysisError(
      "application_fields_not_found",
      "지원자가 작성할 항목을 안전하게 확정하지 못했습니다.",
      422,
    );
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${surface.id}))`);
    const [latestSurface] = await tx
      .select({ extractionStatus: schema.grantApplicationSurfaces.extractionStatus })
      .from(schema.grantApplicationSurfaces)
      .where(eq(schema.grantApplicationSurfaces.id, surface.id))
      .limit(1);
    const latestMap = await loadSurfaceFieldMapState(tx as unknown as CunoteDbSession, surface.id);
    if (shouldReuseExistingFieldMap(latestSurface?.extractionStatus ?? "unknown", latestMap.parserVersions)) {
      return result("already_ready", draft.id, surface.id, latestMap.parserVersions.length, analyzed.document);
    }
    if (latestSurface?.extractionStatus !== "preview_ready" && latestSurface?.extractionStatus !== "fields_ready") {
      throw new ApplicationFieldAnalysisError(
        "application_surface_changed",
        "분석 중 문서 상태가 변경되어 필드 반영을 중단했습니다.",
        409,
      );
    }
    if (latestMap.parserVersions.length > 0 && latestMap.parserVersions.every(isAutomatedApplicationFieldParserVersion)) {
      await tx
        .delete(schema.grantDocumentFields)
        .where(and(
          eq(schema.grantDocumentFields.surfaceId, surface.id),
          like(schema.grantDocumentFields.parserVersion, `${APPLICATION_FIELD_PARSER_PREFIX}%`),
        ));
    }
    const applied = await applyReconciledFields({
      db: tx as unknown as CunoteDbSession,
      surfaceId: surface.id,
      fields,
      parserVersion: APPLICATION_FIELD_PARSER_VERSION,
      extractionVersion: APPLICATION_FIELD_PARSER_VERSION,
      extractionConfidence: coverageConfidence(analyzed.document.fieldCoverage.status),
      defaults: {
        documentCategory: draft.documentCategory,
        documentName: draft.documentName || surface.title,
      },
    });
    return result("ready", draft.id, surface.id, applied.inserted + applied.updated, analyzed.document);
  });
}

/** KorDoc/RHWP 분석 결과를 기존 workspace가 소비하는 필드맵으로 낮춘다. */
export function buildReconciledApplicationFields(document: RoundtripParsedDocument): ReconciledField[] {
  const usedKeys = new Set<string>();
  const fields: ReconciledField[] = [];
  for (const candidate of document.fields.filter((field) => field.recommendedInput)) {
    const label = candidate.displayLabel.trim() || candidate.label.trim();
    if (!label) continue;
    const baseKey = canonicalFieldKey(label);
    const fieldKey = uniqueKey(usedKeys, baseKey);
    const fieldType = roundtripFieldType(candidate.type, candidate.inputKind);
    const fillPlan = resolveReviewFieldFillPlan({ key: baseKey, label, type: fieldType }, baseKey);
    const confidence = clamp(candidate.llmConfidence ?? candidate.inputLikelihood, 0.1, 0.99);
    fields.push({
      fieldKey,
      label,
      section: null,
      fieldType,
      required: candidate.required,
      fillStrategy: fillPlan.fillStrategy,
      confidence,
      tier: confidence >= 0.8 ? "high" : confidence >= 0.55 ? "medium" : "low",
      position: candidate.location.pageNumber
        ? { page: candidate.location.pageNumber, bbox: null }
        : null,
      visualEvidence: {
        source: "kordoc-rhwp",
        location: candidate.location,
        sourceSha256: document.sourceSha256,
      },
      textEvidence: {
        source: "kordoc-rhwp",
        analysisSource: candidate.analysisSource,
        signals: candidate.inputSignals,
      },
      reviewRequired: confidence < 0.75,
      mappedCompanyField: fillPlan.mappedCompanyField,
      sourceSpan: candidateSourceSpan(candidate),
      documentName: document.filename,
      documentCategory: "application_form",
    });
  }

  for (const choice of document.choiceGroups) {
    const label = choice.label.trim();
    if (!label) continue;
    const baseKey = slugFieldKey(label);
    fields.push({
      fieldKey: uniqueKey(usedKeys, baseKey),
      label,
      section: null,
      fieldType: "checkbox",
      required: false,
      fillStrategy: "ask_user",
      confidence: 0.9,
      tier: "high",
      position: null,
      visualEvidence: {
        source: "kordoc-rhwp-form-control",
        location: choice.location,
        sourceSha256: document.sourceSha256,
      },
      textEvidence: {
        source: "kordoc-rhwp-form-control",
        selectionMode: choice.selectionMode,
      },
      reviewRequired: false,
      mappedCompanyField: null,
      sourceSpan: choice.options.map((option) => `□ ${option.label}`).join(" "),
      documentName: document.filename,
      documentCategory: "application_form",
    });
  }
  return fields;
}

function result(
  status: ApplicationFieldAnalysisResult["status"],
  draftId: string,
  surfaceId: string,
  fieldCount: number,
  document: RoundtripParsedDocument | null,
): ApplicationFieldAnalysisResult {
  return {
    status,
    draftId,
    surfaceId,
    fieldCount,
    role: document?.role ?? null,
    planning: document?.fieldPlanning ?? null,
    coverage: document?.fieldCoverage ?? null,
    parserVersion: APPLICATION_FIELD_PARSER_VERSION,
  };
}

function canonicalFieldKey(label: string): string {
  const normalized = normalizeRoundtripLabel(label);
  const thirdParty = /(홍보물제작기업|외주|협력|수행기관|용역사)/u.test(normalized);
  if (!thirdParty && /(회사명|기업명|업체명|상호|법인명)/u.test(normalized)) return "company_name";
  if (/(사업자등록번호|사업자번호)/u.test(normalized)) return "biz_reg_no";
  if (!thirdParty && /(대표자성명|대표자명)/u.test(normalized)) return "ceo_name";
  if (!thirdParty && /(사업장소재지|회사주소|기업주소|소재지|주소)/u.test(normalized)) return "address";
  if (!thirdParty && /(업종|업태|종목)/u.test(normalized)) return "industry";
  if (/(종업원수|직원수|상시근로자|고용인원)/u.test(normalized)) return "employee_count";
  if (/(매출액|매출)/u.test(normalized)) return "revenue";
  if (/(인증|확인서)/u.test(normalized)) return "certifications";
  return slugFieldKey(label);
}

function roundtripFieldType(
  type: RoundtripParsedDocument["fields"][number]["type"],
  inputKind: RoundtripParsedDocument["fields"][number]["inputKind"],
): DocumentFieldType {
  if (inputKind === "textarea") return "long_text";
  if (inputKind === "number") return type === "amount" ? "currency" : "number";
  if (type === "date") return "date";
  if (type === "amount") return "currency";
  if (type === "checkbox") return "checkbox";
  return "text";
}

function candidateSourceSpan(candidate: RoundtripParsedDocument["fields"][number]): string | null {
  if (candidate.options.length > 0) return candidate.options.map((option) => `□ ${option.label}`).join(" ");
  return candidate.helperText?.trim() || candidate.originalValue.trim() || null;
}

function uniqueKey(used: Set<string>, base: string): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  const value = `${base}-${suffix}`;
  used.add(value);
  return value;
}

function fieldPlanningApiKey(): string | null {
  if (process.env.APPLICATION_FIELD_ANALYSIS_USE_LLM !== "true") return null;
  return process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTROPHIC_API_KEY?.trim() || null;
}

function shouldReuseExistingFieldMap(status: string, parserVersions: string[]): boolean {
  if (status !== "fields_ready" || parserVersions.length === 0) return false;
  const state = classifyApplicationFieldMap(parserVersions);
  return state === "current_automated" || state === "protected";
}

async function loadSurfaceFieldMapState(
  db: Pick<CunoteDbSession, "select">,
  surfaceId: string,
): Promise<{ parserVersions: string[] }> {
  const rows = await db
    .select({ parserVersion: schema.grantDocumentFields.parserVersion })
    .from(schema.grantDocumentFields)
    .where(eq(schema.grantDocumentFields.surfaceId, surfaceId));
  return { parserVersions: rows.map((row) => row.parserVersion) };
}

function coverageConfidence(status: RoundtripParsedDocument["fieldCoverage"]["status"]): number {
  if (status === "complete") return 1;
  if (status === "partial") return 0.75;
  return 0.4;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value.toFixed(3))));
}
