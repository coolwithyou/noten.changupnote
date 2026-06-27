interface JsonResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
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
  meta?: {
    cursor?: string | null;
    hasMore?: boolean;
    rulesetVer?: string;
    scoringVer?: string;
  };
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
const preliminaryProfile = {
  is_preliminary: true,
  region: { code: "41", label: "경기" },
  founder_age: 35,
  industries: ["ICT"],
  confidence: {
    region: 0.55,
    biz_age: 0.45,
    founder_age: 0.55,
    industry: 0.35,
  },
};

const stats = await fetchJson<ActionResult<{ openCount: number }>>("/api/web/stats");
expectStatus(stats, 200, "web stats status");
expect(stats.body.ok === true, "web stats envelope ok");
expect(typeof stats.body.data?.openCount === "number", "web stats openCount");
checks.push("web_stats");

const adminStatus = await fetchJson<ApiEnvelope<{
  ok: boolean;
  role: "admin";
  mode: "demo" | "session";
  surfaces: string[];
  runtime: {
    repositoryAdapter: "runtime" | "drizzle";
    webDataSource: "auto" | "sample" | "live";
    authRequired: boolean;
    authProviders: string[];
    databaseConfigured: boolean;
  };
}>>("/api/admin/status");
expect(
  adminStatus.status === 200 || adminStatus.status === 403,
  `admin status boundary: expected 200 or 403, got ${adminStatus.status}`,
);
if (adminStatus.status === 200) {
  expect(adminStatus.body.data?.ok === true, "admin status ok");
  expect(adminStatus.body.data?.surfaces.includes("golden_set") === true, "admin status surfaces");
  expect(["runtime", "drizzle"].includes(adminStatus.body.data.runtime.repositoryAdapter), "admin status runtime adapter");
  expect(typeof adminStatus.body.data.runtime.authRequired === "boolean", "admin status runtime auth");
} else {
  expect(adminStatus.body.error?.code === "admin_forbidden", "admin status forbidden code");
}
checks.push("admin_status_boundary");

const loginHtml = await fetchText("/login?callbackUrl=%2Fdashboard");
expectStatus(loginHtml, 200, "web login html status");
expect(
  loginHtml.body.includes("로그인") || loginHtml.body.includes("기회 맵"),
  "web login renders sign-in or redirects authenticated session",
);
checks.push("web_login_html");

const teaser = await fetchJson<ActionResult<{
  estimatedMaxAmount: number;
  conditionalUpside: number;
  privacyNote: string;
  matches: Array<{ grantId: string; eligibility: string }>;
}>>("/api/web/teaser", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
});
expectStatus(teaser, 200, "web teaser status");
expect(teaser.body.ok === true, "web teaser envelope ok");
expect(typeof teaser.body.data?.estimatedMaxAmount === "number", "web teaser estimatedMaxAmount");
expect(typeof teaser.body.data?.conditionalUpside === "number", "web teaser conditionalUpside");
expect(Boolean(teaser.body.data?.privacyNote), "web teaser privacy note");
expect(Boolean(teaser.body.data?.matches.find((entry) => entry.grantId)), "web teaser exposes matches");
checks.push("web_teaser");

const preliminaryTeaser = await fetchJson<ActionResult<{
  attributes: { region: string | null; industry: string[] };
  matches: Array<{ grantId: string; eligibility: string }>;
}>>("/api/web/teaser", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ profile: preliminaryProfile }),
});
expectStatus(preliminaryTeaser, 200, "web preliminary teaser status");
expect(preliminaryTeaser.body.ok === true, "web preliminary teaser envelope ok");
expect(preliminaryTeaser.body.data?.attributes.region === "경기", "web preliminary teaser region");
expect(preliminaryTeaser.body.data?.attributes.industry.includes("ICT"), "web preliminary teaser industry");
expect(Boolean(preliminaryTeaser.body.data?.matches.find((entry) => entry.grantId)), "web preliminary teaser exposes matches");
checks.push("web_preliminary_teaser");

const webCompanyCreate = await fetchJson<ActionResult<{
  currentCompanyId: string;
  company: {
    id: string;
    profile: {
      region?: { code: string; label?: string };
      is_preliminary?: boolean;
      industries?: string[];
    };
  };
}>>("/api/web/companies", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ profile: preliminaryProfile }),
});
expectStatus(webCompanyCreate, 201, "web company create status");
expect(webCompanyCreate.body.ok === true, "web company create envelope ok");
expect(Boolean(webCompanyCreate.body.data?.currentCompanyId), "web company create selected company");
expect(webCompanyCreate.body.data?.company.profile.is_preliminary === true, "web company create keeps preliminary profile");
expect(webCompanyCreate.body.data?.company.profile.region?.label === "경기", "web company create keeps region");
const selectedCompanyCookie = cookieHeader(webCompanyCreate.headers, "cunote_selected_company_id");
expect(Boolean(selectedCompanyCookie), "web company create sets selected company cookie");
checks.push("web_company_create");

