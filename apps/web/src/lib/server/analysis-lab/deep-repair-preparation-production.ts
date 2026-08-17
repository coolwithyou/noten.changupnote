import { prepareLabAnalysis } from "./analyze";
import { selectDeepRepairPlanningTargets } from "./cohort";
import {
  createDeepRepairProposalFilesystemWriter,
  createDeepRepairProposalPreparer,
  type DeepRepairProposalPreparationResult,
} from "./deep-repair-preparation";
import { readDeepRepairHistoricalGrantIds } from "./deep-repair-preparation-history";
import { readCurrentDeepRepairExecutionProvenance } from "./deep-repair-runtime-provenance";
import {
  ACTIVE_DEEP_REPAIR_SERIES_ID,
  DEEP_REPAIR_PLANNING_PRIMARY_SEED,
  DEEP_REPAIR_PLANNING_SUPPLEMENTAL_SEED,
} from "./deep-repair-formal-policy";
import { prioritizeDeepRepairPlanningTargetsForKordoc } from "./deep-repair-kordoc-priority-production";

const preparer = createDeepRepairProposalPreparer({
  now: () => new Date(),
  readExecutionProvenance: readCurrentDeepRepairExecutionProvenance,
  listExcludedGrantIds: () => readDeepRepairHistoricalGrantIds({ scope: "all" }),
  async selectTargets({ excludedGrantIds }) {
    const [primary, supplemental] = await Promise.all([
      selectDeepRepairPlanningTargets({
        excludeGrantIds: excludedGrantIds,
        seed: DEEP_REPAIR_PLANNING_PRIMARY_SEED,
      }),
      selectDeepRepairPlanningTargets({
        excludeGrantIds: excludedGrantIds,
        seed: DEEP_REPAIR_PLANNING_SUPPLEMENTAL_SEED,
      }),
    ]);
    const seen = new Set<string>();
    const targets = [...primary.targets, ...supplemental.targets].filter((target) => {
      if (seen.has(target.grantId)) return false;
      seen.add(target.grantId);
      return true;
    });
    return prioritizeDeepRepairPlanningTargetsForKordoc({
      ...primary,
      targets,
      warnings: primary.warnings.filter((warning) => !warning.startsWith("쿼터 미충족")),
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

/** 모델·runtime lease·운영 조회 없이 현재 formal series proposal artifact만 준비한다. */
export function prepareCurrentDeepRepairProposal(input: {
  readonly seriesId: typeof ACTIVE_DEEP_REPAIR_SERIES_ID;
}): Promise<DeepRepairProposalPreparationResult> {
  return preparer.prepare(input);
}
