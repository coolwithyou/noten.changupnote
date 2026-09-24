// Offline-only operator entrypoint. Validated manual JSON -> immutable sidecar; no DB/model/network.
// 최초 input: { questionAuthorEmail, items }.
// 관리자 GUI input: { schema, draftPacket, manualInput }을 raw run/review에 exact 재결속한다.
// revision input: { questionAuthorEmail, intent, withdrawnCriterionIndexes, items }와
// --parent-revision/--parent-sha256를 함께 요구한다. implicit latest는 읽지 않는다.
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA } from "@cunote/contracts/confirmation-question-draft";
import type { LabReview, LabRun } from "./lab-contract";
import {
  buildManualConfirmationEvaluationsArtifact,
  buildManualConfirmationEvaluationsRevisionArtifact,
  manualConfirmationEvaluationSelectionForArtifact,
  readSelectedManualConfirmationEvaluations,
  manualConfirmationEvaluationsFilePath,
  saveManualConfirmationEvaluations,
  saveManualConfirmationEvaluationsRevision,
} from "./manual-confirmation-evaluations";
import {
  bindMissingConfirmationSourceRevision,
  validateBoundManualConfirmationInput,
} from "./confirmation-question-draft";
import { labReviewFilePath, readLabReview } from "./review-store";
import { labRunFilePath, readLabRun } from "./run-store";
import { buildCompanyFactReuseIdentity, sameCompanyFactIdentity } from "../matches/companyFactReuse";
import type { CompanyFactReview } from "@cunote/contracts/confirmation-question-draft";

export interface LoadedManualConfirmationCliInput {
  run: LabRun;
  review: LabReview;
  manualInput: Record<string, unknown>;
  reviewArtifactSha256?: string;
}

export interface ManualConfirmationEvaluationsCliResult {
  ok: true;
  path: string;
  itemCount: number;
  selector: {
    grantId: string;
    runId: string;
    revision: number;
    artifactSha256: string;
  };
}

export async function loadManualConfirmationCliInput(input: {
  grantId: string;
  runId: string;
  inputPath: string;
  sourceRevisionSha256?: string;
}): Promise<LoadedManualConfirmationCliInput> {
  const [locatedRun, locatedReview, draft] = await Promise.all([
    readLabRun(input.grantId, input.runId),
    readLabReview(input.grantId, input.runId),
    readFile(input.inputPath, "utf8").then(JSON.parse) as Promise<Record<string, unknown>>,
  ]);
  if (!locatedRun || !locatedReview) throw new Error("run과 사람 review.json이 모두 필요합니다.");
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new Error("manual JSON은 객체여야 합니다.");
  }
  const boundRun = bindMissingConfirmationSourceRevision(
    locatedRun,
    input.sourceRevisionSha256,
  );
  const hasEnvelopeMarker = Object.hasOwn(draft, "schema")
    || Object.hasOwn(draft, "draftPacket")
    || Object.hasOwn(draft, "manualInput");
  if (!hasEnvelopeMarker) {
    return { run: boundRun, review: locatedReview, manualInput: draft };
  }
  if (draft.schema !== CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA) {
    throw new Error("bound manual input marker에는 정확한 envelope schema가 필요합니다.");
  }
  const [runArtifactBytes, reviewArtifactBytes] = await Promise.all([
    readFile(labRunFilePath(locatedRun.source, locatedRun.sourceId, locatedRun.runId)),
    readFile(labReviewFilePath(locatedRun.source, locatedRun.sourceId, locatedRun.runId)),
  ]);
  const validated = validateBoundManualConfirmationInput({
    raw: draft,
    runArtifactBytes,
    reviewArtifactBytes,
    ...(input.sourceRevisionSha256 ? {
      sourceRevisionSha256: input.sourceRevisionSha256,
    } : {}),
  });
  if (validated.run.grantId !== input.grantId || validated.run.runId !== input.runId) {
    throw new Error("bound manual input이 CLI의 exact grantId/runId와 일치하지 않습니다.");
  }
  return {
    run: validated.run,
    review: validated.review,
    manualInput: validated.manualInput as unknown as Record<string, unknown>,
    reviewArtifactSha256: validated.reviewArtifactSha256,
  };
}

