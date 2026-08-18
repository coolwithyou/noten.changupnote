// 로컬 분석 실험실 — 신규 분석 대상 자동 선정.
//
// 책임 경계:
//   1) 서버가 모집 중·사용자 노출 가능·미분석·원문/Kordoc 준비 완료 후보만 확정한다.
//   2) Claude 구독 모델은 그 안전한 후보 안에서 대표성과 배치 적합성만 판단한다.
//   3) 선정 결과는 기존 분석 대상 목록에 추가하고 불변 근거 파일로 남긴다.
//
// 이 모듈은 분석 자체를 시작하지 않는다. 대상 선정과 고비용 분석 실행을 분리해야
// 잘못된 선정이 모델 호출·Kordoc 실행으로 곧바로 번지지 않는다.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type {
  LabAutomaticTargetSelectionItem,
  LabAutomaticTargetSelectionResult,
  LabUsage,
} from "@/lib/server/analysis-lab/lab-contract";
import { kstDayStartUtc } from "@/lib/server/analysis-lab/notice-period";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { grantServingVisiblePredicate } from "@/lib/server/grantServingVisibility";
import { callAnthropicToolModel, type AnthropicToolSchema } from "./ai-review";
import { scanExistingRuns } from "./batch-runner";
import {
  readCohortFileV2,
  writeCohortFileV2,
  type CohortEntry,
  type CohortFileV2,
} from "./cohort-file";
import { resolveLabModel } from "./extractor";
import { BODY_MARKDOWN_MIN_BYTES } from "./input";
import { analysisLabDir } from "./run-store";
import {
  LAB_SOURCES,
  UNIFIED_NOTICE_PATTERN,
  stratumIdOf,
  thicknessTierOf,
} from "./strata";
import {
  classifyRoundtripDocument,
  declaredRoundtripFormat,
  likelyApplicationRole,
} from "./application-roundtrip/core";

export const AUTOMATIC_TARGET_SELECTION_VERSION = "analysis-target-selection-v1";
export const AUTOMATIC_TARGET_SELECTION_MAX_COUNT = 30;
const SHORTLIST_MULTIPLIER = 3;
const SHORTLIST_MIN = 60;
const SHORTLIST_MAX = 120;
const EXPERIMENT_LABEL = "opening-readiness";

export class AutomaticTargetSelectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomaticTargetSelectionConflictError";
  }
}

export interface AutomaticTargetCandidate {
  grantId: string;
  source: string;
  title: string;
  agency: string | null;
  category: string | null;
  applyEnd: string;
  updatedAt: string;
  stratum: string;
  maxMarkdownBytes: number;
  hwpAttachmentCount: number;
  likelyApplicationDocumentCount: number;
  attachmentNames: string[];
}

interface ModelSelectionItem {
  grantId: string;
  reason: string;
}

interface SelectionDependencies {
  loadCandidates: (now: Date) => Promise<AutomaticTargetCandidate[]>;
  readTargets: () => Promise<CohortFileV2 | null>;
  scanAnalyzedGrantIds: () => Promise<Set<string>>;
  callModel: (input: {
    model: string;
    apiKey: string;
    fetchImpl: typeof fetch;
    count: number;
    candidates: AutomaticTargetCandidate[];
  }) => Promise<{ selected: ModelSelectionItem[]; usage: LabUsage | null }>;
  writeTargets: (file: CohortFileV2) => Promise<void>;
  writeEvidence: (result: LabAutomaticTargetSelectionResult) => Promise<void>;
  now: () => Date;
}

