import assert from "node:assert/strict";
import type { ActionResult } from "@cunote/contracts";
import { POST } from "./route";

const companyPreviewEvents = [
  "company_preview_requested",
  "company_preview_succeeded",
  "company_preview_failed",
  "company_confirmed",
  "company_rejected",
] as const;

for (const event of companyPreviewEvents) {
  const response = await POST(new Request("http://localhost/api/web/landing-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, requestId: "company-preview-test" }),
  }));
  const body = await response.json() as ActionResult<{ accepted: true; event: string }>;
  assert.equal(response.status, 202, `${event} must be accepted`);
  assert.equal(body.ok, true);
  assert.equal(body.data?.accepted, true);
  assert.equal(body.data?.event, event);
}

console.log("landing-events/route.test.ts: all assertions passed");
