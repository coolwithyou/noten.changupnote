import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GrantConfirmationSubmitResult } from "@cunote/contracts";
import { InlineGrantConfirmation } from "../../apps/web/src/features/match-results/InlineGrantConfirmation";

const requests: Array<{ method: string; body: unknown }> = [];
const savedResults: GrantConfirmationSubmitResult[] = [];
const preparedGrantIds: string[] = [];

const binding = {
  contractVersion: "confirmation-evaluation-v2" as const,
  criterionId: "criterion-location",
  sourceRevisionSha256: "a".repeat(64),
  sourceRawSha256: "b".repeat(64),
  definitionSha256: "c".repeat(64),
  questionVersion: 2,
};

const match = {
  grantId: "audit-grant",
  title: "브라우저 확인 공고",
  source: "kstartup" as const,
  status: "open" as const,
  eligibility: "eligible" as const,
  recommendationTier: "recommendable" as const,
  recommendationReasonCodes: [],
  matchReasons: ["확인한 조건에 맞아요"],
  riskFlags: [],
  requiredDocs: [],
  ruleTrace: [],
  deadline: null,
};

window.fetch = async (_input, init) => {
  const method = init?.method ?? "GET";
  requests.push({
    method,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
  });
  if (method === "PUT") {
    return new Response(JSON.stringify({
      ok: true,
      data: {
        grantId: "audit-grant",
        saved: [],
        match,
        refresh: { plannedCount: 1, savedCount: 1, status: "succeeded" },
      } satisfies GrantConfirmationSubmitResult,
    }), { headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({
    ok: true,
    data: {
      grantId: "audit-grant",
      canSubmit: true,
      questions: [{
        id: "question-location",
        prompt: "선정되면 사업장을 이전할 수 있나요?",
        answerType: "single",
        options: [
          { value: "yes", label: "네, 가능해요" },
          { value: "no", label: "어려워요" },
          { value: "unknown", label: "잘 모르겠어요", isUnknown: true },
        ],
        binding,
      }],
      answers: [],
    },
  }), { headers: { "content-type": "application/json" } });
};

interface InlineGrantAudit {
  requests: typeof requests;
  savedResults: typeof savedResults;
}

declare global {
  interface Window {
    inlineGrantAudit: InlineGrantAudit & { preparedGrantIds: string[] };
  }
}

function Harness() {
  const [fallbackCount, setFallbackCount] = useState(0);
  window.inlineGrantAudit = { requests, savedResults, preparedGrantIds };
  return (
    <main>
      <InlineGrantConfirmation
        companyId="company-a"
        grantId="audit-grant"
        questionId="question-location"
        onSaved={(result) => savedResults.push(result)}
        onPrepare={(grantId) => preparedGrantIds.push(grantId)}
        onFallback={() => setFallbackCount((current) => current + 1)}
      />
      <output data-testid="fallback-count">{fallbackCount}</output>
    </main>
  );
}

document.body.innerHTML = '<div id="root"></div>';
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