export async function selectAutomaticAnalysisTargets(
  options: {
    count: number;
    transport: "claude-cli";
    apiKey: string;
    fetchImpl: typeof fetch;
    model?: string | undefined;
    /** 반복형 에이전트는 신규 후보가 count보다 적으면 남은 수만 선정한다. */
    allowFewer?: boolean;
  },
  dependencyOverrides: Partial<SelectionDependencies> = {},
): Promise<LabAutomaticTargetSelectionResult> {
  const count = normalizeSelectionCount(options.count);
  if (options.transport !== "claude-cli") {
    throw new Error("자동 선정은 로컬 Claude 구독 transport에서만 실행할 수 있습니다.");
  }
  const deps = selectionDependencies(dependencyOverrides);
  const now = deps.now();
  const current = await deps.readTargets();
  const existingEntries = current?.entries ?? [];
  const existingIds = new Set(existingEntries.map((entry) => entry.grantId));
  const analyzedIds = await deps.scanAnalyzedGrantIds();
  const allCandidates = await deps.loadCandidates(now);
  const eligibleCandidateIds = new Set(allCandidates.map((candidate) => candidate.grantId));
  const pendingExistingCount = existingEntries.filter(
    (entry) => !analyzedIds.has(entry.grantId) && eligibleCandidateIds.has(entry.grantId),
  ).length;
  if (pendingExistingCount > 0) {
    throw new AutomaticTargetSelectionConflictError(
      `현재 분석 대기 ${pendingExistingCount}건을 먼저 처리한 뒤 새 대상을 선정해 주세요.`,
    );
  }
  const candidates = allCandidates.filter(
    (candidate) => !existingIds.has(candidate.grantId) && !analyzedIds.has(candidate.grantId),
  );
  if (candidates.length === 0 || (!options.allowFewer && candidates.length < count)) {
    throw new Error(
      `신규 미분석·첨부 준비 완료 후보가 ${candidates.length}건뿐이라 ${count}건을 선정할 수 없습니다.`,
    );
  }
  const selectionCount = options.allowFewer ? Math.min(count, candidates.length) : count;

  const shortlist = buildBalancedShortlist(candidates, selectionCount);
  if (shortlist.length < selectionCount) {
    throw new Error(`Claude에 전달할 안전 후보가 ${shortlist.length}건뿐입니다.`);
  }
  const model = options.model?.trim()
    || process.env.ANALYSIS_LAB_SELECTION_MODEL?.trim()
    || resolveLabModel();
  const modelResult = await deps.callModel({
    model,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    count: selectionCount,
    candidates: shortlist,
  });
  const validated = validateAutomaticTargetSelection(
    modelResult.selected,
    shortlist,
    selectionCount,
  );

  const selectedAt = now.toISOString();
  const selectionId = `target-selection-${selectedAt.replace(/[-:.]/g, "").replace("Z", "Z")}`;
  const candidateSha256 = createHash("sha256")
    .update(JSON.stringify(shortlist.map((candidate) => candidate.grantId)))
    .digest("hex");
  const selectedEntries: CohortEntry[] = validated.map(({ candidate }) => ({
    grantId: candidate.grantId,
    stratum: candidate.stratum,
  }));
  const nextTargets: CohortFileV2 = {
    version: 2,
    selectedAt,
    seed: current?.seed ?? null,
    experimentLabel: EXPERIMENT_LABEL,
    entries: [...existingEntries, ...selectedEntries],
  };
  const evidencePath = targetSelectionEvidencePath(selectionId);
  const selectedItems: LabAutomaticTargetSelectionItem[] = validated.map(({ candidate, reason }) => ({
    grantId: candidate.grantId,
    title: candidate.title,
    source: candidate.source,
    reason,
    stratum: candidate.stratum,
  }));
  const result: LabAutomaticTargetSelectionResult = {
    version: AUTOMATIC_TARGET_SELECTION_VERSION,
    selectionId,
    selectedAt,
    transport: "claude-cli",
    model,
    requestedCount: count,
    eligibleCandidateCount: candidates.length,
    shortlistCount: shortlist.length,
    previousTargetCount: existingEntries.length,
    targetCount: nextTargets.entries.length,
    candidateSha256,
    usage: modelResult.usage,
    evidencePath,
    selected: selectedItems,
  };

  // 모델 출력 검증을 모두 통과한 뒤에만 canonical 목록을 교체한다. 선정 근거는 그 직후
  // 불변 파일로 저장하며, 목록 자체가 최종 실행 입력의 정본이다.
  await deps.writeTargets(nextTargets);
  await deps.writeEvidence(result);
  return result;
}

function normalizeSelectionCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > AUTOMATIC_TARGET_SELECTION_MAX_COUNT) {
    throw new Error(`count는 1~${AUTOMATIC_TARGET_SELECTION_MAX_COUNT} 정수여야 합니다.`);
  }
  return value;
}

function selectionDependencies(overrides: Partial<SelectionDependencies>): SelectionDependencies {
  return {
    loadCandidates: overrides.loadCandidates ?? loadAutomaticTargetCandidates,
    readTargets: overrides.readTargets ?? readCohortFileV2,
    scanAnalyzedGrantIds: overrides.scanAnalyzedGrantIds ?? (async () =>
      new Set((await scanExistingRuns()).states.keys())),
    callModel: overrides.callModel ?? callSelectionModel,
    writeTargets: overrides.writeTargets ?? writeCohortFileV2,
    writeEvidence: overrides.writeEvidence ?? writeTargetSelectionEvidence,
    now: overrides.now ?? (() => new Date()),
  };
}

export function buildBalancedShortlist(
  candidates: AutomaticTargetCandidate[],
  requestedCount: number,
): AutomaticTargetCandidate[] {
  const limit = Math.min(
    SHORTLIST_MAX,
    Math.max(requestedCount, SHORTLIST_MIN, requestedCount * SHORTLIST_MULTIPLIER),
  );
  const groups = new Map<string, AutomaticTargetCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.stratum) ?? [];
    group.push(candidate);
    groups.set(candidate.stratum, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) =>
      b.likelyApplicationDocumentCount - a.likelyApplicationDocumentCount
      || b.updatedAt.localeCompare(a.updatedAt)
      || b.maxMarkdownBytes - a.maxMarkdownBytes
      || a.grantId.localeCompare(b.grantId));
  }
  const preferredGroupOrder = [
    "kstartup/thick",
    "bizinfo/thick",
    "kstartup/medium",
    "bizinfo/medium",
    "kstartup/thin",
    "bizinfo/thin",
  ];
  const otherGroups = [...groups.keys()]
    .filter((key) => !preferredGroupOrder.includes(key))
    .sort();
  const order = [...preferredGroupOrder, ...otherGroups];
  const selected: AutomaticTargetCandidate[] = [];
  while (selected.length < limit) {
    let progressed = false;
    for (const key of order) {
      const candidate = groups.get(key)?.shift();
      if (!candidate) continue;
      selected.push(candidate);
      progressed = true;
      if (selected.length >= limit) break;
    }
    if (!progressed) break;
  }
  return selected;
}

export function validateAutomaticTargetSelection(
  selected: ModelSelectionItem[],
  candidates: AutomaticTargetCandidate[],
  expectedCount: number,
): Array<{ candidate: AutomaticTargetCandidate; reason: string }> {
  if (selected.length !== expectedCount) {
    throw new Error(`Claude 선정 결과가 ${selected.length}건입니다. 정확히 ${expectedCount}건이어야 합니다.`);
  }
  const byId = new Map(candidates.map((candidate) => [candidate.grantId, candidate]));
  const seen = new Set<string>();
  return selected.map((item, index) => {
    const candidate = byId.get(item.grantId);
    if (!candidate) throw new Error(`Claude가 후보 밖 공고를 선택했습니다: ${item.grantId}`);
    if (seen.has(item.grantId)) throw new Error(`Claude 선정 결과에 중복이 있습니다: ${item.grantId}`);
    const reason = item.reason.trim();
    if (reason.length < 4) throw new Error(`선정 ${index + 1}번의 근거가 너무 짧습니다.`);
    seen.add(item.grantId);
    return { candidate, reason };
  });
}

