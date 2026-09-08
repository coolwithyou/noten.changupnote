import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmationSheet } from "../../apps/web/src/features/match-results/ConfirmationSheet";

interface GetFixture {
  canSubmit: boolean;
  delayMs: number;
  persistedValue: "yes" | "no" | "unknown";
  pending?: boolean;
}

type PutMode = "success" | "forbidden" | "pending_forbidden";

const fixtures = new Map<string, GetFixture>([
  ["a", { canSubmit: false, delayMs: 0, persistedValue: "yes" }],
]);
const requests: Array<{ method: string; companyId: string }> = [];
const pendingPuts: Array<() => void> = [];
const pendingGets: Array<() => void> = [];
let putMode: PutMode = "success";

function confirmationData(companyId: string, fixture: GetFixture) {
  return {
    ok: true,
    data: {
      grantId: "audit-grant",
      canSubmit: fixture.canSubmit,
      questions: [{
        id: `question-${companyId}`,
        prompt: `확인 질문 ${companyId}`,
        answerType: "single",
        options: [
          { value: "yes", label: "예" },
          { value: "no", label: "아니오" },
          { value: "unknown", label: "확인할 수 없음", isUnknown: true },
        ],
      }],
      answers: [{
        questionId: `question-${companyId}`,
        values: [fixture.persistedValue],
        answerRevision: 1,
        answeredAt: "2026-09-08T00:00:00.000Z",
      }],
    },
  };
}

function forbiddenResponse() {
  return new Response(JSON.stringify({
    ok: false,
    error: { code: "company_write_forbidden", message: "조회 전용 권한입니다." },
  }), { status: 403, headers: { "content-type": "application/json" } });
}

window.fetch = async (input, init) => {
  const href = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  const url = new URL(href, "https://local.test");
  if (url.origin !== "https://local.test") throw new Error(`unexpected browser fixture origin: ${url.origin}`);
  const companyId = url.searchParams.get("companyId") ?? "none";
  const method = init?.method ?? "GET";
  requests.push({ method, companyId });
  if (method === "PUT") {
    if (putMode === "forbidden") return forbiddenResponse();
    if (putMode === "pending_forbidden") {
      return new Promise<Response>((resolve) => {
        pendingPuts.push(() => resolve(forbiddenResponse()));
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      data: {
        grantId: "audit-grant",
        saved: [],
        match: null,
        refresh: { plannedCount: 0, savedCount: 0, status: "not_persisted_user_scope" },
      },
    }), { headers: { "content-type": "application/json" } });
  }
  const fixture = { ...(fixtures.get(companyId) ?? { canSubmit: false, delayMs: 0, persistedValue: "unknown" as const }) };
  if (fixture.pending) {
    await new Promise<void>((resolve) => pendingGets.push(resolve));
  }
  if (fixture.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fixture.delayMs));
  return new Response(JSON.stringify(confirmationData(companyId, fixture)), {
    headers: { "content-type": "application/json" },
  });
};

interface BrowserAudit {
  requests: typeof requests;
  pendingPutCount: () => number;
  pendingGetCount: () => number;
  setCompany: (companyId: string) => void;
  setOpen: (open: boolean) => void;
  setGet: (companyId: string, fixture: GetFixture) => void;
  setPutMode: (mode: PutMode) => void;
  releasePendingPuts: () => void;
  releasePendingGets: () => void;
}

declare global {
  interface Window {
    confirmationSheetAudit: BrowserAudit;
  }
}

function Harness() {
  const [companyId, setCompanyId] = useState("a");
  const [open, setOpen] = useState(true);
  window.confirmationSheetAudit = {
    requests,
    pendingPutCount: () => pendingPuts.length,
    pendingGetCount: () => pendingGets.length,
    setCompany: setCompanyId,
    setOpen,
    setGet: (id, fixture) => fixtures.set(id, { ...fixture }),
    setPutMode: (mode) => { putMode = mode; },
    releasePendingPuts: () => pendingPuts.splice(0).forEach((release) => release()),
    releasePendingGets: () => pendingGets.splice(0).forEach((release) => release()),
  };
  return (
    <ConfirmationSheet
      grantId="audit-grant"
      grantTitle="확인질문 읽기 전용 브라우저 회귀"
      companyId={companyId}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

document.body.innerHTML = '<main id="root"></main>';
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