const preliminaryDashboard = await fetchJson<ActionResult<{
  company: { region: string | null; industries: string[] };
}>>("/api/web/dashboard", {
  headers: { cookie: selectedCompanyCookie! },
});
expectStatus(preliminaryDashboard, 200, "web preliminary dashboard status");
expect(preliminaryDashboard.body.ok === true, "web preliminary dashboard envelope ok");
expect(preliminaryDashboard.body.data?.company.region === "경기", "web preliminary dashboard uses selected profile");
expect(preliminaryDashboard.body.data?.company.industries.includes("ICT"), "web preliminary dashboard keeps industry");
checks.push("web_preliminary_dashboard");

const notifications = await fetchJson<ActionResult<{
  deadlineReminder: boolean;
  newMatch: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}>>("/api/web/notifications");
expectStatus(notifications, 200, "web notifications status");
expect(notifications.body.ok === true, "web notifications envelope ok");
expect(typeof notifications.body.data?.deadlineReminder === "boolean", "web notifications deadlineReminder");
expect(typeof notifications.body.data?.newMatch === "boolean", "web notifications newMatch");
checks.push("web_notifications");

const webNotificationUpdate = await fetchJson<ActionResult<{
  deadlineReminder: boolean;
  newMatch: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}>>("/api/web/notifications", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    deadlineReminder: true,
    newMatch: false,
    quietHoursStart: "23:00",
    quietHoursEnd: "08:00",
  }),
});
expectStatus(webNotificationUpdate, 200, "web notification update status");
expect(webNotificationUpdate.body.ok === true, "web notification update envelope ok");
expect(webNotificationUpdate.body.data?.newMatch === false, "web notification update newMatch");
expect(webNotificationUpdate.body.data?.quietHoursEnd === "08:00", "web notification update quietHoursEnd");
checks.push("web_notification_update");

const webNotificationFeed = await fetchJson<ActionResult<{
  generatedAt: string;
  notifications: Array<{ id: string; kind: string; priority: string; target: string }>;
}>>("/api/web/notification-feed");
expectStatus(webNotificationFeed, 200, "web notification feed status");
expect(webNotificationFeed.body.ok === true, "web notification feed envelope ok");
expect(typeof webNotificationFeed.body.data?.generatedAt === "string", "web notification feed generatedAt");
expect(Array.isArray(webNotificationFeed.body.data?.notifications), "web notification feed list");
checks.push("web_notification_feed");

const webCompanies = await fetchJson<ActionResult<{
  currentCompanyId: string;
  companies: Array<{ id: string }>;
}>>("/api/web/companies");
expectStatus(webCompanies, 200, "web companies status");
expect(webCompanies.body.ok === true, "web companies envelope ok");
const webCompanyId = webCompanies.body.data?.currentCompanyId;
expect(Boolean(webCompanyId), "web companies current company");
expect(Boolean(webCompanies.body.data?.companies.find((company) => company.id === webCompanyId)), "web companies include current company");
checks.push("web_companies");

const webCompanySwitch = await fetchJson<ActionResult<{ currentCompanyId: string }>>("/api/web/companies/switch", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ companyId: webCompanyId }),
});
expectStatus(webCompanySwitch, 200, "web company switch status");
expect(webCompanySwitch.body.ok === true, "web company switch envelope ok");
expect(webCompanySwitch.body.data?.currentCompanyId === webCompanyId, "web company switch selected company");
checks.push("web_company_switch");

const webCompanyVerify = await fetchJson<ActionResult<{
  companyId: string;
  bizNoMasked: string;
  verified: boolean;
  verifyMethod: string;
}>>("/api/web/companies/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ bizNo: "1234567890", ownerName: "검증 대표", openedOn: "2024-01-15" }),
});
expectStatus(webCompanyVerify, 200, "web company verify status");
expect(webCompanyVerify.body.ok === true, "web company verify envelope ok");
expect(webCompanyVerify.body.data?.companyId === webCompanyId, "web company verify company id");
expect(!Object.hasOwn(webCompanyVerify.body.data ?? {}, "bizNo"), "web company verify hides raw bizNo");
expect(webCompanyVerify.body.data?.bizNoMasked === "123-**-67***", "web company verify masked bizNo");
expect(webCompanyVerify.body.data?.verified === true, "web company verify result");
checks.push("web_company_verify");

const webCompaniesAfterVerify = await fetchJson<ActionResult<{
  currentCompanyId: string;
  companies: Array<{ id: string; verified?: boolean; bizNoMasked?: string | null }>;
}>>("/api/web/companies");
expectStatus(webCompaniesAfterVerify, 200, "web companies after verify status");
const verifiedWebCompany = webCompaniesAfterVerify.body.data?.companies.find((company) => company.id === webCompanyId);
expect(verifiedWebCompany?.verified === true, "web companies expose verified state");
expect(verifiedWebCompany?.bizNoMasked === "123-**-67***", "web companies expose masked bizNo");
checks.push("web_company_verified_state");

