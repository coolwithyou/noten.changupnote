// 공모 딥분석 실험실 — AI 검수기 코어 (dev 전용, DB read-only, 결과는 파일로만 저장).
// 확대 실험 계획 §9(2026-07-23 프로토콜 개정): 검수 주체를 "사람 전수"에서
// "AI 전수(추출과 다른 모델) + 사람 표본 감사"로 바꾸는 트랙의 판정기.
// 한 런(LabRun)을 AI 로 검수해 런 파일 옆 <runId>.ai-review.<modelSlug>.json 을 만든다.
//
// [순환성 가드 — §9 유지 조항]
//   1. 판정 모델 === 추출 모델(run.model)이면 즉시 throw (자기 채점 순환 차단, 하드 가드).
//   2. AI 검수는 별도 파일에만 저장 — 사람 검수 <runId>.review.json 은 절대 건드리지 않는다
//      (review-store 의 사람 이메일 강제 가드도 그대로 유효).
//   3. golden 승격은 여전히 사람 감사를 거친 신뢰 수준에서만 — 이 파일은 감사 대상 산출까지만.
//
// [블라인드 원칙 — 판정 프롬프트 투입 금지 목록 (앵커링·정답 유출 차단)]
//   - run.analysisMarkdown          : 추출 모델의 자기 설명 — 판정을 추출 모델 서사에 앵커링시킨다.
//   - run.dimensionDiffs·현행 DB criteria(A) : "A와 같은가"가 아니라 "원문에 맞는가"를 재야 한다.
//   - run.programIntent, run.taxonomyProposals : 추출 모델의 부산물 — 동일한 앵커링 경로.
//   - 사람 review.json              : 골든 정답 유출 — 캘리브레이션 자체가 무효가 된다.
//   - criteria 의 confidence·spanVerified : 추출 모델의 자기 평가/서버 검증 신호 — 앵커링.
//   허용되는 입력은 세 가지뿐:
//   ① assembleLabInput 재조립 원문 텍스트(inputSha256 일치 검증 후)
//   ② run.criteria — 인덱스 + dimension/kind/operator/value/sourceSpan/note
//   ③ 빈 축 목록(제안 criterion 이 없는 축 — ReviewSheet emptyAxes 규칙 미러)
//
// [Anthropic API 주의 — extractor.ts 관행 승계 + 모델별 규칙]
//   - temperature/top_p/top_k/thinking 파라미터 일절 미전송 (claude-fable-5 는 thinking 항상
//     켜짐·명시 설정 시 400, claude-sonnet-5 는 생략 시 adaptive).
//   - stop_reason === "refusal" 은 판정 실패로 기록(에러 아님, 재시도 무의미).
//   - claude-fable-5 가 400(30일 retention 미충족 등)/403/404 로 불가하면 "모델 접근 불가"
//     명시 에러로 해당 모델만 실패 처리한다.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CRITERION_DIMENSIONS, type CriterionDimension } from "@cunote/contracts";
import type {
  LabCriterionVerdict,
  LabEmptyAxisVerdict,
  LabRun,
  LabUsage,
} from "@/features/dev/analysis-lab/contract";
import type { AiAxisReview, AiCriterionReview } from "./ai-review-compare";
import { DIMENSION_LABELS } from "./diff";
import { assembleLabInput, type LabAssembledInput, type LabInputArchive } from "./input";
import { findMonorepoRoot, labRunFilePath } from "./run-store";

export const AI_REVIEW_SCHEMA = "lab-ai-review-v1";
export const AI_REVIEW_PROMPT_VERSION = "ai-review-v1";
export const AI_REVIEW_TOOL_NAME = "emit_deep_analysis_review";
export const AI_REVIEW_DEFAULT_MODEL = "claude-sonnet-5";

const MAX_TOKENS = 16_000;
const TIMEOUT_MS = 540_000;

// 일시 오류(레이트리밋·과부하·서버 오류) 1회 재시도 — extractor.ts 선례.
const RETRYABLE_STATUSES = new Set([429, 500, 529]);
const RETRY_DELAY_MS = 5_000;

