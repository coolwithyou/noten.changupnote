// 공모 딥분석 실험실 — 오케스트레이션 (dev 전용).
// grantId → 공고+원본 payload+첨부 로드(read-only) → 입력 조립 → Opus 딥분석 → 서버 검증 →
// A/B diff 계산 → LabRun 조립 → spike-out 에 불변 저장 → 반환.
// 전송층은 ANALYSIS_LAB_TRANSPORT 로 분기(api 기본 | claude-cli — Max 구독, claude-cli-transport.ts)하고
// 어느 쪽이었는지 LabRun.transport 로 항상 기록한다(계획 §5 #1 provenance). 배치 러너
// (batch-runner.ts)·웹 잡처럼 env 대신 명시 지정이 필요한 호출부는 opts 오버라이드
// (transport/model)를 쓴다 — 미지정 시 기존 env 경로와 100% 동일하다.
// 실패해도 error 를 담은 LabRun 을 저장·반환한다(입력 메타 보존). DB에는 어떤 쓰기도 하지 않는다.
import { and, eq } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabCurrentCriterion,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import {
  buildClaudeCliFetch,
  resolveLabLlmBinding,
  resolveLabTransport,
  type LabLlmBinding,
} from "./claude-cli-transport";
import {
  buildApplicationRoundtripReference,
  runAnalysisPair,
} from "./application-precompute";
import { assertApplicationRoundtripOptIn } from "./application-roundtrip-policy";
import { assertAnalysisLabLiveExecutionAdmitted } from "./analysis-execution-admission";
import { prepareApplicationRoundtripReuse } from "./application-roundtrip/reuse";
import { computeLabDimensionDiffs } from "./diff";
import { resolveLabModel, type DeepAnalysisResult } from "./extractor";
import {
  applyLabVerifiedConversionArtifacts,
  assembleLabInput,
  type LabInputArchive,
} from "./input";
import { buildLabRunId, saveLabRun } from "./run-store";
import {
  runValidatedLabPrimary,
  ValidatedLabPrimaryError,
} from "./validated-primary";

/** 공고 자체가 없을 때 — 라우트는 404 로 매핑한다(런 저장 없음). */
export class LabGrantNotFoundError extends Error {
  constructor(grantId: string) {
    super(`공고를 찾지 못했습니다: ${grantId}`);
    this.name = "LabGrantNotFoundError";
  }
}

/** env 대신 명시 지정하는 호출부(배치 러너·웹 잡)용 오버라이드 — 미지정 필드는 기존 env 경로. */
export interface LabAnalysisOverrides {
  /** env(ANALYSIS_LAB_TRANSPORT)보다 우선하는 전송층 지정. */
  transport?: "api" | "claude-cli";
  /** env(ANALYSIS_LAB_MODEL)보다 우선하는 모델 지정(풀 id — 별칭 금지, 가격표·파일 키 결속). */
  model?: string;
  /** 같은 grantId의 Kordoc 빠른 작성 선분석을 형제 작업으로 시작한다. */
  withApplicationRoundtrip?: boolean;
  /** 딥분석만 재시도할 때 현재 원본·계약을 검증한 뒤 재결속할 기존 Kordoc runId. */
  reuseApplicationRoundtripRunId?: string;
  /** 미지정 시 ANALYSIS_LAB_ROUNDTRIP_MODEL 또는 딥 분석 모델을 상속한다. */
  roundtripModel?: string;
  /** 완료된 독립 검수의 검증된 blocker만 재분석 지시로 전달한다. */
  taskInstruction?: string;
  /** taskInstruction의 원천을 런에 결속하는 provenance. */
  reviewRepair?: NonNullable<LabRun["reviewRepair"]>;
}

/**
 * transport 오버라이드용 binding 구성 — claude-cli-transport.ts 의 resolveLabLlmBinding 과
 * 분기별 동일 동작이되, env 재해석(resolveLabTransport) 대신 지정 transport 로 분기한다.
 * 원본 모듈은 env 단일 경로만 제공한다 — 동작을 바꿀 때는 양쪽을 함께 재고할 것.
 */
