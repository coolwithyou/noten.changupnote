import React, {useState} from 'react';
import {WorkspaceView} from '../../apps/web/src/features/apply-workspace/WorkspaceView';
import {workspaceData} from './workspace-data';
import {createRoot} from 'react-dom/client';
import {AppRouterContext} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {CompanyEvidenceSummary} from '../../apps/web/src/features/company-evidence/CompanyEvidenceSummary';
import {CompanyMatchingContext} from '../../apps/web/src/features/match-results/CompanyMatchingContext';
import {ProgramsExperience} from '../../apps/web/src/features/match-results/Programs';
import {ResultsHero} from '../../apps/web/src/features/match-results/ResultsHero';
import {GrantOverviewView} from '../../apps/web/src/features/grant-overview/GrantOverviewView';
import {EligibilityMatchAccordion} from '../../apps/web/src/features/grant-overview/EligibilityMatchAccordion';
import {Accordion} from '../../apps/web/src/components/ui/accordion';
import {ApplicationPipelineView} from '../../apps/web/src/features/applications/ApplicationPipelineView';
import {WritingSectionsPanel} from '../../apps/web/src/features/apply-workspace/WritingSectionsPanel';
const audit:any={requests:[],conflict:false,canWrite:true,applied:[],routes:[]};
(window as any).designAudit=audit;
const router:any={push:(url:string)=>audit.routes.push(url),replace:()=>{},back:()=>{},forward:()=>{},refresh:()=>{},prefetch:()=>{}};
const savedDrafts:Record<string,{text:string,revision:number}>={};
window.fetch=async(input,init)=>{
 const path=String(input),method=init?.method??'GET',body=typeof init?.body==='string'?JSON.parse(init.body):null;
 audit.requests.push({path,method,body});
 if(path.includes('writing-sections')){
 const state=savedDrafts[path]??={text:'사업자 정보에 근거한 검수용 기존 문안',revision:1};
 if(audit.delayRead&&method==='GET')await new Promise(r=>setTimeout(r,400));
 if(method==='PUT'){
 if(audit.conflict)return new Response(JSON.stringify({ok:false,error:{message:'다른 창에서 저장한 문안이 있어요. 최신 저장본과 비교해 주세요.'}}),{status:409});
 state.text=body.text;state.revision++;return new Response(JSON.stringify({ok:true,data:{text:state.text,revision:state.revision}}));}
 return new Response(JSON.stringify({ok:true,data:{canWrite:audit.canWrite,canGenerate:false,consistency:null,sections:[{fieldId:'section-1',label:'사업 개요',guidance:'사업 목적과 고객 문제를 설명하세요.',available:true,revision:state.revision,text:state.text,proposal:null}]}}));}
 if(path.includes('document-drafts')||path.includes('working-document'))return new Response(JSON.stringify({ok:false,error:{message:'합성 fixture에는 원본 HWPX 파일을 연결하지 않았습니다.'}}),{status:404});
 return new Response(JSON.stringify({ok:true,data:{rows:[],total:0,hasMore:false}}));
};
function Harness(){
 const [company,setCompany]=useState('A'); const [scene,setScene]=useState('explore'); const [mode,setMode]=useState('known');
 const name=company==='A'?'합성 테스트 바톤':'합성 테스트 서울기업'; const region=company==='A'?'부산광역시':'서울특별시';
 const trace:any=[{criterionId:'region',dimension:'region',kind:'required',result:company==='A'&&mode!=='failed'?'pass':'fail',label:'부산 소재 기업',sourceSpan:'본점이 부산광역시에 소재한 기업',companyValue:(mode==='failed'?'서울특별시':region)+' · 직접 입력',checklistSection:company==='A'&&mode!=='failed'?'satisfied':'needs_check'}, {criterionId:'revenue',dimension:'revenue',kind:'required',result:'unknown',label:'최근 매출 10억원 이하',sourceSpan:'최근 매출 10억원 이하 기업',unresolvedReason:'company_profile_missing',confirmationNextAction:'company_profile',checklistSection:'needs_check'}, {criterionId:'source',dimension:'other',kind:'exclusion',result:'text_only',label:'중복 지원 제외',sourceSpan:'동일 사업 중복수혜자는 제외할 수 있음',unresolvedReason:'criterion_needs_review',confirmationNextAction:'admin_source_review',checklistSection:'needs_check'}];
 const evidence:any={provider:'manual',source:'manual_profile',cacheStatus:'miss',maskedBizNo:'000-00-*****',checkedAt:'2026-10-01T09:00:00Z',cachedUntil:null,summary:mode==='unknown'?'미확인 정보가 있어요':mode==='partial'?'일부 정보만 확인했어요':mode==='disputed'?'출처 간 정보가 달라 확인이 필요해요':'직접 입력한 회사 정보를 기준으로 대조해요',fields:[{key:'corp_name',label:'회사명',available:true,value:name},{key:'region',label:'소재지',available:mode!=='unknown',value:mode==='unknown'?null:region}]};
 const match:any={grantId:'synthetic-grant',source:'kstartup',sourceId:'synthetic',title:'2026 부산 창업기업 사업화 및 시장 진출 지원사업',agency:'합성 테스트 지원기관',status:'open',eligibility:'conditional',bucket:'conditional',fitScore:null,matchingEvidence:{level:mode==='zero'?'discovery':'verified'},ranking:{relevanceScore:null,priorityScore:null,reasons:[]},supportAmount:{label:'사업화 자금 최대 1억원',max:100000000,unit:'KRW',per:'기업'},benefits:[],applyEnd:null,dDay:12,ruleTrace:trace,matchConfidence:null,rulesetVer:'fixture',scoringVer:'fixture',criteriaExtracted:true,recommendationTier:mode==='zero'?'needs_core_review':'needs_profile_input',reviewReasons:[],authoringMode:'unknown',writeSupport:'unknown',detailUrl:'/grants/synthetic-grant'};
 const profileView:any={asOf:'2026-10-01',knownCount:2,partialCount:1,unknownCount:1,rows:[['region',region,'known'],['industry','소프트웨어 개발','known'],['biz_age','3년 (일부 확인)','partial'],['target_type','법인','known'],['size',null,'unknown']].map(([dimension,displayValue,status])=>({dimension,displayValue:mode==='unknown'?null:displayValue,status:mode==='unknown'?'unknown':status,sourceDisputed:dimension==='target_type'&&mode==='disputed',completeness:status==='partial'?'partial':'complete',sourceLabel:'직접 입력한 합성 정보',asOf:'2026-10-01'}))};
 const teaser:any={profileView,matches:[match],profile:{name,region,businessType:'corporation'},counts:{eligible:0,conditional:1,ineligible:0,deadlineSoon:0},attributes:{region,size:null,bizAgeMonths:36,industry:['소프트웨어']},estimatedMaxAmount:0,conditionalUpside:0,companyEvidence:evidence,nextQuestion:null,searchContext:{evaluatedGrantCount:15},summary:{},};
 const item:any={grantId:'synthetic-closed',title:'마감된 합성 테스트 지원사업',agency:'합성 기관',fitScore:null,eligibility:'conditional',dDay:-16,applyEnd:'2026-09-15',supportLabel:'금액 미확인',stage:'preparing',stageLabel:'준비',lastActionAt:null,draftCount:1,reviewedDraftCount:0,warningCount:0,detailHref:'/grants/synthetic-closed',nextAction:'',assigneeName:null,reminderAt:null,outcomeNote:null,writing:{eligibility:{confirmed:1,total:3,remaining:2,mismatched:0},capability:{originalEdit:true,originalFormat:'hwpx',autofill:null,sectionDrafting:true},completion:{sectionsWritten:2,sectionsTotal:null,factsToReview:1,lastSavedAt:'2026-09-10T03:00:00Z',savedCount:1,closed:true}}};
 return <AppRouterContext.Provider value={router}><div style={{background:'#fff5d8',padding:8,fontSize:12}}>합성 fixture 검증 · 실제 제품 컴포넌트 · 운영 데이터/모델 호출 없음</div><nav style={{display:'flex',gap:8,flexWrap:'wrap',padding:12}}>{['explore','detail','writing','viewer','applications','workspace'].map(s=><button key={s} onClick={()=>{audit.canWrite=s!=='viewer';setScene(s)}}>{s}</button>)}<button onClick={()=>setCompany(company==='A'?'B':'A')}>회사 전환</button>{['known','partial','disputed','unknown','zero','failed'].map(m=><button key={m} onClick={()=>setMode(m)}>{m}</button>)}</nav><main style={{maxWidth:1120,margin:'auto',padding:16}} key={company+scene+mode}>
 {scene==='explore'?<><ResultsHero teaser={teaser} onSave={()=>{}} saving={false} savedCompany companyName={name}/><CompanyMatchingContext profileView={profileView} companyName={name}/><ProgramsExperience teaser={teaser} companyId={'company-'+company} preparing={false} onPrepare={()=>{}} onOpenProfile={()=>{}}/></>:null}
 {scene==='detail'?<GrantOverviewView companyId={'company-'+company} companyName={name} profileView={profileView} draftResume={{savedCount:1,lastSavedAt:new Date('2026-10-01')}} sheet={{grant:{id:match.grantId,title:match.title,agency:match.agency,status:'open',supportAmount:match.supportAmount},schedule:{dDay:12},matchingEvidence:{level:'verified'},satisfied:trace.filter((t:any)=>t.result==='pass'),needsCheck:trace.filter((t:any)=>t.result!=='pass'),deepLink:'https://example.invalid/synthetic',documents:[],sourceAttachments:[],applicationPrep:{draftableDocuments:[{sourceAttachment:"신청서.hwpx",hwpxTemplateAvailable:true}],profileCopyFields:[],planDraftPrompts:[],documentGroups:[],issuableDocuments:[],attachableDocuments:[],missingProfileFields:[]},applyMethod:null} as any}/>:null}
 {scene==='writing'||scene==='viewer'?<WritingSectionsPanel draftId={'draft-'+company} onDirtyChange={()=>{}} {...{presentation:'inline',inspectField:async()=>({beforeText:'양식 기존 문장'}),applySavedText:async(fieldId:string,text:string)=>{audit.applied.push({fieldId,text});}} as any}/>:null}
 {scene==='workspace'?<WorkspaceView data={workspaceData} greeting={{text:'합성 테스트 작성 화면',generalNotice:true}} institutionContact={null}/>:null}
 {scene==='applications'?<ApplicationPipelineView pipeline={{generatedAt:'2026-10-01T09:00:00Z',items:[item],stats:{} as any}}/>:null}
 </main></AppRouterContext.Provider>
}
createRoot(document.getElementById('root')!).render(<Harness/>);