const dashboard = await fetchJson<ActionResult<{
  matches: Array<{ grantId: string; rulesetVer?: string }>;
}>>("/api/web/dashboard");
expectStatus(dashboard, 200, "web dashboard status");
expect(dashboard.body.ok === true, "web dashboard envelope ok");
const webGrant = dashboard.body.data?.matches.find((entry) => entry.grantId);
expect(Boolean(webGrant), "web dashboard exposes a match grant");
checks.push("web_dashboard");

const webFilteredMatches = await fetchJson<ActionResult<{
  matches: Array<{ grantId: string; eligibility: string; fitScore: number }>;
  cursor: string | null;
  hasMore: boolean;
  total: number;
}>>("/api/web/matches?status=eligible&sort=fit&limit=2");
expectStatus(webFilteredMatches, 200, "web filtered matches status");
expect(webFilteredMatches.body.ok === true, "web filtered matches envelope ok");
expect(Array.isArray(webFilteredMatches.body.data?.matches), "web filtered matches list");
expect(
  webFilteredMatches.body.data!.matches.every((entry) => entry.eligibility === "eligible"),
  "web filtered matches eligibility",
);
expectSortedByFit(webFilteredMatches.body.data!.matches, "web filtered matches fit sort");
expect(typeof webFilteredMatches.body.data?.hasMore === "boolean", "web filtered matches hasMore");
expect(typeof webFilteredMatches.body.data?.total === "number", "web filtered matches total");
checks.push("web_filtered_matches");

const roadmap = await fetchJson<ActionResult<{
  roadmap: Array<{ grantId: string; bucket: string }>;
}>>("/api/web/roadmap");
expectStatus(roadmap, 200, "web roadmap status");
expect(roadmap.body.ok === true, "web roadmap envelope ok");
expect(Array.isArray(roadmap.body.data?.roadmap), "web roadmap list");
expect(Boolean(roadmap.body.data?.roadmap.find((entry) => entry.grantId && entry.bucket)), "web roadmap exposes nodes");
checks.push("web_roadmap");

const webNextQuestion = await fetchJson<ActionResult<{
  inputType?: string;
  options?: string[];
  affectedGrantCount?: number;
} | null>>("/api/web/next-question", {
  headers: { cookie: selectedCompanyCookie! },
});
expectStatus(webNextQuestion, 200, "web next question status");
expect(webNextQuestion.body.ok === true, "web next question envelope ok");
expectQuestionInputOptions(webNextQuestion.body.data, "web next question options");
checks.push("web_next_question_options");

const webActionQueue = await fetchJson<ActionResult<Array<{
  id: string;
  kind: string;
  target: string;
  affectedGrantIds: string[];
}>>>("/api/web/action-queue", {
  headers: { cookie: selectedCompanyCookie! },
});
expectStatus(webActionQueue, 200, "web action queue status");
expect(webActionQueue.body.ok === true, "web action queue envelope ok");
expect(Array.isArray(webActionQueue.body.data), "web action queue list");
expectActionQueueEnrich(webActionQueue.body.data, "web action queue enrich");
checks.push("web_action_queue_enrich");

const dashboardHtml = await fetchText("/dashboard");
expectStatus(dashboardHtml, 200, "web dashboard html status");
expect(dashboardHtml.body.includes("match-feedback-controls"), "web dashboard renders match feedback controls");
expect(dashboardHtml.body.includes("opportunity-controls"), "web dashboard renders match filter controls");
expect(dashboardHtml.body.includes("id=\"match-sort\""), "web dashboard renders match sort control");
expect(dashboardHtml.body.includes("action-cta"), "web dashboard renders action queue cta");
expect(dashboardHtml.body.includes("id=\"next-question\""), "web dashboard renders next question anchor");
expect(dashboardHtml.body.includes("id=\"company-settings\""), "web dashboard renders company settings anchor");
expect(dashboardHtml.body.includes("마감 알림"), "web dashboard renders deadline notification toggle");
expect(dashboardHtml.body.includes("새 매칭"), "web dashboard renders new match notification toggle");
expect(dashboardHtml.body.includes("회사정보 보강"), "web dashboard renders company enrichment control");
expect(dashboardHtml.body.includes("검증"), "web dashboard renders company verification control");
expect(dashboardHtml.body.includes("id=\"company-verify-owner-name\""), "web dashboard renders owner-name verification input");
expect(dashboardHtml.body.includes("id=\"company-verify-opened-on\""), "web dashboard renders opened-on verification input");
expect(dashboardHtml.body.includes("수기 프로필"), "web dashboard renders manual profile form");
expect(dashboardHtml.body.includes("id=\"manual-target-type\""), "web dashboard renders target type input");
expect(dashboardHtml.body.includes("기수혜 없음"), "web dashboard renders no-prior-award control");
expect(dashboardHtml.body.includes("ineligible-disclosure"), "web dashboard renders collapsed ineligible reasons");
checks.push("web_dashboard_html");

