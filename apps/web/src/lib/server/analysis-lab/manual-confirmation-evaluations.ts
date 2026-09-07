// 사람 검수자가 확정한 required/preferred/exclusion 서술형 조건의 3상태 질문 sidecar.
// 모델을 호출하지 않으며 immutable LabRun을 수정하지 않는다.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type {
  DeepAnalysisCriterionConfirmation,
  GrantConfirmationEvaluation,
} from "@cunote/contracts";
import type { LabCriterion, LabReview, LabRun } from "./lab-contract";
import { validateReviewerEmail } from "./review-store";
import { labRunFilePath } from "./run-store";
import {
  MANUAL_CONFIRMATION_EVALUATION_SELECTION_SCHEMA,
  sha256Canonical,
  type ManualConfirmationEvaluationSelection,
} from "../analysis-serving/promotionReleaseContract";

export const MANUAL_CONFIRMATION_EVALUATIONS_SCHEMA =
  "lab-manual-confirmation-evaluations-v1" as const;
export const MANUAL_CONFIRMATION_EVALUATIONS_REVISION_SCHEMA =
  "lab-manual-confirmation-evaluations-revision-v1" as const;
export const MANUAL_CONFIRMATION_EVALUATION_SELECTION_SET_SCHEMA =
  "lab-manual-confirmation-evaluation-selection-set-v1" as const;
export const MAX_MANUAL_CONFIRMATION_REVISION = 1_000;

export interface ManualConfirmationEvaluationItem {
  criterionIndex: number;
  /** 첫 구현은 공고에만 귀속되는 사실 확인으로 한정한다. */
  resolutionScope: "per_notice";
  prompt: string;
  options: Array<{
    value: string;
    label: string;
    evaluation: GrantConfirmationEvaluation;
  }>;
}

interface ManualConfirmationEvaluationsCommon {
  grantId: string;
  runId: string;
  sourceRevisionSha256: string;
  inputSha256: string;
  /** 원 criterion을 correct로 판정한 사람 검수자. */
  criterionReviewerEmail: string;
  /** 질문 문구와 3상태 선택지를 작성·확정한 사람. */
  questionAuthorEmail: string;
  createdAt: string;
  items: ManualConfirmationEvaluationItem[];
}

export interface ManualConfirmationEvaluationsV1Artifact
  extends ManualConfirmationEvaluationsCommon {
  schema: typeof MANUAL_CONFIRMATION_EVALUATIONS_SCHEMA;
}

/** revision 2 이상. items는 이전 revision에 덧씌우는 patch가 아니라 전체 활성 snapshot이다. */
export interface ManualConfirmationEvaluationsRevisionArtifact
  extends ManualConfirmationEvaluationsCommon {
  schema: typeof MANUAL_CONFIRMATION_EVALUATIONS_REVISION_SCHEMA;
  revision: number;
  parent: {
    revision: number;
    artifactSha256: string;
  };
  /** 같은 source/input 문자열만 남긴 run criteria 변조를 차단한다. */
  runContentSha256: string;
  /** 이 필드를 제외한 artifact body의 canonical SHA. */
  contentSha256: string;
  intent: "replace" | "withdraw_all";
  /** 바로 이전 활성 snapshot에서 제거한 criterion index와 정확히 일치한다. */
  withdrawnCriterionIndexes: number[];
}

export type ManualConfirmationEvaluationsArtifact =
  | ManualConfirmationEvaluationsV1Artifact
  | ManualConfirmationEvaluationsRevisionArtifact;

/** CLI/release 입력은 이 최소 selector만 받으며 itemCount/intent는 실제 artifact에서 파생한다. */
export interface ManualConfirmationEvaluationSelector {
  grantId: string;
  runId: string;
  revision: number;
  artifactSha256: string;
}

export interface ManualConfirmationEvaluationSelectionSet {
  schema: typeof MANUAL_CONFIRMATION_EVALUATION_SELECTION_SET_SCHEMA;
  selections: ManualConfirmationEvaluationSelector[];
}

export interface SelectedManualConfirmationEvaluations {
  artifact: ManualConfirmationEvaluationsArtifact;
  selection: ManualConfirmationEvaluationSelection;
  path: string;
  /** true면 역사 SHA-only release의 revision 1 재검증이며 신규 plan 선택 필드에는 싣지 않는다. */
  legacyShaOnly: boolean;
}

export function manualConfirmationEvaluationsFilePath(
  source: string,
  sourceId: string,
  runId: string,
): string {
  return labRunFilePath(source, sourceId, runId).replace(
    /\.json$/,
    ".confirmation-evaluations.json",
  );
}

export function manualConfirmationEvaluationsRevisionFilePath(
  source: string,
  sourceId: string,
  runId: string,
  revision: number,
): string {
  assertRevision(revision);
  if (revision === 1) return manualConfirmationEvaluationsFilePath(source, sourceId, runId);
  return labRunFilePath(source, sourceId, runId).replace(
    /\.json$/,
    `.confirmation-evaluations.r${revision}.json`,
  );
}

