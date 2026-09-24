import assert from 'node:assert/strict';
import {assertAppliedReplacementItem,isPreparedAncestorOfReplacement} from './promotion-replacement';
import type {PromotionReleaseManifest} from './promotion-release';
const good={releaseStatus:'active',itemStatus:'applied',ledgerManifestSha256:'a'.repeat(64),manifestSha256:'a'.repeat(64),ledgerRunId:'old',manifestRunId:'old',afterSha256:'b'.repeat(64),currentSha256:'b'.repeat(64)};
assert.doesNotThrow(()=>assertAppliedReplacementItem(good));
for(const change of [{releaseStatus:'applying'},{releaseStatus:'rolling_back'},{itemStatus:'failed'},{ledgerManifestSha256:'c'.repeat(64)},{ledgerRunId:'other'},{afterSha256:null},{currentSha256:'d'.repeat(64)}]){
 assert.throws(()=>assertAppliedReplacementItem({...good,...change}));
}
const old={cohortLabel:'original',revision:1,plans:[{grantId:'g',promotionPlan:{runId:'old'}}]} as PromotionReleaseManifest;
const active={...old,revision:2};
assert.equal(isPreparedAncestorOfReplacement(old,active),true);
assert.equal(isPreparedAncestorOfReplacement({...old,plans:[...old.plans,{...old.plans[0]!,grantId:'held-and-excluded'}]},active),true,
 'an applied subset proves the overlapping target is no longer an outstanding prepared reservation');
assert.equal(isPreparedAncestorOfReplacement({...old,revision:2},active),false);
assert.equal(isPreparedAncestorOfReplacement({...old,cohortLabel:'unrelated'},active),false);
assert.equal(isPreparedAncestorOfReplacement({...old,plans:[]},active),false);
assert.equal(isPreparedAncestorOfReplacement({...old,plans:[{...old.plans[0]!,promotionPlan:{...old.plans[0]!.promotionPlan,runId:'different'}}]},active),false);
console.log('promotion-replacement: passed');
