import assert from "node:assert/strict";
import type postgres from "postgres";
import { loadRecentFieldAgentRuns, transitionFieldAgentSuggestion } from "./fieldAgentRuns";
import { writingContextBinding } from "./writingGroundingSources";
import { emptyWritingBrief } from "@/lib/documents/writingContext";
import { closeCunoteDb } from "../db/client";
import type { CompanyAccess } from "../auth/companyGuard";
import { createWritingSource, loadWritingContext, loadWritingGrounding, readWritingSource, saveWritingBrief, withdrawWritingSource } from "./writingContext";
import { verifyWritingSectionsPostgres } from "./writingSectionsPostgres.integration";

export async function verifyWritingContextPostgres(input: { admin: postgres.Sql; client: postgres.Sql; socket: string; access: CompanyAccess }) {
  assert.equal(input.socket, process.env.CUNOTE_PRODUCT_TEST_SOCKET);
  assert.match(input.socket, /^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/);
  await closeCunoteDb();
  const keys = ["DATABASE_URL", "PGHOST", "PGUSER"] as const;
  const previous = keys.map((key) => process.env[key]);
  process.env.DATABASE_URL = "postgres:///postgres"; process.env.PGHOST = input.socket; process.env.PGUSER = "postgres";
  try {
    const { admin, client, access } = input;
    const [grant] = await admin`select id from grants limit 1`;
    assert.ok(grant);
    const draftId = crypto.randomUUID(); const nextDraft = crypto.randomUUID();
    for (const id of [draftId, nextDraft]) await admin`insert into grant_document_drafts
      (id,grant_id,company_id,user_id,document_key,document_category,document_name,draft_markdown,filled_fields,missing_fields,used_profile_fields,assumptions,warnings,status,model_ver,prompt_ver,parser_version)
      values (${id},${grant.id},${access.companyId},${access.userId},${id},'application_form','작성 검증','','{}','[]','[]','[]','[]','draft','fixture','fixture','fixture')`;
    const context = { access, draftId };
    assert.deepEqual((await loadWritingContext(context)).brief, emptyWritingBrief());
    const body = { requestId: crypto.randomUUID(), title: "2025 회사 소개", content: "2025년 고객사 3곳에 서비스를 제공했습니다.", scope: "company", kind: "company_document", observedDate: "2025-12-31" };
    const sources = await Promise.all(Array.from({ length: 4 }, () => createWritingSource({ ...context, body })));
    const source = sources[0]!;
    assert.ok(sources.every((item) => item.id === source.id));
    assert.equal((await loadWritingContext({ access, draftId: nextDraft })).sources.length, 1);
    await assert.rejects(() => createWritingSource({ ...context, body: { ...body, content: "변경된 내용" } }), { code: "writing_request_conflict" });
    const scoped = await createWritingSource({ ...context, body: { ...body, requestId: crypto.randomUUID(), scope: "application" } });
    await assert.rejects(() => readWritingSource({ access, draftId: nextDraft, sourceId: scoped.id }), { status: 404 });
    await assert.rejects(() => saveWritingBrief({ access, draftId: nextDraft, body: { expectedRevision: 0, brief: emptyWritingBrief(), sourceIds: [scoped.id] } }), { code: "writing_source_unavailable" });
    const brief = { ...emptyWritingBrief(), projectName: "서비스 확장", goals: "2027년 신규 고객 10곳 확보 목표" };
    const saves = await Promise.allSettled(["상반기", "하반기"].map((timeline) => saveWritingBrief({ ...context,
      body: { expectedRevision: 0, brief: { ...brief, timeline }, sourceIds: [source.id] },
    })));
    assert.equal(saves.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((saves.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.code, "writing_brief_conflict");
    const saved = await loadWritingContext(context);
    assert.equal(saved.revision, 1); assert.equal(saved.brief.projectName, brief.projectName);
    assert.equal((await loadWritingGrounding(context)).sources[0]!.content, body.content);
    assert.equal((await loadWritingContext({ access, draftId: nextDraft })).revision, 0);

    // 제안 생성 후 brief/source 변경은 실제 start_apply 승인에서 차단한다. 모델/R2 호출은 없다.
    const revisionId = crypto.randomUUID(); const fieldId = crypto.randomUUID(); const runId = crypto.randomUUID(); const suggestionId = crypto.randomUUID();
    const hash = "a".repeat(64);
    await admin`insert into grant_document_revisions(id,draft_id,origin,format,artifact_storage_key,sha256,byte_size,page_count,field_answers_hash,
      materialized_answers,verification,studio_session_id,document_epoch,change_seq,created_by)
      values (${revisionId},${draftId},'studio_manual','hwpx',${`fixture/${revisionId}`},${hash},1,1,${hash},'{}','{}',${crypto.randomUUID()},0,1,${access.userId})`;
    await admin`insert into grant_document_revision_heads(draft_id,revision_id) values (${draftId},${revisionId})`;
    await admin`insert into grant_document_fields(id,grant_id,source,source_id,document_category,document_name,field_key,label,field_type,fill_strategy,confidence,parser_version)
      values (${fieldId},${grant.id},'bizinfo',${grant.id},'application_form','양식','plan','사업 계획','long_text','llm',1,'fixture')`;
    const binding = writingContextBinding(await loadWritingGrounding(context));
    await admin`insert into grant_document_field_agent_runs(id,draft_id,field_id,field_label,created_by,client_request_id,status,request_binding_sha256,
      base_revision_id,document_sha256,field_binding_sha256,target,before_text,before_text_sha256,format_sha256,adjacent_context_sha256,
      model_version,prompt_version,grounding_binding_sha256,writing_context_binding_sha256,composition)
      values (${runId},${draftId},${fieldId},'사업 계획',${access.userId},${crypto.randomUUID()},'ready',${hash},${revisionId},${hash},${hash},'{}','',${hash},${hash},${hash},
      'fixture','writing-section-v1',${hash},${binding},'{"paragraphs":[],"questions":["추진 일정은 언제인가요?"]}')`;
    await admin`insert into grant_document_field_agent_suggestions(id,run_id,draft_id,field_id,created_by,ordinal,value,rationale,evidence)
      values (${suggestionId},${runId},${draftId},${fieldId},${access.userId},0,'계획 문안','검토용','[]')`;
    assert.deepEqual((await loadRecentFieldAgentRuns(context))[0]?.composition?.questions, ["추진 일정은 언제인가요?"]);
    const operation = { ...context, suggestionId, action: "start_apply" as const, expectedStatusVersion: 0, expectedOperationVersion: 0, operationClientId: crypto.randomUUID() };
    const started = await transitionFieldAgentSuggestion(operation);
    assert.equal(started.operationState, "apply_saving");
    const abandoned = await transitionFieldAgentSuggestion({ ...operation, action: "abandon_apply", expectedStatusVersion: started.statusVersion, expectedOperationVersion: started.operationVersion });
    await saveWritingBrief({ ...context, body: { expectedRevision: 1, brief: { ...brief, goals: "변경한 목표" }, sourceIds: [source.id] } });
    await assert.rejects(() => transitionFieldAgentSuggestion({ ...operation, expectedStatusVersion: abandoned.statusVersion, expectedOperationVersion: abandoned.operationVersion }), { code: "writing_context_changed" });

    const foreignUser = crypto.randomUUID(); const foreignCompany = crypto.randomUUID();
    await admin`insert into users(id,email) values (${foreignUser},${`${foreignUser}@example.invalid`})`;
    await admin`insert into companies(id,name,kind,created_by) values (${foreignCompany},'다른 회사','active',${foreignUser})`;
    await admin`insert into user_company(user_id,company_id,role) values (${foreignUser},${foreignCompany},'owner')`;
    await admin`insert into user_company(user_id,company_id,role) values (${access.userId},${foreignCompany},'member')`;
    await assert.rejects(() => loadRecentFieldAgentRuns({ draftId, access: { ...access, companyId: foreignCompany } }), { status: 404 });
    const foreignAccess: CompanyAccess = { companyId: foreignCompany, userId: foreignUser, role: "owner", mode: "session" };
    await assert.rejects(() => loadWritingContext({ access: foreignAccess, draftId }), { status: 404 });
    await assert.rejects(() => loadWritingContext({ access: { ...access, userId: foreignUser }, draftId }), { status: 403 });
    await admin`insert into user_company(user_id,company_id,role) values (${foreignUser},${access.companyId},'viewer')`;
    const forgedWriter = { ...access, userId: foreignUser }; // stale/forged role must not bypass current DB membership
    assert.equal((await loadWritingContext({ access: forgedWriter, draftId })).canWrite, false);
    await assert.rejects(() => createWritingSource({ access: forgedWriter, draftId, body }), { status: 403 });
    await assert.rejects(() => saveWritingBrief({ access: forgedWriter, draftId, body: { expectedRevision: 2, brief, sourceIds: [] } }), { status: 403 });
    await assert.rejects(() => withdrawWritingSource({ access: forgedWriter, draftId, sourceId: source.id }), { status: 403 });
    await admin`delete from user_company where user_id=${foreignUser} and company_id=${access.companyId}`;
    await assert.rejects(() => loadRecentFieldAgentRuns({ draftId, access: forgedWriter }), { status: 403 });
    const visible = await client.begin(async (tx) => {
      await tx`select set_config('app.current_user_id',${foreignUser},true)`;
      return tx`select id from company_writing_sources where id=${source.id}`;
    });
    assert.equal(visible.length, 0);
    await assert.rejects(() => client.begin(async (tx) => {
      await tx`select set_config('app.current_user_id',${foreignUser},true)`;
      await tx`insert into document_writing_briefs(draft_id,company_id,revision,brief,source_ids,updated_by)
        values (${nextDraft},${foreignCompany},1,'{}','[]',${foreignUser})`;
    }));
    await assert.rejects(() => admin`update company_writing_sources set content='조작' where id=${source.id}`);
    await withdrawWritingSource({ ...context, sourceId: source.id });
    assert.equal((await createWritingSource({ ...context, body })).withdrawn, true);
    await assert.rejects(() => loadWritingGrounding(context), { code: "writing_source_unavailable" });
    await assert.rejects(() => readWritingSource({ ...context, sourceId: source.id }), { status: 404 });
    await assert.rejects(() => admin`update company_writing_sources set withdrawn_at=null where id=${source.id}`);
    assert.equal((await loadWritingContext(context)).brief.projectName, brief.projectName);
    await saveWritingBrief({ ...context, body: { expectedRevision: 2, brief, sourceIds: [] } });
    assert.equal((await loadWritingGrounding(context)).sources.length, 0);
    await verifyWritingSectionsPostgres(input);
    console.log("PASS: writing sources/briefs persist, share within company, isolate application and tenant, reject forged/viewer roles, deduplicate retries, CAS concurrent saves, preserve immutable sources and block withdrawn grounding");
  } finally {
    await closeCunoteDb();
    for (const [index, key] of keys.entries()) { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }
  }
}
