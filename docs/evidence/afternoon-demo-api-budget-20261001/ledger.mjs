import fs from 'node:fs';
const ledger = process.env.DEMO_API_LEDGER || '/tmp/cunote-afternoon-demo-api-budget-20261001.jsonl';
const [command, id, kindOrCost, ...flags] = process.argv.slice(2);
const rows = fs.existsSync(ledger) ? fs.readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const requests = new Map();
for (const row of rows) {
  if (row.action==='reserve') requests.set(row.id,{ ...row, actual:0, unresolved:row.reserve });
  if (row.action==='report') {
    const req=requests.get(row.id);
    if (!req) throw Error('Unknown request');
    req.actual=row.actual;
    req.unresolved=row.reconciled ? 0 : Math.max(0,req.reserve-row.actual);
  }
}
const state=()=>{const all=[...requests.values()]; const reported=all.reduce((n,r)=>n+r.actual,0);const reserved=all.reduce((n,r)=>n+r.unresolved,0);return {ledger,capUsd:20,reportedUsd:reported,unresolvedReservedUsd:reserved,remainingUsd:20-reported-reserved,requests:all};};
const append=(row)=>fs.appendFileSync(ledger,JSON.stringify({at:new Date().toISOString(),...row})+'\n',{mode:0o600});
if(command==='init') {
  if(rows.length) throw Error('Ledger already exists; refusing to reset');
  append({action:'init',capUsd:20});
} else if(command==='reserve') {
  const rates={chat:1.5,field:7,section:7,fieldchat:8.5};
  const reserve=rates[kindOrCost];
  if(!id||requests.has(id)||!reserve) throw Error('Usage: reserve UNIQUE_ID chat|field|section|fieldchat');
  if(!rows.length) throw Error('Initialize first');
  if(reserve>state().remainingUsd+1e-9) throw Error('Budget reservation would exceed $20; do not call API');
  append({action:'reserve',id,kind:kindOrCost,reserve});
  requests.set(id,{id,kind:kindOrCost,reserve,actual:0,unresolved:reserve});
} else if(command==='report') {
  const actual=Number(kindOrCost); const req=requests.get(id);
  if(!req||!Number.isFinite(actual)||actual<0||actual<req.actual) throw Error('Usage: report ID NONDECREASING_USD [--reconciled]');
  if(actual>req.reserve) throw Error('Actual exceeds bound: stop API calls and investigate model/requests');
  const reconciled=flags.includes('--reconciled');
  append({action:'report',id,actual,reconciled});
  req.actual=actual;req.unresolved=reconciled?0:Math.max(0,req.reserve-actual);
} else if(command!=='status') throw Error('Commands: init, reserve, report, status');
console.log(JSON.stringify(state(),null,2));