export async function loadAutomaticTargetCandidates(now: Date): Promise<AutomaticTargetCandidate[]> {
  const dayStart = kstDayStartUtc(now);
  const nextDayStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const db = getCunoteDb();
  const rows = await db
    .select({
      grantId: schema.grants.id,
      source: schema.grants.source,
      title: schema.grants.title,
      agencyOperator: schema.grants.agencyOperator,
      agencyJurisdiction: schema.grants.agencyJurisdiction,
      categoryL1: schema.grants.categoryL1,
      categoryL2: schema.grants.categoryL2,
      applyEnd: schema.grants.applyEnd,
      updatedAt: schema.grants.updatedAt,
      filename: schema.grantAttachmentArchives.filename,
      storageKey: schema.grantAttachmentArchives.storageKey,
      bytes: schema.grantAttachmentArchives.bytes,
      markdownStorageKey: schema.grantAttachmentArchives.markdownStorageKey,
      markdownBytes: schema.grantAttachmentArchives.markdownBytes,
    })
    .from(schema.grants)
    .innerJoin(
      schema.grantAttachmentArchives,
      and(
        eq(schema.grants.source, schema.grantAttachmentArchives.source),
        eq(schema.grants.sourceId, schema.grantAttachmentArchives.sourceId),
      ),
    )
    .where(
      and(
        grantServingVisiblePredicate(),
        eq(schema.grants.status, "open"),
        inArray(schema.grants.source, [...LAB_SOURCES]),
        gte(schema.grants.applyEnd, dayStart),
        or(isNull(schema.grants.applyStart), lt(schema.grants.applyStart, nextDayStart)),
        isNotNull(schema.grantAttachmentArchives.storageKey),
      ),
    )
    .orderBy(desc(schema.grants.updatedAt));

  type Accumulator = Omit<AutomaticTargetCandidate,
    "stratum" | "maxMarkdownBytes" | "hwpAttachmentCount" | "likelyApplicationDocumentCount" | "attachmentNames"
  > & {
    maxMarkdownBytes: number;
    hwpAttachmentCount: number;
    likelyApplicationDocumentCount: number;
    attachmentNames: string[];
  };
  const byGrant = new Map<string, Accumulator>();
  for (const row of rows) {
    if (!row.applyEnd || UNIFIED_NOTICE_PATTERN.test(row.title)) continue;
    const format = declaredRoundtripFormat(row.filename);
    const current = byGrant.get(row.grantId) ?? {
      grantId: row.grantId,
      source: row.source,
      title: row.title,
      agency: row.agencyOperator ?? row.agencyJurisdiction ?? null,
      category: [row.categoryL1, row.categoryL2].filter(Boolean).join(" / ") || null,
      applyEnd: row.applyEnd.toISOString(),
      updatedAt: row.updatedAt?.toISOString() ?? "",
      maxMarkdownBytes: 0,
      hwpAttachmentCount: 0,
      likelyApplicationDocumentCount: 0,
      attachmentNames: [],
    };
    current.maxMarkdownBytes = Math.max(
      current.maxMarkdownBytes,
      row.markdownStorageKey ? Number(row.markdownBytes ?? 0) : 0,
    );
    if (format && row.storageKey) {
      current.hwpAttachmentCount += 1;
      const classification = classifyRoundtripDocument({
        filename: row.filename,
        markdown: "",
        fields: [],
        formConfidence: 0,
      });
      if (likelyApplicationRole(classification.role)) current.likelyApplicationDocumentCount += 1;
      if (!current.attachmentNames.includes(row.filename)) current.attachmentNames.push(row.filename);
    }
    byGrant.set(row.grantId, current);
  }

  return [...byGrant.values()]
    .filter((candidate) =>
      candidate.hwpAttachmentCount > 0
      && candidate.maxMarkdownBytes >= BODY_MARKDOWN_MIN_BYTES)
    .map((candidate) => ({
      ...candidate,
      stratum: stratumIdOf(candidate.source, thicknessTierOf(candidate.maxMarkdownBytes)),
      attachmentNames: candidate.attachmentNames.slice(0, 8),
    }));
}

