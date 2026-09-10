import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type postgres from "postgres";
import type { CompanyAccess } from "../auth/companyGuard";
import { closeCunoteDb } from "../db/client";
import { loadDocumentAgentCore } from "../rhwp/documentAgentCore";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import {
  saveStudioSnapshot,
  loadDraftHeadRevisionFile,
  loadExactDraftRevisionFile,
} from "./documentRevisions";
import { sha256Hex } from "@/lib/rhwp/documentAgentContract";
import { extractDocumentEditCandidates } from "@/lib/rhwp/documentAgentCandidates";
import { applyDocumentAgentEdit, undoDocumentAgentEdit } from "@/lib/rhwp/documentAgentTransaction";
import { exportVerifiedRhwpDocument, type RhwpDocumentFormat } from "@/lib/rhwp/client";

const INSTITUTION_FORM_FIXTURES = [
  {
    format: "hwpx",
    source: "bizinfo",
    sourceId: "PBLN_000000000119234",
    grantId: "a512f025-3b74-4c2a-b3cf-5d0e139954e0",
    attachmentId: "57de6ace07bfaeb119bf",
    filename: "(첨부양식)2026년도 안전관리 우수연구실 인증제 신청서 등 서류.hwpx",
    storageKey: "grant-archive/bizinfo/PBLN_000000000119234/attachments/8963d549c1074ac1-(첨부양식)2026년도_안전관리_우수연구실_인증제_신청서_등_서류.hwpx",
    sourceSha256: "8963d549c1074ac146a606eae12d42c25837c95df2f2290a65d3a2842520f081",
    sourcePath: "spike-samples/files/06_8963d549c1074ac1-_첨부양식_2026년도_안전관리_우수연구실_인증제_신청서_등_서류.hwpx",
    manifestPath: "spike-out/analysis-lab/application-roundtrip/bizinfo__PBLN_000000000119234/roundtrip-2026-08-17T041635.645Z-243b98/manifest.json",
    manifestRawSha256: "ebe2e42b85384fc48b8af9c2ac23497ed7a8fbd543b88c590718392035a9ca38",
    pageCount: 6,
  },
  {
    format: "hwp",
    source: "bizinfo",
    sourceId: "PBLN_000000000120959",
    grantId: "91283f1f-e6c6-46ba-bddf-2e78b32c1576",
    attachmentId: "a8132b1f6d6e0053308f",
    filename: "붙임. 신청자료 서식.hwp",
    storageKey: "grant-archive/bizinfo/PBLN_000000000120959/attachments/073a091dbb6bc9cc-붙임._신청자료_서식.hwp",
    sourceSha256: "073a091dbb6bc9cc4b765a8c257c8023964447f91b684fc60213abd195dd3119",
    sourcePath: "spike-samples2/files/22_073a091dbb6bc9cc-붙임._신청자료_서식.hwp",
    manifestPath: "spike-out/analysis-lab/application-roundtrip/bizinfo__PBLN_000000000120959/roundtrip-2026-09-03T074054.613Z-2488bf/manifest.json",
    manifestRawSha256: "44d7aa1fe5a3a1bd6995e99eadd40832107aeda2e3d9215242e58450f5958e23",
    pageCount: 8,
  },
] as const;

