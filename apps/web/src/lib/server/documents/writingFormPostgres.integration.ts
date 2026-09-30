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

// 공개 기관 원본 + 합성 회사 자료다. 실제 기업의 적격성/모델 품질/브라우저 UAT 증거가 아니다.
const FIXTURE = {
  sourceId: "PBLN_000000000123505",
  path: "spike-samples2/files/16_3852550670afd359-바이오스타_2.0_-_사업계획서.hwpx",
  sha256: "3852550670afd359494589a1b222a65faf9f06837c894b7e3e342f86a6789f95",
};

/** 엄격한 기관 양식 gate에서 호출. 실제 WASM/격리 DB/메모리 객체 저장소만 사용한다. */
export async function verifyWritingFormPostgres(input: {
  admin: postgres.Sql; access: CompanyAccess; storage: R2ObjectStorage; rhwp: RhwpModule;
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
  const document = new input.rhwp.HwpDocument(original);
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
    console.log('PASS: actual business-plan HWPX: company source + brief -> 3 uniquely bound narrative cells -> multi-paragraph native edit -> 4 DB revisions -> exact reopen; untouched cells preserved (synthetic composition, no browser/model/external-editor claim)');
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