const roadmapHtml = await fetchText("/roadmap");
expectStatus(roadmapHtml, 200, "web roadmap html status");
expect(roadmapHtml.body.includes("roadmap-lanes"), "web roadmap renders lanes");
expect(roadmapHtml.body.includes("전략 로드맵"), "web roadmap renders heading");
checks.push("web_roadmap_html");

const adminHtml = await fetchText("/admin");
expectStatus(adminHtml, 200, "admin html status");
expect(adminHtml.body.includes("플라이휠 운영 콘솔"), "admin renders flywheel shell");
expect(
  adminHtml.body.includes("어드민 접근 권한 필요") || adminHtml.body.includes("extraction_log"),
  "admin renders denied state or flywheel surfaces",
);
checks.push("admin_html_boundary");

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

const webFeedback = await fetchJson<ActionResult<{ receipt: { id: string; receivedAt: string } }>>(
  `/api/web/matches/${encodeURIComponent(webGrant!.grantId)}/feedback`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "saved", message: "HTTP 검증" }),
  },
);
expectStatus(webFeedback, 202, "web feedback status");
expect(Boolean(webFeedback.body.data?.receipt.id), "web feedback receipt id");
checks.push("web_match_feedback");

const webGrantDetail = await fetchJson<ActionResult<{
  grant: { id: string; title: string };
  applicationPrep: {
    autoSubmitSupported: boolean;
    profileCopyFields: Array<{ label: string; value: string }>;
    planDraftPrompts: Array<{ title: string; evidence: string[] }>;
  };
}>>(`/api/web/grants/${encodeURIComponent(webGrant!.grantId)}`);
expectStatus(webGrantDetail, 200, "web grant detail status");
expect(webGrantDetail.body.ok === true, "web grant detail envelope ok");
expect(webGrantDetail.body.data?.grant.id === webGrant!.grantId, "web grant detail matches dashboard grant");
expect(webGrantDetail.body.data?.applicationPrep.autoSubmitSupported === false, "web grant detail disables auto submit");
expect(
  Boolean(webGrantDetail.body.data?.applicationPrep.profileCopyFields.find((field) => field.label === "소재지")),
  "web grant detail exposes profile copy fields",
);
expect(webGrantDetail.body.data?.applicationPrep.planDraftPrompts.length === 3, "web grant detail exposes plan prompts");
checks.push("web_grant_detail");

const webGrantDetailHtml = await fetchText(`/grants/${encodeURIComponent(webGrant!.grantId)}`);
expectStatus(webGrantDetailHtml, 200, "web grant detail html status");
expect(webGrantDetailHtml.body.includes("신청 준비 시트"), "web grant detail renders apply sheet");
expect(webGrantDetailHtml.body.includes("체크리스트"), "web grant detail renders checklist");
expect(webGrantDetailHtml.body.includes("복붙 프로필"), "web grant detail renders profile copy section");
expect(webGrantDetailHtml.body.includes("초안 프롬프트"), "web grant detail renders plan prompt section");
expect(webGrantDetailHtml.body.includes("신청 페이지 열기"), "web grant detail renders apply link");
checks.push("web_grant_detail_html");

const webConsentGrant = await fetchJson<ActionResult<{
  scope: string;
  revokedAt: string | null;
}>>("/api/web/consents", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scope: "insurance", purpose: "HTTP 검증" }),
});
expectStatus(webConsentGrant, 200, "web consent grant status");
expect(webConsentGrant.body.ok === true, "web consent grant envelope ok");
expect(webConsentGrant.body.data?.scope === "insurance", "web consent grant scope");
expect(webConsentGrant.body.data?.revokedAt === null, "web consent grant active");
checks.push("web_consent_grant");

const webConsents = await fetchJson<ActionResult<{
  companyId: string;
  consents: Array<{ scope: string; revokedAt: string | null }>;
}>>("/api/web/consents");
expectStatus(webConsents, 200, "web consents status");
expect(webConsents.body.ok === true, "web consents envelope ok");
expect(Boolean(webConsents.body.data?.consents.find((entry) => entry.scope === "insurance" && entry.revokedAt === null)), "web consents include active insurance");
checks.push("web_consents");

const webConsentRevoke = await fetchJson<ActionResult<{
  scope: string;
  revoked: boolean;
}>>("/api/web/consents/insurance", {
  method: "DELETE",
});
expectStatus(webConsentRevoke, 200, "web consent revoke status");
expect(webConsentRevoke.body.ok === true, "web consent revoke envelope ok");
expect(webConsentRevoke.body.data?.scope === "insurance", "web consent revoke scope");
expect(webConsentRevoke.body.data?.revoked === true, "web consent revoked");
checks.push("web_consent_revoke");

