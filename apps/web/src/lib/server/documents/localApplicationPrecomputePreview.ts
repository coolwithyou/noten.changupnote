import type { ConnectedDocumentField } from "./documentFieldLink";
import type { PreviewSurface } from "./documentPreview";
import type { SurfaceApplicationPrecomputeState } from "./applicationPrecomputeState";
import { APPLICATION_FIELD_PARSER_VERSION } from "./applicationFieldVersion";
import { buildApplicationPrecomputeMaterializationPlan } from "./applicationPrecomputeMaterialization";
import { readRoundtripRunArtifacts } from "../analysis-lab/application-roundtrip/store";
import { readLatestLabRun } from "../analysis-lab/run-store";

export interface LocalApplicationPrecomputePreview {
  connectedFields: ConnectedDocumentField[];
  state: SurfaceApplicationPrecomputeState;
}

/**
 * 로컬 구독 분석 결과를 관리자 읽기 전용 시뮬레이션에만 투영한다.
 *
 * DB/R2에 쓰지 않으며 일반 사용자·production 경로에서는 호출되지 않는다. 실제 사용자 빠른 작성은
 * 기존대로 lab 승격 또는 운영 worker가 materialize한 grant_document_fields만 사용한다.
 */
export async function loadLocalApplicationPrecomputePreview(input: {
  grantId: string;
  source: string;
  sourceId: string;
  surface: PreviewSurface;
}): Promise<LocalApplicationPrecomputePreview | null> {
  if (process.env.NODE_ENV === "production") return null;

  const labRun = await readLatestLabRun(input.source, input.sourceId);
  if (
    !labRun
    || labRun.grantId !== input.grantId
    || !labRun.applicationRoundtrip?.runId
  ) return null;

  const artifacts = await readRoundtripRunArtifacts(
    input.grantId,
    labRun.applicationRoundtrip.runId,
  );
  if (!artifacts) return null;

  const attachment = artifacts.manifest.attachments.find((item) =>
    item.storageKey === input.surface.sourceAttachment
    || item.filename === input.surface.sourceAttachment);
  if (!attachment) return null;

  const [plan] = buildApplicationPrecomputeMaterializationPlan({
    labRun,
    roundtripRun: artifacts.run,
    manifest: artifacts.manifest,
    surfaces: [{
      id: input.surface.id,
      title: input.surface.title,
      type: input.surface.type,
      format: input.surface.format,
      sourceAttachment: attachment.storageKey,
      sourceSha256: attachment.sourceSha256,
    }],
  });
  if (!plan) return null;

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
      position: field.position
        ? { page: field.position.page, bbox: field.position.bbox }
        : null,
      visualEvidence: field.visualEvidence,
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
