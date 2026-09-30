import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type postgres from "postgres";
import type { CompanyAccess } from "../auth/companyGuard";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import type { RhwpDocument, RhwpModule } from "@/lib/rhwp/client";
import { exportVerifiedRhwpDocument } from "@/lib/rhwp/client";
import { resolveStudioFieldBindings } from "@/lib/rhwp/studioFieldBindings";
import { collectStudioFieldEvidence } from "@/lib/rhwp/studioFieldAgentTransaction";
import { writingCompositionText } from "@/lib/documents/writingComposition";
import { emptyWritingBrief } from "@/lib/documents/writingContext";
import { createWritingSource, loadWritingGrounding, saveWritingBrief } from "./writingContext";
import { writingGroundingSources } from "./writingGroundingSources";
import { verifyWritingComposition } from "./sectionComposer";
import { loadExactDraftRevisionFile, saveStudioSnapshot } from "./documentRevisions";
import { assertTableLayoutDoesNotOverflow } from "@/lib/rhwp/tableLayoutGuard";
import { transitionFieldAgentSuggestion } from "./fieldAgentRuns";
import { applyTablePagination, inspectTablePagination } from "@/lib/rhwp/tablePagination";

// 공개 기관 원본 + 합성 회사 자료다. 실제 기업의 적격성/모델 품질/브라우저 UAT 증거가 아니다.
const FIXTURE = {
  sourceId: "PBLN_000000000123505",
  path: "spike-samples2/files/16_3852550670afd359-바이오스타_2.0_-_사업계획서.hwpx",
  sha256: "3852550670afd359494589a1b222a65faf9f06837c894b7e3e342f86a6789f95",
};