/**
 * 가격표 (USD / 1M tokens) — claude-api 스킬 2026-07 기준.
 * sonnet-5 는 인트로 가격($2/$10, ~2026-08-31; 정가 $3/$15). 미지 모델은 costUsd=null.
 * cache_read 는 입력 단가의 0.1배(캐싱 미사용이라 보통 0).
 */
const MODEL_PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-fable-5": { input: 10, output: 50 },
};

/** 판정 모델 해석 — 우선순위: CLI --model= > env ANALYSIS_LAB_REVIEW_MODEL > 기본. */
export function resolveAiReviewModel(cliModel?: string | undefined): string {
  return cliModel?.trim() || process.env.ANALYSIS_LAB_REVIEW_MODEL?.trim() || AI_REVIEW_DEFAULT_MODEL;
}

/** 모델 ID 의 파일명 안전 변환(허용 외 문자 → _). */
export function modelSlug(model: string): string {
  return model.replace(/[^A-Za-z0-9._\-]/g, "_");
}

/** AI 검수 파일 경로 — 런 파일 옆 <runId>.ai-review.<modelSlug>.json. */
export function aiReviewFilePath(source: string, sourceId: string, runId: string, model: string): string {
  return labRunFilePath(source, sourceId, runId).replace(/\.json$/, `.ai-review.${modelSlug(model)}.json`);
}

export interface AiReviewFile {
  schema: typeof AI_REVIEW_SCHEMA;
  runId: string;
  grantId: string;
  reviewerKind: "ai";
  model: string;
  promptVersion: typeof AI_REVIEW_PROMPT_VERSION;
  /** 판정 rubric 으로 삽입된 검수 가이드 전문의 sha256 (provenance). */
  guideSha256: string;
  /** 재조립 입력 sha256 === run.inputSha256 검증 통과 표식(불일치 런은 파일 자체가 없음). */
  inputSha256Verified: true;
  createdAt: string;
  criterionReviews: AiCriterionReview[];
  axisReviews: AiAxisReview[];
  usage: LabUsage | null;
  costUsd: number | null;
  durationMs: number;
}

export type AiReviewOutcome =
  | { status: "created"; file: AiReviewFile; path: string }
  | { status: "exists"; file: AiReviewFile; path: string }
  /** 재조립 입력이 run.inputSha256 과 다름 — 다른 텍스트에 대한 판정은 무의미하므로 스킵. */
  | { status: "input_drift"; expectedSha256: string; actualSha256: string }
  /** 모델이 판정을 거부(stop_reason=refusal) — 판정 실패로 기록, 재시도 무의미. */
  | { status: "refusal" };

export function computeAiReviewCostUsd(model: string, usage: LabUsage | null): number | null {
  const price = MODEL_PRICES_PER_MTOK[model];
  if (!price || !usage) return null;
  return (
    (usage.inputTokens * price.input) / 1e6 +
    (usage.outputTokens * price.output) / 1e6 +
    (((usage.cacheReadTokens ?? 0) * price.input) / 1e6) * 0.1
  );
}

// ---- rubric: 동결된 검수 가이드에서 런타임 추출 (기준서 단일 원천) ----------------

/** 검수 가이드 파일 경로 — 동결 커밋 1adfeec 의 가이드가 곧 rubric 이다. */
export function reviewGuidePath(): string {
  return join(findMonorepoRoot(), "docs", "research", "2026-07-18-공모딥분석-검수판정-가이드.md");
}

/**
 * 가이드에서 §0(리트머스)·§1(판정별 무게)·§2(경계 규칙 A~G)·§5(사례집)를 원문 그대로 추출.
 * 섹션 경계는 "## <n>." 헤딩 — 어느 하나라도 없으면 가이드 개정으로 간주하고 실패시킨다
 * (rubric 이 조용히 비는 것보다 정직한 실패가 낫다).
 */
export function extractGuideRubricSections(guideMarkdown: string): string {
  const wanted = ["0", "1", "2", "5"];
  const lines = guideMarkdown.split("\n");
  const sections: string[] = [];
  for (const number of wanted) {
    const start = lines.findIndex((line) => line.startsWith(`## ${number}.`));
    if (start < 0) {
      throw new Error(`검수 가이드에서 §${number} 헤딩(## ${number}.)을 찾지 못했습니다 — rubric 추출 실패.`);
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (lines[i]!.startsWith("## ")) {
        end = i;
        break;
      }
    }
    sections.push(lines.slice(start, end).join("\n").trim());
  }
  return sections.join("\n\n");
}

