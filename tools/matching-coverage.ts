/** Offline evaluation of an exact sampled inventory. No DB, model, or customer writes.
 * The sample file binds grant IDs to prepared source SHA, split and source evidence.
 * Repeat with a fresh serving snapshot and the same sources/profile/date to measure change. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {buildCoveragePredictions,coverageCompanies,evaluateCoverage,coverageSha,type CoverageReview} from '../packages/core/src/evaluation/matching-coverage';
import type {NormalizedGrant} from '@cunote/contracts';
function argument(name:string,required=true){
 const values=process.argv.slice(2).filter(a=>a.startsWith(`--${name}=`));
 if(values.length>1 || required&&values.length!==1) throw Error(`--${name}= required exactly once`);
 return values[0]?.slice(name.length+3);
}
const snapshot=JSON.parse(readFileSync(argument('snapshot')!,'utf8')) as {grants:NormalizedGrant[]};
const sample=JSON.parse(readFileSync(argument('sample')!,'utf8')) as {asOf:string;rows:Array<{id:string;inputSha256:string;split:string;sourceEvidence:string}>};
const output=argument('output')!;
const reviewPath=argument('reviews',false);
const byId=new Map(snapshot.grants.map(g=>[g.grant.id,g]));
const companies=coverageCompanies();
const grants=sample.rows.map(r=>{const g=byId.get(r.id);if(!g)throw Error(`sample grant missing: ${r.id}`);return g;});
const sourceSha256ByGrantId=Object.fromEntries(sample.rows.map(r=>[r.id,r.inputSha256]));
const predictions=buildCoveragePredictions({grants,companies,asOf:new Date(sample.asOf),sourceSha256ByGrantId});
const reviews:CoverageReview[]=reviewPath?JSON.parse(readFileSync(reviewPath,'utf8')):[];
const count=(items:string[])=>items.reduce<Record<string,number>>((a,k)=>(a[k]=(a[k]??0)+1,a),{});
const report={schema:'matching-coverage-report-v1',asOf:sample.asOf,sampleSha256:coverageSha(sample),
 populationInference:false,companyCount:companies.length,grantCount:grants.length,
 ...evaluateCoverage(predictions,reviews),tiers:count(predictions.map(p=>p.tier)),
 perCompany:companies.map(c=>({id:c.id,...evaluateCoverage(predictions.filter(p=>p.companyId===c.id),reviews.filter(r=>r.pairId.endsWith(`::${c.id}`)))})),
 limitations:['synthetic company profiles; not live customer acceptance','independent source labels required for quality metrics','stratified diagnostic sample; not population prevalence'],modelCalls:0,serviceWrites:0};
mkdirSync(output,{recursive:false});
writeFileSync(join(output,'predictions.json'),JSON.stringify(predictions,null,2),{flag:'wx'});
writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});
writeFileSync(join(output,'companies.json'),JSON.stringify(companies,null,2),{flag:'wx'});
// Blank expected labels; independent reviewers receive source evidence separately from predictions.
writeFileSync(join(output,'review-packet.json'),JSON.stringify(predictions.map(p=>({pairId:p.pairId,inputSha256:p.inputSha256,
 split:sample.rows.find(r=>r.id===p.grantId)!.split,expected:null,sourceEvidence:sample.rows.find(r=>r.id===p.grantId)!.sourceEvidence,reviewer:null})),null,2),{flag:'wx'});
console.log(JSON.stringify(report,null,2));
