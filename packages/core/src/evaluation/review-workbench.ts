import { createHash } from "node:crypto";
import type { V3AnnotationRecord, V3GrantAnnotation, V3EligibilityPairAnnotation } from "./v3-annotations.js";
import type { MatchingV3GrantReviewTask } from "./review-packet.js";
import type { MatchingV3PairReviewTask } from "./pair-review-packet.js";

export interface MatchingV3CompanyReviewTask {
  recordType: "company_review_task";
  schemaVersion: "matching-v3-company-review-task-v1";
  companyId: string;
  businessKind: "individual" | "corporation" | "unknown";
  profileDimensionsPresent: string[];
  sourceFixture: string;
  annotationTemplate: Extract<V3AnnotationRecord, { recordType: "company" }>;
}

export function buildMatchingV3CompanyReviewTasks(
  companies: Array<Extract<V3AnnotationRecord, { recordType: "company" }>>,
): MatchingV3CompanyReviewTask[] {
  return companies.map((company) => ({
    recordType: "company_review_task",
    schemaVersion: "matching-v3-company-review-task-v1",
    companyId: company.companyId,
    businessKind: company.businessKind,
    profileDimensionsPresent: Object.keys(company.profile).filter((key) => key !== "id" && key !== "name").sort(),
    sourceFixture: company.sourceFixture,
    annotationTemplate: company,
  }));
}

export function validateIndependentAnnotation(record: V3AnnotationRecord): string[] {
  const errors: string[] = [];
  if (record.recordType === "grant") validateGrant(record, errors);
  if (record.recordType === "eligibility_pair") validatePair(record, errors);
  if (record.recordType === "company" && Object.keys(record.profile).length === 0) errors.push("company profile must not be empty");
  return errors;
}

