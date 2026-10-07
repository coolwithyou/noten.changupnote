import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildReconciledApplicationFields } from '../../apps/web/src/lib/server/documents/applicationFieldAnalysis';
import { seedProfileFieldAnswers } from '../../apps/web/src/lib/server/documents/seedProfileAnswers';
import { classifyApplicationPrecomputeDocument } from '../../apps/web/src/lib/server/documents/applicationPrecomputeMaterialization';
const [sourcePath, analysisPath, outputPath] = process.argv.slice(2);
if (!sourcePath || !analysisPath || !outputPath) throw Error('source.hwpx analysis.json output.json 필요');
const sourceSha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
const run = JSON.parse(readFileSync(analysisPath, 'utf8'));
const document = run.documents.find((document: any) => document.sourceSha256 === sourceSha256);
if (!document) throw Error('같은 원문 SHA의 분석 문서 없음');
// 승인·승격 경로를 호출하지 않는 pure consumer다. 저장된 held 상태를 그대로 보고한다.
const admission = classifyApplicationPrecomputeDocument(document);
const fields = buildReconciledApplicationFields(document).map(field => {
  const candidate = document.fields.find((candidate: any) => candidate.recommendedInput
    && candidate.location.blockIndex === field.position?.blockIndex
    && candidate.location.row === field.position?.row && candidate.location.col === field.position?.col
    && candidate.location.occurrence === field.position?.occurrence);
  if (!candidate) throw Error('source candidate identity 불일치');
  return { ...field, fieldId: candidate.fieldInstanceId, anchorLabel: field.position?.anchorLabel };
});
const profile = { personal: { fullName: null, applicationEmail: null, phone: null, postalCode: null, addressLine1: null, addressLine2: null },
  company: { name: '합성 검증 기업', representativeName: '합성 대표', businessNumber: '0000000000', businessNumberVerified: false,
    applicationEmail: null, phone: null, postalCode: null, addressLine1: null, addressLine2: null }, updatedAt: null };
const seededAnswers = seedProfileFieldAnswers({ fields, profile: { name: profile.company.name } as any,
  identity: { businessNumber: profile.company.businessNumber }, current: {} });
writeFileSync(outputPath, JSON.stringify({ sourceSha256, profile, seededAnswers, analysisSha256: createHash('sha256').update(readFileSync(analysisPath)).digest('hex'),
  admission, rawCandidateCount: document.fields.length, acceptedCandidateCount: document.fields.filter((candidate: any) => candidate.recommendedInput).length, fields }));
console.log(JSON.stringify({ sourceSha256, admission, projectedCount: fields.length }));
