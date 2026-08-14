import { prepareLabAnalysis } from "./analyze";
import { selectDeepRepairPlanningTargets } from "./cohort";
import {
  createDeepRepairProposalFilesystemWriter,
  createDeepRepairProposalPreparer,
  type DeepRepairProposalPreparationResult,
} from "./deep-repair-preparation";
import { readDeepRepairHistoricalGrantIds } from "./deep-repair-preparation-history";
import { readCurrentDeepRepairExecutionProvenance } from "./deep-repair-runtime-provenance";

const preparer = createDeepRepairProposalPreparer({
  now: () => new Date(),
  readExecutionProvenance: readCurrentDeepRepairExecutionProvenance,
  listExcludedGrantIds: () => readDeepRepairHistoricalGrantIds({ scope: "formal-baseline" }),
  async selectTargets({ excludedGrantIds }) {
    return selectDeepRepairPlanningTargets({
      excludeGrantIds: excludedGrantIds,
    });
  },
  async prepareTarget(grantId) {
    const prepared = await prepareLabAnalysis(grantId);
    return {
      grantId: prepared.grant.id,
      source: prepared.grant.source,
      title: prepared.grant.title,
      inputSha256: prepared.input.inputSha256,
      attachmentManifestSha256: prepared.input.attachmentManifestSha256,
      inputTotalChars: prepared.input.totalChars,
      inputBlocks: prepared.input.blocks,
    };
  },
  writeImmutableArtifact: createDeepRepairProposalFilesystemWriter(),
});

/** 모델·runtime lease·운영 조회 없이 deep-v18 proposal artifact만 준비한다. */
export function prepareCurrentDeepRepairProposal(input: {
  readonly seriesId: "deep-v18";
}): Promise<DeepRepairProposalPreparationResult> {
  return preparer.prepare(input);
}