const webProfileField = await fetchJson<ActionResult<{
  profile: {
    revenue_krw?: number | null;
    confidence?: Record<string, number>;
  };
}>>("/api/web/profile/field", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ field: "revenue", value: 120000000, confidence: 0.77 }),
});
expectStatus(webProfileField, 200, "web profile field status");
expect(webProfileField.body.ok === true, "web profile field envelope ok");
expect(webProfileField.body.data?.profile.revenue_krw === 120000000, "web profile field persists revenue");
expect(webProfileField.body.data?.profile.confidence?.revenue === 0.77, "web profile field persists confidence");
checks.push("web_profile_field");

const webPriorAwardField = await fetchJson<ActionResult<{
  profile: {
    prior_awards?: string[];
    confidence?: Record<string, number>;
  };
}>>("/api/web/profile/field", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ field: "prior_award", value: [], confidence: 0.78 }),
});
expectStatus(webPriorAwardField, 200, "web prior award field status");
expect(webPriorAwardField.body.ok === true, "web prior award field envelope ok");
expect(Array.isArray(webPriorAwardField.body.data?.profile.prior_awards), "web prior award field persists empty list");
expect(webPriorAwardField.body.data?.profile.prior_awards?.length === 0, "web prior award field stores no-award self report");
expect(webPriorAwardField.body.data?.profile.confidence?.prior_award === 0.78, "web prior award field persists confidence");
checks.push("web_prior_award_field");

const login = await fetchJson<ApiEnvelope<{
  accessToken?: string;
  refreshToken?: string;
  deviceId?: string;
}>>("/api/app/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, deviceId: "verify-web-http" }),
});
expectStatus(login, 200, "app login status");
const accessToken = login.body.data?.accessToken;
const refreshToken = login.body.data?.refreshToken;
expect(Boolean(accessToken), "app login access token");
expect(Boolean(refreshToken), "app login refresh token");
expect(login.body.data?.deviceId === "verify-web-http", "app login device id");
checks.push("app_login");

const refresh = await fetchJson<ApiEnvelope<{
  accessToken?: string;
  refreshToken?: string;
  deviceId?: string;
}>>("/api/app/v1/auth/refresh", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ refreshToken }),
});
expectStatus(refresh, 200, "app refresh status");
expect(Boolean(refresh.body.data?.accessToken), "app refresh access token");
expect(Boolean(refresh.body.data?.refreshToken), "app refresh refresh token");
expect(refresh.body.data?.refreshToken !== refreshToken, "app refresh rotates token");
expect(refresh.body.data?.deviceId === "verify-web-http", "app refresh keeps device id");
checks.push("app_refresh");

const reusedRefresh = await fetchJson<ApiEnvelope<null>>("/api/app/v1/auth/refresh", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ refreshToken }),
});
expectStatus(reusedRefresh, 401, "app reused refresh status");
expect(reusedRefresh.body.error?.code === "invalid_token", "app reused refresh rejected");
checks.push("app_refresh_reuse_rejected");

const oauthLogin = await fetchJson<ApiEnvelope<{ accessToken?: string; deviceId?: string }>>("/api/app/v1/auth/google", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: "verify-oauth-code", deviceId: "verify-web-http-oauth" }),
});
expectStatus(oauthLogin, 200, "app oauth login status");
expect(Boolean(oauthLogin.body.data?.accessToken), "app oauth login access token");
expect(oauthLogin.body.data?.deviceId === "verify-web-http-oauth", "app oauth login device id");
checks.push("app_oauth_login");

const appStats = await fetchJson<ApiEnvelope<{ openCount: number }>>("/api/app/v1/stats");
expectStatus(appStats, 200, "app stats status");
expect(typeof appStats.body.data?.openCount === "number", "app stats openCount");
checks.push("app_stats");

const appOpenApi = await fetchJson<{
  openapi?: string;
  servers?: Array<{ url?: string }>;
  paths?: Record<string, unknown>;
}>("/api/app/v1/openapi.json");
expectStatus(appOpenApi, 200, "app openapi status");
expect(appOpenApi.body.openapi === "3.1.0", "app openapi version");
expect(
  Boolean(appOpenApi.body.servers?.find((server) => server.url === "https://dev.changupnote.com")),
  "app openapi dev tunnel server",
);
expect(
  Boolean(appOpenApi.body.paths?.["/api/app/v1/companies/{companyId}/matches"]),
  "app openapi exposes company matches",
);
expect(
  Boolean(appOpenApi.body.paths?.["/api/app/v1/companies/{companyId}/notifications"]),
  "app openapi exposes company notifications",
);
checks.push("app_openapi");

