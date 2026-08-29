import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { parse } from "kordoc";
import type { GrantSource } from "@cunote/contracts";
import type { ReconciledField } from "@cunote/core";
import type { ConnectedDocumentField } from "./documentFieldLink";
import type { PreviewSurface } from "./documentPreview";
import type { SurfaceApplicationPrecomputeState } from "./applicationPrecomputeState";
import { APPLICATION_FIELD_PARSER_VERSION } from "./applicationFieldVersion";
import { buildReconciledApplicationFields } from "./applicationFieldAnalysis";
import {
  buildApplicationPrecomputeMaterializationPlan,
  buildApplicationPrecomputeSurfacePlan,
} from "./applicationPrecomputeMaterialization";
import {
  APPLICATION_ROUNDTRIP_VERSION,
  LOCAL_PREVIEW_COMPATIBLE_ROUNDTRIP_VERSIONS,
} from "../analysis-lab/application-roundtrip/contract";
import { extractLocatedRoundtripFields, normalizeRoundtripLabel } from "../analysis-lab/application-roundtrip/core";
import { extractContextualRoundtripFields } from "../analysis-lab/application-roundtrip/editable-regions";
import { verifyRoundtripParagraphFieldBindings } from "../analysis-lab/application-roundtrip/native-paragraph-bindings";
import {
  listRoundtripRunArtifactsForSource,
  readRoundtripRunArtifacts,
  type RoundtripRunArtifacts,
} from "../analysis-lab/application-roundtrip/store";
import { readLabRun, readLatestLabRun } from "../analysis-lab/run-store";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";

export interface LocalApplicationPrecomputePreview {
  connectedFields: ConnectedDocumentField[];
  state: SurfaceApplicationPrecomputeState;
}

/**
 * 로컬 구독 분석 결과를 관리자 읽기 전용 시뮬레이션에만 투영한다.
 *
 * DB/R2에 쓰지 않으며 일반 사용자·production 경로에서는 호출되지 않는다. 실제 사용자 RHWP
 * field-aware 작성은 승인된 release/promotion이 materialize한 grant_document_fields만 사용한다.
 */
export async function loadLocalApplicationPrecomputePreview(input: {
  grantId: string;
  source: string;
  sourceId: string;
  surface: PreviewSurface;
}): Promise<LocalApplicationPrecomputePreview | null> {
  if (process.env.NODE_ENV === "production") return null;

  if (!input.surface.sourceAttachment) return null;
  const db = getCunoteDb();
  const [archive] = await db
    .select({ sha256: schema.grantAttachmentArchives.sha256 })
    .from(schema.grantAttachmentArchives)
    .where(and(
      eq(schema.grantAttachmentArchives.source, input.source as GrantSource),
      eq(schema.grantAttachmentArchives.sourceId, input.sourceId),
      or(
        eq(schema.grantAttachmentArchives.storageKey, input.surface.sourceAttachment),
        eq(schema.grantAttachmentArchives.filename, input.surface.sourceAttachment),
      ),
    ))
    .limit(1);
  const currentSourceSha256 = archive?.sha256;
  if (!currentSourceSha256 || !/^[a-f0-9]{64}$/i.test(currentSourceSha256)) return null;

  const latestLabRun = await readLatestLabRun(input.source, input.sourceId);
  const preferred = latestLabRun?.grantId === input.grantId && latestLabRun.applicationRoundtrip?.runId
    ? await readRoundtripRunArtifacts(input.grantId, latestLabRun.applicationRoundtrip.runId)
    : null;
  const historical = await listRoundtripRunArtifactsForSource({
    grantId: input.grantId,
    source: input.source,
    sourceId: input.sourceId,
  });
  const candidates = uniqueArtifacts(preferred ? [preferred, ...historical] : historical);

  for (const artifacts of candidates) {
    const attachment = artifacts.manifest.attachments.find((item) =>
      item.storageKey === input.surface.sourceAttachment
      || item.filename === input.surface.sourceAttachment);
    if (!attachment || attachment.sourceSha256 !== currentSourceSha256) continue;
    const parentLabRunId = artifacts.run.parentLabRunId;
    if (!parentLabRunId) continue;
    const labRun = latestLabRun?.runId === parentLabRunId
      ? latestLabRun
      : await readLabRun(input.grantId, parentLabRunId);
    if (!labRun || labRun.applicationRoundtrip?.runId !== artifacts.run.runId) continue;

    let plan: ReturnType<typeof buildApplicationPrecomputeMaterializationPlan>[number] | undefined;
    try {
      const surface = {
          id: input.surface.id,
          title: input.surface.title,
          type: input.surface.type,
          format: input.surface.format,
          sourceAttachment: attachment.storageKey,
          sourceSha256: currentSourceSha256,
      };
      if (artifacts.run.version === APPLICATION_ROUNDTRIP_VERSION) {
        [plan] = buildApplicationPrecomputeMaterializationPlan({
          labRun,
          roundtripRun: artifacts.run,
          manifest: artifacts.manifest,
          surfaces: [surface],
        });
      } else if (LOCAL_PREVIEW_COMPATIBLE_ROUNDTRIP_VERSIONS.has(artifacts.run.version)) {
        const document = artifacts.run.documents.find((item) => item.attachmentId === attachment.attachmentId);
        if (!document || document.sourceSha256 !== currentSourceSha256) continue;
        plan = buildApplicationPrecomputeSurfacePlan({
          surface,
          run: artifacts.run,
          analysisVersion: `local-preview:${artifacts.run.version}`,
          sourceSha256: currentSourceSha256,
          document,
        });
        plan = await augmentLegacyLocalPreviewWithCurrentStructure({
          plan,
          document,
          storageKey: attachment.storageKey,
          sourceSha256: currentSourceSha256,
        });
      }
    } catch {
      continue;
    }
    if (!plan || plan.fields.length === 0) continue;

    return {
      connectedFields: plan.fields.map((field) => ({
        fieldId: `local:${artifacts.run.runId}:${input.surface.id}:${field.fieldKey}`,
        fieldKey: field.fieldKey,
        label: field.label,
        section: field.section,
        fieldType: field.fieldType,
        required: field.required,
        sourceSpan: field.sourceSpan,
        mappedCompanyField: field.mappedCompanyField,
        fillStrategy: field.fillStrategy,
        position: field.position ? { ...field.position } : null,
        visualEvidence: field.visualEvidence,
        anchorLabel: typeof field.position?.anchorLabel === "string"
          ? field.position.anchorLabel
          : field.label,
        guidance: typeof field.textEvidence?.helperText === "string"
          ? field.textEvidence.helperText
          : null,
        parserVersion: APPLICATION_FIELD_PARSER_VERSION,
      })),
      state: {
        status: plan.status,
        current: true,
        analysisVersion: plan.analysisVersion,
        sourceSha256: plan.sourceSha256,
        artifactId: `local:${artifacts.run.runId}:${input.surface.id}`,
        fieldCount: plan.fields.length,
        errorCode: plan.errorCode,
      },
    };
  }
  return null;
}

