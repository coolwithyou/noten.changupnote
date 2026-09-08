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