export function buildManualConfirmationEvaluationsArtifact(input: {
  run: LabRun;
  review: LabReview;
  /** API 직접 사용 시 기존 검수자와 같다고 명시적으로 간주한다. CLI는 별도 입력을 요구한다. */
  questionAuthorEmail?: string;
  createdAt: string;
  items: unknown;
}): ManualConfirmationEvaluationsV1Artifact {
  if (!input.run.sourceRevisionSha256 || !sha256(input.run.sourceRevisionSha256)) {
    throw new Error("manual confirmation에는 run sourceRevisionSha256가 필요합니다.");
  }
  if (input.review.runId !== input.run.runId || input.review.grantId !== input.run.grantId) {
    throw new Error("manual confirmation review가 run과 일치하지 않습니다.");
  }
  const criterionReviewer = validateReviewerEmail(input.review.reviewerEmail);
  if (!criterionReviewer.ok) throw new Error(criterionReviewer.reason);
  const questionAuthor = validateReviewerEmail(
    input.questionAuthorEmail ?? input.review.reviewerEmail,
  );
  if (!questionAuthor.ok) throw new Error(questionAuthor.reason);
  const correct = new Set(input.review.criterionReviews
    .filter((item) => item.verdict === "correct")
    .map((item) => item.criterionIndex));
  const items = parseManualItems(input.items, input.run, correct, { allowEmpty: false });
  return {
    schema: MANUAL_CONFIRMATION_EVALUATIONS_SCHEMA,
    grantId: input.run.grantId,
    runId: input.run.runId,
    sourceRevisionSha256: input.run.sourceRevisionSha256,
    inputSha256: input.run.inputSha256,
    criterionReviewerEmail: criterionReviewer.email,
    questionAuthorEmail: questionAuthor.email,
    createdAt: new Date(input.createdAt).toISOString(),
    items,
  };
}

export function buildManualConfirmationEvaluationsRevisionArtifact(input: {
  run: LabRun;
  review: LabReview;
  parent: SelectedManualConfirmationEvaluations;
  questionAuthorEmail: string;
  createdAt: string;
  intent: "replace" | "withdraw_all";
  withdrawnCriterionIndexes: unknown;
  items: unknown;
}): ManualConfirmationEvaluationsRevisionArtifact {
  assertManualArtifactBinding(input.parent.artifact, input.run);
  assertSelectionMatchesArtifact(input.parent.selection, input.parent.artifact);
  const revision = input.parent.selection.revision + 1;
  assertRevision(revision);
  const criterionReviewer = validateReviewerEmail(input.review.reviewerEmail);
  if (!criterionReviewer.ok) throw new Error(criterionReviewer.reason);
  const questionAuthor = validateReviewerEmail(input.questionAuthorEmail);
  if (!questionAuthor.ok) throw new Error(questionAuthor.reason);
  if (input.review.runId !== input.run.runId || input.review.grantId !== input.run.grantId) {
    throw new Error("manual confirmation review가 run과 일치하지 않습니다.");
  }
  const correct = new Set(input.review.criterionReviews
    .filter((item) => item.verdict === "correct")
    .map((item) => item.criterionIndex));
  const items = parseManualItems(input.items, input.run, correct, { allowEmpty: true })
    .sort((left, right) => left.criterionIndex - right.criterionIndex);
  const parentItems = [...input.parent.artifact.items]
    .sort((left, right) => left.criterionIndex - right.criterionIndex);
  const parentIndexes = new Set(parentItems.map((item) => item.criterionIndex));
  const itemIndexes = new Set(items.map((item) => item.criterionIndex));
  const removed = [...parentIndexes].filter((index) => !itemIndexes.has(index)).sort((a, b) => a - b);
  const withdrawn = parseCriterionIndexes(input.withdrawnCriterionIndexes, "withdrawnCriterionIndexes");
  if (JSON.stringify(removed) !== JSON.stringify(withdrawn)) {
    throw new Error("withdrawnCriterionIndexes가 부모 대비 제거된 조건과 일치하지 않습니다.");
  }
  if (input.intent === "withdraw_all") {
    if (parentItems.length === 0 || items.length !== 0 || removed.length !== parentItems.length) {
      throw new Error("withdraw_all은 비어 있지 않은 부모의 모든 질문을 철회할 때만 허용됩니다.");
    }
  } else if (input.intent === "replace") {
    if (items.length === 0) {
      throw new Error("빈 질문 snapshot은 intent=withdraw_all이어야 합니다.");
    }
    if (sha256Canonical(parentItems) === sha256Canonical(items)) {
      throw new Error("부모와 동일한 질문 snapshot으로 새 revision을 만들 수 없습니다.");
    }
  } else {
    throw new Error("manual confirmation revision intent가 올바르지 않습니다.");
  }
  const body = {
    schema: MANUAL_CONFIRMATION_EVALUATIONS_REVISION_SCHEMA,
    revision,
    parent: {
      revision: input.parent.selection.revision,
      artifactSha256: input.parent.selection.artifactSha256,
    },
    runContentSha256: sha256Canonical(input.run),
    intent: input.intent,
    withdrawnCriterionIndexes: withdrawn,
    grantId: input.run.grantId,
    runId: input.run.runId,
    sourceRevisionSha256: input.run.sourceRevisionSha256!,
    inputSha256: input.run.inputSha256,
    criterionReviewerEmail: criterionReviewer.email,
    questionAuthorEmail: questionAuthor.email,
    createdAt: new Date(input.createdAt).toISOString(),
    items,
  } satisfies Omit<ManualConfirmationEvaluationsRevisionArtifact, "contentSha256">;
  return { ...body, contentSha256: sha256Canonical(body) };
}