/**
 * v7 immutable 결과는 수정하지 않고 dev 관리자 read model에서만 현재 구조 보강을 겹쳐 읽는다.
 * 새 후보는 모델 없이 원문 SHA가 같은 RHWP 고신호 구조·고정 placeholder 교정만 허용한다.
 */
async function augmentLegacyLocalPreviewWithCurrentStructure(input: {
  plan: ReturnType<typeof buildApplicationPrecomputeMaterializationPlan>[number];
  document: RoundtripRunArtifacts["run"]["documents"][number];
  storageKey: string;
  sourceSha256: string;
}): Promise<ReturnType<typeof buildApplicationPrecomputeMaterializationPlan>[number]> {
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) return input.plan;
  try {
    const { body } = await storage.getObjectBytes(input.storageKey);
    if (createHash("sha256").update(body).digest("hex") !== input.sourceSha256) return input.plan;
    const parsed = await parse(body);
    if (!parsed.success || (parsed.fileType !== "hwp" && parsed.fileType !== "hwpx")) return input.plan;
    const freshFields = [
      ...extractLocatedRoundtripFields(parsed.blocks, input.sourceSha256).fields,
      ...extractContextualRoundtripFields(parsed.blocks, input.sourceSha256),
    ];
    await verifyRoundtripParagraphFieldBindings({ body, fields: freshFields });
    return mergeLegacyLocalPreviewStructure(input.plan, input.document, freshFields);
  } catch {
    return input.plan;
  }
}

export function mergeLegacyLocalPreviewStructure(
  plan: ReturnType<typeof buildApplicationPrecomputeMaterializationPlan>[number],
  document: RoundtripRunArtifacts["run"]["documents"][number],
  freshFields: RoundtripRunArtifacts["run"]["documents"][number]["fields"],
): ReturnType<typeof buildApplicationPrecomputeMaterializationPlan>[number] {
  const upgrades = freshFields.filter((field) =>
    field.recommendedInput
    && (
      field.source === "rhwp-structural"
      || field.location.target?.kind === "paragraph_text"
      || field.inputSignals.includes("입력 셀에 남아 있는 고정 양식 placeholder")
    ));
  if (upgrades.length === 0) return plan;

  const obsoleteAnchorLabels = new Set(upgrades.flatMap((field) => {
    const normalized = normalizeRoundtripLabel(field.originalValue);
    return normalized ? [normalized] : [];
  }));
  const merged = new Map<string, ReconciledField>();
  for (const field of plan.fields) {
    const anchorLabel = typeof field.position?.anchorLabel === "string"
      ? normalizeRoundtripLabel(field.position.anchorLabel)
      : "";
    if (!obsoleteAnchorLabels.has(anchorLabel)) merged.set(field.fieldKey, field);
  }
  const upgradeDocument = {
    ...document,
    fields: upgrades,
    choiceGroups: [],
    recommendedInputFieldCount: upgrades.length,
    recommendedChoiceGroupCount: 0,
  };
  for (const field of buildReconciledApplicationFields(upgradeDocument)) {
    merged.set(field.fieldKey, field);
  }
  return { ...plan, fields: [...merged.values()] };
}

function uniqueArtifacts(items: readonly RoundtripRunArtifacts[]): RoundtripRunArtifacts[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.run.runId)) return false;
    seen.add(item.run.runId);
    return true;
  });
}
