// 공모 딥분석 실험실 — 오케스트레이션 (dev 전용).
// grantId → 공고+원본 payload+첨부 로드(read-only) → 입력 조립 → Opus 딥분석 → 서버 검증 →
// A/B diff 계산 → LabRun 조립 → spike-out 에 불변 저장 → 반환.
// 실패해도 error 를 담은 LabRun 을 저장·반환한다(입력 메타 보존). DB에는 어떤 쓰기도 하지 않는다.
import { and, eq } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabCurrentCriterion,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import { computeLabDimensionDiffs } from "./diff";
import { resolveLabModel, runDeepGrantAnalysis, type DeepAnalysisResult } from "./extractor";
import { assembleLabInput, type LabInputArchive } from "./input";
import { buildLabRunId, saveLabRun } from "./run-store";

/** 공고 자체가 없을 때 — 라우트는 404 로 매핑한다(런 저장 없음). */
export class LabGrantNotFoundError extends Error {
  constructor(grantId: string) {
    super(`공고를 찾지 못했습니다: ${grantId}`);
    this.name = "LabGrantNotFoundError";
  }
}

export async function runLabAnalysis(grantId: string): Promise<LabRun> {
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
      markdownStorageKey: schema.grantAttachmentArchives.markdownStorageKey,
      markdownBytes: schema.grantAttachmentArchives.markdownBytes,
    })
    .from(schema.grantAttachmentArchives)
    .where(
      and(
        eq(schema.grantAttachmentArchives.source, grant.source),
        eq(schema.grantAttachmentArchives.sourceId, grant.sourceId),
      ),
    );
  const archives: LabInputArchive[] = archiveRows.map((row) => ({
    filename: row.filename,
    markdownStorageKey: row.markdownStorageKey ?? null,
    markdownBytes: row.markdownBytes ?? null,
  }));

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
  let extraction: DeepAnalysisResult | null = null;
  let error: string | null = null;
  try {
    const apiKey = await resolveAnthropicApiKey();
    extraction = await runDeepGrantAnalysis({ apiKey, inputText: input.text });
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 2_000) : String(caught).slice(0, 2_000);
  }

  const run: LabRun = {
    runId,
    grantId: grant.id,
    source: grant.source,
    sourceId: grant.sourceId,
    title: grant.title,
    model: extraction?.model ?? resolveLabModel(),
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
    error,
  };
  await saveLabRun(run);
  return run;
}

/**
 * ANTHROPIC_API_KEY 해석. Next dev 런타임은 apps/web/.env.local 만 자동 로드하므로
 * 루트 .env 의 키가 안 보일 수 있다 → loadMonorepoEnv 로 보강 후에도 없으면 명확히 실패.
 * (키 값은 절대 로그·응답에 출력하지 않는다.)
 */
async function resolveAnthropicApiKey(): Promise<string> {
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
  return apiKey;
}