export async function saveManualConfirmationEvaluations(
  artifact: ManualConfirmationEvaluationsV1Artifact,
  run: LabRun,
  outputPath = manualConfirmationEvaluationsFilePath(run.source, run.sourceId, run.runId),
): Promise<string> {
  const parsed = parseManualConfirmationEvaluationsArtifact(artifact, run);
  if (parsed.schema !== MANUAL_CONFIRMATION_EVALUATIONS_SCHEMA) {
    throw new Error("초기 manual confirmation 저장에는 revision 1 artifact만 허용됩니다.");
  }
  await writeFile(outputPath, serializeManualConfirmationEvaluationsArtifact(parsed), {
    encoding: "utf8",
    flag: "wx",
  });
  return outputPath;
}

export async function saveManualConfirmationEvaluationsRevision(
  artifact: ManualConfirmationEvaluationsRevisionArtifact,
  run: LabRun,
  outputPath = manualConfirmationEvaluationsRevisionFilePath(
    run.source,
    run.sourceId,
    run.runId,
    artifact.revision,
  ),
  options: { basePath?: string } = {},
): Promise<string> {
  const parsed = parseManualConfirmationEvaluationsArtifact(artifact, run);
  if (parsed.schema !== MANUAL_CONFIRMATION_EVALUATIONS_REVISION_SCHEMA) {
    throw new Error("revision 저장에는 revision artifact만 허용됩니다.");
  }
  const basePath = options.basePath ?? basePathForRevisionOutput(outputPath, parsed.revision);
  const actualParent = await readSelectedManualConfirmationEvaluations(
    run,
    parsed.parent,
    { basePath },
  );
  assertRevisionTransition(actualParent.artifact, parsed);
  await writeFile(outputPath, serializeManualConfirmationEvaluationsArtifact(parsed), {
    encoding: "utf8",
    flag: "wx",
  });
  return outputPath;
}

