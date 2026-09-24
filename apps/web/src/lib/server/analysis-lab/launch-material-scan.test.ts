import assert from 'node:assert/strict';
import { matchesLabRunMaterialBinding, resolveLabBatchRunScan } from './batch-runner';
import { partitionCohortEntries } from './batch-plan';
import { ANALYSIS_LAB_PROMPT_VERSION } from './lab-contract';
const grantId = '465e05fe-0895-4484-97fe-6bd9b4261292';
const binding = {inputSha256:'a'.repeat(64),attachmentManifestSha256:'b'.repeat(64)};
const expected = new Map([[grantId,binding]]);
const base = {grantId,promptVersion:ANALYSIS_LAB_PROMPT_VERSION,startedAt:'2026-09-24T00:00:00.000Z',identity:'source/run.json',primaryValidationOutcome:'publishable',error:null,...binding};
const partition = (records: typeof base[]) => partitionCohortEntries([{grantId}],
  resolveLabBatchRunScan(records.filter(run=>matchesLabRunMaterialBinding(run,expected))).states,
  {retryErrors:false,reanalyzeOutdated:false});
assert.equal(partition([{...base,inputSha256:'c'.repeat(64)}]).pending.length,1,'a success before notice recovery must not skip the new input');
assert.equal(partition([{...base,attachmentManifestSha256:'c'.repeat(64)}]).pending.length,1,'attachment drift must not reuse success');
assert.equal(partition([base]).skippedOk.length,1,'identical successful material must still skip');
assert.equal(partition([{...base,primaryValidationOutcome:'held'}]).skippedHeld.length,1,'identical held material must not be rerun as new');
assert.equal(matchesLabRunMaterialBinding({grantId},expected),false,'unbound historical rows cannot prove current input completion');
assert.equal(matchesLabRunMaterialBinding({...base,grantId:'another'},expected),false);
console.log('launch-material-scan: passed');
