import { buildKStartupCriteria } from "@cunote/core";
import fs from "node:fs";
const rows = fs.readFileSync("apps/web/src/lib/server/ingestion/.renorm-analysis/structured.jsonl","utf8").trim().split("\n").map(s=>JSON.parse(s));
const targets = ["173273","173390","172414"];
for (const id of targets) {
  const r = rows.find((x:any)=>x.sourceId===id);
  if(!r){console.log(id,"not in structured");continue;}
  const row:any = { pbanc_sn: Number(id), aply_trgt_ctnt: r.applyText, aply_excl_trgt_ctnt: r.exclText };
  const crit = buildKStartupCriteria(row);
  const ind = crit.find((c:any)=>c.dimension==="industry");
  console.log("=== id",id, r.ruleLabel);
  console.log("  operator:", ind?.operator, "codes:", JSON.stringify((ind?.value as any)?.codes));
  console.log("  source_span:", (ind?.source_span||"").slice(0,140));
  const GUARD=/제외|불가|우대|가점|가산|해당\s*없/;
  console.log("  span has guard kw:", GUARD.test(ind?.source_span||""));
}