export async function readManualConfirmationEvaluations(
  run: LabRun,
  inputPath = manualConfirmationEvaluationsFilePath(run.source, run.sourceId, run.runId),
): Promise<ManualConfirmationEvaluationsArtifact | null> {
  try {
    const raw = JSON.parse(await readFile(inputPath, "utf8"));
    return parseManualConfirmationEvaluationsArtifact(raw, run);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

/** exact revision/hash만 읽고 v2면 revision 1까지의 연속 parent chain을 검증한다. */
export async function readSelectedManualConfirmationEvaluations(
  run: LabRun,
  selector: Pick<ManualConfirmationEvaluationSelector, "revision" | "artifactSha256">,
  options: { basePath?: string; legacyShaOnly?: boolean } = {},
): Promise<SelectedManualConfirmationEvaluations> {
  assertRevision(selector.revision);
  if (!sha256(selector.artifactSha256)) throw new Error("manual confirmation selector SHA가 올바르지 않습니다.");
  const basePath = options.basePath
    ?? manualConfirmationEvaluationsFilePath(run.source, run.sourceId, run.runId);
  const chain: SelectedManualConfirmationEvaluations[] = [];
  let revision = selector.revision;
  let expectedSha256 = selector.artifactSha256;
  while (revision >= 1) {
    const path = revision === 1
      ? basePath
      : basePath.replace(/\.json$/, `.r${revision}.json`);
    const bytes = await readFile(path);
    const artifactSha256 = sha256Bytes(bytes);
    if (artifactSha256 !== expectedSha256) {
      throw new Error(`manual confirmation revision ${revision} 파일 SHA가 선택과 일치하지 않습니다.`);
    }
    const artifact = parseManualConfirmationEvaluationsArtifact(
      JSON.parse(bytes.toString("utf8")),
      run,
    );
    const actualRevision = artifact.schema === MANUAL_CONFIRMATION_EVALUATIONS_SCHEMA
      ? 1
      : artifact.revision;
    if (actualRevision !== revision) {
      throw new Error(`manual confirmation revision ${revision} 파일 내용의 revision이 다릅니다.`);
    }
    const selected: SelectedManualConfirmationEvaluations = {
      artifact,
      selection: selectionForArtifact(artifact, artifactSha256),
      path,
      legacyShaOnly: options.legacyShaOnly === true,
    };
    chain.push(selected);
    if (revision === 1) break;
    if (artifact.schema !== MANUAL_CONFIRMATION_EVALUATIONS_REVISION_SCHEMA) {
      throw new Error(`manual confirmation revision ${revision}은 revision artifact여야 합니다.`);
    }
    if (artifact.parent.revision !== revision - 1) {
      throw new Error(`manual confirmation revision ${revision} parent가 연속되지 않습니다.`);
    }
    revision = artifact.parent.revision;
    expectedSha256 = artifact.parent.artifactSha256;
  }
  const oldestToNewest = [...chain].reverse();
  for (let index = 1; index < oldestToNewest.length; index += 1) {
    assertRevisionTransition(
      oldestToNewest[index - 1]!.artifact,
      oldestToNewest[index]!.artifact,
    );
  }
  return chain[0]!;
}

/** 신규 release 준비: sidecar가 하나라도 있으면 exact selector를 반드시 요구한다. */
export async function resolveManualConfirmationEvaluationsForPreparation(
  run: LabRun,
  selector?: Pick<ManualConfirmationEvaluationSelector, "revision" | "artifactSha256">,
  options: { basePath?: string } = {},
): Promise<SelectedManualConfirmationEvaluations | null> {
  if (selector) return readSelectedManualConfirmationEvaluations(run, selector, options);
  if (await hasManualConfirmationEvaluationArtifacts(run, options.basePath)) {
    throw new Error(`수동 confirmation revision을 명시적으로 선택해야 합니다: ${run.grantId}`);
  }
  return null;
}

/** 역사 release 재검증: manifest가 지목한 SHA/selection만 읽고 이후 파일 출현은 무시한다. */
export async function resolveManualConfirmationEvaluationsForSource(input: {
  run: LabRun;
  manualConfirmationEvaluationsSha256?: string | null;
  selection?: ManualConfirmationEvaluationSelection;
  basePath?: string;
}): Promise<SelectedManualConfirmationEvaluations | null> {
  if (input.selection) {
    assertSelection(input.selection);
    if (input.manualConfirmationEvaluationsSha256 !== input.selection.artifactSha256) {
      throw new Error("manual confirmation source SHA와 revision 선택이 일치하지 않습니다.");
    }
    const resolved = await readSelectedManualConfirmationEvaluations(
      input.run,
      input.selection,
      { ...(input.basePath ? { basePath: input.basePath } : {}) },
    );
    if (sha256Canonical(resolved.selection) !== sha256Canonical(input.selection)) {
      throw new Error("manual confirmation source 선택 metadata가 artifact와 일치하지 않습니다.");
    }
    return resolved;
  }
  if (typeof input.manualConfirmationEvaluationsSha256 === "string") {
    return readSelectedManualConfirmationEvaluations(
      input.run,
      { revision: 1, artifactSha256: input.manualConfirmationEvaluationsSha256 },
      { ...(input.basePath ? { basePath: input.basePath } : {}), legacyShaOnly: true },
    );
  }
  return null;
}

export async function readManualConfirmationEvaluationSelectionSet(
  path: string | undefined,
): Promise<ManualConfirmationEvaluationSelectionSet> {
  if (!path) {
    return { schema: MANUAL_CONFIRMATION_EVALUATION_SELECTION_SET_SCHEMA, selections: [] };
  }
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("manual confirmation selection set 형식이 올바르지 않습니다.");
  }
  const record = raw as Record<string, unknown>;
  if (
    record.schema !== MANUAL_CONFIRMATION_EVALUATION_SELECTION_SET_SCHEMA
    || !Array.isArray(record.selections)
  ) {
    throw new Error("manual confirmation selection set schema가 올바르지 않습니다.");
  }
  const seen = new Set<string>();
  const selections = record.selections.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`manual confirmation selections[${index}] 형식 오류`);
    }
    const value = entry as Record<string, unknown>;
    const grantId = clean(value.grantId);
    const runId = clean(value.runId);
    if (!grantId || !runId || !Number.isSafeInteger(value.revision)) {
      throw new Error(`manual confirmation selections[${index}] 결속 누락`);
    }
    const revision = value.revision as number;
    assertRevision(revision);
    if (!sha256(value.artifactSha256)) {
      throw new Error(`manual confirmation selections[${index}] SHA 오류`);
    }
    const key = `${grantId}\u0000${runId}`;
    if (seen.has(key)) throw new Error(`manual confirmation selection 중복: ${grantId}/${runId}`);
    seen.add(key);
    return { grantId, runId, revision, artifactSha256: value.artifactSha256 as string };
  });
  return { schema: MANUAL_CONFIRMATION_EVALUATION_SELECTION_SET_SCHEMA, selections };
}