export async function loadGuideRubric(): Promise<{ rubric: string; guideSha256: string }> {
  const body = await readFile(reviewGuidePath(), "utf8");
  return {
    rubric: extractGuideRubricSections(body),
    guideSha256: createHash("sha256").update(body).digest("hex"),
  };
}

// ---- 빈 축 도출 (사람 검수 시트와 1:1 동일해야 캘리브레이션 비교가 성립) ---------

/**
 * 빈 축 = 제안 criterion 이 없는 축. ReviewSheet 의
 * `run.dimensionDiffs.filter(d => d.proposed.length === 0)` 및 review API 의
 * "제안된 criterion 이 있는 축 거부" 검증과 동치다(dimensionDiffs 는 22축 전수 생성이므로
 * CRITERION_DIMENSIONS − 제안 축 집합과 같다). 예약 2축(premises/export_performance)은
 * criteria 에 나올 수 없어 항상 빈 축에 포함된다 — 사람 시트와 동일.
 */
export function deriveEmptyAxes(run: LabRun): CriterionDimension[] {
  const proposed = new Set(run.criteria.map((criterion) => criterion.dimension));
  const empty = CRITERION_DIMENSIONS.filter((dimension) => !proposed.has(dimension));
  // 저장된 dimensionDiffs 와의 교차 검증(있을 때만) — 규칙 드리프트를 조기에 드러낸다.
  if (run.dimensionDiffs.length > 0) {
    const fromDiffs = run.dimensionDiffs
      .filter((diff) => diff.proposed.length === 0)
      .map((diff) => diff.dimension);
    if (fromDiffs.length !== empty.length || fromDiffs.some((dimension, i) => dimension !== empty[i])) {
      throw new Error(
        `빈 축 도출 불일치: dimensionDiffs 기준 ${fromDiffs.length}축 vs criteria 기준 ${empty.length}축 (${run.runId})`,
      );
    }
  }
  return empty;
}

// ---- 프롬프트 ---------------------------------------------------------------------

function buildSystemPrompt(rubric: string): string {
  return [
    "너는 정부지원사업 공고 딥분석 결과를 검수하는 독립 검수자다.",
    "다른 모델이 공고 원문에서 추출한 자격조건(criteria)과, 조건 없음으로 남긴 축(빈 축)을",
    "오직 아래 제공되는 공고 원문 입력만을 근거로 판정한다. 원문 밖 상식·추측으로 판정하지 마라.",
    "",
    "[판정 기준서 — 동결된 검수 가이드 원문. 아래 규칙이 판정의 단일 원천이다]",
    rubric,
    "",
    "[판정 지시]",
    "- criterion 판정 어휘는 기준서 §0 의 4분류와 1:1 대응한다:",
    "  correct(정확) / needs_edit(수정 필요) / wrong(오류) / unsure(판단 불가).",
    "- correct 가 아닌 판정은 note 필수: 무엇이 틀렸고 어떻게 고쳐야 하는지(올바른 값), 원문 근거와 함께 쓴다.",
    "- 빈 축 판정: confirmed_absent(그 축의 자격요건이 원문 전체에 없음을 확인) /",
    "  missed_condition(원문에 그 축의 요건이 실재하는데 추출이 못 잡음 — 누락).",
    "- missed_condition 이면 note 에 누락된 요건을 원문 문구 인용으로 서술한다(필수).",
    "- [적대적 검증] 각 criterion 에 대해 \"이 criterion 을 이대로 DB에 넣고 매칭 판정에 썼을 때,",
    "  원문과 다른 판정 결론이 나오는 기업이 존재하는지\" 능동적으로 반증을 시도하라 —",
    "  반례가 될 기업을 구체적으로 상정하고 value·operator·kind 를 원문과 대조하라.",
    "- unsure 남발 금지 — 기준서 §2-G 그대로: 붙임이 입력에 없거나(변환 실패) 원문이 실제로",
    "  모호할 때만. \"귀찮음\"의 도피처가 아니다 — unsure 비율 자체가 품질 지표다.",
    "- 검수는 \"추출이 원문에 맞는가\"다. 축약된 표현이라도 매칭 판정 결과가 같으면 정확이다(§0).",
    "- 모든 criterion 인덱스와 모든 빈 축을 빠짐없이 정확히 한 번씩 판정하라.",
  ].join("\n");
}

