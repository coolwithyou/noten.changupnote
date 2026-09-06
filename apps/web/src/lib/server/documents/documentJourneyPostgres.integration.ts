import assert from "node:assert/strict";
import type postgres from "postgres";
import type { CompanyAccess } from "../auth/companyGuard";
import { closeCunoteDb } from "../db/client";
import { loadDocumentAgentCore } from "../rhwp/documentAgentCore";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import { saveStudioSnapshot, loadExactDraftRevisionFile } from "./documentRevisions";
import { sha256Hex } from "@/lib/rhwp/documentAgentContract";
import { extractDocumentEditCandidates } from "@/lib/rhwp/documentAgentCandidates";
import { applyDocumentAgentEdit, undoDocumentAgentEdit } from "@/lib/rhwp/documentAgentTransaction";

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
  } finally {
    await closeCunoteDb();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