export function indexManualConfirmationEvaluationSelectors(
  selectors: readonly ManualConfirmationEvaluationSelector[],
  expectedGrantIds: readonly string[],
): ReadonlyMap<string, ManualConfirmationEvaluationSelector> {
  const expected = new Set(expectedGrantIds);
  const indexed = new Map<string, ManualConfirmationEvaluationSelector>();
  for (const [index, selector] of selectors.entries()) {
    const grantId = clean(selector?.grantId);
    const runId = clean(selector?.runId);
    if (!grantId || !runId) throw new Error(`manual confirmation selector[${index}] 결속 누락`);
    assertRevision(selector.revision);
    if (!sha256(selector.artifactSha256)) {
      throw new Error(`manual confirmation selector[${index}] SHA 오류`);
    }
    if (!expected.has(grantId)) {
      throw new Error(`exact cohort 밖 manual confirmation selector: ${grantId}`);
    }
    if (indexed.has(grantId)) {
      throw new Error(`manual confirmation selector grant 중복: ${grantId}`);
    }
    indexed.set(grantId, {
      grantId,
      runId,
      revision: selector.revision,
      artifactSha256: selector.artifactSha256,
    });
  }
  return indexed;
}

export function parseManualConfirmationEvaluationsArtifact(
  raw: unknown,
  run: LabRun,
): ManualConfirmationEvaluationsArtifact {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("manual confirmation artifact 형식이 올바르지 않습니다.");
  }
  const artifact = raw as ManualConfirmationEvaluationsArtifact;
  if (
    artifact.schema !== MANUAL_CONFIRMATION_EVALUATIONS_SCHEMA
    && artifact.schema !== MANUAL_CONFIRMATION_EVALUATIONS_REVISION_SCHEMA
  ) {
    throw new Error("manual confirmation artifact schema가 올바르지 않습니다.");
  }
  assertManualArtifactBinding(artifact, run);
  if (artifact.schema === MANUAL_CONFIRMATION_EVALUATIONS_SCHEMA) {
    // 역사 저장 artifact도 동일한 strict parser를 통과시켜 option 의미 누락을 허용하지 않는다.
    return buildManualConfirmationEvaluationsArtifact({
      run,
      review: reviewForStoredArtifact(run, artifact),
      questionAuthorEmail: artifact.questionAuthorEmail,
      createdAt: artifact.createdAt,
      items: artifact.items,
    });
  }
  assertRevision(artifact.revision);
  if (artifact.revision < 2) throw new Error("manual confirmation revision artifact는 revision 2 이상이어야 합니다.");
  if (
    !artifact.parent
    || !Number.isSafeInteger(artifact.parent.revision)
    || artifact.parent.revision !== artifact.revision - 1
    || !sha256(artifact.parent.artifactSha256)
  ) {
    throw new Error("manual confirmation revision parent 결속이 올바르지 않습니다.");
  }
  if (!sha256(artifact.runContentSha256) || artifact.runContentSha256 !== sha256Canonical(run)) {
    throw new Error("manual confirmation revision의 run content 결속이 일치하지 않습니다.");
  }
  if (!sha256(artifact.contentSha256)) {
    throw new Error("manual confirmation revision content SHA가 올바르지 않습니다.");
  }
  if (artifact.intent !== "replace" && artifact.intent !== "withdraw_all") {
    throw new Error("manual confirmation revision intent가 올바르지 않습니다.");
  }
  const criterionReviewer = validateReviewerEmail(artifact.criterionReviewerEmail);
  if (!criterionReviewer.ok) throw new Error(criterionReviewer.reason);
  const questionAuthor = validateReviewerEmail(artifact.questionAuthorEmail);
  if (!questionAuthor.ok) throw new Error(questionAuthor.reason);
  const correct = new Set((Array.isArray(artifact.items) ? artifact.items : [])
    .flatMap((item) => Number.isSafeInteger(item?.criterionIndex) ? [item.criterionIndex] : []));
  const items = parseManualItems(artifact.items, run, correct, { allowEmpty: true })
    .sort((left, right) => left.criterionIndex - right.criterionIndex);
  const withdrawnCriterionIndexes = parseCriterionIndexes(
    artifact.withdrawnCriterionIndexes,
    "withdrawnCriterionIndexes",
  );
  const body = {
    schema: MANUAL_CONFIRMATION_EVALUATIONS_REVISION_SCHEMA,
    revision: artifact.revision,
    parent: {
      revision: artifact.parent.revision,
      artifactSha256: artifact.parent.artifactSha256,
    },
    runContentSha256: artifact.runContentSha256,
    intent: artifact.intent,
    withdrawnCriterionIndexes,
    grantId: artifact.grantId,
    runId: artifact.runId,
    sourceRevisionSha256: artifact.sourceRevisionSha256,
    inputSha256: artifact.inputSha256,
    criterionReviewerEmail: criterionReviewer.email,
    questionAuthorEmail: questionAuthor.email,
    createdAt: new Date(artifact.createdAt).toISOString(),
    items,
  } satisfies Omit<ManualConfirmationEvaluationsRevisionArtifact, "contentSha256">;
  if (artifact.contentSha256 !== sha256Canonical(body)) {
    throw new Error("manual confirmation revision content SHA가 내용과 일치하지 않습니다.");
  }
  return { ...body, contentSha256: artifact.contentSha256 };
}

