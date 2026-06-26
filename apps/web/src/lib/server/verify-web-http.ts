interface JsonResponse<T = unknown> {
  status: number;
  body: T;
}

interface ActionResult<T> {
  ok?: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
  };
}

interface ApiEnvelope<T> {
  data?: T | null;
  error?: {
    code?: string;
    message?: string;
  };
}

const rawBaseUrl = process.env.CUNOTE_HTTP_VERIFY_BASE_URL?.trim();

if (!rawBaseUrl) {
  console.log(JSON.stringify({
    skipped: true,
    reason: "CUNOTE_HTTP_VERIFY_BASE_URL is not set.",
    example: "CUNOTE_HTTP_VERIFY_BASE_URL=http://127.0.0.1:4010 pnpm verify:web-http",
  }, null, 2));
  process.exit(0);
}

const baseUrl = rawBaseUrl.replace(/\/$/, "");
const email = process.env.CUNOTE_HTTP_VERIFY_EMAIL?.trim() || "demo@changupnote.com";
const checks: string[] = [];

const stats = await fetchJson<ActionResult<{ openCount: number }>>("/api/web/stats");
expectStatus(stats, 200, "web stats status");
expect(stats.body.ok === true, "web stats envelope ok");
expect(typeof stats.body.data?.openCount === "number", "web stats openCount");
checks.push("web_stats");

const notifications = await fetchJson<ActionResult<{
  deadlineReminder: boolean;
  newMatch: boolean;
}>>("/api/web/notifications");
expectStatus(notifications, 200, "web notifications status");
expect(notifications.body.ok === true, "web notifications envelope ok");
expect(typeof notifications.body.data?.deadlineReminder === "boolean", "web notifications deadlineReminder");
expect(typeof notifications.body.data?.newMatch === "boolean", "web notifications newMatch");
checks.push("web_notifications");

const dashboard = await fetchJson<ActionResult<{
  matches: Array<{ grantId: string; rulesetVer?: string }>;
}>>("/api/web/dashboard");
expectStatus(dashboard, 200, "web dashboard status");
expect(dashboard.body.ok === true, "web dashboard envelope ok");
const webGrant = dashboard.body.data?.matches.find((entry) => entry.grantId);
expect(Boolean(webGrant), "web dashboard exposes a match grant");
checks.push("web_dashboard");

const roadmap = await fetchJson<ActionResult<{
  roadmap: Array<{ grantId: string; bucket: string }>;
}>>("/api/web/roadmap");
expectStatus(roadmap, 200, "web roadmap status");
expect(roadmap.body.ok === true, "web roadmap envelope ok");
expect(Array.isArray(roadmap.body.data?.roadmap), "web roadmap list");
expect(Boolean(roadmap.body.data?.roadmap.find((entry) => entry.grantId && entry.bucket)), "web roadmap exposes nodes");
checks.push("web_roadmap");

const dashboardHtml = await fetchText("/dashboard");
expectStatus(dashboardHtml, 200, "web dashboard html status");
expect(dashboardHtml.body.includes("match-feedback-controls"), "web dashboard renders match feedback controls");
expect(dashboardHtml.body.includes("action-cta"), "web dashboard renders action queue cta");
expect(dashboardHtml.body.includes("id=\"next-question\""), "web dashboard renders next question anchor");
expect(dashboardHtml.body.includes("마감 알림"), "web dashboard renders deadline notification toggle");
expect(dashboardHtml.body.includes("새 매칭"), "web dashboard renders new match notification toggle");
expect(dashboardHtml.body.includes("회사정보 보강"), "web dashboard renders company enrichment control");
checks.push("web_dashboard_html");

const roadmapHtml = await fetchText("/roadmap");
expectStatus(roadmapHtml, 200, "web roadmap html status");
expect(roadmapHtml.body.includes("roadmap-lanes"), "web roadmap renders lanes");
expect(roadmapHtml.body.includes("전략 로드맵"), "web roadmap renders heading");
checks.push("web_roadmap_html");

const webEvent = await fetchJson<ActionResult<{ event: string }>>(
  `/api/web/matches/${encodeURIComponent(webGrant!.grantId)}/events`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "apply_click", rulesetVer: webGrant!.rulesetVer }),
  },
);
expectStatus(webEvent, 202, "web event status");
expect(webEvent.body.ok === true && webEvent.body.data?.event === "apply_click", "web event accepted");
checks.push("web_match_event");

const login = await fetchJson<ApiEnvelope<{ accessToken?: string }>>("/api/app/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, deviceId: "verify-web-http" }),
});
expectStatus(login, 200, "app login status");
const accessToken = login.body.data?.accessToken;
expect(Boolean(accessToken), "app login access token");
checks.push("app_login");

const companies = await fetchJson<ApiEnvelope<Array<{ id: string }> | { companies: Array<{ id: string }> }>>(
  "/api/app/v1/companies",
  { headers: { authorization: `Bearer ${accessToken}` } },
);
expectStatus(companies, 200, "app companies status");
const companyId = Array.isArray(companies.body.data)
  ? companies.body.data[0]?.id
  : companies.body.data?.companies[0]?.id;
expect(Boolean(companyId), "app companies company id");
checks.push("app_companies");

const appMatches = await fetchJson<ApiEnvelope<{
  matches: Array<{ grantId: string; rulesetVer?: string }>;
}>>(`/api/app/v1/companies/${companyId}/matches`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appMatches, 200, "app matches status");
const appGrant = appMatches.body.data?.matches.find((entry) => entry.grantId);
expect(Boolean(appGrant), "app matches exposes a match grant");
checks.push("app_matches");

const appGrantDetail = await fetchJson<ApiEnvelope<{
  grant: { id: string; title: string };
}>>(`/api/app/v1/grants/${encodeURIComponent(appGrant!.grantId)}?companyId=${encodeURIComponent(companyId!)}`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appGrantDetail, 200, "app grant detail status");
expect(appGrantDetail.body.data?.grant.id === appGrant!.grantId, "app grant detail uses selected company context");
checks.push("app_grant_detail");

const appEvent = await fetchJson<ApiEnvelope<{ event: string }>>(
  `/api/app/v1/matches/${companyId}/${encodeURIComponent(appGrant!.grantId)}/events`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ event: "clicked", rulesetVer: appGrant!.rulesetVer }),
  },
);
expectStatus(appEvent, 202, "app event status");
expect(appEvent.body.data?.event === "clicked", "app event accepted");
checks.push("app_match_event");

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  checks,
  companyId,
  webGrantId: webGrant!.grantId,
  appGrantId: appGrant!.grantId,
}, null, 2));

async function fetchJson<T>(path: string, init?: RequestInit): Promise<JsonResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json() as T;
  return {
    status: response.status,
    body,
  };
}

async function fetchText(path: string, init?: RequestInit): Promise<JsonResponse<string>> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.text();
  return {
    status: response.status,
    body,
  };
}

function expectStatus(response: JsonResponse, status: number, label: string) {
  expect(response.status === status, `${label}: expected ${status}, got ${response.status}`);
}

function expect(condition: boolean, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

export {};