function renderCriterionForPrompt(index: number, criterion: LabRun["criteria"][number]): string {
  // 블라인드 원칙: confidence/spanVerified/spanOffsetRatio 는 넣지 않는다(상단 금지 목록).
  return [
    `### criterion_index ${index}`,
    `- dimension: ${criterion.dimension} (${DIMENSION_LABELS[criterion.dimension]})`,
    `- kind: ${criterion.kind}`,
    `- operator: ${criterion.operator}`,
    `- value: ${JSON.stringify(criterion.value ?? {})}`,
    `- source_span(근거 인용): ${criterion.sourceSpan ?? "(없음)"}`,
    `- note: ${criterion.note ?? "(없음)"}`,
  ].join("\n");
}

function buildUserMessage(input: LabAssembledInput, run: LabRun, emptyAxes: CriterionDimension[]): string {
  return [
    "아래는 ① 공고 원문 입력 ② 다른 모델이 추출한 criteria ③ 추출이 조건 없음으로 남긴 빈 축 목록이다.",
    "기준서대로 criteria 전 인덱스와 빈 축 전부를 판정하라.",
    "",
    "[공고 원문 입력 — 판정의 유일한 근거]",
    input.text,
    "",
    `[검수 대상 A — 추출된 criteria ${run.criteria.length}건 (criterion_index 0~${run.criteria.length - 1} 전수 판정)]`,
    ...run.criteria.map((criterion, index) => renderCriterionForPrompt(index, criterion)),
    "",
    `[검수 대상 B — 빈 축 ${emptyAxes.length}축 (각 축의 자격요건이 원문 전체에 없는지 전수 확인)]`,
    ...emptyAxes.map((dimension) => `- ${dimension} (${DIMENSION_LABELS[dimension]})`),
  ].join("\n");
}

// ---- tool 스키마 (extractor.ts 의 tool 강제 패턴 미러) ---------------------------

const CRITERION_VERDICTS: readonly LabCriterionVerdict[] = ["correct", "needs_edit", "wrong", "unsure"];
const AXIS_VERDICTS: readonly LabEmptyAxisVerdict[] = ["confirmed_absent", "missed_condition"];

export function buildAiReviewToolSchema(criteriaCount: number, emptyAxes: CriterionDimension[]) {
  return {
    name: AI_REVIEW_TOOL_NAME,
    description: "딥분석 criteria 전수 판정과 빈 축 전수 확인 결과를 반환한다.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        criterion_reviews: {
          type: "array",
          minItems: criteriaCount,
          maxItems: criteriaCount,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              criterion_index: { type: "integer", minimum: 0, maximum: Math.max(0, criteriaCount - 1) },
              verdict: { type: "string", enum: [...CRITERION_VERDICTS] },
              note: { type: "string", description: "correct 가 아니면 필수 — 무엇을 어떻게 고칠지/원문 근거" },
            },
            required: ["criterion_index", "verdict"],
          },
        },
        axis_reviews: {
          type: "array",
          minItems: emptyAxes.length,
          maxItems: emptyAxes.length,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              dimension: { type: "string", enum: [...emptyAxes] },
              verdict: { type: "string", enum: [...AXIS_VERDICTS] },
              note: { type: "string", description: "missed_condition 이면 필수 — 누락 요건의 원문 문구 인용" },
            },
            required: ["dimension", "verdict"],
          },
        },
      },
      required: ["criterion_reviews", "axis_reviews"],
    },
  };
}

// ---- 응답 검증 (응답 불신 원칙 — extractor 동형) ---------------------------------

export type AiReviewPayloadCheck =
  | { ok: true; criterionReviews: AiCriterionReview[]; axisReviews: AiAxisReview[] }
  | { ok: false; reason: string };