function reviewForStoredArtifact(
  run: LabRun,
  artifact: ManualConfirmationEvaluationsArtifact,
): LabReview {
  return {
    grantId: run.grantId,
    runId: run.runId,
    reviewerEmail: artifact.criterionReviewerEmail,
    createdAt: artifact.createdAt,
    updatedAt: artifact.createdAt,
    criterionReviews: artifact.items.map((item) => ({
      criterionIndex: item.criterionIndex,
      verdict: "correct" as const,
      note: null,
    })),
    axisReviews: [],
    overallNote: null,
  };
}

export function mergeManualConfirmationEvaluations(
  run: LabRun,
  artifact: ManualConfirmationEvaluationsArtifact | null | undefined,
): LabRun {
  if (!artifact) return run;
  const parsed = parseManualConfirmationEvaluationsArtifact(artifact, run);
  const byIndex = new Map(parsed.items.map((item) => [item.criterionIndex, item]));
  let changed = false;
  const criteria = run.criteria.map((criterion, index) => {
    const item = byIndex.get(index);
    if (!item) return criterion;
    if (criterion.confirmation) {
      throw new Error(`criterionIndex ${index}에 confirmation이 이미 있습니다.`);
    }
    changed = true;
    const confirmation: DeepAnalysisCriterionConfirmation = {
      prompt: item.prompt,
      options: item.options,
      answerType: "single",
      reusable: "per_notice",
      conditionKey: null,
      evaluationContractVersion: "confirmation-evaluation-v2",
    };
    return { ...criterion, confirmation };
  });
  return changed ? { ...run, criteria } : run;
}

/** 첫 단위는 근거가 검증된 text_only 조건의 공고별 수동 확인만 지원한다. */
export function classifyManualConfirmationCriterion(
  criterion: LabCriterion,
): "user_confirmation" | "company_profile" | "admin_source_review" {
  if (!criterion.spanVerified || !criterion.sourceSpan) return "admin_source_review";
  if (criterion.operator !== "text_only") return "company_profile";
  const value = criterion.value && typeof criterion.value === "object"
    ? criterion.value as Record<string, unknown>
    : {};
  const reason = typeof value.downgrade_reason === "string" ? value.downgrade_reason : null;
  if (reason && ADMIN_ONLY_DOWNGRADE_REASONS.has(reason)) return "admin_source_review";
  if (typeof value.original_dimension === "string" || criterion.dimension !== "other") {
    return "admin_source_review";
  }
  return "user_confirmation";
}

const ADMIN_ONLY_DOWNGRADE_REASONS = new Set([
  "contract_validation_failed",
  "exclusive_upper_bound_mismatch",
  "sanction_cause_state_flattening",
  "source_semantic_contradiction",
]);

function parseManualItems(
  raw: unknown,
  run: LabRun,
  correctCriterionIndexes: ReadonlySet<number>,
  options: { allowEmpty: boolean },
): ManualConfirmationEvaluationItem[] {
  if (!Array.isArray(raw) || (!options.allowEmpty && raw.length === 0)) {
    throw new Error(options.allowEmpty
      ? "manual confirmation items는 배열이어야 합니다."
      : "manual confirmation에는 질문이 하나 이상 필요합니다.");
  }
  const seen = new Set<number>();
  const items = raw.map((entry, itemIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`manual confirmation items[${itemIndex}] 형식 오류`);
    }
    const item = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(item.criterionIndex)) {
      throw new Error(`manual confirmation items[${itemIndex}] criterionIndex 오류`);
    }
    const criterionIndex = item.criterionIndex as number;
    const criterion = run.criteria[criterionIndex];
    if (!criterion || criterionIndex < 0) {
      throw new Error(`manual confirmation criterionIndex ${criterionIndex}가 run 범위를 벗어납니다.`);
    }
    if (seen.has(criterionIndex)) {
      throw new Error(`manual confirmation criterionIndex 중복: ${criterionIndex}`);
    }
    seen.add(criterionIndex);
    if (!correctCriterionIndexes.has(criterionIndex)) {
      throw new Error(`criterionIndex ${criterionIndex}는 사람 검수에서 correct가 아닙니다.`);
    }
    if (classifyManualConfirmationCriterion(criterion) !== "user_confirmation") {
      throw new Error(`criterionIndex ${criterionIndex}는 사용자 확인 질문으로 발행할 수 없습니다.`);
    }
    if (item.resolutionScope !== "per_notice") {
      throw new Error(`criterionIndex ${criterionIndex}는 per_notice 질문이어야 합니다.`);
    }
    const prompt = clean(item.prompt);
    if (!prompt) throw new Error(`criterionIndex ${criterionIndex} prompt가 필요합니다.`);
    return {
      criterionIndex,
      resolutionScope: "per_notice" as const,
      prompt,
      options: parseEvaluationOptions(item.options, criterionIndex),
    };
  });
  return items.sort((left, right) => left.criterionIndex - right.criterionIndex);
}