const appTeaser = await fetchJson<ApiEnvelope<{
  estimatedMaxAmount: number;
  conditionalUpside: number;
  privacyNote: string;
  matches: Array<{ grantId: string; eligibility: string }>;
}>>("/api/app/v1/teaser", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
});
expectStatus(appTeaser, 200, "app teaser status");
expect(typeof appTeaser.body.data?.estimatedMaxAmount === "number", "app teaser estimatedMaxAmount");
expect(typeof appTeaser.body.data?.conditionalUpside === "number", "app teaser conditionalUpside");
expect(Boolean(appTeaser.body.data?.privacyNote), "app teaser privacy note");
expect(Boolean(appTeaser.body.data?.matches.find((entry) => entry.grantId)), "app teaser exposes matches");
checks.push("app_teaser");

const appPreliminaryTeaser = await fetchJson<ApiEnvelope<{
  attributes: { region: string | null; industry: string[] };
  matches: Array<{ grantId: string; eligibility: string }>;
}>>("/api/app/v1/teaser", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ profile: preliminaryProfile }),
});
expectStatus(appPreliminaryTeaser, 200, "app preliminary teaser status");
expect(appPreliminaryTeaser.body.data?.attributes.region === "경기", "app preliminary teaser region");
expect(appPreliminaryTeaser.body.data?.attributes.industry.includes("ICT"), "app preliminary teaser industry");
expect(Boolean(appPreliminaryTeaser.body.data?.matches.find((entry) => entry.grantId)), "app preliminary teaser exposes matches");
checks.push("app_preliminary_teaser");

const appCompanyCreate = await fetchJson<ApiEnvelope<{
  company: {
    id: string;
    profile: {
      region?: { code: string; label?: string };
      is_preliminary?: boolean;
      industries?: string[];
    };
  };
}>>("/api/app/v1/companies", {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ profile: preliminaryProfile }),
});
expectStatus(appCompanyCreate, 201, "app company create status");
expect(Boolean(appCompanyCreate.body.data?.company.id), "app company create id");
expect(appCompanyCreate.body.data?.company.profile.is_preliminary === true, "app company create keeps preliminary profile");
expect(appCompanyCreate.body.data?.company.profile.region?.label === "경기", "app company create keeps region");
expect(appCompanyCreate.body.data?.company.profile.industries?.includes("ICT") === true, "app company create keeps industry");
checks.push("app_company_create");

const appNotifications = await fetchJson<ApiEnvelope<{
  deadlineReminder: boolean;
  newMatch: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}>>("/api/app/v1/notifications/settings", {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appNotifications, 200, "app notifications status");
expect(typeof appNotifications.body.data?.deadlineReminder === "boolean", "app notifications deadlineReminder");
checks.push("app_notifications");

const appNotificationUpdate = await fetchJson<ApiEnvelope<{
  deadlineReminder: boolean;
  newMatch: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}>>("/api/app/v1/notifications/settings", {
  method: "PUT",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    deadlineReminder: false,
    newMatch: true,
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
  }),
});
expectStatus(appNotificationUpdate, 200, "app notification update status");
expect(appNotificationUpdate.body.data?.deadlineReminder === false, "app notification update deadlineReminder");
expect(appNotificationUpdate.body.data?.quietHoursStart === "22:00", "app notification update quietHoursStart");
checks.push("app_notification_update");

const deviceId = "verify-web-http-device";
const appDevice = await fetchJson<ApiEnvelope<{
  deviceId: string;
  platform: "ios" | "android";
  registered: boolean;
}>>("/api/app/v1/devices", {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    deviceId,
    platform: "ios",
    pushToken: "verify-push-token",
  }),
});
expectStatus(appDevice, 201, "app device register status");
expect(appDevice.body.data?.deviceId === deviceId, "app device id");
expect(appDevice.body.data?.registered === true, "app device registered");
checks.push("app_device_register");

const appDeviceDelete = await fetchJson<ApiEnvelope<{ deleted: boolean }>>(`/api/app/v1/devices/${deviceId}`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appDeviceDelete, 200, "app device delete status");
expect(appDeviceDelete.body.data?.deleted === true, "app device deleted");
checks.push("app_device_delete");

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

const appCompanyVerify = await fetchJson<ApiEnvelope<{
  companyId: string;
  bizNoMasked: string;
  verified: boolean;
  verifyMethod: string;
}>>(`/api/app/v1/companies/${companyId}/verify`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    bizNo: "1234567890",
    ownerName: "검증 대표",
    openedOn: "2024-01-01",
  }),
});
expectStatus(appCompanyVerify, 200, "app company verify status");
expect(appCompanyVerify.body.data?.companyId === companyId, "app company verify company id");
expect(!Object.hasOwn(appCompanyVerify.body.data ?? {}, "bizNo"), "app company verify hides raw bizNo");
expect(appCompanyVerify.body.data?.bizNoMasked === "123-**-67***", "app company verify masked bizNo");
expect(appCompanyVerify.body.data?.verified === true, "app company verified");
checks.push("app_company_verify");