async function resolveLabLlmBindingForTransport(
  transport: "api" | "claude-cli",
  schedulerKey: string,
): Promise<LabLlmBinding> {
  if (transport === "claude-cli") {
    return { transport, apiKey: "subscription", fetchImpl: buildClaudeCliFetch({ schedulerKey }) };
  }
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    const { loadMonorepoEnv } = await import("../loadMonorepoEnv");
    loadMonorepoEnv();
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY 가 설정되어 있지 않습니다. 모노레포 루트 .env(.env.local)에 키를 넣고 dev 서버를 재시작해주세요.",
    );
  }
  return { transport, apiKey, fetchImpl: undefined };
}

export async function runLabAnalysis(
  grantId: string,
  opts?: LabAnalysisOverrides,
): Promise<LabRun> {
  assertApplicationRoundtripOptIn(opts ?? {});
  assertAnalysisLabLiveExecutionAdmitted();
  const db = getCunoteDb();
  const startedAt = new Date();
  const runId = buildLabRunId(startedAt);

  // ── 공고 로드(없으면 런을 만들지 않고 즉시 실패 → 404) ──────────
  const grantRows = await db
    .select({
      id: schema.grants.id,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      title: schema.grants.title,
      agencyOperator: schema.grants.agencyOperator,
      agencyJurisdiction: schema.grants.agencyJurisdiction,
      applyStart: schema.grants.applyStart,
      applyEnd: schema.grants.applyEnd,
      applyMethod: schema.grants.applyMethod,
      supportAmount: schema.grants.supportAmount,
      benefits: schema.grants.benefits,
    })
    .from(schema.grants)
    .where(eq(schema.grants.id, grantId))
    .limit(1);
  const grant = grantRows[0];
  if (!grant) throw new LabGrantNotFoundError(grantId);

  // ── 원본 payload + 첨부 로드(read-only) ─────────────────────────
  const rawRows = await db
    .select({ payload: schema.grantRaw.payload })
    .from(schema.grantRaw)
    .where(and(eq(schema.grantRaw.source, grant.source), eq(schema.grantRaw.sourceId, grant.sourceId)))
    .limit(1);
  const archiveRows = await db
    .select({
      filename: schema.grantAttachmentArchives.filename,
      storageKey: schema.grantAttachmentArchives.storageKey,
      sha256: schema.grantAttachmentArchives.sha256,
      markdownStorageKey: schema.grantAttachmentArchives.markdownStorageKey,
      markdownSha256: schema.grantAttachmentArchives.markdownSha256,
      markdownBytes: schema.grantAttachmentArchives.markdownBytes,
    })
    .from(schema.grantAttachmentArchives)
    .where(
      and(
        eq(schema.grantAttachmentArchives.source, grant.source),
        eq(schema.grantAttachmentArchives.sourceId, grant.sourceId),
      ),
    );
  const convertedArtifactRows = await db
    .select({
      sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
      title: schema.grantApplicationSurfaces.title,
      storageKey: schema.documentArtifacts.storageKey,
      sha256: schema.documentArtifacts.sha256,
      metadata: schema.documentArtifacts.metadata,
    })
    .from(schema.grantApplicationSurfaces)
    .innerJoin(
      schema.documentArtifacts,
      eq(schema.documentArtifacts.surfaceId, schema.grantApplicationSurfaces.id),
    )
    .where(and(
      eq(schema.grantApplicationSurfaces.grantId, grant.id),
      eq(schema.documentArtifacts.kind, "markdown"),
    ));
  const archives: LabInputArchive[] = applyLabVerifiedConversionArtifacts(archiveRows.map((row) => ({
    filename: row.filename,
    storageKey: row.storageKey ?? null,
    markdownStorageKey: row.markdownStorageKey ?? null,
    markdownSha256: row.markdownSha256 ?? null,
    markdownBytes: row.markdownBytes ?? null,
  })), convertedArtifactRows.map((row) => ({
    sourceAttachment: row.sourceAttachment,
    title: row.title,
    storageKey: row.storageKey,
    sha256: row.sha256,
    markdownChars: numericMetadataValue(row.metadata, "charCount"),
  })));

  // ── 입력 조립(구조화 필드 + 첨부 markdown 전문, 캡·sha256 포함) ──
  const input = await assembleLabInput({
    grant: {
      source: grant.source,
      sourceId: grant.sourceId,
      title: grant.title,
      agencyOperator: grant.agencyOperator ?? null,
      agencyJurisdiction: grant.agencyJurisdiction ?? null,
      applyStart: grant.applyStart ?? null,
      applyEnd: grant.applyEnd ?? null,
      applyMethod: grant.applyMethod ?? null,
      supportAmount: grant.supportAmount ?? null,
      benefits: grant.benefits ?? null,
    },
    payload: rawRows[0]?.payload ?? null,
    archives,
  });

  // ── 현재 DB criteria 스냅샷(A) ──────────────────────────────────
  const criteriaRows = await db
    .select({
      dimension: schema.grantCriteria.dimension,
      kind: schema.grantCriteria.kind,
      operator: schema.grantCriteria.operator,
      value: schema.grantCriteria.value,
      confidence: schema.grantCriteria.confidence,
      needsReview: schema.grantCriteria.needsReview,
      sourceSpan: schema.grantCriteria.sourceSpan,
    })
    .from(schema.grantCriteria)
    .where(eq(schema.grantCriteria.grantId, grantId));
  const currentCriteria: LabCurrentCriterion[] = criteriaRows.map((row) => ({
    dimension: row.dimension,
    kind: row.kind,
    operator: row.operator,
    value: row.value,
    confidence: row.confidence ?? null,
    needsReview: row.needsReview ?? null,
    sourceSpan: row.sourceSpan ?? null,
  }));

  // ── 딥분석 호출(실패해도 error 런으로 보존) ─────────────────────
  // transport 해석(순수 env 파싱 또는 명시 오버라이드)은 try 밖 — 성공/실패(error) 런 모두
  // 같은 값을 기록해야 provenance 가 오염되지 않는다(계획 §5 #1). binding 구체화(api 키
  // 부재 throw 가능)는 기존처럼 try 안 — "실패해도 error 런 저장" 계약(상단 주석)을 보존한다.
  const transport = opts?.transport ?? resolveLabTransport();
  const requestedModel = opts?.model ?? resolveLabModel();
  const roundtripModel = opts?.roundtripModel
    ?? (process.env.ANALYSIS_LAB_ROUNDTRIP_MODEL?.trim() || requestedModel);
  // 딥분석 모델을 시작하기 전에 원본 SHA·Kordoc 버전·모델·transport를 검증한다.
  // fail-closed 하면 잘못된 재사용 때문에 비싼 primary를 돌린 뒤 발견하는 일이 없다.
  const preparedRoundtripReuse = opts?.reuseApplicationRoundtripRunId
    ? await prepareApplicationRoundtripReuse({
        grantId,
        sourceRunId: opts.reuseApplicationRoundtripRunId,
        transport,
        model: roundtripModel,
        currentSources: archiveRows.map((archive) => ({
          filename: archive.filename,
          storageKey: archive.storageKey ?? null,
          sha256: archive.sha256 ?? null,
        })),
      })
    : null;
  // 같은 binding Promise를 두 형제 작업이 공유한다. API 키 부재/CLI 준비 실패도 primary는
  // error LabRun, sidecar는 failed reference로 각각 종결돼 한쪽이 다른 쪽을 덮지 않는다.
  const bindingPromise = opts?.transport === undefined
    ? resolveLabLlmBinding({ schedulerKey: runId })
    : resolveLabLlmBindingForTransport(opts.transport, runId);
  const runPrimary = async (): Promise<{
    extraction: DeepAnalysisResult | null;
    error: string | null;
    repairCount: number;
    outcome?: NonNullable<LabRun["primaryValidationOutcome"]>;
    /** 패스별 validator 계측(2026-08-11 T4) — validator 최종 실패에도 보존한다. */
    passes?: NonNullable<LabRun["primaryPasses"]>;
  }> => {
    try {
      const binding = await bindingPromise;
      const validated = await runValidatedLabPrimary({
        grantId,
        apiKey: binding.apiKey,
        inputText: input.text,
        inputSha256: input.inputSha256,
        model: requestedModel,
        ...(opts?.taskInstruction ? { taskInstruction: opts.taskInstruction } : {}),
        ...(binding.fetchImpl ? { fetchImpl: binding.fetchImpl } : {}),
      });
      return {
        extraction: validated.extraction,
        // held는 validator가 의도한 품질 terminal이지 실행 오류가 아니다.
        // 구 artifact의 primary_validation_held sentinel은 reader classifier에서만 호환한다.
        error: null,
        repairCount: validated.repairCount,
        outcome: validated.outcome,
        passes: validated.passes,
      };
    } catch (caught) {
      if (caught instanceof ValidatedLabPrimaryError) {
        return {
          extraction: caught.extraction,
          repairCount: caught.repairCount,
          passes: caught.passes,
          error: caught.message.slice(0, 2_000),
        };
      }
      return {
        extraction: null,
        repairCount: 0,
        error: caught instanceof Error
          ? caught.message.slice(0, 2_000)
          : String(caught).slice(0, 2_000),
      };
    }
  };

  let primary: Awaited<ReturnType<typeof runPrimary>>;
  let applicationRoundtrip: LabRun["applicationRoundtrip"];
  if (opts?.withApplicationRoundtrip === true) {
    const paired = await runAnalysisPair({
      primary: runPrimary,
      application: async () => {
        if (preparedRoundtripReuse) return preparedRoundtripReuse.materialize(runId);
        const [binding, roundtripModule] = await Promise.all([
          bindingPromise,
          import("./application-roundtrip/analyze"),
        ]);
        return roundtripModule.runApplicationRoundtripAnalysis(grantId, {
          apiKey: binding.apiKey,
          model: roundtripModel,
          timeoutMs: resolveRoundtripTimeoutMs(),
          transport,
          // 전역 CLI 4슬롯을 한 공고의 Kordoc이 모두 점유하지 않게 2-way로 제한한다.
          // primary/repair와 겹치면 3슬롯, 단건 Kordoc만 남으면 다른 공고와 합쳐 4슬롯을 쓴다.
          candidateConcurrency: 2,
          parentLabRunId: runId,
          ...(binding.fetchImpl ? { fetchImpl: binding.fetchImpl } : {}),
        });
      },
    });
    primary = paired.primary;
    if (paired.application) {
      applicationRoundtrip = buildApplicationRoundtripReference({
        result: paired.application,
        transport,
        model: roundtripModel,
      });
    }
  } else {
    primary = await runPrimary();
  }
  const { extraction, error } = primary;

  const run: LabRun = {
    runId,
    grantId: grant.id,
    source: grant.source,
    sourceId: grant.sourceId,
    title: grant.title,
    // 실패(error) 런에도 오버라이드 모델을 기록한다 — extraction 이 없으면 env 폴백 전에
    // 오버라이드가 우선해야 provenance 가 실제 요청 모델과 일치한다.
    model: extraction?.model ?? requestedModel,
    transport,
    promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    inputBlocks: input.blocks,
    inputTotalChars: input.totalChars,
    inputSha256: input.inputSha256,
    usage: extraction?.usage ?? null,
    costUsd: extraction?.costUsd ?? null,
    analysisMarkdown: extraction?.analysisMarkdown ?? "",
    programIntent: extraction?.programIntent ?? null,
    criteria: extraction?.criteria ?? [],
    axisAssessments: extraction?.axisAssessments ?? [],
    taxonomyProposals: extraction?.taxonomyProposals ?? [],
    dimensionDiffs: computeLabDimensionDiffs({
      current: currentCriteria,
      proposed: extraction?.criteria ?? [],
      assessments: extraction?.axisAssessments ?? [],
    }),
    primaryRepairCount: primary.repairCount,
    ...(primary.outcome ? { primaryValidationOutcome: primary.outcome } : {}),
    ...(primary.passes ? { primaryPasses: primary.passes } : {}),
    ...(opts?.reviewRepair ? { reviewRepair: opts.reviewRepair } : {}),
    ...(applicationRoundtrip !== undefined ? { applicationRoundtrip } : {}),
    error,
  };
  await saveLabRun(run);
  return run;
}

function numericMetadataValue(
  metadata: Record<string, unknown>,
  key: string,
): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveRoundtripTimeoutMs(): number {
  const raw = process.env.ANALYSIS_LAB_ROUNDTRIP_TIMEOUT_MS?.trim()
    || process.env.ANALYSIS_LAB_TIMEOUT_MS?.trim();
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 540_000;
}