export async function runManualConfirmationEvaluationsCli(
  argv: readonly string[],
): Promise<ManualConfirmationEvaluationsCliResult> {
  const grantId = arg(argv, "grantId");
  const runId = arg(argv, "runId");
  const input = arg(argv, "input");
  const sourceRevisionSha256 = arg(argv, "source-revision-sha256");
  if (!grantId || !runId || !input) {
    throw new Error("--grantId, --runId, --input=<manual-json>이 필요합니다.");
  }
  const { run, review, manualInput, reviewArtifactSha256 } = await loadManualConfirmationCliInput({
    grantId,
    runId,
    inputPath: input,
    ...(sourceRevisionSha256 ? { sourceRevisionSha256 } : {}),
  });
  if (typeof manualInput?.questionAuthorEmail !== "string") {
    throw new Error("manual JSON의 questionAuthorEmail이 필요합니다.");
  }
  const parentRevisionRaw = arg(argv, "parent-revision");
  const parentSha256 = arg(argv, "parent-sha256");
  const hasRevisionOnlyFields = manualInput?.intent !== undefined
    || manualInput?.withdrawnCriterionIndexes !== undefined;
  if (Boolean(parentRevisionRaw) !== Boolean(parentSha256)) {
    throw new Error("revision 발행은 --parent-revision과 --parent-sha256를 함께 요구합니다.");
  }
  if (hasRevisionOnlyFields && (!parentRevisionRaw || !parentSha256)) {
    throw new Error("revision 전용 필드는 --parent-revision과 --parent-sha256를 요구합니다.");
  }
  const verifiedExistingDefinitionKeys = await verifyExistingCompanyFactDefinitions(run, manualInput);
  const artifact = parentRevisionRaw && parentSha256
    ? buildManualConfirmationEvaluationsRevisionArtifact({
      run,
      review,
      parent: await readSelectedManualConfirmationEvaluations(run, {
        revision: Number(parentRevisionRaw),
        artifactSha256: parentSha256,
      }),
      questionAuthorEmail: manualInput.questionAuthorEmail,
      createdAt: new Date().toISOString(),
      intent: manualInput?.intent as "replace" | "withdraw_all",
      withdrawnCriterionIndexes: manualInput?.withdrawnCriterionIndexes,
      items: manualInput?.items,
      ...(reviewArtifactSha256 ? { reviewArtifactSha256 } : {}),
      verifiedExistingDefinitionKeys,
    })
    : buildManualConfirmationEvaluationsArtifact({
      run,
      review,
      questionAuthorEmail: manualInput.questionAuthorEmail,
      createdAt: new Date().toISOString(),
      items: manualInput?.items,
      ...(reviewArtifactSha256 ? { reviewArtifactSha256 } : {}),
      verifiedExistingDefinitionKeys,
    });
  const path = artifact.schema === "lab-manual-confirmation-evaluations-v1"
    ? await saveManualConfirmationEvaluations(artifact, run)
    : await saveManualConfirmationEvaluationsRevision(artifact, run);
  const selection = manualConfirmationEvaluationSelectionForArtifact(artifact);
  return {
    ok: true,
    path,
    itemCount: artifact.items.length,
    selector: {
      grantId: run.grantId,
      runId: run.runId,
      revision: selection.revision,
      artifactSha256: selection.artifactSha256,
    },
  };
}

