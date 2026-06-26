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
  body: JSON.stringify({ bizNo: "1234567890" }),
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
expect(dashboardHtml.body.includes("검증"), "web dashboard renders company verification control");
expect(dashboardHtml.body.includes("ineligible-disclosure"), "web dashboard renders collapsed ineligible reasons");
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
}>>(`/api/web/grants/${encodeURIComponent(webGrant!.grantId)}`);
expectStatus(webGrantDetail, 200, "web grant detail status");
expect(webGrantDetail.body.ok === true, "web grant detail envelope ok");
expect(webGrantDetail.body.data?.grant.id === webGrant!.grantId, "web grant detail matches dashboard grant");
checks.push("web_grant_detail");

const webGrantDetailHtml = await fetchText(`/grants/${encodeURIComponent(webGrant!.grantId)}`);
expectStatus(webGrantDetailHtml, 200, "web grant detail html status");
expect(webGrantDetailHtml.body.includes("신청 준비 시트"), "web grant detail renders apply sheet");
expect(webGrantDetailHtml.body.includes("체크리스트"), "web grant detail renders checklist");
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

const login = await fetchJson<ApiEnvelope<{ accessToken?: string }>>("/api/app/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, deviceId: "verify-web-http" }),
});
expectStatus(login, 200, "app login status");
const accessToken = login.body.data?.accessToken;
expect(Boolean(accessToken), "app login access token");
checks.push("app_login");

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

const appMatches = await fetchJson<ApiEnvelope<{
  matches: Array<{ grantId: string; rulesetVer?: string }>;
}>>(`/api/app/v1/companies/${companyId}/matches`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appMatches, 200, "app matches status");
const appGrant = appMatches.body.data?.matches.find((entry) => entry.grantId);
expect(Boolean(appGrant), "app matches exposes a match grant");
checks.push("app_matches");

const appActionQueue = await fetchJson<ApiEnvelope<{
  actions: Array<{ id: string; affectedGrantIds: string[] }>;
}>>(`/api/app/v1/companies/${companyId}/action-queue`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appActionQueue, 200, "app action queue status");
expect(Array.isArray(appActionQueue.body.data?.actions), "app action queue list");
checks.push("app_action_queue");

const appNextQuestion = await fetchJson<ApiEnvelope<{
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
}>>(`/api/app/v1/grants/${encodeURIComponent(appGrant!.grantId)}?companyId=${encodeURIComponent(companyId!)}`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appGrantDetail, 200, "app grant detail status");
expect(appGrantDetail.body.data?.grant.id === appGrant!.grantId, "app grant detail uses selected company context");
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

export {};