/** 엄격한 기관 양식 gate에서 호출. 실제 WASM/격리 DB/메모리 객체 저장소만 사용한다. */
export async function verifyWritingFormPostgres(input: {
  admin: postgres.Sql; access: CompanyAccess; storage: R2ObjectStorage; rhwp: RhwpModule; allowTablePagination?: boolean;
}) {
  const original = readFileSync(FIXTURE.path);
  assert.equal(hash(original), FIXTURE.sha256);
  const grantId = crypto.randomUUID();
  const draftId = crypto.randomUUID();
  await input.admin`insert into grants(id,source,source_id,title,status,overall_confidence)
    values (${grantId},'bizinfo',${`writing-fixture-${grantId}`},'합성 회사의 실제 사업계획서 작성 검증','closed',1)`;
  await input.admin`insert into grant_document_drafts
    (id,grant_id,company_id,user_id,document_key,document_category,document_name,source_attachment,draft_markdown,
     filled_fields,missing_fields,used_profile_fields,assumptions,warnings,status,model_ver,prompt_ver,parser_version)
    values (${draftId},${grantId},${input.access.companyId},${input.access.userId},'writing-fixture','business_plan',
      '바이오스타 2.0 사업계획서',${FIXTURE.path},'','{}','[]','[]','[]','[]','draft','fixture','fixture','fixture')`;
  const context = { access: input.access, draftId };
  const source = await createWritingSource({ ...context, body: { requestId: crypto.randomUUID(), title: '합성 회사 소개',
    content: '검증 회사는 실험 기록 관리 소프트웨어를 개발합니다.', scope: 'company', kind: 'user_statement', observedDate: null } });
  await saveWritingBrief({ ...context, body: { expectedRevision: 0, sourceIds: [source.id], brief: {
    ...emptyWritingBrief(), projectName: '실험 기록 관리 고도화', goals: '연구자 인터뷰를 진행하고 사용성을 검증할 계획입니다.',
  } } });
  const sources = writingGroundingSources({ ...await loadWritingGrounding(context), companyId: input.access.companyId, draftId });
  const material = sources.find(entry => entry.kind === 'company_material')!;
  const plan = sources.find(entry => entry.kind === 'application_plan')!;
  let document = new input.rhwp.HwpDocument(original);
  let revisionId: string | null = null;
  let changeSeq = 0;
  const sessionId = crypto.randomUUID();
  try {
    const beforeCells = readCells(document);
    const changed = new Set<string>();
    const save = async (body: Uint8Array) => {
      const saved = await saveStudioSnapshot({ ...context, body: Buffer.from(body), baseRevisionId: revisionId,
        format: 'hwpx', filename: 'writing-plan-fixture.hwpx', pageCount: document.pageCount(), sessionId,
        documentEpoch: 0, changeSeq: ++changeSeq, origin: 'studio_manual', checkpointRequestId: null,
        materializedAnswers: {}, verification: { fixtureSourceId: FIXTURE.sourceId, fixtureSourceSha256: FIXTURE.sha256,
          syntheticCompany: true, nativeCoreEdit: true } }, { storage: input.storage });
      revisionId = saved.revisionId;
      const reopened = await loadExactDraftRevisionFile({ ...context, revisionId }, { storage: input.storage });
      assert.equal(hash(reopened.body), saved.sha256);
      return reopened;
    };
    await save(original);
    if (input.allowTablePagination) {
      const first = resolveStudioFieldBindings(document, [{ fieldId: 'first', label: 'KIST 연구팀 매칭', fieldType: 'long_text' }])[0]!;
      assert.equal(first.status, 'unique');
      if (first.status !== 'unique' || first.target.kind !== 'table_cell_region') throw new Error('첫 표 위치 미확정');
      const position = first.target;
      const target = (await inspectTablePagination(document, hash(original))).find((candidate) =>
        candidate.section === position.section && candidate.parentPara === position.parentPara && candidate.controlIndex === position.controlIndex);
      assert.ok(target, '사용자가 고를 수 있는 표로 탐색된다');
      const request = { rhwp: input.rhwp, bytes: original, format: 'hwpx' as const, target };
      await assert.rejects(() => applyTablePagination({ ...request, target: { ...target, documentSha256: '0'.repeat(64) } }), /문서가 변경/);
      await assert.rejects(() => applyTablePagination({ ...request, target: { ...target, tableSha256: '0'.repeat(64) } }), /현재 속성/);
      const applied = await applyTablePagination(request);
      document.free(); document = new input.rhwp.HwpDocument(applied.bytes);
      await save(applied.bytes);
      await assert.rejects(() => applyTablePagination({ ...request, bytes: applied.bytes }), /문서가 변경/);
      assert.equal((await inspectTablePagination(document, applied.afterDocumentSha256)).some((candidate) =>
        candidate.section === position.section && candidate.parentPara === position.parentPara && candidate.controlIndex === position.controlIndex), false);
    }
    // 실제 양식의 세 지원분야별 활용계획. 위치를 fixture 좌표로 강제하지 않고 제품 resolver를 사용한다.
    for (const label of ['KIST 연구팀 매칭', '기술고도화 / PoC', '사업화 / 투자유치']) {
      const field = { fieldId: crypto.randomUUID(), label, fieldType: 'long_text' };
      const binding = resolveStudioFieldBindings(document, [field])[0]!;
      assert.equal(binding.status, 'unique', label);
      if (binding.status !== 'unique' || binding.target.kind !== 'table_cell_region') throw new Error('서술 문항 위치 미확정');
      const target = binding.target;
      const key = [target.section, target.parentPara, target.controlIndex, target.cellIndex].join(':');
      assert.equal(beforeCells.get(key)?.text.trim(), '', '안내문/고정 문구를 입력 칸으로 선택하지 않는다');
      const composition = verifyWritingComposition({ paragraphs: [
        { kind: 'company_fact', text: '검증 회사는 실험 기록 관리 소프트웨어를 개발합니다.', evidence: [{ sourceId: material.sourceId, quote: '검증 회사는 실험 기록 관리 소프트웨어를 개발합니다.' }] },
        { kind: 'plan', text: '연구자 인터뷰를 진행하고 사용성을 검증할 계획입니다.', evidence: [{ sourceId: plan.sourceId, quote: '연구자 인터뷰를 진행하고 사용성을 검증할 계획입니다.' }] },
        { kind: 'proposal', text: `${label}의 지원 범위를 확인한 뒤 세부 실행 내용을 보완합니다.`, evidence: [] },
      ], questions: ['구체적인 협력 대상과 일정은 무엇인가요?'] }, sources);
      const value = writingCompositionText(composition);
      const args = [target.section, target.parentPara, target.controlIndex, target.cellIndex] as const;
      const count = document.getCellParagraphCount(...args);
      assert.equal(JSON.parse(document.deleteRangeInCell(...args, 0, 0, count - 1, document.getCellParagraphLength(...args, count - 1))).ok, true);
      const paragraphs = value.split('\n');
      for (const [index, text] of paragraphs.entries()) {
        if (index > 0) assert.equal(JSON.parse(document.splitParagraphInCell(...args, index - 1, document.getCellParagraphLength(...args, index - 1))).ok, true);
        if (text) assert.equal(JSON.parse(document.insertTextInCell(...args, index, 0, text)).ok, true);
      }
      const exported = exportVerifiedRhwpDocument({ rhwp: input.rhwp, document, format: 'hwpx' });
      if (input.allowTablePagination) assertTableLayoutDoesNotOverflow({ rhwp: input.rhwp, before: original, after: exported.bytes, target });
      assert.equal((await collectStudioFieldEvidence(input.rhwp, exported.bytes, target)).text, value);
      const saved = await save(exported.bytes);
      const reopened = new input.rhwp.HwpDocument(saved.body);
      try {
        assert.equal(readCells(reopened).get(key)?.text, value);
        changed.add(key);
        const after = readCells(reopened);
        assert.equal(after.size, beforeCells.size, '기존 표 셀 수 보존');
        for (const [cellKey, before] of beforeCells) {
          if (!changed.has(cellKey)) assert.deepEqual(after.get(cellKey), before, '선택하지 않은 셀의 문구·서식 보존');
        }
      } finally { reopened.free(); }
    }
    assert.equal(changed.size, 3);
    assert.equal(hash(readFileSync(FIXTURE.path)), FIXTURE.sha256, '원본 파일은 수정하지 않는다');
    console.log(`PASS: actual business-plan HWPX: company source + brief -> ${input.allowTablePagination ? 'explicit table pagination -> ' : ''}3 uniquely bound narrative cells -> multi-paragraph native edit -> ${changeSeq} DB revisions -> exact reopen; untouched cells preserved (synthetic composition, no browser/model/external-editor claim)`);
  } finally { document.free(); }
}

