// Offline-only operator entrypoint. Validated manual JSON -> immutable sidecar; no DB/model/network.
// 최초 input: { questionAuthorEmail, items }.
// revision input: { questionAuthorEmail, intent, withdrawnCriterionIndexes, items }와
// --parent-revision/--parent-sha256를 함께 요구한다. implicit latest는 읽지 않는다.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  buildManualConfirmationEvaluationsArtifact,
  buildManualConfirmationEvaluationsRevisionArtifact,
  manualConfirmationEvaluationSelectionForArtifact,
  readSelectedManualConfirmationEvaluations,
  saveManualConfirmationEvaluations,
  saveManualConfirmationEvaluationsRevision,
} from "./manual-confirmation-evaluations";
import { readLabReview } from "./review-store";
import { readLabRun } from "./run-store";

async function main(): Promise<number> {
  const grantId = arg("grantId");
  const runId = arg("runId");
  const input = arg("input");
  if (!grantId || !runId || !input) {
    throw new Error("--grantId, --runId, --input=<manual-json>이 필요합니다.");
  }
  const [run, review, draft] = await Promise.all([
    readLabRun(grantId, runId),
    readLabReview(grantId, runId),
    readFile(input, "utf8").then(JSON.parse),
  ]);
  if (!run || !review) throw new Error("run과 사람 review.json이 모두 필요합니다.");
  if (typeof draft?.questionAuthorEmail !== "string") {
    throw new Error("manual JSON의 questionAuthorEmail이 필요합니다.");
  }
  const parentRevisionRaw = arg("parent-revision");
  const parentSha256 = arg("parent-sha256");
  const hasRevisionOnlyFields = draft?.intent !== undefined
    || draft?.withdrawnCriterionIndexes !== undefined;
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
      questionAuthorEmail: draft.questionAuthorEmail,
      createdAt: new Date().toISOString(),
      intent: draft?.intent,
      withdrawnCriterionIndexes: draft?.withdrawnCriterionIndexes,
      items: draft?.items,
    })
    : buildManualConfirmationEvaluationsArtifact({
      run,
      review,
      questionAuthorEmail: draft.questionAuthorEmail,
      createdAt: new Date().toISOString(),
      items: draft?.items,
    });
  const path = artifact.schema === "lab-manual-confirmation-evaluations-v1"
    ? await saveManualConfirmationEvaluations(artifact, run)
    : await saveManualConfirmationEvaluationsRevision(artifact, run);
  const selection = manualConfirmationEvaluationSelectionForArtifact(artifact);
  console.log(JSON.stringify({
    ok: true,
    path,
    itemCount: artifact.items.length,
    selector: {
      grantId: run.grantId,
      runId: run.runId,
      revision: selection.revision,
      artifactSha256: selection.artifactSha256,
    },
  }, null, 2));
  return 0;
}

function arg(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