export function validateAiReviewPayload(
  input: unknown,
  criteriaCount: number,
  emptyAxes: CriterionDimension[],
): AiReviewPayloadCheck {
  if (!isRecord(input)) return { ok: false, reason: "tool 입력이 객체가 아님" };
  const rawCriteria = input.criterion_reviews;
  const rawAxes = input.axis_reviews;
  if (!Array.isArray(rawCriteria) || !Array.isArray(rawAxes)) {
    return { ok: false, reason: "criterion_reviews/axis_reviews 배열 누락" };
  }

  const criterionReviews: AiCriterionReview[] = [];
  const seenIndexes = new Set<number>();
  for (const row of rawCriteria) {
    if (!isRecord(row)) return { ok: false, reason: "criterion_reviews 항목이 객체가 아님" };
    const index = row.criterion_index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= criteriaCount) {
      return { ok: false, reason: `criterion_index 범위 밖: ${String(index)}` };
    }
    if (seenIndexes.has(index)) return { ok: false, reason: `criterion_index ${index} 중복` };
    seenIndexes.add(index);
    const verdict = row.verdict;
    if (typeof verdict !== "string" || !(CRITERION_VERDICTS as readonly string[]).includes(verdict)) {
      return { ok: false, reason: `criterion verdict 어휘 밖: ${String(verdict)}` };
    }
    const note = cleanString(row.note);
    if (verdict !== "correct" && !note) {
      return { ok: false, reason: `criterion_index ${index}: 비-correct(${verdict}) 판정에 note 없음` };
    }
    criterionReviews.push({ criterionIndex: index, verdict: verdict as LabCriterionVerdict, note });
  }
  if (criterionReviews.length !== criteriaCount) {
    return { ok: false, reason: `criterion 커버리지 미달: ${criterionReviews.length}/${criteriaCount}` };
  }

  const allowedAxes = new Set<string>(emptyAxes);
  const axisReviews: AiAxisReview[] = [];
  const seenAxes = new Set<string>();
  for (const row of rawAxes) {
    if (!isRecord(row)) return { ok: false, reason: "axis_reviews 항목이 객체가 아님" };
    const dimension = row.dimension;
    if (typeof dimension !== "string" || !allowedAxes.has(dimension)) {
      return { ok: false, reason: `빈 축 아님/어휘 밖 dimension: ${String(dimension)}` };
    }
    if (seenAxes.has(dimension)) return { ok: false, reason: `축 ${dimension} 판정 중복` };
    seenAxes.add(dimension);
    const verdict = row.verdict;
    if (typeof verdict !== "string" || !(AXIS_VERDICTS as readonly string[]).includes(verdict)) {
      return { ok: false, reason: `빈 축 verdict 어휘 밖: ${String(verdict)}` };
    }
    const note = cleanString(row.note);
    if (verdict === "missed_condition" && !note) {
      return { ok: false, reason: `축 ${dimension}: missed_condition 판정에 원문 인용 note 없음` };
    }
    axisReviews.push({ dimension: dimension as CriterionDimension, verdict: verdict as LabEmptyAxisVerdict, note });
  }
  if (axisReviews.length !== emptyAxes.length) {
    return { ok: false, reason: `빈 축 커버리지 미달: ${axisReviews.length}/${emptyAxes.length}` };
  }
  // 출력 안정화: criterion 은 인덱스, 축은 표준 22축 순서로 정렬.
  criterionReviews.sort((a, b) => a.criterionIndex - b.criterionIndex);
  axisReviews.sort(
    (a, b) => CRITERION_DIMENSIONS.indexOf(a.dimension) - CRITERION_DIMENSIONS.indexOf(b.dimension),
  );
  return { ok: true, criterionReviews, axisReviews };
}

// ---- 입력 재조립 (analyze.ts 의 로드 흐름 복제 — read-only select 만) -------------

/**
 * analyze.ts 의 공고 로드 → assembleLabInput 흐름을 복제한다(원본은 비export 인라인).
 * DB 모듈은 함수 안에서만 동적 import — --dry-run 등 비실행 경로가 DB 를 아예 로드하지
 * 않도록(batch.ts 관행). 여기의 select 3개가 이 파일의 유일한 DB 접근이다(쓰기 없음).
 */
