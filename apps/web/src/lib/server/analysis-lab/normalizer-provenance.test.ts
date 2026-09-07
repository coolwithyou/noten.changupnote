import assert from "node:assert/strict";
import {
  BIZINFO_NORMALIZER_VERSION,
  KSTARTUP_LLM_EXTRACTOR_VERSION,
  LLM_CRITERIA_NORMALIZATION_CONTRACT_VERSION,
} from "@cunote/core";
import { ANALYSIS_LAB_PROMPT_VERSION } from "./lab-contract";
import { resolveGrantRunStates } from "./run-scan-state";

assert.equal(BIZINFO_NORMALIZER_VERSION, "bizinfo-llm-criteria-v3");
assert.equal(KSTARTUP_LLM_EXTRACTOR_VERSION, "kstartup-llm-criteria-v1");
assert.equal(ANALYSIS_LAB_PROMPT_VERSION, "lab-deep-v21");
assert.equal(
  LLM_CRITERIA_NORMALIZATION_CONTRACT_VERSION,
  "grant-llm-criteria-normalization-v1",
);

// 공용 normalizer provenance는 additive다. 기존 자동 재분석 상태는 promptVersion만으로
// 결정되며, normalizer 버전 차이만으로 역사 모델 실행을 다시 열지 않는다.
const states = resolveGrantRunStates([{
  grantId: "same-prompt-old-normalizer",
  promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
  normalizerContractVersion: "legacy-normalizer",
  startedAt: "2026-09-07T00:00:00.000Z",
  identity: "same-prompt.json",
  primaryValidationOutcome: "publishable",
  error: null,
}, {
  grantId: "old-prompt-current-normalizer",
  promptVersion: "lab-deep-v20",
  normalizerContractVersion: LLM_CRITERIA_NORMALIZATION_CONTRACT_VERSION,
  startedAt: "2026-09-07T00:00:00.000Z",
  identity: "old-prompt.json",
  primaryValidationOutcome: "publishable",
  error: null,
}], ANALYSIS_LAB_PROMPT_VERSION);

assert.deepEqual(states.get("same-prompt-old-normalizer")?.state, {
  okCurrent: true,
  okOutdated: false,
  heldCurrent: false,
  errorCurrent: false,
});
assert.deepEqual(states.get("old-prompt-current-normalizer")?.state, {
  okCurrent: false,
  okOutdated: true,
  heldCurrent: false,
  errorCurrent: false,
});

console.log("normalizer provenance tests: ok");
