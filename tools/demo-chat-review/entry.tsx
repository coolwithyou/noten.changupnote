import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { WorkspaceView } from '../../apps/web/src/features/apply-workspace/WorkspaceView';
import { workspaceData } from '../design-company-review/workspace-data';

const audit = { requests: [] as unknown[], routes: [] as string[] };
(window as any).designAudit = audit;
const router: any = { push: (url: string) => audit.routes.push(url), replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} };
window.fetch = async (input, init) => {
  const path = String(input);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  audit.requests.push({ path, method: init?.method ?? 'GET', body });
  if (path.includes('/api/web/chat')) {
    // AI SDK v1 UI-message SSE; entirely synthetic, never reaches a model/provider.
    const chunks = [{ type: 'start', messageId: 'synthetic-answer' }, { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: '합성 SSE 응답: 공고의 제출서류와 마감일을 확인해 주세요.' },
      { type: 'text-end', id: 'answer' }, { type: 'finish' }];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'X-Cunote-Chat-Session': 'synthetic-general-session' },
    });
  }
  if (path.includes('writing-sections')) return Response.json({ ok: true, data: { canWrite: true, canGenerate: false, consistency: null, sections: [] } });
  return Response.json({ ok: false, error: { message: 'UI 전용 합성 fixture에는 원본 파일을 연결하지 않았습니다.' } }, { status: 404 });
};
function Harness() {
  const [preview, setPreview] = useState(false);
  const data = { ...workspaceData, ladder: 'b' as const, connectedFields: [], documentAgentAvailable: false, fieldEditorAgentAvailable: false,
    ...(preview ? { draftId: null, execution: { mode: 'admin_preview' as const, companyName: '합성 미리보기 기업', reviewerEmail: 'synthetic@example.invalid' } } : {}) };
  return <AppRouterContext.Provider value={router}>
    <div style={{ padding: 12, background: '#fff5d8' }}>UI 전용 합성 SSE 검증 · 실제 WorkspaceView/ChatPanel · 운영 API·모델·파일 저장 없음</div>
    <button data-fixture-preview onClick={() => setPreview(!preview)}>합성 미리보기 전환</button>
    <WorkspaceView key={String(preview)} data={data} greeting={{ text: '공고에 관해 자유롭게 물어보세요.', generalNotice: true }} institutionContact={null} />
  </AppRouterContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