export async function reassembleLabInputForRun(run: LabRun): Promise<LabAssembledInput> {
  const [{ getCunoteDb }, schema, { and, eq }] = await Promise.all([
    import("../db/client"),
    import("../db/schema"),
    import("drizzle-orm"),
  ]);
  const db = getCunoteDb();
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
    .where(eq(schema.grants.id, run.grantId))
    .limit(1);
  const grant = grantRows[0];
  if (!grant) throw new Error(`공고를 찾지 못했습니다(재조립 불가): ${run.grantId}`);

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

  return assembleLabInput({
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
}

// ---- Anthropic 호출 ---------------------------------------------------------------

interface AnthropicToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface AnthropicMessageResponse {
  content?: Array<AnthropicToolUseBlock | { type: string; text?: string }>;
  stop_reason?: string;
  usage?: Record<string, unknown>;
}

type ReviewCallResult =
  | { kind: "ok"; input: Record<string, unknown>; usage: LabUsage | null }
  | { kind: "refusal"; usage: LabUsage | null };

async function callReviewModel(options: {
  apiKey: string;
  model: string;
  system: string;
  userText: string;
  toolSchema: ReturnType<typeof buildAiReviewToolSchema>;
  fetchImpl?: typeof fetch;
}): Promise<ReviewCallResult> {
  const requestBody = JSON.stringify({
    model: options.model,
    max_tokens: MAX_TOKENS,
    system: options.system,
    messages: [{ role: "user", content: options.userText }],
    tools: [options.toolSchema],
    tool_choice: { type: "tool", name: AI_REVIEW_TOOL_NAME },
    // temperature/top_p/top_k/thinking 절대 미포함 — 상단 주석의 모델별 규칙.
  });

  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await (options.fetchImpl ?? fetch)("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
        body: requestBody,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`AI 검수 호출이 타임아웃됐습니다(${TIMEOUT_MS}ms).`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  let response = await attempt();
  if (RETRYABLE_STATUSES.has(response.status)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, RETRY_DELAY_MS));
    response = await attempt();
  }

  const body = await response.text();
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw new Error(
        `모델 접근 불가(${options.model}): ${response.status} ${response.statusText} — ` +
          `이 모델은 이 API 키/조직에서 사용할 수 없습니다.\n${body.slice(0, 500)}`,
      );
    }
    if (response.status === 400 && /retention|zero data|invalid_request/i.test(body)) {
      throw new Error(
        `모델 접근 불가 가능성(${options.model}): 400 — claude-fable-5 는 30일 데이터 보존 설정이 ` +
          `필요합니다(ZDR 조직은 전 요청 400).\n${body.slice(0, 500)}`,
      );
    }
    throw new Error(
      `AI 검수 호출 실패(${options.model}): ${response.status} ${response.statusText}\n${body.slice(0, 800)}`,
    );
  }

  const payload = JSON.parse(body) as AnthropicMessageResponse;
  const usage = normalizeUsage(payload.usage);
  if (payload.stop_reason === "refusal") {
    return { kind: "refusal", usage };
  }
  const toolUse = payload.content?.find(
    (block): block is AnthropicToolUseBlock =>
      block.type === "tool_use" && "name" in block && block.name === AI_REVIEW_TOOL_NAME,
  );
  if (!toolUse) {
    if (payload.stop_reason === "max_tokens") {
      throw new Error(`출력 토큰 한도(max_tokens=${MAX_TOKENS}) 도달 — 도구 응답이 잘렸습니다.`);
    }
    throw new Error(`응답에 ${AI_REVIEW_TOOL_NAME} tool_use 없음(stop_reason=${payload.stop_reason ?? "unknown"}).`);
  }
  return { kind: "ok", input: isRecord(toolUse.input) ? toolUse.input : {}, usage };
}

// ---- 메인: 한 런 AI 검수 -----------------------------------------------------------