async function verifyExistingCompanyFactDefinitions(
  run: LabRun,
  manualInput: Record<string, unknown>,
): Promise<ReadonlyMap<number, string>> {
  const verified = new Map<number, string>();
  if (!Array.isArray(manualInput.items)) return verified;
  for (const raw of manualInput.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (item.resolutionScope !== "company_fact") continue;
    const factReview = item.companyFactReview as CompanyFactReview | undefined;
    if (factReview?.definitionSource !== "existing_reviewed") continue;
    const ref = factReview.existingDefinition;
    if (!ref || typeof ref.grantId !== "string" || !ref.grantId
      || typeof ref.runId !== "string" || !ref.runId
      || !Number.isSafeInteger(ref.revision) || ref.revision < 1
      || !/^[0-9a-f]{64}$/.test(ref.artifactSha256)
      || !Number.isSafeInteger(ref.criterionIndex) || ref.criterionIndex < 0
      || !Number.isSafeInteger(item.criterionIndex)) {
      throw new Error("기존 회사 사실 정의에는 exact artifact selector와 criterion index가 필요합니다.");
    }
    const priorRun = await readLabRun(ref.grantId, ref.runId);
    if (!priorRun) throw new Error("기존 회사 사실 정의의 원 run을 찾지 못했습니다.");
    const selected = await readSelectedManualConfirmationEvaluations(priorRun, {
      revision: ref.revision,
      artifactSha256: ref.artifactSha256,
    });
    const basePath = manualConfirmationEvaluationsFilePath(priorRun.source, priorRun.sourceId, priorRun.runId);
    const baseName = basename(basePath).replace(/\.json$/, "");
    const entries = await readdir(dirname(basePath));
    if (entries.some((name) => {
      const prefix = `${baseName}.r`;
      const revisionText = name.startsWith(prefix) && name.endsWith(".json")
        ? name.slice(prefix.length, -5)
        : "";
      return /^\d+$/.test(revisionText) && Number(revisionText) > ref.revision;
    })) {
      throw new Error("기존 회사 사실 정의의 선택 revision 이후 수동 수정·철회가 있어 재선택이 필요합니다.");
    }
    const priorItem = selected.artifact.items.find((candidate) => candidate.criterionIndex === ref.criterionIndex);
    const priorReview = priorItem?.companyFactReview;
    if (!priorItem || priorItem.resolutionScope !== "company_fact"
      || priorReview?.definitionSource !== "new_review"
      || priorReview.definitionKey !== factReview.definitionKey
      || priorReview.meaning !== factReview.meaning) {
      throw new Error("기존 회사 사실 정의의 의미·검수 출처가 선택 artifact와 다릅니다.");
    }
    const priorCriterion = priorRun.criteria[ref.criterionIndex];
    const currentCriterion = run.criteria[item.criterionIndex as number];
    if (!priorCriterion || !currentCriterion) throw new Error("기존 회사 사실 정의의 criterion index가 범위를 벗어납니다.");
    const identity = (criterion: typeof priorCriterion, options: unknown) => buildCompanyFactReuseIdentity({
      questionId: `${run.runId}:${item.criterionIndex}`,
      grantId: run.grantId,
      reusable: "company_fact",
      conditionKey: priorItem.conditionKey!,
      evaluationContractVersion: "confirmation-evaluation-v2",
      answerType: "single",
      options: options as Array<{ value: string; evaluation?: "satisfied" | "unsatisfied" | "unknown" }>,
      criterion: { dimension: criterion.dimension, kind: criterion.kind, operator: criterion.operator, value: criterion.value },
    });
    const priorIdentity = identity(priorCriterion, priorItem.options);
    const currentIdentity = identity(currentCriterion, item.options);
    if (!priorIdentity || !currentIdentity || !sameCompanyFactIdentity(priorIdentity, currentIdentity)) {
      throw new Error("기존 회사 사실 정의의 identity가 현재 criterion과 다릅니다.");
    }
    verified.set(item.criterionIndex as number, priorItem.conditionKey!);
  }
  return verified;
}

function arg(argv: readonly string[], name: string): string | undefined {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runManualConfirmationEvaluationsCli(process.argv.slice(2)).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