function parseCriterionIndexes(raw: unknown, label: string): number[] {
  if (!Array.isArray(raw)) throw new Error(`${label}는 배열이어야 합니다.`);
  const indexes = raw.map((value) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`${label}에는 0 이상의 안전한 정수만 허용됩니다.`);
    }
    return value as number;
  }).sort((left, right) => left - right);
  if (new Set(indexes).size !== indexes.length) throw new Error(`${label}에 중복이 있습니다.`);
  return indexes;
}

function assertRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_MANUAL_CONFIRMATION_REVISION) {
    throw new Error(`manual confirmation revision은 1..${MAX_MANUAL_CONFIRMATION_REVISION} 안전한 정수여야 합니다.`);
  }
}

export function serializeManualConfirmationEvaluationsArtifact(
  artifact: ManualConfirmationEvaluationsArtifact,
): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export function manualConfirmationEvaluationSelectionForArtifact(
  artifact: ManualConfirmationEvaluationsArtifact,
  artifactSha256 = sha256Bytes(serializeManualConfirmationEvaluationsArtifact(artifact)),
): ManualConfirmationEvaluationSelection {
  if (!sha256(artifactSha256)) throw new Error("manual confirmation artifact SHA가 올바르지 않습니다.");
  const revision = artifact.schema === MANUAL_CONFIRMATION_EVALUATIONS_SCHEMA ? 1 : artifact.revision;
  assertRevision(revision);
  return {
    schema: MANUAL_CONFIRMATION_EVALUATION_SELECTION_SCHEMA,
    revision,
    artifactSha256,
    itemCount: artifact.items.length,
    intent: artifact.schema === MANUAL_CONFIRMATION_EVALUATIONS_REVISION_SCHEMA
      && artifact.intent === "withdraw_all"
      ? "withdraw_all"
      : "active",
  };
}

/** 순수 plan 호출도 표준 직렬화 bytes와 exact selection을 함께 제시해야 한다. */
export function assertManualConfirmationEvaluationSelectionForArtifact(
  artifact: ManualConfirmationEvaluationsArtifact,
  selection: ManualConfirmationEvaluationSelection,
): void {
  assertSelection(selection);
  const expected = manualConfirmationEvaluationSelectionForArtifact(artifact);
  if (sha256Canonical(expected) !== sha256Canonical(selection)) {
    throw new Error("manual confirmation selection이 artifact bytes/내용과 일치하지 않습니다.");
  }
}

function selectionForArtifact(
  artifact: ManualConfirmationEvaluationsArtifact,
  artifactSha256: string,
): ManualConfirmationEvaluationSelection {
  return manualConfirmationEvaluationSelectionForArtifact(artifact, artifactSha256);
}

function assertSelection(selection: ManualConfirmationEvaluationSelection): void {
  if (!selection || selection.schema !== MANUAL_CONFIRMATION_EVALUATION_SELECTION_SCHEMA) {
    throw new Error("manual confirmation selection schema가 올바르지 않습니다.");
  }
  assertRevision(selection.revision);
  if (!sha256(selection.artifactSha256)) throw new Error("manual confirmation selection SHA가 올바르지 않습니다.");
  if (!Number.isSafeInteger(selection.itemCount) || selection.itemCount < 0) {
    throw new Error("manual confirmation selection itemCount가 올바르지 않습니다.");
  }
  if (selection.intent !== "active" && selection.intent !== "withdraw_all") {
    throw new Error("manual confirmation selection intent가 올바르지 않습니다.");
  }
  if (selection.intent === "active" && selection.itemCount === 0) {
    throw new Error("active manual confirmation selection에는 질문이 필요합니다.");
  }
  if (selection.intent === "withdraw_all" && selection.itemCount !== 0) {
    throw new Error("withdraw_all manual confirmation selection은 비어 있어야 합니다.");
  }
}

function assertSelectionMatchesArtifact(
  selection: ManualConfirmationEvaluationSelection,
  artifact: ManualConfirmationEvaluationsArtifact,
): void {
  assertSelection(selection);
  const expected = manualConfirmationEvaluationSelectionForArtifact(
    artifact,
    selection.artifactSha256,
  );
  if (sha256Canonical(expected) !== sha256Canonical(selection)) {
    throw new Error("manual confirmation selection이 artifact 내용과 일치하지 않습니다.");
  }
}