export async function runAiReview(options: {
  run: LabRun;
  model: string;
  apiKey: string;
  /** true 면 기존 ai-review 파일을 덮어쓴다. 기본은 존재 시 스킵(멱등). */
  force?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<AiReviewOutcome> {
  const { run, model } = options;

  // [하드 가드 §9] 판정 모델 === 추출 모델이면 자기 채점 순환 — 즉시 실패.
  if (model === run.model) {
    throw new Error(
      `판정 모델(${model})이 추출 모델(run.model=${run.model})과 같습니다 — 자기 채점 순환 금지(§9). 다른 모델을 지정하세요.`,
    );
  }
  if (run.error !== null) {
    throw new Error(`실패한 런은 검수 대상이 아닙니다: ${run.runId}`);
  }

  const path = aiReviewFilePath(run.source, run.sourceId, run.runId, model);
  if (!options.force && existsSync(path)) {
    const existing = await readAiReviewFile(path);
    if (existing) return { status: "exists", file: existing, path };
    throw new Error(`기존 AI 검수 파일 파싱 실패: ${path} — 확인 후 --force 로 재생성하세요.`);
  }

  // ── 입력 재조립·무결성: 재조립 sha 가 다르면 원문 드리프트 — 판정 무의미, 정직하게 스킵.
  const input = await reassembleLabInputForRun(run);
  if (input.inputSha256 !== run.inputSha256) {
    return { status: "input_drift", expectedSha256: run.inputSha256, actualSha256: input.inputSha256 };
  }

  const emptyAxes = deriveEmptyAxes(run);
  const { rubric, guideSha256 } = await loadGuideRubric();
  const system = buildSystemPrompt(rubric);
  const userText = buildUserMessage(input, run, emptyAxes);
  const toolSchema = buildAiReviewToolSchema(run.criteria.length, emptyAxes);

  const startedMs = Date.now();
  let totalUsage: LabUsage | null = null;
  const accumulateUsage = (usage: LabUsage | null) => {
    if (!usage) return;
    totalUsage = totalUsage
      ? {
          inputTokens: totalUsage.inputTokens + usage.inputTokens,
          outputTokens: totalUsage.outputTokens + usage.outputTokens,
          cacheReadTokens: (totalUsage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
        }
      : usage;
  };

  // 검증 실패 시 1회 재시도(extractor 의 재시도 선례 — 여기서는 커버리지 검증 실패도 재시도 사유).
  let checked: AiReviewPayloadCheck | null = null;
  for (let attemptNo = 1; attemptNo <= 2; attemptNo += 1) {
    const result = await callReviewModel({
      apiKey: options.apiKey,
      model,
      system,
      userText,
      toolSchema,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    accumulateUsage(result.usage);
    if (result.kind === "refusal") return { status: "refusal" };
    checked = validateAiReviewPayload(result.input, run.criteria.length, emptyAxes);
    if (checked.ok) break;
    if (attemptNo === 2) {
      throw new Error(`AI 검수 응답 검증 실패(재시도 후에도): ${checked.reason}`);
    }
    console.warn(`[ai-review] 응답 검증 실패 — 1회 재시도: ${checked.reason}`);
  }
  if (!checked?.ok) throw new Error("AI 검수 응답 검증 실패(도달 불가 경로)");

  const file: AiReviewFile = {
    schema: AI_REVIEW_SCHEMA,
    runId: run.runId,
    grantId: run.grantId,
    reviewerKind: "ai",
    model,
    promptVersion: AI_REVIEW_PROMPT_VERSION,
    guideSha256,
    inputSha256Verified: true,
    createdAt: new Date().toISOString(),
    criterionReviews: checked.criterionReviews,
    axisReviews: checked.axisReviews,
    usage: totalUsage,
    costUsd: computeAiReviewCostUsd(model, totalUsage),
    durationMs: Date.now() - startedMs,
  };

  await mkdir(dirname(path), { recursive: true });
  // 불변("wx") 쓰기 — 존재하면 실패. --force 만 덮어쓰기 허용. 사람 review.json 은 불가침.
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    flag: options.force ? "w" : "wx",
  });
  return { status: "created", file, path };
}

export async function readAiReviewFile(path: string): Promise<AiReviewFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as AiReviewFile;
    return parsed.schema === AI_REVIEW_SCHEMA &&
      typeof parsed.runId === "string" &&
      typeof parsed.grantId === "string" &&
      Array.isArray(parsed.criterionReviews) &&
      Array.isArray(parsed.axisReviews)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

// ---- 공용 유틸 --------------------------------------------------------------------

function normalizeUsage(usage: Record<string, unknown> | undefined): LabUsage | null {
  if (!usage) return null;
  const inputTokens = finiteNumber(usage.input_tokens);
  const outputTokens = finiteNumber(usage.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  return { inputTokens, outputTokens, cacheReadTokens: finiteNumber(usage.cache_read_input_tokens) };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
