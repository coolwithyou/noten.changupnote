import { createEditor } from '@rhwp/editor';
import { loadRhwp } from '../../apps/web/src/lib/rhwp/client';
import { RHWP_STUDIO_URL } from '../../apps/web/src/lib/rhwp/editorClient';
import { resolveStudioFieldAgentProtocol } from '../../apps/web/src/lib/rhwp/studioDocumentAgentProtocol';
import { resolveStudioFieldBindings } from '../../apps/web/src/lib/rhwp/studioFieldBindings';
import { collectStudioFieldEvidence } from '../../apps/web/src/lib/rhwp/studioFieldAgentTransaction';
import { createStudioProfileAutofillTransaction } from '../../apps/web/src/lib/rhwp/studioProfileAutofillTransaction';
import { buildAutomaticProfileAutofillEntries, buildApplicationProfileAutofillPlan } from '../../apps/web/src/lib/documents/applicationProfileAutofill';

const audit: any = { state: 'starting', boundary: 'Local engine probe only; original held artifact is not materialized, published or edited.', modelRequests: 0, databaseWrites: 0 };
(window as any).autofillAudit = audit;
(async () => {
  let editor: any;
  try {
    const input = await (await fetch('/input.json')).json();
    const source = new Uint8Array(await (await fetch('/source.hwpx')).arrayBuffer());
    const sourceHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', source))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (sourceHash !== input.sourceSha256) throw Error('Source SHA mismatch');
    audit.input = { ...input, fields: undefined, seededAnswers: undefined, profile: undefined };
    const rhwp = await loadRhwp();
    editor = await createEditor('#editor', { studioUrl: RHWP_STUDIO_URL, requestTimeoutMs: 30000 });
    await editor.loadFile(source, 'local-engine-probe.hwpx', { skipUnsavedGuard: true });
    const protocol = resolveStudioFieldAgentProtocol(editor);
    if (!protocol) throw Error('Actual Studio field protocol unavailable');
    const beforeBytes = await editor.exportHwpx();
    const doc = new rhwp.HwpDocument(beforeBytes);
    const resolutions = resolveStudioFieldBindings(doc, input.fields);
    doc.free();
    const bindings = [];
    for (const resolution of resolutions) {
      if (resolution.status !== 'unique') { bindings.push(resolution); continue; }
      const evidence = await collectStudioFieldEvidence(rhwp, beforeBytes, resolution.target);
      bindings.push({ fieldId: resolution.fieldId, status: resolution.status, beforeText: evidence.text, targetKind: resolution.target.kind });
    }
    const profile = input.profile;
    const plan = buildApplicationProfileAutofillPlan({ fields: input.fields, profile, bindings });
    audit.plan = plan;
    audit.instantAutomaticEntries = buildAutomaticProfileAutofillEntries({ fields: input.fields, answers: input.seededAnswers, bindings });
    audit.engineMode = "Existing profile dialog ready plan → real Studio profile transaction; instant automatic entries are reported separately.";
    const allowed = plan.ready.filter(item => ['company_name', 'company_business_number', 'company_representative_name'].includes(item.profileKey ?? ''));
    if (allowed.length === 0) throw Error('No normal-profile ready identity fields; no mutation attempted');
    const entries = allowed.map(item => {
      const field = input.fields.find((field: any) => field.fieldId === item.fieldId);
      const resolution = resolutions.find(resolution => resolution.fieldId === item.fieldId);
      if (!field || resolution?.status !== 'unique' || resolution.target.kind !== 'table_cell_text' || !item.value) throw Error('Normal identity binding unavailable');
      return { fieldId: item.fieldId, label: field.label, sourceSpan: field.sourceSpan, target: resolution.target, value: item.value };
    });
    const transaction = createStudioProfileAutofillTransaction({ rhwp, protocol, exportCurrentBytes: () => editor.exportHwpx() });
    const result = await transaction.apply({ bytes: beforeBytes, format: 'hwpx', entries });
    const reopened = new rhwp.HwpDocument(result.bytes);
    const afterResolutions = resolveStudioFieldBindings(reopened, input.fields);
    reopened.free();
    const applied = [];
    for (const entry of entries) {
      const resolution = afterResolutions.find(resolution => resolution.fieldId === entry.fieldId);
      if (resolution?.status !== 'unique') throw Error('Reopened binding is not unique');
      const evidence = await collectStudioFieldEvidence(rhwp, result.bytes, resolution.target);
      if (evidence.text !== entry.value) throw Error('Reopened exact value mismatch');
      applied.push({ ...entry, reopenedText: evidence.text });
    }
    audit.applied = applied;
    audit.receipts = result.applied.map(entry => ({ fieldId: entry.fieldId, receipt: entry.result.receipt }));
    // Parent finite runner retrieves only local bytes for independent Kordoc before/after comparison.
    audit.beforeBytes = Array.from(beforeBytes); audit.afterBytes = Array.from(result.bytes);
    audit.state = 'passed';
  } catch (error) { audit.state = 'failed'; audit.error = String(error); }
  finally { editor?.destroy(); document.querySelector('#status')!.textContent = audit.state + (audit.error ? ': ' + audit.error : ''); }
})();