function artifactRevision(artifact: ManualConfirmationEvaluationsArtifact): number {
  return artifact.schema === MANUAL_CONFIRMATION_EVALUATIONS_SCHEMA ? 1 : artifact.revision;
}

function assertRevisionTransition(
  parent: ManualConfirmationEvaluationsArtifact,
  child: ManualConfirmationEvaluationsArtifact,
): void {
  if (child.schema !== MANUAL_CONFIRMATION_EVALUATIONS_REVISION_SCHEMA) {
    throw new Error("manual confirmation child는 revision artifact여야 합니다.");
  }
  const parentRevision = artifactRevision(parent);
  if (child.revision !== parentRevision + 1 || child.parent.revision !== parentRevision) {
    throw new Error("manual confirmation revision parent가 연속되지 않습니다.");
  }
  if (
    parent.grantId !== child.grantId
    || parent.runId !== child.runId
    || parent.sourceRevisionSha256 !== child.sourceRevisionSha256
    || parent.inputSha256 !== child.inputSha256
  ) {
    throw new Error("manual confirmation revision parent와 source 결속이 다릅니다.");
  }
  const childIndexes = new Set(child.items.map((item) => item.criterionIndex));
  const removed = parent.items
    .map((item) => item.criterionIndex)
    .filter((index) => !childIndexes.has(index))
    .sort((left, right) => left - right);
  if (sha256Canonical(removed) !== sha256Canonical(child.withdrawnCriterionIndexes)) {
    throw new Error("manual confirmation revision 철회 목록이 parent transition과 다릅니다.");
  }
  if (child.intent === "withdraw_all") {
    if (parent.items.length === 0 || child.items.length !== 0 || removed.length !== parent.items.length) {
      throw new Error("withdraw_all transition은 비어 있지 않은 parent 전체를 제거해야 합니다.");
    }
  } else if (child.items.length === 0 || sha256Canonical(parent.items) === sha256Canonical(child.items)) {
    throw new Error("replace transition은 비어 있지 않은 변경 snapshot이어야 합니다.");
  }
}

async function hasManualConfirmationEvaluationArtifacts(
  run: LabRun,
  inputBasePath?: string,
): Promise<boolean> {
  const basePath = inputBasePath
    ?? manualConfirmationEvaluationsFilePath(run.source, run.sourceId, run.runId);
  const directory = dirname(basePath);
  const baseName = basename(basePath).replace(/\.json$/, "");
  const pattern = new RegExp(`^${escapeRegExp(baseName)}(?:\\.r[0-9]+)?\\.json$`);
  try {
    return (await readdir(directory)).some((entry) => pattern.test(entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

function basePathForRevisionOutput(outputPath: string, revision: number): string {
  const suffix = `.r${revision}.json`;
  if (!outputPath.endsWith(suffix)) {
    throw new Error("revision output 경로에서 parent base 경로를 결정할 수 없습니다.");
  }
  return `${outputPath.slice(0, -suffix.length)}.json`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseEvaluationOptions(raw: unknown, criterionIndex: number) {
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new Error(`criterionIndex ${criterionIndex}는 3개 선택지가 필요합니다.`);
  }
  const seenValues = new Set<string>();
  const seenEvaluations = new Set<GrantConfirmationEvaluation>();
  const options = raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`criterionIndex ${criterionIndex} options[${index}] 형식 오류`);
    }
    const option = entry as Record<string, unknown>;
    const value = clean(option.value);
    const label = clean(option.label);
    const evaluation = option.evaluation;
    if (!value || !label || !isEvaluation(evaluation)) {
      throw new Error(`criterionIndex ${criterionIndex} options[${index}] 의미 누락`);
    }
    if (seenValues.has(value) || seenEvaluations.has(evaluation)) {
      throw new Error(`criterionIndex ${criterionIndex} option value/evaluation 중복`);
    }
    seenValues.add(value);
    seenEvaluations.add(evaluation);
    return { value, label, evaluation };
  });
  if (["satisfied", "unsatisfied", "unknown"].some((value) => !seenEvaluations.has(value as GrantConfirmationEvaluation))) {
    throw new Error(`criterionIndex ${criterionIndex} 3상태가 모두 필요합니다.`);
  }
  return options;
}

function assertManualArtifactBinding(
  artifact: Pick<ManualConfirmationEvaluationsArtifact, "grantId" | "runId" | "sourceRevisionSha256" | "inputSha256">,
  run: LabRun,
) {
  if (
    artifact.grantId !== run.grantId
    || artifact.runId !== run.runId
    || artifact.sourceRevisionSha256 !== run.sourceRevisionSha256
    || artifact.inputSha256 !== run.inputSha256
  ) throw new Error("manual confirmation artifact가 현재 run/source와 일치하지 않습니다.");
}

function isEvaluation(value: unknown): value is GrantConfirmationEvaluation {
  return value === "satisfied" || value === "unsatisfied" || value === "unknown";
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