function readCells(document: RhwpDocument) {
  const cells = new Map<string, { text: string; properties: unknown }>();
  for (let page = 0; page < document.pageCount(); page++) {
    const layout = JSON.parse(document.getPageControlLayout(page));
    for (const table of layout.controls ?? []) {
      if (table.type !== 'table' || table.stableIndex?.length !== 3) continue;
      const { secIdx: s, paraIdx: p, controlIdx: c } = table;
      const count = JSON.parse(document.getTableDimensions(s, p, c)).cellCount;
      for (let cell = 0; cell < count; cell++) {
        const key = [s, p, c, cell].join(':');
        if (cells.has(key)) continue;
        const text = Array.from({ length: document.getCellParagraphCount(s, p, c, cell) }, (_, i) =>
          document.getTextInCell(s, p, c, cell, i, 0, document.getCellParagraphLength(s, p, c, cell, i))).join('\n');
        cells.set(key, { text, properties: JSON.parse(document.getCellOwnProperties(s, p, c, cell)) });
      }
    }
  }
  return cells;
}
function hash(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }

/** 알려진 양식 실패를 숨기지 않고, 실패한 자동 적용이 원본 head를 덮지 않는지만 검증한다. */
export async function verifyWritingLayoutSafetyPostgres(input: {
  admin: postgres.Sql; access: CompanyAccess; storage: R2ObjectStorage; rhwp: RhwpModule;
}) {
  const original = readFileSync(FIXTURE.path);
  assert.equal(hash(original), FIXTURE.sha256);
  const grantId = crypto.randomUUID(), draftId = crypto.randomUUID(), fieldId = crypto.randomUUID();
  await input.admin`insert into grants(id,source,source_id,title,status,overall_confidence)
    values (${grantId},'bizinfo',${grantId},'원본 표 넘침 보호 검증','closed',1)`;
  await input.admin`insert into grant_document_drafts
    (id,grant_id,company_id,user_id,document_key,document_category,document_name,draft_markdown,filled_fields,missing_fields,used_profile_fields,assumptions,warnings,status,model_ver,prompt_ver,parser_version)
    values (${draftId},${grantId},${input.access.companyId},${input.access.userId},${draftId},'business_plan','넘침 보호','','{}','[]','[]','[]','[]','draft','fixture','fixture','fixture')`;
  await input.admin`insert into grant_document_fields(id,grant_id,source,source_id,document_category,document_name,field_key,label,field_type,fill_strategy,confidence,parser_version)
    values (${fieldId},${grantId},'bizinfo',${grantId},'business_plan','양식','plan','KIST 연구팀 매칭','long_text','llm',1,'fixture')`;
  const document = new input.rhwp.HwpDocument(original);
  const context = { draftId, access: input.access };
  const sessionId = crypto.randomUUID();
  const common = { ...context, format: 'hwpx' as const, filename: 'layout-fixture.hwpx', sessionId, documentEpoch: 0,
    checkpointRequestId: null, materializedAnswers: {}, verification: {} };
  try {
    const resolved = resolveStudioFieldBindings(document, [{ fieldId, label: 'KIST 연구팀 매칭', fieldType: 'long_text' }])[0]!;
    assert.equal(resolved.status, 'unique');
    if (resolved.status !== 'unique' || resolved.target.kind !== 'table_cell_region') throw new Error('fixture target missing');
    const target = resolved.target;
    assertTableLayoutDoesNotOverflow({ rhwp: input.rhwp, before: original, after: original, target });
    const baseline = await saveStudioSnapshot({ ...common, body: original, pageCount: document.pageCount(), baseRevisionId: null,
      changeSeq: 1, origin: 'studio_manual' }, { storage: input.storage });
    const args = [target.section, target.parentPara, target.controlIndex, target.cellIndex] as const;
    const lines = Array.from({ length: 20 }, () => '검증용 긴 문안을 실제 표에 입력하여 페이지 넘침을 재현합니다.');
    for (const [index, text] of lines.entries()) {
      if (index) assert.equal(JSON.parse(document.splitParagraphInCell(...args, index - 1, document.getCellParagraphLength(...args, index - 1))).ok, true);
      assert.equal(JSON.parse(document.insertTextInCell(...args, index, 0, text)).ok, true);
    }
    const after = Buffer.from(exportVerifiedRhwpDocument({ rhwp: input.rhwp, document, format: 'hwpx' }).bytes);
    assert.throws(() => assertTableLayoutDoesNotOverflow({ rhwp: input.rhwp, before: original, after, target }), /용지 밖/u);
    const runId = crypto.randomUUID(), suggestionId = crypto.randomUUID(), sha = 'a'.repeat(64);
    await input.admin`insert into grant_document_field_agent_runs(id,draft_id,field_id,field_label,created_by,client_request_id,status,request_binding_sha256,
      base_revision_id,document_sha256,field_binding_sha256,target,before_text,before_text_sha256,format_sha256,adjacent_context_sha256,model_version,prompt_version,grounding_binding_sha256)
      values (${runId},${draftId},${fieldId},'KIST 연구팀 매칭',${input.access.userId},${crypto.randomUUID()},'ready',${sha},${baseline.revisionId},${baseline.sha256},${sha},${JSON.stringify(target)}::jsonb,'',${sha},${sha},${sha},'synthetic','fixture',${sha})`;
    await input.admin`insert into grant_document_field_agent_suggestions(id,run_id,draft_id,field_id,created_by,ordinal,value,rationale,evidence)
      values (${suggestionId},${runId},${draftId},${fieldId},${input.access.userId},0,${lines.join('\n')},'합성 넘침 검증','[]')`;
    const started = await transitionFieldAgentSuggestion({ ...context, suggestionId, action: 'start_apply', expectedStatusVersion: 0, expectedOperationVersion: 0, operationClientId: crypto.randomUUID() });
    let uploads = 0;
    await assert.rejects(() => saveStudioSnapshot({ ...common, body: after, pageCount: document.pageCount(), baseRevisionId: baseline.revisionId,
      changeSeq: 2, origin: 'studio_agent_apply', fieldAgentSuggestionId: suggestionId, agentOperation: 'apply', operationVersion: started.operationVersion },
    { storage: { ...input.storage, async putObject(value) { uploads++; return input.storage.putObject(value); } } }), { code: 'field_layout_overflow' });
    assert.equal(uploads, 0, '잘린 자동 입력본을 객체 저장소에 올리지 않는다');
    const [head] = await input.admin`select revision_id from grant_document_revision_heads where draft_id=${draftId}`;
    assert.equal(head!.revision_id, baseline.revisionId);
    assert.equal(hash((await loadExactDraftRevisionFile({ ...context, revisionId: baseline.revisionId }, { storage: input.storage })).body), FIXTURE.sha256);
    console.log('PASS: real institutional HWPX overflow is rejected before agent snapshot upload; previous immutable revision/head/original bytes preserved (not a successful narrative form roundtrip or browser rollback proof)');
  } finally { document.free(); }
}