export function renderMatchingV3ReviewWorkbench(input: {
  companyTasks?: MatchingV3CompanyReviewTask[];
  grantTasks: MatchingV3GrantReviewTask[];
  pairTasks: MatchingV3PairReviewTask[];
  includeHoldout?: boolean;
}): string {
  const selectedPairTasks = input.includeHoldout
    ? input.pairTasks
    : input.pairTasks.filter((task) => task.annotationTemplate.split === "development");
  const pairTasks = selectedPairTasks.map((task) =>
    input.includeHoldout && task.annotationTemplate.split === "holdout"
      ? blindHoldoutPairTask(task)
      : task);
  const packet = {
    schemaVersion: "matching-v3-review-workbench-v1",
    includeHoldout: input.includeHoldout === true,
    companyTasks: input.companyTasks ?? [],
    grantTasks: input.grantTasks,
    pairTasks,
  };
  const packetJson = safeEmbeddedJson(packet);
  const packetId = createHash("sha256").update(packetJson).digest("hex").slice(0, 16);
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:">
<title>창업노트 Matching v3 Review Workbench</title>
<style>
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}header{padding:14px 18px;background:#16213b;color:white;display:flex;gap:12px;align-items:center;flex-wrap:wrap}header h1{font-size:17px;margin:0 auto 0 0}button,input,textarea{font:inherit}button{border:1px solid #b7c0d3;background:white;border-radius:7px;padding:7px 10px;cursor:pointer}button.primary{background:#2563eb;color:white;border-color:#2563eb}button.danger{background:#b42318;color:white;border-color:#b42318}input{border:1px solid #aeb8ca;border-radius:7px;padding:7px}.layout{display:grid;grid-template-columns:330px 1fr;height:calc(100vh - 62px)}aside{border-right:1px solid #d5dbe8;background:white;overflow:auto;padding:12px}.tabs{display:flex;gap:6px;margin-bottom:10px}.tabs button.active{background:#dbeafe;border-color:#60a5fa}.task{display:block;width:100%;text-align:left;margin:5px 0;padding:9px;font-size:12px}.task.active{outline:2px solid #2563eb}.badge{display:inline-block;border-radius:99px;background:#eef2ff;padding:2px 6px;margin-right:4px}.holdout{background:#fee2e2}main{overflow:auto;padding:18px}.card{background:white;border:1px solid #d8deea;border-radius:10px;padding:14px;margin-bottom:12px}h2{font-size:19px;margin:0 0 10px}h3{font-size:14px;margin:0 0 8px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7f8fb;padding:10px;border-radius:7px;font-size:12px;max-height:260px;overflow:auto}textarea{width:100%;min-height:380px;border:1px solid #9ca8bc;border-radius:8px;padding:10px;font-family:ui-monospace,monospace;font-size:12px}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.notice{font-size:12px;color:#526079}.error{color:#b42318;white-space:pre-wrap}.ok{color:#067647}.review-check{display:flex;align-items:center;gap:6px;font-size:13px}@media(max-width:850px){.layout{grid-template-columns:1fr;height:auto}aside{max-height:300px;border-right:0;border-bottom:1px solid #ddd}.grid{grid-template-columns:1fr}}
</style></head><body>
<header><h1>Matching v3 Review Workbench <small>packet ${packetId}</small></h1><label>검수자 ID <input id="identity" placeholder="human-reviewer-id"></label><button id="importBtn">JSONL 가져오기</button><input id="importFile" type="file" accept=".jsonl,.txt" hidden><button id="exportBtn" class="primary">현재 탭 JSONL 내보내기</button></header>
<div class="layout"><aside><div class="tabs"><button data-tab="company" class="active">회사 <span id="companyCount"></span></button><button data-tab="grant">공고 <span id="grantCount"></span></button><button data-tab="pair">판정쌍 <span id="pairCount"></span></button></div><input id="search" placeholder="ID·제목 검색" style="width:100%"><div id="tasks"></div></aside>
<main><div id="empty" class="card">왼쪽에서 검수 항목을 선택하세요.</div><div id="detail" hidden>
<div class="card"><h2 id="title"></h2><div id="meta" class="notice"></div></div>
<div class="grid"><div class="card"><h3>검수 근거</h3><pre id="evidence"></pre></div><div class="card"><h3>엔진 예측</h3><pre id="prediction"></pre></div></div>
<div class="card"><h3>Annotation JSON</h3><textarea id="annotation" spellcheck="false"></textarea><p id="validation" class="notice"></p>
<div class="actions"><label class="review-check"><input id="independentCheck" type="checkbox">예측과 독립적으로 원문·누락 조건을 검토했습니다.</label><button id="annotatedBtn">1차 annotation 완료 표시</button><button id="reviewedBtn" class="danger">독립 reviewer 확정</button></div></div>
</div></main></div>
<script id="packet" type="application/json">${packetJson}</script>
<script>
const packet=JSON.parse(document.getElementById('packet').textContent);const storageKey='cunote-review:${packetId}';
const saved=JSON.parse(localStorage.getItem(storageKey)||'{}');let tab='company',selected=null;
const companyTasks=packet.companyTasks,grantTasks=packet.grantTasks,pairTasks=packet.pairTasks;const key=t=>(t.pairId||t.grantId||t.companyId);const type=t=>t.recordType==='company_review_task'?'company':t.recordType==='grant_review_task'?'grant':'pair';
for(const t of [...companyTasks,...grantTasks,...pairTasks])if(!saved[key(t)])saved[key(t)]=JSON.stringify(t.annotationTemplate,null,2);
const qs=id=>document.getElementById(id);qs('companyCount').textContent='('+companyTasks.length+')';qs('grantCount').textContent='('+grantTasks.length+')';qs('pairCount').textContent='('+pairTasks.length+')';
function tasks(){return tab==='company'?companyTasks:tab==='grant'?grantTasks:pairTasks}function persist(){localStorage.setItem(storageKey,JSON.stringify(saved))}
function renderList(){const q=qs('search').value.toLowerCase();qs('tasks').innerHTML='';for(const t of tasks().filter(x=>JSON.stringify([key(x),x.title||'']).toLowerCase().includes(q))){const b=document.createElement('button');b.className='task'+(selected===key(t)?' active':'');const a=parse(t);b.innerHTML='<span class="badge">'+escape(type(t))+'</span>'+(a&&a.labelStatus==='reviewed'?'<span class="badge">reviewed</span>':'')+(a&&a.split==='holdout'?'<span class="badge holdout">holdout</span>':'')+'<br>'+escape(key(t))+(t.title?'<br>'+escape(t.title):'');b.onclick=()=>select(t);qs('tasks').appendChild(b)}}
function select(t){selected=key(t);qs('empty').hidden=true;qs('detail').hidden=false;qs('title').textContent=t.title||t.pairId||t.companyId;qs('meta').textContent=key(t)+' · '+(t.source||t.businessKind||'');qs('annotation').value=saved[key(t)];qs('independentCheck').checked=false;if(type(t)==='company'){qs('evidence').textContent=JSON.stringify({businessKind:t.businessKind,profileDimensionsPresent:t.profileDimensionsPresent,sourceFixture:t.sourceFixture},null,2);qs('prediction').textContent=JSON.stringify(t.annotationTemplate.profile,null,2)}else if(type(t)==='grant'){qs('evidence').textContent=JSON.stringify({sourceFields:t.sourceFields,attachments:t.attachments,warnings:t.warnings},null,2);qs('prediction').textContent=JSON.stringify(t.predictedCriteria,null,2)}else{qs('evidence').textContent=JSON.stringify({businessKind:t.businessKind,profileDimensionsPresent:t.profileDimensionsPresent,grantSourceRevision:t.grantSourceRevision},null,2);qs('prediction').textContent=t.blindPrediction?'HOLDOUT BLIND — 엔진 예측은 숨겨져 있습니다.':JSON.stringify({eligibility:t.predictedEligibility,trace:t.predictedTrace},null,2)}validate();renderList()}
function currentTask(){return [...companyTasks,...grantTasks,...pairTasks].find(t=>key(t)===selected)}function parse(t){try{return JSON.parse(saved[key(t)])}catch{return null}}
function errors(a,t){const e=[];if(!a||typeof a!=='object')return['JSON object가 아닙니다.'];if(type(t)==='company'){if(a.companyId!==t.companyId)e.push('companyId 변경 금지');if(!a.profile||Object.keys(a.profile).length===0)e.push('company profile은 비어 있을 수 없습니다.');if(a.businessKind==='unknown')e.push('businessKind를 individual/corporation으로 확정하세요.')}else if(type(t)==='grant'){if(a.grantId!==t.grantId)e.push('grantId 변경 금지');if(a.sourceRevision!==t.annotationTemplate.sourceRevision)e.push('sourceRevision 변경 금지');for(const c of a.criteria||[]){if(String(c.note||'').includes('PREDICTION_'))e.push(c.criterionId+': prediction note를 실제 검수 메모로 교체하세요.');if(c.operator!=='text_only'&&!c.sourceSpan)e.push(c.criterionId+': structured criterion sourceSpan 필요')}}else{if(a.pairId!==t.pairId)e.push('pairId 변경 금지');if(!['eligible','conditional','ineligible'].includes(a.expectedEligibility))e.push('expectedEligibility를 독립 판정하세요.');if(String(a.note||'').includes('ENGINE_PREDICTION'))e.push('pair note를 독립 판정 근거로 교체하세요.');if(typeof a.resolvableByProfileInput!=='boolean')e.push('resolvableByProfileInput을 true/false로 확정하세요.')}return e}
function validate(){const t=currentTask();if(!t)return;try{const a=JSON.parse(qs('annotation').value);const e=errors(a,t);qs('validation').className=e.length?'error':'ok';qs('validation').textContent=e.length?e.join('\\n'):'JSON 및 독립 검수 필수값 확인됨'}catch(err){qs('validation').className='error';qs('validation').textContent='JSON 오류: '+err.message}}
qs('annotation').oninput=()=>{if(!selected)return;saved[selected]=qs('annotation').value;persist();validate()};qs('search').oninput=renderList;
for(const b of document.querySelectorAll('[data-tab]'))b.onclick=()=>{tab=b.dataset.tab;selected=null;qs('detail').hidden=true;qs('empty').hidden=false;for(const x of document.querySelectorAll('[data-tab]'))x.classList.toggle('active',x===b);renderList()};
function applyRole(role){const t=currentTask(),id=qs('identity').value.trim();if(!t||!id)return alert('검수자 ID를 입력하세요.');if(!qs('independentCheck').checked)return alert('독립 검토 확인란을 체크하세요.');let a;try{a=JSON.parse(qs('annotation').value)}catch{return alert('JSON 오류를 먼저 수정하세요.')}const e=errors(a,t);if(e.length)return alert(e.join('\\n'));const now=new Date().toISOString();if(role==='annotator'){a.labelStatus='draft';a.annotatorId=id;a.annotatedAt=now;a.reviewerId=null;a.reviewedAt=null}else{if(!a.annotatorId||!a.annotatedAt)return alert('1차 annotator 정보가 필요합니다.');if(String(a.annotatorId).toLowerCase()===id.toLowerCase())return alert('reviewer는 annotator와 달라야 합니다.');if(/(^|[^a-z])(ai|llm|gpt|claude|codex|gemini|anthropic|openai)([^a-z]|$)/i.test(id))return alert('사람 reviewer 식별자를 사용하세요.');a.labelStatus='reviewed';a.reviewerId=id;a.reviewedAt=now}saved[key(t)]=JSON.stringify(a,null,2);qs('annotation').value=saved[key(t)];persist();validate();renderList()}
qs('annotatedBtn').onclick=()=>applyRole('annotator');qs('reviewedBtn').onclick=()=>applyRole('reviewer');
qs('exportBtn').onclick=()=>{const lines=[];for(const t of tasks()){try{const a=JSON.parse(saved[key(t)]);lines.push(JSON.stringify(a))}catch{return alert(key(t)+' JSON 오류')}}const blob=new Blob([lines.join('\\n')+'\\n'],{type:'application/x-ndjson'});const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='matching-v3-'+tab+'-annotations.jsonl';a.click();URL.revokeObjectURL(u)};
qs('importBtn').onclick=()=>qs('importFile').click();qs('importFile').onchange=async e=>{const text=await e.target.files[0].text();for(const line of text.split(/\\r?\\n/).filter(Boolean)){const a=JSON.parse(line),id=a.pairId||a.grantId||a.companyId;if(saved[id]!==undefined)saved[id]=JSON.stringify(a,null,2)}persist();if(selected){const t=currentTask();select(t)}renderList()};
function escape(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}renderList();
</script></body></html>`;
}

function blindHoldoutPairTask(task: MatchingV3PairReviewTask): Record<string, unknown> {
  const { predictedEligibility: _predictedEligibility, predictedTrace: _predictedTrace, ...safeTask } = task;
  return {
    ...safeTask,
    blindPrediction: true,
    annotationTemplate: {
      ...task.annotationTemplate,
      expectedEligibility: null,
      hardFailCriterionIds: [],
      unknownCriterionIds: [],
    },
  };
}

function validateGrant(record: V3GrantAnnotation, errors: string[]): void {
  for (const criterion of record.criteria) {
    if (criterion.note?.includes("PREDICTION_")) errors.push(`${criterion.criterionId}: prediction note remains`);
    if (criterion.operator !== "text_only" && !criterion.sourceSpan?.trim()) errors.push(`${criterion.criterionId}: structured criterion sourceSpan required`);
  }
}
function validatePair(record: V3EligibilityPairAnnotation, errors: string[]): void {
  if (record.note.includes("ENGINE_PREDICTION")) errors.push(`${record.pairId}: independent review note required`);
  if (typeof record.resolvableByProfileInput !== "boolean") errors.push(`${record.pairId}: resolvableByProfileInput must be decided`);
  const hardFails = new Set(record.hardFailCriterionIds);
  for (const criterionId of record.unknownCriterionIds) if (hardFails.has(criterionId)) errors.push(`${record.pairId}: criterion cannot be hard-fail and unknown`);
}
function safeEmbeddedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