const appConsentGrant = await fetchJson<ApiEnvelope<{
  consent: { scope: string; revokedAt: string | null };
}>>(`/api/app/v1/companies/${companyId}/consents`, {
  method: "PUT",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ scope: "hometax", purpose: "HTTP 검증" }),
});
expectStatus(appConsentGrant, 200, "app consent grant status");
expect(appConsentGrant.body.data?.consent.scope === "hometax", "app consent grant scope");
expect(appConsentGrant.body.data?.consent.revokedAt === null, "app consent grant active");
checks.push("app_consent_grant");

const appConsents = await fetchJson<ApiEnvelope<{
  companyId: string;
  consents: Array<{ scope: string; revokedAt: string | null }>;
}>>(`/api/app/v1/companies/${companyId}/consents`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appConsents, 200, "app consents status");
expect(Boolean(appConsents.body.data?.consents.find((entry) => entry.scope === "hometax" && entry.revokedAt === null)), "app consents include active hometax");
checks.push("app_consents");

const appConsentRevoke = await fetchJson<ApiEnvelope<{
  scope: string;
  revoked: boolean;
}>>(`/api/app/v1/companies/${companyId}/consents/hometax`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appConsentRevoke, 200, "app consent revoke status");
expect(appConsentRevoke.body.data?.scope === "hometax", "app consent revoke scope");
expect(appConsentRevoke.body.data?.revoked === true, "app consent revoked");
checks.push("app_consent_revoke");

const appProfile = await fetchJson<ApiEnvelope<{
  profile: { id?: string; industries?: string[] };
}>>(`/api/app/v1/companies/${companyId}/profile`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appProfile, 200, "app profile status");
expect(Boolean(appProfile.body.data?.profile), "app profile payload");
checks.push("app_profile");

const appProfileField = await fetchJson<ApiEnvelope<{
  profile: {
    employees_count?: number | null;
    target_types?: string[];
    confidence?: Record<string, number>;
  };
}>>(`/api/app/v1/companies/${companyId}/profile/field`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ field: "employees", value: 12, confidence: 0.81 }),
});
expectStatus(appProfileField, 200, "app profile field status");
expect(appProfileField.body.data?.profile.employees_count === 12, "app profile field persists employees");
expect(appProfileField.body.data?.profile.confidence?.employees === 0.81, "app profile field persists confidence");
checks.push("app_profile_field");

const appProfileFields = await fetchJson<ApiEnvelope<{
  profile: {
    target_types?: string[];
    confidence?: Record<string, number>;
  };
}>>(`/api/app/v1/companies/${companyId}/profile/fields`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ field: "target_type", value: ["법인"], confidence: 0.82 }),
});
expectStatus(appProfileFields, 200, "app profile fields status");
expect(appProfileFields.body.data?.profile.target_types?.includes("법인") === true, "app profile fields persists target type");
expect(appProfileFields.body.data?.profile.confidence?.target_type === 0.82, "app profile fields persists confidence");
checks.push("app_profile_fields");

const appMatches = await fetchJson<ApiEnvelope<{
  matches: Array<{ grantId: string; rulesetVer?: string }>;
}>>(`/api/app/v1/companies/${companyId}/matches`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appMatches, 200, "app matches status");
const appGrant = appMatches.body.data?.matches.find((entry) => entry.grantId);
expect(Boolean(appGrant), "app matches exposes a match grant");
checks.push("app_matches");

const appFilteredMatches = await fetchJson<ApiEnvelope<{
  matches: Array<{ grantId: string; eligibility: string; fitScore: number }>;
}>>(`/api/app/v1/companies/${companyId}/matches?status=eligible&sort=fit&limit=2`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appFilteredMatches, 200, "app filtered matches status");
expect(Array.isArray(appFilteredMatches.body.data?.matches), "app filtered matches list");
expect(
  appFilteredMatches.body.data!.matches.every((entry) => entry.eligibility === "eligible"),
  "app filtered matches eligibility",
);
expectSortedByFit(appFilteredMatches.body.data!.matches, "app filtered matches fit sort");
expect(typeof appFilteredMatches.body.meta?.hasMore === "boolean", "app filtered matches hasMore");
expect(appFilteredMatches.body.meta?.cursor === null || typeof appFilteredMatches.body.meta?.cursor === "string", "app filtered matches cursor");
checks.push("app_filtered_matches");

const appActionQueue = await fetchJson<ApiEnvelope<{
  actions: Array<{ id: string; kind: string; target: string; affectedGrantIds: string[] }>;
}>>(`/api/app/v1/companies/${companyId}/action-queue`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appActionQueue, 200, "app action queue status");
expect(Array.isArray(appActionQueue.body.data?.actions), "app action queue list");
expectActionQueueEnrich(appActionQueue.body.data?.actions, "app action queue enrich");
checks.push("app_action_queue");

