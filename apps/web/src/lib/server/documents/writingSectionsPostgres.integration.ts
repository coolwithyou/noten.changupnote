import assert from "node:assert/strict";
import type postgres from "postgres";
import type { CompanyAccess } from "../auth/companyGuard";
import { loadWritingSections, requestWritingSection, saveWritingSection } from "./writingSections";
import { createWritingSource, saveWritingBrief, withdrawWritingSource } from "./writingContext";
import { emptyWritingBrief } from "@/lib/documents/writingContext";
import type { SectionComposerResult } from "./sectionComposer";

/** 기존 격리 runner 연결에서만 실행. 모델·R2·실제 회사 자료를 사용하지 않는다. */
export async function verifyWritingSectionsPostgres(input: { admin: postgres.Sql; client: postgres.Sql; access: CompanyAccess }) {
  const { admin, client, access } = input;
  const grantId = crypto.randomUUID(), draftId = crypto.randomUUID(), fieldId = crypto.randomUUID();
  await admin`insert into grants(id,source,source_id,title,status,overall_confidence)
    values (${grantId},'bizinfo',${grantId},'문안 격리 검증','closed',1)`;
  const surfaceId = crypto.randomUUID();
  await admin`insert into grant_application_surfaces(id,grant_id,source,source_id,type,title,format)
    values (${surfaceId},${grantId},'bizinfo',${grantId},'file_template','문안 양식','hwpx')`;
  await admin`insert into grant_document_drafts
    (id,grant_id,company_id,user_id,surface_id,document_key,document_category,document_name,draft_markdown,filled_fields,missing_fields,used_profile_fields,assumptions,warnings,status,model_ver,prompt_ver,parser_version)
    values (${draftId},${grantId},${access.companyId},${access.userId},${surfaceId},${draftId},'business_plan','문안 검증','','{}','[]','[]','[]','[]','draft','fixture','fixture','fixture')`;
  await admin`insert into grant_document_fields(id,grant_id,surface_id,source,source_id,document_category,document_name,field_key,label,field_type,fill_strategy,confidence,parser_version)
    values (${fieldId},${grantId},${surfaceId},'bizinfo',${grantId},'business_plan','양식','plan','사업 목표','long_text','llm',1,'fixture')`;
  const context = { access, draftId };
  assert.equal((await loadWritingSections(context)).sections[0]?.revision, 0);
  // native revision/입력 위치가 없어도 문안은 보존된다.
  const saves = await Promise.allSettled(['초안 A', '초안 B'].map(text => saveWritingSection({ ...context, body: { fieldId, text, expectedRevision: 0 } })));
  assert.equal(saves.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((saves.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'writing_section_conflict');
  const saved = (await loadWritingSections(context)).sections[0]!;
  assert.equal(saved.revision, 1); assert.match(saved.text, /^초안 [AB]$/u);
  await assert.rejects(() => saveWritingSection({ ...context, body: { fieldId: crypto.randomUUID(), text: '다른 문항', expectedRevision: 0 } }), { code: 'writing_field_unavailable' });
  await assert.rejects(() => saveWritingSection({ ...context, body: { fieldId, text: 'x'.repeat(12001), expectedRevision: 1 } }), { code: 'invalid_writing_input' });

  const outsider = crypto.randomUUID(), otherCompany = crypto.randomUUID();
  await admin`insert into users(id,email) values (${outsider},${`${outsider}@example.invalid`})`;
  await admin`insert into companies(id,name,kind,created_by) values (${otherCompany},'문안 외부 회사','active',${outsider})`;
  await admin`insert into user_company(user_id,company_id,role) values (${outsider},${otherCompany},'owner'), (${access.userId},${otherCompany},'owner')`;
  await assert.rejects(() => loadWritingSections({ draftId, access: { ...access, companyId: otherCompany } }), { status: 404 });
  await assert.rejects(() => loadWritingSections({ draftId, access: { ...access, userId: outsider } }), { status: 403 });
  await admin`insert into user_company(user_id,company_id,role) values (${outsider},${access.companyId},'viewer')`;
  const viewer = { ...access, userId: outsider };
  assert.equal((await loadWritingSections({ draftId, access: viewer })).canWrite, false);
  await assert.rejects(() => saveWritingSection({ draftId, access: viewer, body: { fieldId, text: '금지', expectedRevision: 1 } }), { status: 403 });
  await admin`delete from user_company where user_id=${outsider} and company_id=${access.companyId}`;
  assert.equal((await client.begin(async tx => {
    await tx`select set_config('app.current_user_id',${outsider},true)`;
    return tx`select content from document_writing_sections where draft_id=${draftId}`;
  })).length, 0);
  await assert.rejects(() => client.begin(async tx => {
    await tx`select set_config('app.current_user_id',${outsider},true)`;
    await tx`insert into document_writing_sections(draft_id,field_id,company_id,label,revision,content,updated_by)
      values (${draftId},${crypto.randomUUID()},${otherCompany},'위조',1,'내용',${outsider})`;
  }));

  const flag = process.env.CUNOTE_WRITING_SECTION_AGENT_ENABLED;
  const result: SectionComposerResult = { composition: { paragraphs: [{ kind: 'proposal', text: '고객 인터뷰를 검토합니다.', evidence: [] }], questions: ['목표 고객은 누구인가요?'] },
    suggestions: {}, alternatives: {}, readiness: {}, modelVersion: 'synthetic', groundingBindingSha256: 'a'.repeat(64) };
  let calls = 0;
  const generate = async () => { calls++; return result; };
  try {
    process.env.CUNOTE_WRITING_SECTION_AGENT_ENABLED = 'false';
    const body = { fieldId, expectedRevision: 1, requestId: crypto.randomUUID() };
    await assert.rejects(() => requestWritingSection({ ...context, body }, { generate }), { code: 'writing_generation_unavailable' });
    assert.equal(calls, 0);
    process.env.CUNOTE_WRITING_SECTION_AGENT_ENABLED = 'true';
    const generated = await requestWritingSection({ ...context, body }, { generate });
    assert.equal(generated.sections[0]?.proposal?.status, 'ready');
    assert.equal(generated.sections[0]?.text, saved.text, '제안은 사용자 문안을 덮어쓰지 않는다');
    assert.deepEqual(generated.sections[0]?.proposal?.composition?.questions, result.composition.questions);
    await requestWritingSection({ ...context, body }, { generate }); assert.equal(calls, 1);
    await assert.rejects(() => requestWritingSection({ ...context, body: { ...body, expectedRevision: 0 } }, { generate }), { code: 'writing_request_conflict' });
    await saveWritingSection({ ...context, body: { fieldId, expectedRevision: 1, text: '사용자가 수정한 문안' } });
    assert.equal((await loadWritingSections(context)).sections[0]?.proposal?.stale, true);

    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { finish = resolve; });
    const request = { fieldId, expectedRevision: 2, requestId: crypto.randomUUID() };
    const underway = requestWritingSection({ ...context, body: request }, { generate: async () => { calls++; entered(); await paused; return result; } });
    await started;
    try {
      assert.equal((await requestWritingSection({ ...context, body: request }, { generate })).sections[0]?.proposal?.status, 'running');
      await assert.rejects(() => requestWritingSection({ ...context, body: { ...request, requestId: crypto.randomUUID() } }, { generate }), { code: 'writing_generation_running' });
      await saveWritingSection({ ...context, body: { fieldId, expectedRevision: 2, text: '생성 중 직접 수정' } });
    } finally { finish(); }
    const after = await underway;
    assert.equal(calls, 2); assert.equal(after.sections[0]?.text, '생성 중 직접 수정');
    assert.equal(after.sections[0]?.proposal?.stale, true);

    const source = await createWritingSource({ ...context, body: { requestId: crypto.randomUUID(), title: '자료', content: '검증 자료', scope: 'application', kind: 'user_statement', observedDate: null } });
    await saveWritingBrief({ ...context, body: { expectedRevision: 0, brief: emptyWritingBrief(), sourceIds: [source.id] } });
    const withdrawn = await requestWritingSection({ ...context, body: { fieldId, expectedRevision: 3, requestId: crypto.randomUUID() } }, {
      generate: async () => { await withdrawWritingSource({ ...context, sourceId: source.id }); return result; },
    });
    assert.equal(withdrawn.sections[0]?.proposal?.status, 'failed');
    assert.equal(withdrawn.sections[0]?.proposal?.composition, null);
    assert.equal(withdrawn.sections[0]?.text, '생성 중 직접 수정');
    await saveWritingBrief({ ...context, body: { expectedRevision: 1, brief: emptyWritingBrief(), sourceIds: [] } });

    // 프로세스 종료/응답 유실 이후 같은 요청은 모델을 재실행하지 않는다.
    const latestId = withdrawn.sections[0]!.proposal!.id;
    await admin`update document_writing_section_runs set status='running', expires_at=now()-interval '1 second' where id=${latestId}`;
    const retried = await requestWritingSection({ ...context, body: { fieldId, expectedRevision: 3, requestId: latestId } }, { generate });
    assert.equal(retried.sections[0]?.proposal?.status, 'failed'); assert.equal(calls, 2);
    await admin`delete from grant_document_fields where id=${fieldId}`;
    assert.equal((await loadWritingSections(context)).sections[0]?.available, false);
    await saveWritingSection({ ...context, body: { fieldId, expectedRevision: 3, text: '문항 삭제 후에도 보관한 문안 수정\n총사업비: 1억원\n정부지원금: 7000만원\n자부담: 2000만원' } });
    assert.equal((await loadWritingSections(context)).sections[0]?.revision, 4);
    assert.equal((await loadWritingSections(context)).consistency?.issues[0]?.kind, 'budget_total');
    assert.equal((await client.begin(async tx => {
      await tx`select set_config('app.current_user_id',${outsider},true)`;
      return tx`select composition from document_writing_section_runs where draft_id=${draftId}`;
    })).length, 0);
    console.log('PASS: standalone section manuscripts without native anchors, persistence/CAS/tenant/RLS/viewer isolation, duplicate and concurrent generation, user-edit preservation, withdrawal during generation, expired retry without duplicate model, removed-field retention (injected composer only)');
  } finally {
    if (flag === undefined) delete process.env.CUNOTE_WRITING_SECTION_AGENT_ENABLED;
    else process.env.CUNOTE_WRITING_SECTION_AGENT_ENABLED = flag;
  }
}