/** test-product-postgres가 만든 새 Unix cluster 안에서만 호출한다. R2/모델 호출 없음. */
export async function verifyDocumentJourneyPostgres(input: { admin: postgres.Sql; socket: string; access: CompanyAccess }) {
  assert.equal(input.socket, process.env.CUNOTE_PRODUCT_TEST_SOCKET);
  assert.match(input.socket, /^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/);
  await closeCunoteDb();
  const previous = { DATABASE_URL: process.env.DATABASE_URL, PGHOST: process.env.PGHOST, PGUSER: process.env.PGUSER };
  process.env.DATABASE_URL = "postgres:///postgres";
  process.env.PGHOST = input.socket;
  process.env.PGUSER = "postgres";
  // 운영의 privileged connection과 동일하게 SQL 역할과 검증된 회사 접근 문맥을 분리한다.
  // 일반 역할의 실제 RLS 검증은 companyWritePostgres.integration.test.ts가 담당한다.
  const objects = new Map<string, Buffer>();
  const storage: R2ObjectStorage = {
    async putObject({ key, body }) { objects.set(key, Buffer.from(body)); return { key, url: `memory:${key}` }; },
    async getObjectBytes(key) { const body = objects.get(key); assert.ok(body); return { body: Buffer.from(body), contentType: null }; },
    async getObjectText(key) { return (await storage.getObjectBytes(key)).body.toString(); },
    async objectExists(key) { return objects.has(key); },
    publicUrl(key) { return `memory:${key}`; },
    async presignGetUrl(key) { return `memory:${key}`; },
  };
  try {
    const rhwp = await loadDocumentAgentCore();
    const grantId = crypto.randomUUID();
    await input.admin`insert into grants(id,source,source_id,title,status,overall_confidence) values (${grantId},'bizinfo',${grantId},'격리 문서 검증 공고','open',1)`;
    for (const format of ["hwp", "hwpx"] as const) {
      const draftId = crypto.randomUUID();
      await input.admin`insert into grant_document_drafts
        (id,grant_id,company_id,user_id,document_key,document_category,document_name,draft_markdown,filled_fields,missing_fields,used_profile_fields,assumptions,warnings,status,model_ver,prompt_ver,parser_version)
        values (${draftId},${grantId},${input.access.companyId},${input.access.userId},${format},'application_form','격리 신청서','','{}','[]','[]','[]','[]','draft','fixture','fixture','fixture')`;
      const document = rhwp.HwpDocument.createEmpty();
      document.createBlankDocument();
      const beforeText = "회사의 사업 계획과 실행 일정을 구체적으로 작성합니다.";
      assert.equal(JSON.parse(document.insertText(0, 0, 0, "사업 계획서")).ok, true);
      assert.equal(JSON.parse(document.splitParagraph(0, 0, document.getParagraphLength(0, 0))).ok, true);
      assert.equal(JSON.parse(document.insertText(0, 1, 0, beforeText)).ok, true);
      const original = format === "hwp" ? document.exportHwp() : document.exportHwpx();
      document.free();
      const source = new rhwp.HwpDocument(original);
      const candidates = await extractDocumentEditCandidates({ document: source, sourceKey: draftId, documentSha256: await sha256Hex(original), selectedPage: 1, reservedAnchors: [] });
      source.free();
      const candidate = candidates.find((entry) => entry.beforeText === beforeText);
      assert.ok(candidate);
      const common = { draftId, access: input.access, format, filename: `fixture.${format}`, pageCount: 1, sessionId: crypto.randomUUID(), documentEpoch: 0, origin: "studio_manual" as const, checkpointRequestId: null, materializedAnswers: {}, verification: {} };
      const baseline = await saveStudioSnapshot({ ...common, body: Buffer.from(original), baseRevisionId: null, changeSeq: 1 }, { storage });
      const [epochZeroRun] = await input.admin`insert into grant_document_agent_runs
        (draft_id,created_by,client_request_id,status,lease_owner,lease_expires_at,request_binding_sha256,
         base_revision_id,document_sha256,studio_session_id,document_epoch,change_seq,selected_page,candidate,
         candidate_id,model_version,prompt_version,grounding_binding_sha256,grounding_provenance)
        values (${draftId},${input.access.userId},${crypto.randomUUID()},'generating',${crypto.randomUUID()},now() + interval '2 minutes',
          ${"a".repeat(64)},${baseline.revisionId},${baseline.sha256},${common.sessionId},0,1,1,'{}',${"b".repeat(64)},
          'fixture-model','fixture-prompt',${"c".repeat(64)},'{}')
        returning id,document_epoch`;
      assert.equal(epochZeroRun?.document_epoch, 0, "초기 Studio checkpoint의 epoch 0도 agent run에 결속할 수 있다");
      await input.admin`update grant_document_agent_runs
        set status='cancelled', status_version=1, lease_owner=null, lease_expires_at=null, completed_at=now()
        where id=${epochZeroRun!.id}`;
      await assert.rejects(
        () => input.admin`update grant_document_agent_runs set document_epoch=-1 where id=${epochZeroRun!.id}`,
        /grant_document_agent_runs_state_check/,
      );
      const replacement = "검증 회사는 시제품 검증과 고객 인터뷰를 순차적으로 진행합니다.";
      const applied = await applyDocumentAgentEdit({ rhwp, bytes: original, format, reservedAnchors: [], command: { schemaVersion: "document-agent-v1", candidate, replacement } });
      const saved = await saveStudioSnapshot({ ...common, body: Buffer.from(applied.bytes), baseRevisionId: baseline.revisionId, changeSeq: 2 }, { storage });
      assert.notEqual(saved.sha256, baseline.sha256);
      const reopened = await loadExactDraftRevisionFile({ draftId, revisionId: saved.revisionId, access: input.access }, { storage });
      assert.equal(reopened.sha256, await sha256Hex(reopened.body));
      assert.equal(reopened.parentRevisionId, baseline.revisionId);
      const downloaded = new rhwp.HwpDocument(reopened.body);
      assert.ok(downloaded.getTextFileText().includes(replacement));
      downloaded.free();
      const head = await loadDraftHeadRevisionFile({ draftId }, { storage });
      assert.ok(head);
      assert.equal(head.revisionId, saved.revisionId);
      assert.equal(head.body.byteLength, saved.byteSize);
      assert.equal(hash(head.body), saved.sha256);
      const savedStorageKey = [...objects.keys()].find((key) => (
        key.startsWith(`grant-drafts/${draftId}/revisions/`)
        && key.includes(saved.sha256.slice(0, 16))
      ));
      assert.ok(savedStorageKey);
      const intactSavedBody = objects.get(savedStorageKey);
      assert.ok(intactSavedBody);
      const sameSizeCorruption = Buffer.from(intactSavedBody);
      sameSizeCorruption[sameSizeCorruption.byteLength - 1] = sameSizeCorruption[sameSizeCorruption.byteLength - 1]! ^ 0xff;
      objects.set(savedStorageKey, sameSizeCorruption);
      await assert.rejects(
        () => loadDraftHeadRevisionFile({ draftId }, { storage }),
        { code: "snapshot_corrupted" },
      );
      objects.set(savedStorageKey, intactSavedBody.subarray(0, intactSavedBody.byteLength - 1));
      await assert.rejects(
        () => loadDraftHeadRevisionFile({ draftId }, { storage }),
        { code: "snapshot_corrupted" },
      );
      objects.set(savedStorageKey, intactSavedBody);
      await assert.rejects(() => loadExactDraftRevisionFile({ draftId, revisionId: saved.revisionId, access: { ...input.access, companyId: crypto.randomUUID() } }, { storage }), { code: "revision_not_found" });
      await assert.rejects(() => saveStudioSnapshot({ ...common, body: Buffer.from(original), baseRevisionId: baseline.revisionId, changeSeq: 99 }, { storage }), { status: 409 });
      const undone = await undoDocumentAgentEdit({ rhwp, bytes: reopened.body, format, reservedAnchors: [], command: { schemaVersion: "document-agent-v1", candidate, afterText: replacement } });
      const undoSaved = await saveStudioSnapshot({ ...common, body: Buffer.from(undone.bytes), baseRevisionId: saved.revisionId, changeSeq: 3 }, { storage });
      const undoFile = await loadExactDraftRevisionFile({ draftId, revisionId: undoSaved.revisionId, access: input.access }, { storage });
      const undoDocument = new rhwp.HwpDocument(undoFile.body);
      assert.ok(undoDocument.getTextFileText().includes(beforeText));
      assert.ok(!undoDocument.getTextFileText().includes(replacement));
      undoDocument.free();
      const objectCount = objects.size;
      await assert.rejects(() => saveStudioSnapshot({ ...common, access: { ...input.access, role: "viewer" }, body: Buffer.from(original), baseRevisionId: undoSaved.revisionId, changeSeq: 4 }, { storage }), { status: 403 });
      assert.equal(objects.size, objectCount, "viewer 거절은 객체 업로드 전에 일어난다");
      console.log(`PASS: ${format} real WASM apply -> PostgreSQL save -> exact reload -> Undo; SHA, parent, stale revision and foreign company checks`);
    }
    await verifyProfileAutofillSnapshotProjectionPostgres({
      admin: input.admin,
      access: input.access,
      storage,
      rhwp,
      grantId,
    });
    if (process.env.CUNOTE_REQUIRE_INSTITUTION_FORM_FIXTURES === "1") {
      await verifyInstitutionFormJourneyPostgres({ admin: input.admin, access: input.access, storage, objects, rhwp });
    } else {
      console.log("SKIP: institution HWP/HWPX source fixtures (set CUNOTE_REQUIRE_INSTITUTION_FORM_FIXTURES=1 for the strict local gate)");
    }
  } finally {
    await closeCunoteDb();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function verifyProfileAutofillSnapshotProjectionPostgres(input: {
  admin: postgres.Sql;
  access: CompanyAccess;
  storage: R2ObjectStorage;
  rhwp: Awaited<ReturnType<typeof loadDocumentAgentCore>>;
  grantId: string;
}) {
  const draftId = crypto.randomUUID();
  const companyFieldId = crypto.randomUUID();
  const planFieldId = crypto.randomUUID();
  const companyValue = "격리 검증 회사";
  const planValue = "사용자가 확정한 기존 계획";
  const seededAnswers = {
    "업 체 명": {
      value: companyValue,
      status: "suggested",
      source: "profile",
      suggestedValue: companyValue,
      basis: "사업자 정보",
      fieldId: companyFieldId,
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
    "사업 계획": {
      value: planValue,
      status: "edited",
      source: "user",
      fieldId: planFieldId,
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
  };
  await input.admin`insert into grant_document_drafts
    (id,grant_id,company_id,user_id,document_key,document_category,document_name,draft_markdown,
     filled_fields,field_answers,missing_fields,used_profile_fields,assumptions,warnings,status,model_ver,prompt_ver,parser_version)
    values (${draftId},${input.grantId},${input.access.companyId},${input.access.userId},'profile-autofill','application_form',
      '회사 정보 자동 입력 격리 신청서','',${JSON.stringify({ "사업 계획": planValue })}::jsonb,
      ${JSON.stringify(seededAnswers)}::jsonb,'[]','[]','[]','[]','draft','fixture','fixture','fixture')`;

  const document = input.rhwp.HwpDocument.createEmpty();
  document.createBlankDocument();
  const original = document.exportHwpx();
  assert.equal(parsedOk(document.insertText(0, 0, 0, companyValue)), true);
  const appliedBytes = document.exportHwpx();
  const pageCount = document.pageCount();
  document.free();
  const sessionId = crypto.randomUUID();
  const common = {
    draftId,
    access: input.access,
    format: "hwpx" as const,
    filename: "profile-autofill-fixture.hwpx",
    pageCount,
    sessionId,
    documentEpoch: 0,
    origin: "studio_manual" as const,
    checkpointRequestId: null,
    verification: { fixtureKind: "profile-autofill-atomic-projection" },
  };
  const baseline = await saveStudioSnapshot({
    ...common,
    body: Buffer.from(original),
    baseRevisionId: null,
    changeSeq: 1,
    materializedAnswers: { [planFieldId]: planValue },
  }, { storage: input.storage });
  const applied = await saveStudioSnapshot({
    ...common,
    body: Buffer.from(appliedBytes),
    baseRevisionId: baseline.revisionId,
    changeSeq: 2,
    profileAutofillOperation: "apply",
    profileAutofillFieldIds: [companyFieldId],
    materializedAnswers: { [planFieldId]: planValue, [companyFieldId]: companyValue },
  }, { storage: input.storage });

  const [afterApply] = await input.admin`select d.field_answers,d.filled_fields,h.revision_id,
      r.field_answers_hash,r.materialized_answers
    from grant_document_drafts d
    join grant_document_revision_heads h on h.draft_id=d.id
    join grant_document_revisions r on r.id=h.revision_id
    where d.id=${draftId}`;
  assert.equal(afterApply!.revision_id, applied.revisionId);
  assert.equal(afterApply!.field_answers["업 체 명"].status, "accepted");
  assert.equal(afterApply!.field_answers["업 체 명"].materializedRevisionId, applied.revisionId);
  assert.equal(afterApply!.field_answers["사업 계획"].value, planValue);
  assert.equal(afterApply!.field_answers["사업 계획"].status, "edited");
  assert.equal(afterApply!.field_answers_hash, hashJson(afterApply!.field_answers));
  assert.equal(afterApply!.materialized_answers[companyFieldId], companyValue);
  assert.equal(afterApply!.materialized_answers[planFieldId], planValue);
  assert.equal(afterApply!.filled_fields["업 체 명"], companyValue);
  assert.equal(afterApply!.filled_fields["사업 계획"], planValue);

  const assertApplyStateUnchanged = async (message: string) => {
    const [state] = await input.admin`select d.field_answers,h.revision_id,count(r.id)::int as revision_count
      from grant_document_drafts d
      join grant_document_revision_heads h on h.draft_id=d.id
      join grant_document_revisions r on r.draft_id=d.id
      where d.id=${draftId}
      group by d.field_answers,h.revision_id`;
    assert.equal(state!.revision_id, applied.revisionId, `${message}: head revision`);
    assert.deepEqual(state!.field_answers, afterApply!.field_answers, `${message}: draft answers`);
    assert.equal(state!.revision_count, 2, `${message}: immutable revision count`);
  };
  await assert.rejects(() => saveStudioSnapshot({
    ...common,
    body: Buffer.from(original),
    baseRevisionId: baseline.revisionId,
    changeSeq: 3,
    profileAutofillOperation: "undo",
    profileAutofillFieldIds: [companyFieldId],
    materializedAnswers: { [planFieldId]: planValue },
  }, { storage: input.storage }), { status: 409 });
  await assertApplyStateUnchanged("stale profile Undo");

  await assert.rejects(() => saveStudioSnapshot({
    ...common,
    body: Buffer.from(original),
    baseRevisionId: applied.revisionId,
    changeSeq: 4,
    profileAutofillOperation: "undo",
    profileAutofillFieldIds: [companyFieldId],
    materializedAnswers: { [planFieldId]: "다른 값" },
  }, { storage: input.storage }), { code: "profile_autofill_materialized_conflict" });
  await assertApplyStateUnchanged("untargeted answer conflict");

  const undoInput = {
    ...common,
    body: Buffer.from(original),
    baseRevisionId: applied.revisionId,
    changeSeq: 5,
    profileAutofillOperation: "undo" as const,
    profileAutofillFieldIds: [companyFieldId],
    materializedAnswers: { [planFieldId]: planValue },
  };
  const undone = await saveStudioSnapshot(undoInput, { storage: input.storage });
  const replayedUndo = await saveStudioSnapshot(undoInput, { storage: input.storage });
  assert.equal(replayedUndo.revisionId, undone.revisionId, "같은 Undo 재시도는 기존 revision을 재사용한다");
  const [afterUndo] = await input.admin`select d.field_answers,d.filled_fields,h.revision_id,
      r.field_answers_hash,r.materialized_answers
    from grant_document_drafts d
    join grant_document_revision_heads h on h.draft_id=d.id
    join grant_document_revisions r on r.id=h.revision_id
    where d.id=${draftId}`;
  assert.equal(afterUndo!.revision_id, undone.revisionId);
  assert.equal(afterUndo!.field_answers["업 체 명"].status, "dismissed");
  assert.equal(afterUndo!.field_answers["업 체 명"].materializedRevisionId, undefined);
  assert.equal(afterUndo!.filled_fields["업 체 명"], undefined);
  assert.equal(afterUndo!.filled_fields["사업 계획"], planValue);
  assert.equal(afterUndo!.field_answers_hash, hashJson(afterUndo!.field_answers));
  assert.equal(afterUndo!.materialized_answers[companyFieldId], undefined);
  assert.equal(afterUndo!.materialized_answers[planFieldId], planValue);
  const reopened = await loadDraftHeadRevisionFile({ draftId }, { storage: input.storage });
  assert.equal(reopened?.revisionId, undone.revisionId);
  assert.ok(reopened);
  assert.equal(hash(reopened.body), hash(original));

  await assert.rejects(() => saveStudioSnapshot({
    ...common,
    body: Buffer.from(appliedBytes),
    baseRevisionId: undone.revisionId,
    changeSeq: 6,
    profileAutofillOperation: "apply",
    profileAutofillFieldIds: [companyFieldId],
    materializedAnswers: { [planFieldId]: planValue, [companyFieldId]: companyValue },
  }, { storage: input.storage }), { code: "profile_autofill_answer_conflict" });
  const [afterRejectedReopen] = await input.admin`select d.field_answers,h.revision_id,count(r.id)::int as revision_count
    from grant_document_drafts d
    join grant_document_revision_heads h on h.draft_id=d.id
    join grant_document_revisions r on r.draft_id=d.id
    where d.id=${draftId}
    group by d.field_answers,h.revision_id`;
  assert.equal(afterRejectedReopen!.revision_id, undone.revisionId);
  assert.equal(afterRejectedReopen!.field_answers["업 체 명"].status, "dismissed");
  assert.equal(afterRejectedReopen!.revision_count, 3);
  console.log("PASS: profile autofill snapshot and answers advance atomically; stale/untargeted conflicts preserve both; Undo persists dismissal and blocks reopen reapply");
}

async function verifyInstitutionFormJourneyPostgres(input: {
  admin: postgres.Sql;
  access: CompanyAccess;
  storage: R2ObjectStorage;
  objects: Map<string, Buffer>;
  rhwp: Awaited<ReturnType<typeof loadDocumentAgentCore>>;
}) {
  for (const fixture of INSTITUTION_FORM_FIXTURES) {
    const manifestBytes = readFileSync(fixture.manifestPath);
    assert.equal(hash(manifestBytes), fixture.manifestRawSha256, `${fixture.format} source manifest raw SHA`);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      grantId?: unknown;
      source?: unknown;
      sourceId?: unknown;
      attachments?: Array<Record<string, unknown>>;
    };
    assert.equal(manifest.grantId, fixture.grantId);
    assert.equal(manifest.source, fixture.source);
    assert.equal(manifest.sourceId, fixture.sourceId);
    assert.equal(manifest.attachments?.length, 1);
    assert.deepEqual(manifest.attachments?.[0], {
      attachmentId: fixture.attachmentId,
      filename: fixture.filename,
      storageKey: fixture.storageKey,
      sourceSha256: fixture.sourceSha256,
      detectedFormat: fixture.format,
    });

    const original = readFileSync(fixture.sourcePath);
    assert.equal(hash(original), fixture.sourceSha256, `${fixture.format} local source SHA`);
    const sourceDocument = new input.rhwp.HwpDocument(original);
    const marker = `[CUNOTE-R7-${fixture.format.toUpperCase()}-${fixture.sourceSha256.slice(0, 12)}]`;
    let edited: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let editedText = "";
    let originalPageCount = 0;
    try {
      originalPageCount = sourceDocument.pageCount();
      assert.equal(originalPageCount, fixture.pageCount);
      const originalText = sourceDocument.getTextFileText();
      const firstParagraphLength = sourceDocument.getParagraphLength(0, 0);
      assert.equal(
        parsedOk(sourceDocument.insertText(0, 0, firstParagraphLength, ` ${marker}`)),
        true,
        `${fixture.format} isolated manual marker insertion`,
      );
      editedText = sourceDocument.getTextFileText();
      assert.notEqual(editedText, originalText);
      assert.ok(editedText.includes(marker));
      edited = exportVerifiedRhwpDocument({
        rhwp: input.rhwp,
        document: sourceDocument,
        format: fixture.format as RhwpDocumentFormat,
      }).bytes;
    } finally {
      sourceDocument.free();
    }
    assert.equal(hash(readFileSync(fixture.sourcePath)), fixture.sourceSha256, "source file must stay immutable");
    assert.notEqual(hash(edited), fixture.sourceSha256);

    await input.admin`insert into grants(id,source,source_id,title,status,overall_confidence)
      values (${fixture.grantId},${fixture.source},${fixture.sourceId},${`격리 ${fixture.format.toUpperCase()} 기관 양식 검증`},'open',1)`;
    const draftId = crypto.randomUUID();
    await input.admin`insert into grant_document_drafts
      (id,grant_id,company_id,user_id,document_key,document_category,document_name,source_attachment,draft_markdown,filled_fields,missing_fields,used_profile_fields,assumptions,warnings,status,model_ver,prompt_ver,parser_version)
      values (${draftId},${fixture.grantId},${input.access.companyId},${input.access.userId},${fixture.format},'application_form',${fixture.filename},${fixture.filename},'','{}','[]','[]','[]','[]','draft','fixture','fixture','fixture')`;
    const saved = await saveStudioSnapshot({
      draftId,
      access: input.access,
      body: Buffer.from(edited),
      format: fixture.format,
      filename: fixture.filename,
      pageCount: originalPageCount,
      sessionId: crypto.randomUUID(),
      baseRevisionId: null,
      documentEpoch: 0,
      changeSeq: 1,
      origin: "studio_manual",
      checkpointRequestId: null,
      materializedAnswers: {},
      verification: {
        fixtureKind: "immutable-institution-source",
        sourceSha256: fixture.sourceSha256,
        evidenceBoundary: "isolated-postgres-memory-object-store",
      },
    }, { storage: input.storage });
    assert.equal(saved.sha256, hash(edited));
    assert.equal(saved.byteSize, edited.byteLength);

    const head = await loadDraftHeadRevisionFile({ draftId }, { storage: input.storage });
    assert.ok(head);
    assert.equal(head.revisionId, saved.revisionId);
    assert.equal(hash(head.body), saved.sha256);
    assert.equal(head.body.byteLength, saved.byteSize);
    const reopened = new input.rhwp.HwpDocument(head.body);
    let downloadCandidate: Uint8Array;
    try {
      assert.equal(reopened.pageCount(), originalPageCount);
      assert.equal(reopened.getTextFileText(), editedText);
      downloadCandidate = exportVerifiedRhwpDocument({
        rhwp: input.rhwp,
        document: reopened,
        format: fixture.format as RhwpDocumentFormat,
      }).bytes;
    } finally {
      reopened.free();
    }
    const downloaded = new input.rhwp.HwpDocument(downloadCandidate);
    try {
      assert.equal(downloaded.pageCount(), originalPageCount);
      assert.equal(downloaded.getTextFileText(), editedText);
    } finally {
      downloaded.free();
    }

    const [storageKey] = [...input.objects.keys()].filter((key) => key.startsWith(`grant-drafts/${draftId}/revisions/`));
    assert.ok(storageKey);
    const intact = input.objects.get(storageKey);
    assert.ok(intact);
    const sameSizeCorruption = Buffer.from(intact);
    const lastByteIndex = sameSizeCorruption.byteLength - 1;
    sameSizeCorruption[lastByteIndex] = sameSizeCorruption[lastByteIndex]! ^ 0xff;
    input.objects.set(storageKey, sameSizeCorruption);
    await assert.rejects(
      () => loadDraftHeadRevisionFile({ draftId }, { storage: input.storage }),
      { code: "snapshot_corrupted" },
    );
    input.objects.set(storageKey, intact.subarray(0, intact.byteLength - 1));
    await assert.rejects(
      () => loadDraftHeadRevisionFile({ draftId }, { storage: input.storage }),
      { code: "snapshot_corrupted" },
    );
    input.objects.set(storageKey, intact);
    assert.equal(hash(readFileSync(fixture.sourcePath)), fixture.sourceSha256, "source file must remain immutable");
    console.log(`PASS: exact institution ${fixture.format.toUpperCase()} source -> RHWP manual marker -> isolated PostgreSQL/memory object-store save -> head reload -> export candidate reopen; not R2/OAuth/browser-download evidence`);
  }
}

function parsedOk(value: string): boolean {
  try {
    return (JSON.parse(value) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