async function callSelectionModel(input: {
  model: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  count: number;
  candidates: AutomaticTargetCandidate[];
}): Promise<{ selected: ModelSelectionItem[]; usage: LabUsage | null }> {
  const toolSchema: AnthropicToolSchema = {
    name: "select_analysis_targets",
    description: "운영 준비용 신규 분석 대상 공고를 정확한 개수로 선정합니다.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["selected"],
      properties: {
        selected: {
          type: "array",
          minItems: input.count,
          maxItems: input.count,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["grantId", "reason"],
            properties: {
              grantId: { type: "string" },
              reason: { type: "string", minLength: 4, maxLength: 240 },
            },
          },
        },
      },
    },
  };
  const system = [
    "당신은 정부지원사업 공고 분석 파이프라인의 운영 준비 표본을 고르는 선임 검수자입니다.",
    `제공된 안전 후보에서 정확히 ${input.count}건만 선택하세요. 후보 밖 ID를 만들면 안 됩니다.`,
    "선정 목적은 22축 딥분석과 HWP/HWPX 빠른 작성 분석의 전체 사이클을 검증하는 것입니다.",
    "실제 모집 공고, 지원대상·신청요건을 판정할 본문, 신청서나 사업계획서 가능성이 높은 첨부를 우선하세요.",
    "소스·기관·분야·본문 두께·첨부 구성이 한쪽에 몰리지 않도록 대표성을 확보하세요.",
    "행사 안내, 단순 결과 공지, 증빙서류만 있는 공고, 지나치게 복합적인 통합공고는 피하세요.",
    "지원 자격을 판정하지 말고 분석 배치 대상으로 적합한지만 판단하세요.",
    "각 reason은 제목과 첨부 구성에 근거한 짧은 한국어 한 문장으로 작성하세요.",
  ].join("\n");
  const userText = JSON.stringify({
    requestedCount: input.count,
    candidates: input.candidates.map((candidate) => ({
      grantId: candidate.grantId,
      source: candidate.source,
      title: candidate.title,
      agency: candidate.agency,
      category: candidate.category,
      applyEnd: candidate.applyEnd,
      bodyTier: candidate.stratum.split("/")[1] ?? "unknown",
      bodyMarkdownBytes: candidate.maxMarkdownBytes,
      hwpAttachmentCount: candidate.hwpAttachmentCount,
      likelyApplicationDocumentCount: candidate.likelyApplicationDocumentCount,
      attachmentNames: candidate.attachmentNames,
    })),
  });
  const response = await callAnthropicToolModel({
    apiKey: input.apiKey,
    model: input.model,
    system,
    userText,
    toolSchema,
    fetchImpl: input.fetchImpl,
  });
  if (response.kind === "refusal") throw new Error("Claude가 분석 대상 선정을 거부했습니다.");
  const raw = response.input.selected;
  if (!Array.isArray(raw)) throw new Error("Claude 선정 응답에 selected 배열이 없습니다.");
  const selected = raw.map((item) => {
    if (!isRecord(item) || typeof item.grantId !== "string" || typeof item.reason !== "string") {
      throw new Error("Claude 선정 응답 항목의 grantId/reason 형식이 잘못됐습니다.");
    }
    return { grantId: item.grantId, reason: item.reason };
  });
  return { selected, usage: response.usage };
}

function targetSelectionEvidencePath(selectionId: string): string {
  return join(analysisLabDir(), "target-selections", `${selectionId}.json`);
}

async function writeTargetSelectionEvidence(result: LabAutomaticTargetSelectionResult): Promise<void> {
  await mkdir(dirname(result.evidencePath), { recursive: true });
  await writeFile(result.evidencePath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
