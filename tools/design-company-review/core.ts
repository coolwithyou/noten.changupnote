// Browser-safe exports of the exact production core implementations.
export {explainMatch,explainCondition} from '../../packages/core/src/use-cases/match-explanation';
export {projectDiscoveryCard} from '../../packages/core/src/matching/discovery-policy';
export {answerableHardUnknownDimensions,hasUnanswerableHardUnknown,isPreparableMatchCard} from '../../packages/core/src/use-cases/select-match-cards';
export {DISQUALIFICATION_FLAG_LABELS,DISQUALIFICATION_QUESTIONS} from '../../packages/core/src/disqualification/canonical';