const appNotificationFeed = await fetchJson<ApiEnvelope<{
  generatedAt: string;
  notifications: Array<{ id: string; kind: string; priority: string; target: string }>;
}>>(`/api/app/v1/companies/${companyId}/notifications`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appNotificationFeed, 200, "app notification feed status");
expect(typeof appNotificationFeed.body.data?.generatedAt === "string", "app notification feed generatedAt");
expect(Array.isArray(appNotificationFeed.body.data?.notifications), "app notification feed list");
checks.push("app_notification_feed");

const appNextQuestion = await fetchJson<ApiEnvelope<{
  inputType?: string;
  options?: string[];
  dimension?: string;
  affectedGrantCount?: number;
} | null>>(`/api/app/v1/companies/${companyId}/next-question`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appNextQuestion, 200, "app next question status");
expect(
  appNextQuestion.body.data === null || typeof appNextQuestion.body.data?.affectedGrantCount === "number",
  "app next question payload",
);
expectQuestionInputOptions(appNextQuestion.body.data, "app next question options");
checks.push("app_next_question");

const appRoadmap = await fetchJson<ApiEnvelope<{
  roadmap: Array<{ grantId: string; bucket: string }>;
}>>(`/api/app/v1/companies/${companyId}/roadmap`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appRoadmap, 200, "app roadmap status");
expect(Array.isArray(appRoadmap.body.data?.roadmap), "app roadmap list");
expect(Boolean(appRoadmap.body.data?.roadmap.find((entry) => entry.grantId && entry.bucket)), "app roadmap exposes nodes");
checks.push("app_roadmap");

const appGrantDetail = await fetchJson<ApiEnvelope<{
  grant: { id: string; title: string };
  applicationPrep: {
    autoSubmitSupported: boolean;
    profileCopyFields: Array<{ label: string; value: string }>;
    planDraftPrompts: Array<{ title: string; evidence: string[] }>;
  };
}>>(`/api/app/v1/grants/${encodeURIComponent(appGrant!.grantId)}?companyId=${encodeURIComponent(companyId!)}`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appGrantDetail, 200, "app grant detail status");
expect(appGrantDetail.body.data?.grant.id === appGrant!.grantId, "app grant detail uses selected company context");
expect(appGrantDetail.body.data?.applicationPrep.autoSubmitSupported === false, "app grant detail disables auto submit");
expect(
  Boolean(appGrantDetail.body.data?.applicationPrep.profileCopyFields.find((field) => field.label === "소재지")),
  "app grant detail exposes profile copy fields",
);
checks.push("app_grant_detail");

const appFeedback = await fetchJson<ApiEnvelope<{ receipt: { id: string; receivedAt: string } }>>(
  `/api/app/v1/matches/${companyId}/${encodeURIComponent(appGrant!.grantId)}/feedback`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ kind: "applied", message: "HTTP 검증" }),
  },
);
expectStatus(appFeedback, 202, "app feedback status");
expect(Boolean(appFeedback.body.data?.receipt.id), "app feedback receipt id");
checks.push("app_match_feedback");

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

const appLogout = await fetchJson<ApiEnvelope<{ revoked: boolean }>>("/api/app/v1/auth/logout", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ refreshToken: refresh.body.data?.refreshToken }),
});
expectStatus(appLogout, 200, "app logout status");
expect(appLogout.body.data?.revoked === true, "app logout revoked");
checks.push("app_logout");

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
    headers: response.headers,
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
    headers: response.headers,
  };
}

function cookieHeader(headers: Headers, name: string): string | null {
  const setCookie = headers.get("set-cookie");
  const cookie = setCookie?.split(/,(?=\s*[^;=]+=)/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  return cookie?.split(";")[0] ?? null;
}

function expectStatus(response: JsonResponse, status: number, label: string) {
  expect(response.status === status, `${label}: expected ${status}, got ${response.status}`);
}

function expect(condition: boolean, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function expectSortedByFit(entries: Array<{ fitScore: number }>, label: string) {
  for (let index = 1; index < entries.length; index += 1) {
    expect(entries[index - 1]!.fitScore >= entries[index]!.fitScore, label);
  }
}

function expectQuestionInputOptions(question: { inputType?: string; options?: string[] } | null | undefined, label: string) {
  if (!question || question.inputType !== "select") return;
  expect(Array.isArray(question.options) && question.options.length > 0, label);
}

function expectActionQueueEnrich(
  actions: Array<{ kind: string; target: string; affectedGrantIds: string[] }> | null | undefined,
  label: string,
) {
  const enrich = actions?.find((action) => action.kind === "enrich");
  expect(Boolean(enrich), label);
  expect(enrich!.target === "#company-settings", `${label} target`);
  expect(enrich!.affectedGrantIds.length > 0, `${label} affected grants`);
}

export {};
