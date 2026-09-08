// Offline-only operator entrypoint. Validated manual JSON -> immutable sidecar; no DB/model/network.
// 최초 input: { questionAuthorEmail, items }.
// 관리자 GUI input: { schema, draftPacket, manualInput }을 raw run/review에 exact 재결속한다.
// revision input: { questionAuthorEmail, intent, withdrawnCriterionIndexes, items }와
// --parent-revision/--parent-sha256를 함께 요구한다. implicit latest는 읽지 않는다.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA } from "@cunote/contracts/confirmation-question-draft";
import type { LabReview, LabRun } from "./lab-contract";
import {
  buildManualConfirmationEvaluationsArtifact,
  buildManualConfirmationEvaluationsRevisionArtifact,
  manualConfirmationEvaluationSelectionForArtifact,
  readSelectedManualConfirmationEvaluations,
  saveManualConfirmationEvaluations,
  saveManualConfirmationEvaluationsRevision,
} from "./manual-confirmation-evaluations";
import { validateBoundManualConfirmationInput } from "./confirmation-question-draft";
import { labReviewFilePath, readLabReview } from "./review-store";
import { labRunFilePath, readLabRun } from "./run-store";

export interface LoadedManualConfirmationCliInput {
  run: LabRun;
  review: LabReview;
  manualInput: Record<string, unknown>;
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
  const hasEnvelopeMarker = Object.hasOwn(draft, "schema")
    || Object.hasOwn(draft, "draftPacket")
    || Object.hasOwn(draft, "manualInput");
  if (!hasEnvelopeMarker) {
    return { run: locatedRun, review: locatedReview, manualInput: draft };
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
  });
  if (validated.run.grantId !== input.grantId || validated.run.runId !== input.runId) {
    throw new Error("bound manual input이 CLI의 exact grantId/runId와 일치하지 않습니다.");
  }
  return {
    run: validated.run,
    review: validated.review,
    manualInput: validated.manualInput as unknown as Record<string, unknown>,
  };
}

export async function runManualConfirmationEvaluationsCli(
  argv: readonly string[],
): Promise<ManualConfirmationEvaluationsCliResult> {
  const grantId = arg(argv, "grantId");
  const runId = arg(argv, "runId");
  const input = arg(argv, "input");
  if (!grantId || !runId || !input) {
    throw new Error("--grantId, --runId, --input=<manual-json>이 필요합니다.");
  }
  const { run, review, manualInput } = await loadManualConfirmationCliInput({
    grantId,
    runId,
    inputPath: input,
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
    })
    : buildManualConfirmationEvaluationsArtifact({
      run,
      review,
      questionAuthorEmail: manualInput.questionAuthorEmail,
      createdAt: new Date().toISOString(),
      items: manualInput?.items,
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
