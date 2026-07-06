const fs=require("fs");
const rows=fs.readFileSync("structured.jsonl","utf8").trim().split("\n").map(JSON.parse);
const RULES=[
  {label:"소프트웨어업",codes:["582","62"],kw:/소프트웨어|SW\s*기업/},
  {label:"정보통신업",codes:["J"],kw:/정보통신업/},
  {label:"음식점업",codes:["56"],kw:/음식점|외식업|요식업/},
  {label:"관광·숙박업",codes:["55","752"],kw:/관광|숙박업|호텔업/},
  {label:"제조업",codes:["C"],kw:/제조업|제조업체/},
  {label:"건설업",codes:["F"],kw:/건설업/},
  {label:"도매 및 소매업",codes:["G"],kw:/도소매업|도매업|소매업/},
  {label:"농업·임업·어업",codes:["A"],kw:/농업|농생명|임업|어업/},
];
const ANY=/전\s*분야|모든\s*분야|분야\s*(?:제한|상관)\s*(?:없|무관)|분야\s*불문|분야\s*(?:제한\s*)?없|업종\s*(?:제한\s*(?:은|이)?\s*)?(?:없|무관|상관\s*없|불문)|모든\s*업종|전\s*업종|전업종|전\s*산업|모든\s*창업/;
const NEG=/제외|제한|불가|불허|우대|가점|가산|해당\s*없|예외|허용|환영|이외|아닌|없는\s*자|없어야|없을|불문|무관|관심\s*(?:이|을)?\s*(?:있|많)|관계자|참관|수강|교육생|이수|누구나/;
const HWSW=/하드웨어\s*[·,]?\s*(?:및|또는)?\s*소프트웨어|소프트웨어\s*[·,]?\s*(?:및|또는)?\s*하드웨어/;
const GENERIC=/^(창업|기업|사업|산업|취업|졸업|작업|부업|분업|협업|동업|개업|폐업|휴업|조업|파업|실업|수업|종업|잔업|가업|생업|본업|현업|영업|기업체|대기업|중기업|소기업)$/;
function segs(raw){
  return raw.split(/\r?\n/).flatMap(l=>l.split(/(?=[▷▶►○◦∙※□▢◎●■◆]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]|\s[-–—]\s|\s\*\s)/))
    .map(s=>s.replace(/\s+/g," ").trim()).filter(Boolean);
}
function distinctUp(win){
  const set=new Set();
  for(const m of win.matchAll(/[가-힣]{2,}?업(?![가-힣])/g)){ if(!GENERIC.test(m[0])) set.add(m[0]); }
  return set;
}
function posTemplate(seg,kw){
  const m=seg.match(kw); if(!m)return false;
  const i=m.index,K=m[0];
  const after=seg.slice(i+K.length,i+K.length+14);
  if(/^\s*등/.test(after))return false;
  if(/(을|를|은|는|이|가)?\s*영위/.test(after))return true;
  if(/(관련\s*)?(창업|예비창업|기창업|초기창업)/.test(after))return true;
  if(/(관련\s*)?(기업|사업체|소공인|스타트업|사업자(?!등록))/.test(after))return true;
  if(/(관련\s*)?분야[가-힣\s]{0,10}(창업|예비|기업|사업자|모집|대상|소재|영위|희망|아이템|아이디어)/.test(after))return true;
  const before=seg.slice(Math.max(0,i-14),i);
  if(/(소재|지역|거주)/.test(before)&&/(기업|사업체|스타트업|예비창업|창업자|분야)/.test(after))return true;
  return false;
}
function listSignal(seg,kw){
  const m=seg.match(kw); if(!m)return false;
  const i=m.index,K=m[0];
  const pre=seg.slice(Math.max(0,i-4),i), post=seg.slice(i+K.length,i+K.length+4);
  if(/[,]\s*$/.test(pre)||/\s\/\s*$/.test(pre))return true;          // comma/slash before
  if(/^\s*[,]/.test(post)||/^\s*\/\s/.test(post))return true;         // comma/slash after
  if(/·\s*$/.test(pre))return true;                                    // middot list (K not first)
  if(/(및|또는)\s*$/.test(pre))return true;                            // conjunction before K
  for(const pm of seg.matchAll(/\([^)]*\)/g)){ if(i>=pm.index&&i<pm.index+pm[0].length&&/[,·/]/.test(pm[0]))return true; }
  if(/및\s*[가-힣]+\s*(분야|기업|산업|콘텐츠|서비스업)/.test(seg))return true;
  return false;
}
function classify(rawApply){
  if(!rawApply.trim())return{o:"placeholder",reason:"empty"};
  if(ANY.test(rawApply.replace(/\s+/g," ")))return{o:"nationwide"};
  const S=segs(rawApply);
  for(const rule of RULES){
    for(let i=0;i<S.length;i++){
      if(!rule.kw.test(S[i]))continue;
      const win=[S[i-1],S[i]].filter(Boolean).join(" ⏎ ");
      if(RULES.filter(r=>r.kw.test(win)).length>=2)continue;
      if(distinctUp(win).size>=2)continue;
      if(NEG.test(win))continue;
      if(rule.label==="소프트웨어업"&&HWSW.test(win))continue;
      if(listSignal(S[i],rule.kw))continue;
      if(!posTemplate(S[i],rule.kw))continue;
      return{o:"structured",label:rule.label,codes:rule.codes,seg:S[i]};
    }
  }
  return{o:"placeholder"};
}
const out={structured:0,nationwide:0,placeholder:0};
const kept=[];
for(const r of rows){const c=classify(r.rawApply);out[c.o]++;if(c.o==="structured")kept.push({id:r.sourceId,label:c.label,seg:c.seg});}
console.log("of current 467 → new:",JSON.stringify(out));
const byl={};for(const k of kept)byl[k.label]=(byl[k.label]||0)+1;
console.log("kept by label:",JSON.stringify(byl));
fs.writeFileSync("proto-kept.json",JSON.stringify(kept,null,1));
console.log("kept total:",kept.length);
