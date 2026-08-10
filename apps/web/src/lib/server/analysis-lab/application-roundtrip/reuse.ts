import { VERSION } from "kordoc";
import {
  APPLICATION_ROUNDTRIP_VERSION,
  type ApplicationRoundtripRun,
  type RoundtripLlmTransport,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import { declaredRoundtripFormat } from "./core";
import {
  buildRoundtripRunId,
  readRoundtripMarkdownByAttachmentId,
  readRoundtripRunArtifacts,
  saveRoundtripRun,
  type RoundtripRunManifest,
} from "./store";

export type ApplicationRoundtripReuseFailureCode =
  | "artifact_not_found"
  | "contract_mismatch"
  | "source_changed"
  | "artifact_incomplete";

export class ApplicationRoundtripReuseError extends Error {
  constructor(
    readonly code: ApplicationRoundtripReuseFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ApplicationRoundtripReuseError";
  }
}

export interface CurrentRoundtripSource {
  filename: string;
  storageKey: string | null;
  sha256: string | null;
}

export interface PreparedApplicationRoundtripReuse {
  readonly sourceRunId: string;
  materialize(parentLabRunId: string): Promise<ApplicationRoundtripRun>;
}

/**
 * 딥분석 재시도 전에 Kordoc 재사용 계약을 먼저 검증한다.
 * 원본 SHA 세트·Kordoc 버전·엔진·모델·transport가 하나라도 다르거나
 * 미처리/실패 문서가 있으면 모델 실행을 시작하기 전에 fail-closed 한다.
 */
export async function prepareApplicationRoundtripReuse(input: {
  grantId: string;
  sourceRunId: string;
  transport: RoundtripLlmTransport;
  model: string;
  currentSources: CurrentRoundtripSource[];
}): Promise<PreparedApplicationRoundtripReuse> {
  const artifacts = await readRoundtripRunArtifacts(input.grantId, input.sourceRunId);
  if (!artifacts) {
    throw new ApplicationRoundtripReuseError("artifact_not_found", `Kordoc 산출물을 찾지 못했습니다: ${input.sourceRunId}`);
  }
  assertReusableApplicationRoundtrip({
    grantId: input.grantId,
    run: artifacts.run,
    manifest: artifacts.manifest,
    transport: input.transport,
    model: input.model,
    currentSources: input.currentSources,
  });
  const markdownByAttachmentId = await readRoundtripMarkdownByAttachmentId(artifacts);

  return {
    sourceRunId: artifacts.run.runId,
    async materialize(parentLabRunId: string): Promise<ApplicationRoundtripRun> {
      const started = new Date();
      const runId = buildRoundtripRunId(started);
      const run: ApplicationRoundtripRun = {
        ...structuredClone(artifacts.run),
        runId,
        parentLabRunId,
        reusedFromRunId: artifacts.run.runId,
        startedAt: started.toISOString(),
        durationMs: Date.now() - started.getTime(),
        documents: artifacts.run.documents.map((document) => ({
          ...structuredClone(document),
          fieldPlanning: {
            ...structuredClone(document.fieldPlanning),
            parentLabRunId,
          },
        })),
      };
      const manifest: RoundtripRunManifest = {
        ...structuredClone(artifacts.manifest),
        runId,
      };
      await saveRoundtripRun({ run, manifest, markdownByAttachmentId });
      return run;
    },
  };
}

export function assertReusableApplicationRoundtrip(input: {
  grantId: string;
  run: ApplicationRoundtripRun;
  manifest: RoundtripRunManifest;
  transport: RoundtripLlmTransport;
  model: string;
  currentSources: CurrentRoundtripSource[];
}): void {
  const { run, manifest } = input;
  if (
    run.version !== APPLICATION_ROUNDTRIP_VERSION
    || run.engine !== "kordoc"
    || run.engineVersion !== VERSION
    || run.transport !== input.transport
    || run.requestedModel !== input.model
  ) {
    throw new ApplicationRoundtripReuseError(
      "contract_mismatch",
      `Kordoc 재사용 계약이 다릅니다: ${run.version}/${run.engineVersion}/${run.transport}/${run.requestedModel}`,
    );
  }
  if (
    run.error !== null
    || (run.failureCode ?? null) !== null
    || (run.skippedDocumentCount ?? 0) !== 0
    || run.documents.some((document) =>
      document.error !== null
      || (document.fieldPlanning.failureCode ?? null) !== null
      || document.fieldPlanning.status === "heuristic_fallback"
      || (document.fieldPlanning.unprocessedCandidateCount ?? 0) > 0
      || document.fieldPlanning.transport !== input.transport
      || document.fieldPlanning.requestedModel !== input.model)
  ) {
    throw new ApplicationRoundtripReuseError(
      "artifact_incomplete",
      "실패·미처리·heuristic Kordoc 산출물은 딥분석 재시도에 재사용할 수 없습니다.",
    );
  }

  const currentSources = eligibleCurrentSources(input.currentSources);
  if (
    run.grantId !== input.grantId
    || manifest.runId !== run.runId
    || manifest.grantId !== run.grantId
    || manifest.source !== run.source
    || manifest.sourceId !== run.sourceId
    || (run.sourceCount ?? run.documents.length) !== currentSources.length
    || manifest.attachments.length !== currentSources.length
    || run.documents.length !== manifest.attachments.length
  ) {
    throw new ApplicationRoundtripReuseError(
      "source_changed",
      "현재 HWP/HWPX 원본 세트와 Kordoc 산출물의 문서 수가 다릅니다.",
    );
  }

  const currentByStorageKey = new Map(currentSources.map((source) => [source.storageKey, source]));
  const documentByAttachmentId = new Map(run.documents.map((document) => [document.attachmentId, document]));
  for (const attachment of manifest.attachments) {
    const current = currentByStorageKey.get(attachment.storageKey);
    const document = documentByAttachmentId.get(attachment.attachmentId);
    if (
      !current
      || current.filename !== attachment.filename
      || current.sha256 !== attachment.sourceSha256.toLowerCase()
      || document?.filename !== attachment.filename
      || document.sourceSha256?.toLowerCase() !== attachment.sourceSha256.toLowerCase()
    ) {
      throw new ApplicationRoundtripReuseError(
        "source_changed",
        `현재 원본 SHA·파일명이 Kordoc 산출물과 다릅니다: ${attachment.filename}`,
      );
    }
  }
}

function eligibleCurrentSources(sources: CurrentRoundtripSource[]): Array<{
  filename: string;
  storageKey: string;
  sha256: string;
}> {
  const seen = new Set<string>();
  return sources.flatMap((source) => {
    if (!declaredRoundtripFormat(source.filename) || !source.storageKey || !source.sha256) return [];
    const sha256 = source.sha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256) || seen.has(source.storageKey)) return [];
    seen.add(source.storageKey);
    return [{ filename: source.filename, storageKey: source.storageKey, sha256 }];
  });
}
