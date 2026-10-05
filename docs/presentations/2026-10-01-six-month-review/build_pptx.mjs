// Editable slides from the same source/deck.json as the offline presentation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const workspaceDir=path.dirname(fileURLToPath(import.meta.url));
const {RUNTIME_NODE_MODULES,RUNTIME_PYTHON,SKILL_DIR}=process.env;
if(!RUNTIME_NODE_MODULES||!RUNTIME_PYTHON||!SKILL_DIR)throw new Error('Set bundled RUNTIME_NODE_MODULES, RUNTIME_PYTHON and presentations SKILL_DIR.');
const {importRuntimeModule}=await import(pathToFileURL(path.join(SKILL_DIR,'container_tools/runtime_helpers.mjs')));
const {Presentation,PresentationFile}=await importRuntimeModule('@oai/artifact-tool');
const {createCanvas,GlobalFonts}=await importRuntimeModule('@napi-rs/canvas');
const {finalizePresentation}=await import(pathToFileURL(path.join(SKILL_DIR,'container_tools/artifact_tool_utils.mjs')));
const family='Apple SD Gothic Neo';
if(!GlobalFonts.families.some(f=>f.family===family))throw new Error('Required Korean font unavailable');
const canvas=createCanvas(1,1),ctx=canvas.getContext('2d');
const C={blue:'#3182f6',blueLight:'#e8f3ff',ink:'#191f28',text:'#333d4b',muted:'#6b7684',line:'#e5e8eb',soft:'#f9fafb',white:'#ffffff'};
const deck=JSON.parse(await fs.readFile(path.join(workspaceDir,'source/deck.json'),'utf8'));
const git=JSON.parse(await fs.readFile(path.join(workspaceDir,'source/git-history.json'),'utf8'));
const smap=new Map(git.commits.map(c=>[c.sha.slice(0,7),c.sha]));
const p=Presentation.create({slideSize:{width:1280,height:720}});
const geometry=[];
function box(slide,x,y,w,h,color,r=0){return slide.shapes.add({geometry:'rect',position:{left:x,top:y,width:w,height:h},fill:color,line:{fill:'none',width:0},borderRadius:r});}
function wrap(text,width,size,bold){ctx.font=`${bold?'700':'400'} ${size}px "${family}"`;return String(text).split('\n').map(para=>{const words=para.split(' '),lines=[];let line='';for(const word of words){const test=line?line+' '+word:word;if(ctx.measureText(test).width>width*.97&&line){lines.push(line);line=word;}else line=test;}if(line)lines.push(line);return lines.join('\n');}).join('\n');}
function text(slide,value,x,y,w,h,size=24,bold=false,color=C.text,align='left'){
 const content=wrap(value,w,size,bold),n=content.split('\n').length;
 if(n*size*1.18>h)throw new Error(`Text frame too small: ${value.slice(0,40)} needs ${n*size*1.18}, h=${h}`);
 const s=slide.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
 s.text=content;s.text.style={typeface:family,fontSize:size,bold,color,alignment:align,verticalAlignment:'top',autoFit:'none',wrap:'none',insets:{top:0,bottom:0,left:0,right:0}};
 geometry.push({slide:p.slides.items.length,text:value,lines:n,x,y,w,h,size});return s;
}
function url(s){if(s.startsWith('https://'))return s;if(smap.has(s))return 'https://github.com/coolwithyou/noten.changupnote/commit/'+smap.get(s);if(s.includes(':')){const [ref,...a]=s.split(':');return 'https://github.com/coolwithyou/noten.changupnote/blob/'+ref+'/'+a.join(':');}return 'Local source: '+s;}
for(let i=0;i<deck.length;i++){
 const d=deck[i],s=p.slides.add();s.background.fill=C.white;
 if(d.kind==='cover'){
  text(s,d.subtitle,72,60,1100,40,22,false,C.muted);
  text(s,d.title,72,195,1120,190,64,true,C.ink);
  text(s,d.tag,72,440,1100,75,28,false,C.blue);
  box(s,72,570,560,14,C.blue,7);
 }else{
  text(s,d.title,72,52,1136,74,43,true,C.ink);
  text(s,d.subtitle,72,133,1136,56,22,false,C.muted);
  const its=d.items,n=its.length;
  if(['scope','metric','pilot','split'].includes(d.kind)){
   const gap=24,w=(1136-gap*(n-1))/n,y=235;
   its.forEach((a,j)=>{const x=72+j*(w+gap);box(s,x,y,w,315,C.soft,24);
    const isBig=['scope','metric'].includes(d.kind),fs=isBig?(a[0].length>9?40:60):30;
    text(s,a[0],x+28,y+38,w-56,isBig?100:92,fs,true,isBig?C.blue:C.ink);
    text(s,a[1],x+28,y+(isBig?158:153),w-56,140,25,false,C.muted);
   });
  }else if(d.kind==='quote'){
   text(s,d.highlight,72,214,1100,158,50,true,C.blue);
   const gap=30,w=(1136-gap*(n-1))/n;
   its.forEach((a,j)=>{const x=72+j*(w+gap);text(s,a[0],x,415,w,52,25,true,C.ink);text(s,a[1],x,476,w,115,23,false,C.muted);});
  }else if(['timeline','flow'].includes(d.kind)){
   const gap=24,w=(1136-gap*(n-1))/n;
   its.forEach((a,j)=>{const x=72+j*(w+gap),[label,title,desc]=a.length===3?a:['',a[0],a[1]];box(s,x,245,w,5,C.blue);text(s,label,x,278,w,48,18,false,C.muted);text(s,title,x,348,w,92,31,true,C.ink);text(s,desc,x,468,w,115,23,false,C.muted);});
  }else if(d.kind==='weekly'){
   its.forEach((a,j)=>{const y=213+j*143;text(s,a[0],72,y,155,40,20,true,C.blue);text(s,a[1],244,y,964,47,27,true,C.ink);text(s,a[2],244,y+51,964,82,22,false,C.muted);if(j<n-1)box(s,72,y+133,1136,1,C.line);});
  }else{
   const height=n===4?99:121;
   its.forEach((a,j)=>{const y=228+j*height;text(s,a[0],72,y,304,height-15,25,true,C.ink);text(s,a[1],402,y,806,height-15,25,false,C.muted);if(j<n-1)box(s,72,y+height-15,1136,1,C.line);});
  }
 }
 const foot=d.foot||'창업노트 6개월 회고 · 기록 기준 2026-10-01';
 text(s,foot,72,653,1020,43,14,false,C.muted);
 text(s,`${String(i+1).padStart(2,'0')} / ${deck.length}`,1120,653,88,32,14,false,C.muted,'right');
 s.speakerNotes.textFrame.setText(d.notes+'\n\n출처\n'+d.sources.map(url).join('\n')+'\n\nTDS Colors: https://tossmini-docs.toss.im/tds-mobile/foundation/colors/\nTDS Typography: https://tossmini-docs.toss.im/tds-mobile/foundation/typography/\n폰트: Apple SD Gothic Neo (로컬 사용 가능 폰트).');
}
const stagingDir=process.env.BUILD_DIR||path.join(workspaceDir,'.build');await fs.mkdir(stagingDir,{recursive:true});
const candidatePath=path.join(stagingDir,'candidate.pptx'),finalPath=path.join(stagingDir,'output',process.env.PPTX_NAME||'review.pptx');
await fs.mkdir(path.dirname(finalPath),{recursive:true});
await (await PresentationFile.exportPptx(p)).save(candidatePath);
await fs.writeFile(path.join(stagingDir,'authored-geometry.json'),JSON.stringify(geometry,null,2));
await finalizePresentation({workspaceDir,candidatePath,finalPath,pythonExecutable:RUNTIME_PYTHON,integrityValidatorPath:path.join(SKILL_DIR,'container_tools/inspect_presentation_package_integrity.py'),layoutValidatorPath:path.join(SKILL_DIR,'container_tools/inspect_presentation_layout_geometry.py'),layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit'],explicitTotalSlideCount:deck.length,requiredNativeTableOwnerSlides:[],requiredNativeChartOwnerSlides:[],fontPolicy:{basis:'design',families:[family]},verifyArtifactToolImport:true,receiptPath:path.join(stagingDir,'validation.json')});
await fs.copyFile(finalPath,path.join(workspaceDir,process.env.PPTX_NAME||'review.pptx'));
console.log(JSON.stringify({finalPath,slides:deck.length,font:family}));
