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
const opsAdminOrigin = (process.env.CUNOTE_OPS_ADMIN_ORIGIN?.trim() || "https://ops.changupnote.com").replace(/\/$/, "");
const requestTimeoutMs = readPositiveIntegerEnv("CUNOTE_HTTP_VERIFY_TIMEOUT_MS", 30_000);
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
const verifyBizNoRun = String(Date.now() % 100_000_000).padStart(8, "0");
const webVerifyBizNo = `71${verifyBizNoRun}`;
const appVerifyBizNo = `72${verifyBizNoRun}`;

const stats = await fetchJson<ActionResult<{ openCount: number }>>("/api/web/stats");
expectStatus(stats, 200, "web stats status");
expect(stats.body.ok === true, "web stats envelope ok");
expect(typeof stats.body.data?.openCount === "number", "web stats openCount");
checks.push("web_stats");

const adminStatus = await fetchJson<ApiEnvelope<null>>("/api/admin/status");
expectAdminMovedApi(adminStatus, "admin status moved boundary");
checks.push("admin_status_moved_to_ops");

const internalLiveMatchHtml = await fetchText("/internal/live-match", { redirect: "manual" });
expectOpsAdminRedirect(internalLiveMatchHtml, "/internal/live-match", "internal live match moved boundary");
const internalLiveMatchForbidden = await fetchJson<ApiEnvelope<null>>("/api/matches/live", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
});
expectAdminMovedApi(internalLiveMatchForbidden, "internal live match api moved boundary");
checks.push("internal_live_match_moved_to_ops");

const adminLegalReadinessReport = await fetchText("/api/admin/status/legal-readiness");
expectAdminMovedText(adminLegalReadinessReport, "admin legal readiness moved boundary");
checks.push("admin_legal_readiness_moved_to_ops");

const adminSaasReadinessReport = await fetchText("/api/admin/status/saas-readiness");
expectAdminMovedText(adminSaasReadinessReport, "admin saas readiness moved boundary");
checks.push("admin_saas_readiness_moved_to_ops");

const adminSaasReleaseChecklist = await fetchText("/api/admin/status/release-checklist");
expectAdminMovedText(adminSaasReleaseChecklist, "admin saas release checklist moved boundary");
checks.push("admin_saas_release_checklist_moved_to_ops");

const adminSupportTicketReport = await fetchText("/api/admin/flywheel/support-tickets/report");
expectAdminMovedText(adminSupportTicketReport, "admin support ticket report moved boundary");
checks.push("admin_support_ticket_report_moved_to_ops");

const homeHtml = await fetchText("/");
expectStatus(homeHtml, 200, "web home html status");
expect(homeHtml.body.includes("href=\"/support\""), "web home links support page");
expect(homeHtml.body.includes("href=\"/privacy\""), "web home links privacy policy");
expect(homeHtml.body.includes("href=\"/terms\""), "web home links terms");
checks.push("web_home_legal_links");

const loginHtml = await fetchText("/login?callbackUrl=%2Fdashboard");
expectStatus(loginHtml, 200, "web login html status");
expect(
  loginHtml.body.includes("로그인") || loginHtml.body.includes("기회 맵"),
  "web login renders sign-in or redirects authenticated session",
);
expect(loginHtml.body.includes("/forgot-password"), "web login links password reset");
checks.push("web_login_html");

const forgotPasswordHtml = await fetchText("/forgot-password?callbackUrl=%2Fdashboard");
expectStatus(forgotPasswordHtml, 200, "web forgot password html status");
expect(forgotPasswordHtml.body.includes("비밀번호 찾기"), "web forgot password renders heading");
checks.push("web_forgot_password_html");

const resetPasswordHtml = await fetchText("/reset-password?token=verify-token&callbackUrl=%2Fdashboard");
expectStatus(resetPasswordHtml, 200, "web reset password html status");
expect(resetPasswordHtml.body.includes("새 비밀번호 설정"), "web reset password renders heading");
checks.push("web_reset_password_html");

const passwordResetRequestInvalid = await fetchJson<ActionResult<null>>("/api/web/auth/password-reset/request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "not-an-email" }),
});
expectStatus(passwordResetRequestInvalid, 400, "web password reset invalid email status");
expect(passwordResetRequestInvalid.body.error?.code === "invalid_email", "web password reset invalid email code");
checks.push("web_password_reset_invalid_email");

const passwordResetRequest = await fetchJson<ActionResult<{
  accepted: true;
  persisted: boolean;
  expiresInMinutes: number;
  resetUrl: string | null;
  emailDelivery?: {
    provider: string;
    configured: boolean;
    status: string;
  };
}>>("/api/web/auth/password-reset/request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `missing-reset-${verifyBizNoRun}@example.test`, callbackUrl: "/dashboard" }),
});
expectStatus(passwordResetRequest, 200, "web password reset request status");
expect(passwordResetRequest.body.ok === true, "web password reset request envelope");
expect(passwordResetRequest.body.data?.accepted === true, "web password reset request accepted");
expect(typeof passwordResetRequest.body.data?.expiresInMinutes === "number", "web password reset request expiry");
expect(passwordResetRequest.body.data?.emailDelivery?.provider === "none", "web password reset email delivery provider");
expect(passwordResetRequest.body.data?.emailDelivery?.status === "skipped", "web password reset email delivery skipped");
checks.push("web_password_reset_request");

const passwordResetEmailHandoff = await fetchText("/api/web/auth/password-reset/handoff", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "reset-handoff@example.test",
    resetUrl: `${baseUrl}/reset-password?token=verify-reset-token&callbackUrl=%2Fdashboard`,
    expiresInMinutes: 30,
  }),
});
expectStatus(passwordResetEmailHandoff, 200, "web password reset email handoff status");
expect(
  passwordResetEmailHandoff.headers.get("content-type")?.includes("message/rfc822") === true,
  "web password reset email handoff content-type",
);
expect(
  passwordResetEmailHandoff.headers.get("content-disposition")?.includes("attachment") === true,
  "web password reset email handoff attachment",
);
expect(
  passwordResetEmailHandoff.body.includes("X-Cunote-Handoff: password-reset-email"),
  "web password reset email handoff marker",
);
expect(passwordResetEmailHandoff.body.includes("verify-reset-token"), "web password reset email handoff link");
checks.push("web_password_reset_email_handoff");

const registerLegalGate = await fetchJson<{ ok?: boolean; error?: string }>("/api/web/auth/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: `verify-${verifyBizNoRun}@example.test`,
    password: "verify-password-123",
    name: "검증 사용자",
  }),
});
expectStatus(registerLegalGate, 400, "web auth register legal gate status");
expect(registerLegalGate.body.ok === false, "web auth register legal gate envelope");
expect(
  typeof registerLegalGate.body.error === "string" && registerLegalGate.body.error.includes("동의"),
  "web auth register legal gate error",
);
checks.push("web_auth_register_legal_gate");

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

const landingEvent = await fetchJson<ActionResult<{
  accepted: true;
  event: string;
  receivedAt: string;
}>>("/api/web/landing-events", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    event: "teaser_match_clicked",
    requestId: "verify-landing-event",
    durationMs: 123,
    inputLength: 10,
    grantId: teaser.body.data?.matches[0]?.grantId ?? "verify-grant",
    eligibility: teaser.body.data?.matches[0]?.eligibility ?? "eligible",
    eligibleCount: teaser.body.data?.matches.filter((entry) => entry.eligibility === "eligible").length ?? 0,
    conditionalCount: teaser.body.data?.matches.filter((entry) => entry.eligibility === "conditional").length ?? 0,
    hasAmount: (teaser.body.data?.estimatedMaxAmount ?? 0) > 0 || (teaser.body.data?.conditionalUpside ?? 0) > 0,
  }),
});
expectStatus(landingEvent, 202, "web landing event status");
expect(landingEvent.body.ok === true, "web landing event envelope");
expect(landingEvent.body.data?.accepted === true, "web landing event accepted");
expect(landingEvent.body.data?.event === "teaser_match_clicked", "web landing event name");
checks.push("web_landing_event");

const invalidLandingEvent = await fetchJson<ActionResult<null>>("/api/web/landing-events", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ event: "raw_biz_no_submitted", bizNo: webVerifyBizNo }),
});
expectStatus(invalidLandingEvent, 400, "web invalid landing event status");
expect(invalidLandingEvent.body.error?.code === "invalid_landing_event", "web invalid landing event code");
checks.push("web_landing_event_invalid");

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
  body: JSON.stringify({ bizNo: webVerifyBizNo, ownerName: "검증 대표", openedOn: "2024-01-15" }),
});
expectStatus(webCompanyVerify, 200, "web company verify status");
expect(webCompanyVerify.body.ok === true, "web company verify envelope ok");
expect(webCompanyVerify.body.data?.companyId === webCompanyId, "web company verify company id");
expect(!Object.hasOwn(webCompanyVerify.body.data ?? {}, "bizNo"), "web company verify hides raw bizNo");
expect(webCompanyVerify.body.data?.bizNoMasked === maskBizNo(webVerifyBizNo), "web company verify masked bizNo");
expect(webCompanyVerify.body.data?.verified === true, "web company verify result");
checks.push("web_company_verify");

const webCompaniesAfterVerify = await fetchJson<ActionResult<{
  currentCompanyId: string;
  companies: Array<{ id: string; verified?: boolean; bizNoMasked?: string | null }>;
}>>("/api/web/companies");
expectStatus(webCompaniesAfterVerify, 200, "web companies after verify status");
const verifiedWebCompany = webCompaniesAfterVerify.body.data?.companies.find((company) => company.id === webCompanyId);
expect(verifiedWebCompany?.verified === true, "web companies expose verified state");
expect(verifiedWebCompany?.bizNoMasked === maskBizNo(webVerifyBizNo), "web companies expose masked bizNo");
checks.push("web_company_verified_state");

const dashboard = await fetchJson<ActionResult<{
  matches: Array<{ grantId: string; rulesetVer?: string; benefits?: unknown[] }>;
}>>("/api/web/dashboard");
expectStatus(dashboard, 200, "web dashboard status");
expect(dashboard.body.ok === true, "web dashboard envelope ok");
const dashboardGrant = dashboard.body.data?.matches.find((entry) => entry.grantId);
expect(Boolean(dashboardGrant), "web dashboard exposes a match grant");
expect(Array.isArray(dashboardGrant?.benefits), "web dashboard exposes benefit badges");
checks.push("web_dashboard");

const webFilteredMatches = await fetchJson<ActionResult<{
  matches: Array<{ grantId: string; eligibility: string; fitScore: number; benefits?: unknown[]; rulesetVer?: string }>;
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
expect(
  webFilteredMatches.body.data!.matches.every((entry) => Array.isArray(entry.benefits)),
  "web filtered matches benefit badges",
);
expect(typeof webFilteredMatches.body.data?.hasMore === "boolean", "web filtered matches hasMore");
expect(typeof webFilteredMatches.body.data?.total === "number", "web filtered matches total");
checks.push("web_filtered_matches");

const webGrant = webFilteredMatches.body.data?.matches.find((entry) => entry.grantId);
expect(Boolean(webGrant), "web filtered matches expose eligible grant");

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
expect(dashboardHtml.body.includes("설정 완료도"), "web dashboard renders onboarding progress prompt");
expect(dashboardHtml.body.includes("id=\"next-question\""), "web dashboard renders next question anchor");
expect(dashboardHtml.body.includes("id=\"company-settings\""), "web dashboard renders company settings anchor");
expect(dashboardHtml.body.includes("변경 알림"), "web dashboard renders notification feed");
expect(dashboardHtml.body.includes("/api/web/notification-feed/report"), "web dashboard links notification report");
expect(dashboardHtml.body.includes("/api/web/dashboard/report"), "web dashboard links dashboard report");
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

const dashboardReport = await fetchText("/api/web/dashboard/report");
expectStatus(dashboardReport, 200, "web dashboard report status");
expect(
  dashboardReport.headers.get("content-type")?.includes("text/markdown") === true,
  "web dashboard report content-type",
);
expect(
  dashboardReport.headers.get("content-disposition")?.includes("attachment") === true,
  "web dashboard report attachment",
);
expect(dashboardReport.body.includes("기회 맵 리포트"), "web dashboard report title");
expect(dashboardReport.body.includes("## 우선 액션"), "web dashboard report action queue");
expect(dashboardReport.body.includes("## 운영 액션"), "web dashboard report next actions");
checks.push("web_dashboard_report");

const roadmapHtml = await fetchText("/roadmap");
expectStatus(roadmapHtml, 200, "web roadmap html status");
expect(roadmapHtml.body.includes("roadmap-lanes"), "web roadmap renders lanes");
expect(roadmapHtml.body.includes("전략 로드맵"), "web roadmap renders heading");
checks.push("web_roadmap_html");

const applicationsHtml = await fetchText("/applications");
expectStatus(applicationsHtml, 200, "web applications html status");
expect(applicationsHtml.body.includes("신청 관리"), "web applications renders heading");
expect(applicationsHtml.body.includes("application-board"), "web applications renders pipeline board");
expect(applicationsHtml.body.includes("/api/web/applications/report"), "web applications links pipeline report");
expect(applicationsHtml.body.includes("/api/web/applications/calendar"), "web applications links board calendar");
expect(applicationsHtml.body.includes("/api/web/applications/calendar-subscription"), "web applications links calendar subscription");
expect(applicationsHtml.body.includes("/api/web/grants/") && applicationsHtml.body.includes("/package"), "web applications links package export");
checks.push("web_applications_html");

const applicationsReport = await fetchText("/api/web/applications/report");
expectStatus(applicationsReport, 200, "web applications report status");
expect(
  applicationsReport.headers.get("content-type")?.includes("text/markdown") === true,
  "web applications report content-type",
);
expect(
  applicationsReport.headers.get("content-disposition")?.includes("attachment") === true,
  "web applications report attachment",
);
expect(applicationsReport.body.includes("신청 파이프라인 리포트"), "web applications report title");
expect(applicationsReport.body.includes("상태 요약"), "web applications report summary");
checks.push("web_applications_report");

const notificationReport = await fetchText("/api/web/notification-feed/report");
expectStatus(notificationReport, 200, "web notification report status");
expect(
  notificationReport.headers.get("content-type")?.includes("text/markdown") === true,
  "web notification report content-type",
);
expect(
  notificationReport.headers.get("content-disposition")?.includes("attachment") === true,
  "web notification report attachment",
);
expect(notificationReport.body.includes("알림센터 리포트"), "web notification report title");
expect(notificationReport.body.includes("## 알림 상세"), "web notification report detail");
checks.push("web_notification_report");

const applicationsCalendar = await fetchText("/api/web/applications/calendar");
expectStatus(applicationsCalendar, 200, "web applications calendar status");
expect(
  applicationsCalendar.headers.get("content-type")?.includes("text/calendar") === true,
  "web applications calendar content-type",
);
expect(
  applicationsCalendar.headers.get("content-disposition")?.includes("attachment") === true,
  "web applications calendar attachment",
);
expect(applicationsCalendar.body.includes("BEGIN:VCALENDAR"), "web applications calendar body");
expect(applicationsCalendar.body.includes("BEGIN:VEVENT"), "web applications calendar event");
expect(applicationsCalendar.body.includes("마감:"), "web applications calendar deadline event");
checks.push("web_applications_calendar");

const applicationReminderEmail = await fetchText(`/api/web/applications/${encodeURIComponent(webGrant!.grantId)}/reminder-email`);
expectStatus(applicationReminderEmail, 200, "web application reminder email status");
expect(
  applicationReminderEmail.headers.get("content-type")?.includes("message/rfc822") === true,
  "web application reminder email content-type",
);
expect(applicationReminderEmail.body.includes("X-Cunote-Handoff: application-reminder-email"), "web application reminder email marker");
checks.push("web_application_reminder_email");

const applicationsCalendarSubscription = await fetchText("/api/web/applications/calendar-subscription");
expectStatus(applicationsCalendarSubscription, 200, "web applications calendar subscription status");
expect(
  applicationsCalendarSubscription.headers.get("content-type")?.includes("text/markdown") === true,
  "web applications calendar subscription content-type",
);
expect(
  applicationsCalendarSubscription.headers.get("content-disposition")?.includes("attachment") === true,
  "web applications calendar subscription attachment",
);
expect(applicationsCalendarSubscription.body.includes("신청 캘린더 구독 URL"), "web applications calendar subscription title");
expect(applicationsCalendarSubscription.body.includes("webcal://"), "web applications calendar subscription webcal url");
const calendarFeedPath = applicationsCalendarSubscription.body.match(/\/api\/web\/applications\/calendar-feed\/[A-Za-z0-9._~-]+/)?.[0] ?? null;
expect(Boolean(calendarFeedPath), "web applications calendar subscription exposes feed path");
checks.push("web_applications_calendar_subscription");

const applicationsCalendarFeed = await fetchText(calendarFeedPath!);
expectStatus(applicationsCalendarFeed, 200, "web applications calendar feed status");
expect(
  applicationsCalendarFeed.headers.get("content-type")?.includes("text/calendar") === true,
  "web applications calendar feed content-type",
);
expect(applicationsCalendarFeed.body.includes("BEGIN:VCALENDAR"), "web applications calendar feed body");
expect(applicationsCalendarFeed.body.includes("BEGIN:VEVENT"), "web applications calendar feed event");
checks.push("web_applications_calendar_feed");

const teamHtml = await fetchText("/team");
expectStatus(teamHtml, 200, "web team html status");
expect(teamHtml.body.includes("팀과 권한"), "web team renders heading");
expect(teamHtml.body.includes("team-members-list"), "web team renders member list");
expect(teamHtml.body.includes("team-invite-panel"), "web team renders invite panel");
expect(teamHtml.body.includes("권한 변경 이력"), "web team renders role change history");
expect(teamHtml.body.includes("/api/web/team/report"), "web team links operations report");
checks.push("web_team_html");

const teamReport = await fetchText("/api/web/team/report");
expectStatus(teamReport, 200, "web team report status");
expect(
  teamReport.headers.get("content-type")?.includes("text/markdown") === true,
  "web team report content-type",
);
expect(
  teamReport.headers.get("content-disposition")?.includes("attachment") === true,
  "web team report attachment",
);
expect(teamReport.body.includes("팀 운영 리포트"), "web team report title");
expect(teamReport.body.includes("## 멤버"), "web team report members");
expect(teamReport.body.includes("## 운영 액션"), "web team report next actions");
checks.push("web_team_report");

const teamInvitation = await fetchJson<ActionResult<{
  id: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  inviteUrl: string | null;
  persisted: boolean;
  emailDelivery?: {
    provider: string;
    configured: boolean;
    status: string;
  };
}>>("/api/web/team/invitations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "team-verify@changupnote.com",
    role: "member",
  }),
});
expect(
  teamInvitation.status === 201 || teamInvitation.status === 202,
  `web team invitation status: expected 201 or 202, got ${teamInvitation.status}`,
);
expect(teamInvitation.body.ok === true, "web team invitation envelope ok");
expect(Boolean(teamInvitation.body.data?.id), "web team invitation id");
expect(teamInvitation.body.data?.emailDelivery?.provider === "none", "web team invitation email delivery provider");
expect(teamInvitation.body.data?.emailDelivery?.status === "skipped", "web team invitation email delivery skipped");
  if (teamInvitation.body.data?.persisted) {
    expect(
      typeof teamInvitation.body.data.inviteUrl === "string"
        && teamInvitation.body.data.inviteUrl.includes("/team/invite/"),
      "web team invitation invite url",
    );
    const inviteEmailToken = teamInvitation.body.data.inviteUrl!.split("/").filter(Boolean).at(-1)!;
    const teamInvitationEmailHandoff = await fetchText(`/api/web/team/invitations/handoff/${encodeURIComponent(inviteEmailToken)}`);
    expectStatus(teamInvitationEmailHandoff, 200, "web team invitation email handoff status");
    expect(
      teamInvitationEmailHandoff.headers.get("content-type")?.includes("message/rfc822") === true,
      "web team invitation email handoff content-type",
    );
    expect(teamInvitationEmailHandoff.body.includes("X-Cunote-Handoff: team-invitation-email"), "web team invitation email handoff marker");
    checks.push("web_team_invitation_email_handoff");
  }
  checks.push("web_team_invitation");

const teamInvitationEmailHandoffInvalid = await fetchJson<ActionResult<null>>("/api/web/team/invitations/handoff/short");
expectStatus(teamInvitationEmailHandoffInvalid, 400, "web team invitation email handoff invalid status");
expect(
  teamInvitationEmailHandoffInvalid.body.error?.code === "invalid_team_invitation_token",
  "web team invitation email handoff invalid code",
);
checks.push("web_team_invitation_email_handoff_invalid");

const billingHtml = await fetchText("/billing");
expectStatus(billingHtml, 200, "web billing html status");
expect(billingHtml.body.includes("플랜과 청구"), "web billing renders heading");
expect(billingHtml.body.includes("billing-plan-summary"), "web billing renders plan summary");
expect(billingHtml.body.includes("청구 준비도"), "web billing renders readiness panel");
expect(billingHtml.body.includes("결제 provider"), "web billing renders provider readiness");
expect(billingHtml.body.includes("구독 상태"), "web billing renders subscription status");
expect(billingHtml.body.includes("청구 프로필"), "web billing renders tax profile");
expect(billingHtml.body.includes("billing-tax-profile-form"), "web billing renders tax profile form");
expect(billingHtml.body.includes("청구 증빙 파일"), "web billing renders tax documents");
expect(billingHtml.body.includes("billing-tax-documents-panel"), "web billing renders tax documents panel");
expect(billingHtml.body.includes("결제수단 기록"), "web billing renders payment method history");
expect(billingHtml.body.includes("청구/영수증 기록"), "web billing renders invoice history");
expect(billingHtml.body.includes("billing-plan-request-form"), "web billing renders plan request form");
expect(billingHtml.body.includes("전환 요청 기록"), "web billing renders plan request history");
expect(billingHtml.body.includes("/api/web/billing/statement"), "web billing links statement download");
expect(billingHtml.body.includes("/api/web/billing/payment-instructions"), "web billing links payment instructions");
checks.push("web_billing_html");

const billingStatement = await fetchText("/api/web/billing/statement");
expectStatus(billingStatement, 200, "web billing statement status");
expect(
  billingStatement.headers.get("content-type")?.includes("text/markdown") === true,
  "web billing statement content-type",
);
expect(
  billingStatement.headers.get("content-disposition")?.includes("attachment") === true,
  "web billing statement attachment",
);
expect(billingStatement.body.includes("청구 명세"), "web billing statement title");
expect(billingStatement.body.includes("현재 플랜"), "web billing statement plan section");
expect(billingStatement.body.includes("구독 상태"), "web billing statement subscription section");
expect(billingStatement.body.includes("청구 준비도"), "web billing statement readiness section");
expect(billingStatement.body.includes("결제 provider"), "web billing statement provider status");
expect(billingStatement.body.includes("청구 프로필"), "web billing statement tax profile section");
expect(billingStatement.body.includes("청구 증빙 파일"), "web billing statement tax documents section");
expect(billingStatement.body.includes("결제 수단"), "web billing statement payment method section");
expect(billingStatement.body.includes("최근 청구/영수증"), "web billing statement invoice section");
checks.push("web_billing_statement");

const billingPaymentInstructions = await fetchText("/api/web/billing/payment-instructions");
expectStatus(billingPaymentInstructions, 200, "web billing payment instructions status");
expect(
  billingPaymentInstructions.headers.get("content-type")?.includes("text/markdown") === true,
  "web billing payment instructions content-type",
);
expect(
  billingPaymentInstructions.headers.get("content-disposition")?.includes("attachment") === true,
  "web billing payment instructions attachment",
);
expect(billingPaymentInstructions.body.includes("수동 결제 안내서"), "web billing payment instructions title");
expect(billingPaymentInstructions.body.includes("결제 처리 방식"), "web billing payment instructions method section");
expect(billingPaymentInstructions.body.includes("내부 결재 체크리스트"), "web billing payment instructions checklist");
checks.push("web_billing_payment_instructions");

const billingInvoiceEmailHandoffInvalid = await fetchJson<ActionResult<null>>("/api/web/billing/invoices/not-a-valid-invoice/email-handoff");
expectStatus(billingInvoiceEmailHandoffInvalid, 400, "web billing invoice email handoff invalid status");
expect(
  billingInvoiceEmailHandoffInvalid.body.error?.code === "invalid_billing_invoice_id",
  "web billing invoice email handoff invalid code",
);
checks.push("web_billing_invoice_email_handoff_invalid");

const billingPlanRequestEmailHandoffInvalid = await fetchJson<ActionResult<null>>("/api/web/billing/plan-requests/not-a-valid-request/email-handoff");
expectStatus(billingPlanRequestEmailHandoffInvalid, 400, "web billing plan request email handoff invalid status");
expect(
  billingPlanRequestEmailHandoffInvalid.body.error?.code === "invalid_billing_plan_request_id",
  "web billing plan request email handoff invalid code",
);
checks.push("web_billing_plan_request_email_handoff_invalid");

const billingTaxProfile = await fetchJson<ActionResult<{
  persisted: boolean;
  profile: {
    companyId: string;
    businessName: string | null;
    businessRegistrationNumberMasked: string | null;
    taxInvoiceEmail: string | null;
    taxInvoiceEnabled: boolean;
  };
}>>("/api/web/billing/tax-profile", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    businessName: "검증 회사",
    businessRegistrationNumber: "1234567890",
    recipientName: "청구 담당자",
    recipientEmail: "billing-verify@changupnote.com",
    recipientPhone: "010-0000-0000",
    taxInvoiceEmail: "tax-verify@changupnote.com",
    billingAddressLine1: "서울시 중구",
    billingAddressLine2: "검증 빌딩",
    postalCode: "04500",
    taxInvoiceEnabled: true,
    notes: "HTTP 검증에서 청구 프로필 저장 경로를 확인합니다.",
  }),
});
expect(
  billingTaxProfile.status === 200 || billingTaxProfile.status === 202,
  `web billing tax profile status: expected 200 or 202, got ${billingTaxProfile.status}`,
);
expect(billingTaxProfile.body.ok === true, "web billing tax profile envelope ok");
expect(billingTaxProfile.body.data?.profile.companyId === webCompanyId, "web billing tax profile company");
expect(billingTaxProfile.body.data?.profile.taxInvoiceEnabled === true, "web billing tax profile tax enabled");
expect(billingTaxProfile.body.data?.profile.businessRegistrationNumberMasked === "123-45-*****", "web billing tax profile masks biz no");
checks.push("web_billing_tax_profile");

const billingTaxDocumentForm = new FormData();
billingTaxDocumentForm.set("documentKind", "business_registration");
billingTaxDocumentForm.set("file", new Blob(["billing document verify"], { type: "application/pdf" }), "business-registration.pdf");
const billingTaxDocument = await fetchJson<ActionResult<{
  persisted: boolean;
  storageConfigured: boolean;
  document: {
    id: string;
    companyId: string;
    documentKind: string;
    filename: string;
    archiveUrl: string;
  } | null;
  message: string;
}>>("/api/web/billing/tax-documents", {
  method: "POST",
  body: billingTaxDocumentForm,
});
expect(
  billingTaxDocument.status === 201 || billingTaxDocument.status === 202,
  `web billing tax document status: expected 201 or 202, got ${billingTaxDocument.status}`,
);
expect(billingTaxDocument.body.ok === true, "web billing tax document envelope ok");
expect(typeof billingTaxDocument.body.data?.persisted === "boolean", "web billing tax document persisted flag");
if (billingTaxDocument.body.data?.persisted) {
  expect(billingTaxDocument.body.data.document?.companyId === webCompanyId, "web billing tax document company");
  expect(billingTaxDocument.body.data.document?.documentKind === "business_registration", "web billing tax document kind");
  expect(billingTaxDocument.body.data.document?.filename === "business-registration.pdf", "web billing tax document filename");
  expect(Boolean(billingTaxDocument.body.data.document?.archiveUrl), "web billing tax document archive url");
}
checks.push("web_billing_tax_document");

const billingPlanRequest = await fetchJson<ActionResult<{
  id: string;
  status: "open" | "queued";
  persisted: boolean;
  desiredPlan: "team" | "growth" | "enterprise";
  seatCount: number;
}>>("/api/web/billing/plan-request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "billing-verify@changupnote.com",
    name: "HTTP 검증",
    desiredPlan: "team",
    seatCount: 5,
    billingCycle: "undecided",
    message: "HTTP 검증에서 플랜 전환 요청 API가 응답하는지 확인합니다.",
  }),
});
expect(
  billingPlanRequest.status === 201 || billingPlanRequest.status === 202,
  `web billing plan request status: expected 201 or 202, got ${billingPlanRequest.status}`,
);
expect(billingPlanRequest.body.ok === true, "web billing plan request envelope ok");
expect(Boolean(billingPlanRequest.body.data?.id), "web billing plan request receipt id");
expect(billingPlanRequest.body.data?.desiredPlan === "team", "web billing plan request desired plan");
expect(billingPlanRequest.body.data?.seatCount === 5, "web billing plan request seat count");
checks.push("web_billing_plan_request");

if (billingPlanRequest.body.data?.persisted) {
  const billingPlanRequestEmailHandoff = await fetchText(
    `/api/web/billing/plan-requests/${encodeURIComponent(billingPlanRequest.body.data.id)}/email-handoff`,
  );
  expectStatus(billingPlanRequestEmailHandoff, 200, "web billing plan request email handoff status");
  expect(
    billingPlanRequestEmailHandoff.headers.get("content-type")?.includes("message/rfc822") === true,
    "web billing plan request email handoff content-type",
  );
  expect(
    billingPlanRequestEmailHandoff.headers.get("content-disposition")?.includes("attachment") === true,
    "web billing plan request email handoff attachment",
  );
  expect(
    billingPlanRequestEmailHandoff.body.includes("X-Cunote-Handoff: billing-plan-request-email"),
    "web billing plan request email handoff marker",
  );
  expect(billingPlanRequestEmailHandoff.body.includes("희망 플랜: Team"), "web billing plan request email handoff plan");
  checks.push("web_billing_plan_request_email_handoff");
}

const billingWebhookUnsigned = await fetchJson<ActionResult<null>>("/api/web/billing/webhook/manual", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ eventId: "verify-unsigned", eventType: "billing.subscription.updated" }),
});
expect(
  billingWebhookUnsigned.status === 401 || billingWebhookUnsigned.status === 503,
  `web billing webhook unsigned boundary: expected 401 or 503, got ${billingWebhookUnsigned.status}`,
);
expect(
  billingWebhookUnsigned.body.error?.code === "invalid_billing_webhook_signature"
    || billingWebhookUnsigned.body.error?.code === "billing_webhook_secret_missing",
  "web billing webhook unsigned boundary code",
);
checks.push("web_billing_webhook_unsigned_boundary");

const accountHtml = await fetchText("/account");
expectStatus(accountHtml, 200, "web account html status");
expect(accountHtml.body.includes("내 계정"), "web account renders heading");
expect(accountHtml.body.includes("서비스 문서"), "web account renders service docs");
expect(accountHtml.body.includes("데이터 내보내기"), "web account renders data export action");
expect(accountHtml.body.includes("표시 이름"), "web account renders profile panel");
expect(accountHtml.body.includes("보안과 세션"), "web account renders security status panel");
expect(accountHtml.body.includes("/api/web/account/security-report"), "web account links security report");
expect(accountHtml.body.includes("/api/web/account/deletion-request/handoff"), "web account links deletion request handoff");
expect(accountHtml.body.includes("법무 동의"), "web account renders legal acceptance status");
expect(accountHtml.body.includes("/api/web/notification-feed/report"), "web account links notification report");
expect(accountHtml.body.includes("비밀번호 변경"), "web account renders password panel");
expect(accountHtml.body.includes("계정 데이터 삭제 요청"), "web account renders deletion request panel");
expect(accountHtml.body.includes("최근 삭제 요청"), "web account renders deletion request history");
expect(accountHtml.body.includes("id=\"account-support-tickets\""), "web account renders support tickets panel");
checks.push("web_account_html");

const accountSecurityReport = await fetchText("/api/web/account/security-report");
expectStatus(accountSecurityReport, 200, "web account security report status");
expect(
  accountSecurityReport.headers.get("content-type")?.includes("text/markdown") === true,
  "web account security report content-type",
);
expect(
  accountSecurityReport.headers.get("content-disposition")?.includes("attachment") === true,
  "web account security report attachment",
);
expect(accountSecurityReport.body.includes("보안 리포트"), "web account security report heading");
expect(accountSecurityReport.body.includes("## 법무 동의"), "web account security report legal section");
expect(accountSecurityReport.body.includes("## 운영 액션"), "web account security report actions section");
checks.push("web_account_security_report");

const accountDeletionHandoff = await fetchText("/api/web/account/deletion-request/handoff");
expectStatus(accountDeletionHandoff, 200, "web account deletion handoff status");
expect(
  accountDeletionHandoff.headers.get("content-type")?.includes("message/rfc822") === true,
  "web account deletion handoff content-type",
);
expect(
  accountDeletionHandoff.headers.get("content-disposition")?.includes("attachment") === true,
  "web account deletion handoff attachment",
);
expect(
  accountDeletionHandoff.body.includes("X-Cunote-Handoff: account-deletion-request-email"),
  "web account deletion handoff marker",
);
expect(accountDeletionHandoff.body.includes("/account#account-deletion-request"), "web account deletion handoff path");
checks.push("web_account_deletion_email_handoff");

const accountExport = await fetchJson<{
  schema?: string;
  user?: { id?: string; email?: string | null; name?: string | null };
  workspace?: { currentCompany?: { id?: string } };
  legal?: {
    termsVersion?: string;
    privacyVersion?: string;
    privacyOfficerName?: string;
    businessRegistrationNumber?: string | null;
    businessAddress?: string | null;
    mailOrderRegistrationNumber?: string | null;
    retentionSummary?: string;
    privacyProcessors?: unknown[];
    overseasTransfers?: unknown[];
    acceptance?: {
      termsAcceptedAt?: string | null;
      privacyAcceptedAt?: string | null;
      termsVersion?: string | null;
      privacyVersion?: string | null;
    };
  };
  consents?: unknown[];
  billingSubscription?: { status?: string; providerLabel?: string; sourceLabel?: string };
  billingTaxProfile?: { taxInvoiceEnabled?: boolean; businessRegistrationNumberMasked?: string | null };
  billingTaxDocuments?: unknown[];
  billingInvoices?: unknown[];
  billingPaymentMethods?: unknown[];
  billingPlanRequests?: unknown[];
  deletionRequests?: unknown[];
  exclusions?: string[];
}>("/api/web/account/export");
expectStatus(accountExport, 200, "web account export status");
expect(
  accountExport.headers.get("content-type")?.includes("application/json") === true,
  "web account export content-type",
);
expect(accountExport.headers.get("content-disposition")?.includes("attachment") === true, "web account export attachment");
expect(accountExport.body.schema === "cunote.account_export.v1", "web account export schema");
expect(Boolean(accountExport.body.user?.id), "web account export user id");
expect(accountExport.body.workspace?.currentCompany?.id === webCompanyId, "web account export company id");
expect(typeof accountExport.body.legal?.termsVersion === "string", "web account export legal terms version");
expect(typeof accountExport.body.legal?.privacyVersion === "string", "web account export legal privacy version");
expect(typeof accountExport.body.legal?.privacyOfficerName === "string", "web account export legal privacy officer");
expect("businessAddress" in (accountExport.body.legal ?? {}), "web account export legal business address");
expect("mailOrderRegistrationNumber" in (accountExport.body.legal ?? {}), "web account export legal mail order number");
expect(typeof accountExport.body.legal?.retentionSummary === "string", "web account export legal retention summary");
expect(Array.isArray(accountExport.body.legal?.privacyProcessors), "web account export legal processors");
expect(Array.isArray(accountExport.body.legal?.overseasTransfers), "web account export legal overseas transfers");
expect(Boolean(accountExport.body.legal?.acceptance), "web account export legal acceptance object");
expect(Array.isArray(accountExport.body.consents), "web account export consents");
expect(typeof accountExport.body.billingSubscription?.status === "string", "web account export billing subscription status");
expect(typeof accountExport.body.billingSubscription?.providerLabel === "string", "web account export billing subscription provider");
expect(typeof accountExport.body.billingTaxProfile?.taxInvoiceEnabled === "boolean", "web account export billing tax profile");
expect(Array.isArray(accountExport.body.billingTaxDocuments), "web account export billing tax documents");
expect(Array.isArray(accountExport.body.billingInvoices), "web account export billing invoices");
expect(Array.isArray(accountExport.body.billingPaymentMethods), "web account export billing payment methods");
expect(Array.isArray(accountExport.body.billingPlanRequests), "web account export billing plan requests");
expect(Array.isArray(accountExport.body.deletionRequests), "web account export deletion requests");
expect(Array.isArray(accountExport.body.exclusions), "web account export exclusions");
checks.push("web_account_export");

const accountProfileValidation = await fetchJson<ActionResult<null>>("/api/web/account/profile", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "가".repeat(81) }),
});
expect(
  accountProfileValidation.status === 400 || accountProfileValidation.status === 401,
  `web account profile validation boundary: expected 400 or 401, got ${accountProfileValidation.status}`,
);
if (accountProfileValidation.status === 400) {
  expect(accountProfileValidation.body.error?.code === "invalid_name", "web account profile validation code");
} else {
  expect(accountProfileValidation.body.error?.code === "auth_required", "web account profile auth boundary");
}
checks.push("web_account_profile_validation");

const accountPasswordValidation = await fetchJson<ActionResult<null>>("/api/web/account/password", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "short" }),
});
expect(
  accountPasswordValidation.status === 400 || accountPasswordValidation.status === 401,
  `web account password validation boundary: expected 400 or 401, got ${accountPasswordValidation.status}`,
);
if (accountPasswordValidation.status === 400) {
  expect(accountPasswordValidation.body.error?.code === "invalid_password", "web account password validation code");
} else {
  expect(accountPasswordValidation.body.error?.code === "auth_required", "web account password auth boundary");
}
checks.push("web_account_password_validation");

const accountDeletionValidation = await fetchJson<ActionResult<null>>("/api/web/account/deletion-request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, confirmation: "삭제" }),
});
expectStatus(accountDeletionValidation, 400, "web account deletion request validation status");
expect(accountDeletionValidation.body.error?.code === "confirmation_required", "web account deletion request confirmation gate");
checks.push("web_account_deletion_request_validation");

const accountDeletionRequest = await fetchJson<ActionResult<{
  id: string;
  status: "open" | "queued";
  persisted: boolean;
}>>("/api/web/account/deletion-request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email,
    reason: "HTTP 검증에서 계정 삭제 요청 접수와 이력 노출 경로를 확인합니다.",
    confirmation: "삭제 요청",
  }),
});
expect(
  accountDeletionRequest.status === 201 || accountDeletionRequest.status === 202,
  `web account deletion request status: expected 201 or 202, got ${accountDeletionRequest.status}`,
);
expect(accountDeletionRequest.body.ok === true, "web account deletion request envelope ok");
expect(Boolean(accountDeletionRequest.body.data?.id), "web account deletion request receipt id");
checks.push("web_account_deletion_request");

const settingsHtml = await fetchText("/settings");
expectStatus(settingsHtml, 200, "web settings html status");
expect(settingsHtml.body.includes("회사와 신청 준비 데이터를 관리하세요"), "web settings renders heading");
expect(settingsHtml.body.includes("/api/web/settings/report"), "web settings links settings report");
expect(settingsHtml.body.includes("id=\"company-settings\""), "web settings renders company settings panel");
checks.push("web_settings_html");

const settingsReport = await fetchText("/api/web/settings/report");
expectStatus(settingsReport, 200, "web settings report status");
expect(
  settingsReport.headers.get("content-type")?.includes("text/markdown") === true,
  "web settings report content-type",
);
expect(
  settingsReport.headers.get("content-disposition")?.includes("attachment") === true,
  "web settings report attachment",
);
expect(settingsReport.body.includes("설정 리포트"), "web settings report heading");
expect(settingsReport.body.includes("## 온보딩 단계"), "web settings report onboarding section");
expect(settingsReport.body.includes("## 운영 액션"), "web settings report actions section");
checks.push("web_settings_report");

const onboardingHtml = await fetchText("/onboarding");
expectStatus(onboardingHtml, 200, "web onboarding html status");
expect(onboardingHtml.body.includes("온보딩"), "web onboarding renders heading");
expect(onboardingHtml.body.includes("온보딩 진행 상태"), "web onboarding renders progress status");
expect(onboardingHtml.body.includes("회사 데이터 연결"), "web onboarding renders setup panel");
checks.push("web_onboarding_html");

const onboardingNextHtml = await fetchText("/onboarding?next=%2Fapplications");
expectStatus(onboardingNextHtml, 200, "web onboarding next html status");
expect(onboardingNextHtml.body.includes("이어서 진행"), "web onboarding next renders continuation action");
expect(onboardingNextHtml.body.includes("href=\"/applications\""), "web onboarding next keeps internal destination");
checks.push("web_onboarding_next_html");

const termsHtml = await fetchText("/terms");
expectStatus(termsHtml, 200, "web terms html status");
expect(termsHtml.body.includes("창업노트 서비스 이용약관"), "web terms renders title");
expect(termsHtml.body.includes("운영자 정보"), "web terms renders operator disclosure");
expect(termsHtml.body.includes("사업자등록번호"), "web terms renders business registration disclosure");
checks.push("web_terms_html");

const privacyHtml = await fetchText("/privacy");
expectStatus(privacyHtml, 200, "web privacy html status");
expect(privacyHtml.body.includes("창업노트 개인정보 처리방침"), "web privacy renders title");
expect(privacyHtml.body.includes("개인정보보호책임자"), "web privacy renders privacy officer");
expect(privacyHtml.body.includes("수탁사"), "web privacy renders processor disclosure");
expect(privacyHtml.body.includes("국외이전"), "web privacy renders overseas transfer disclosure");
checks.push("web_privacy_html");

const supportHtml = await fetchText("/support");
expectStatus(supportHtml, 200, "web support html status");
expect(supportHtml.body.includes("고객지원"), "web support renders title");
expect(supportHtml.body.includes("support-ticket-form"), "web support renders ticket form");
expect(supportHtml.body.includes("id=\"support-attachment\""), "web support renders attachment input");
expect(
  supportHtml.body.includes("href=\"/account#account-support-tickets\"")
    || supportHtml.body.includes("callbackUrl=%2Faccount%23account-support-tickets"),
  "web support links account support history",
);
checks.push("web_support_html");

const supportTicket = await fetchJson<ActionResult<{
  id: string;
  status: "open" | "queued";
  persisted: boolean;
  emailDelivery?: {
    provider: string;
    configured: boolean;
    status: string;
  };
}>>("/api/web/support/tickets", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    category: "product",
    email: "support-verify@changupnote.com",
    name: "HTTP 검증",
    subject: "지원 문의 접수 검증",
    message: "HTTP 검증에서 지원 문의 접수 API가 응답하는지 확인합니다.",
  }),
});
expect(
  supportTicket.status === 201 || supportTicket.status === 202,
  `web support ticket status: expected 201 or 202, got ${supportTicket.status}`,
);
expect(supportTicket.body.ok === true, "web support ticket envelope ok");
expect(Boolean(supportTicket.body.data?.id), "web support ticket receipt id");
expect(supportTicket.body.data?.emailDelivery?.provider === "none", "web support ticket email delivery provider");
expect(supportTicket.body.data?.emailDelivery?.status === "skipped", "web support ticket email delivery skipped");
checks.push("web_support_ticket");

const supportTicketIntakeHandoffInvalid = await fetchJson<ActionResult<null>>("/api/web/support/tickets/handoff", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    category: "product",
    email: "not-an-email",
    subject: "지원 문의",
    message: "HTTP 검증에서 handoff validation을 확인합니다.",
  }),
});
expectStatus(supportTicketIntakeHandoffInvalid, 400, "web support ticket intake handoff invalid status");
expect(supportTicketIntakeHandoffInvalid.body.error?.code === "invalid_email", "web support ticket intake handoff invalid code");
checks.push("web_support_ticket_intake_email_handoff_invalid");

const supportTicketIntakeHandoff = await fetchText("/api/web/support/tickets/handoff", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    category: "product",
    email: "support-verify@changupnote.com",
    name: "HTTP 검증",
    subject: "지원 문의 접수 검증",
    message: "HTTP 검증에서 지원 문의 접수 handoff 메일 파일이 생성되는지 확인합니다.",
    ticketId: supportTicket.body.data?.id,
    hasAttachment: false,
  }),
});
expectStatus(supportTicketIntakeHandoff, 200, "web support ticket intake handoff status");
expect(
  supportTicketIntakeHandoff.headers.get("content-type")?.includes("message/rfc822") === true,
  "web support ticket intake handoff content-type",
);
expect(
  supportTicketIntakeHandoff.headers.get("content-disposition")?.includes("attachment") === true,
  "web support ticket intake handoff attachment",
);
expect(
  supportTicketIntakeHandoff.body.includes("X-Cunote-Handoff: support-ticket-intake-email"),
  "web support ticket intake handoff marker",
);
expect(supportTicketIntakeHandoff.body.includes("지원 문의 접수 검증"), "web support ticket intake handoff subject");
expect(supportTicketIntakeHandoff.body.includes("/support#support-ticket-form"), "web support ticket intake handoff path");
checks.push("web_support_ticket_intake_email_handoff");

const supportAttachmentInvalidForm = new FormData();
supportAttachmentInvalidForm.set("email", "support-verify@changupnote.com");
supportAttachmentInvalidForm.set("file", new Blob(["invalid ticket attachment verify"], { type: "text/plain" }), "invalid-ticket.txt");
const supportTicketAttachmentInvalid = await fetchJson<ActionResult<null>>(
  "/api/web/support/tickets/not-a-ticket/attachments",
  {
    method: "POST",
    body: supportAttachmentInvalidForm,
  },
);
expectStatus(supportTicketAttachmentInvalid, 400, "web support ticket attachment invalid status");
expect(
  supportTicketAttachmentInvalid.body.error?.code === "support_ticket_attachment_invalid_ticket",
  "web support ticket attachment invalid code",
);
checks.push("web_support_ticket_attachment_invalid");

const supportTicketAttachmentArchiveInvalid = await fetchJson<ActionResult<null>>(
  "/api/web/support/tickets/not-a-ticket/attachments/not-an-attachment",
  { method: "DELETE" },
);
expectStatus(supportTicketAttachmentArchiveInvalid, 400, "web support ticket attachment archive invalid status");
expect(
  supportTicketAttachmentArchiveInvalid.body.error?.code === "support_ticket_attachment_invalid_ticket",
  "web support ticket attachment archive invalid code",
);
checks.push("web_support_ticket_attachment_archive_invalid");

const supportTicketStatusInvalid = await fetchJson<ActionResult<null>>(
  "/api/web/support/tickets/not-a-ticket",
  {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "resolve" }),
  },
);
expectStatus(supportTicketStatusInvalid, 400, "web support ticket status invalid status");
expect(
  supportTicketStatusInvalid.body.error?.code === "invalid_support_ticket_id",
  "web support ticket status invalid code",
);
checks.push("web_support_ticket_status_invalid");

if (supportTicket.body.data?.persisted) {
  const supportAttachmentForm = new FormData();
  supportAttachmentForm.set("email", "support-verify@changupnote.com");
  supportAttachmentForm.set("file", new Blob(["support attachment verify"], { type: "text/plain" }), "support-verify.txt");
  const supportTicketAttachment = await fetchJson<ActionResult<{
    persisted: boolean;
    storageConfigured: boolean;
    attachment: {
      id: string;
      ticketId: string;
      filename: string;
      archiveUrl: string;
    } | null;
    message: string;
  }>>(`/api/web/support/tickets/${encodeURIComponent(supportTicket.body.data.id)}/attachments`, {
    method: "POST",
    body: supportAttachmentForm,
  });
  expect(
    supportTicketAttachment.status === 201 || supportTicketAttachment.status === 202,
    `web support ticket attachment status: expected 201 or 202, got ${supportTicketAttachment.status}`,
  );
  expect(supportTicketAttachment.body.ok === true, "web support ticket attachment envelope ok");
  expect(typeof supportTicketAttachment.body.data?.persisted === "boolean", "web support ticket attachment persisted flag");
  if (supportTicketAttachment.body.data?.persisted) {
    expect(supportTicketAttachment.body.data.attachment?.ticketId === supportTicket.body.data.id, "web support ticket attachment ticket");
    expect(supportTicketAttachment.body.data.attachment?.filename === "support-verify.txt", "web support ticket attachment filename");
    expect(Boolean(supportTicketAttachment.body.data.attachment?.archiveUrl), "web support ticket attachment archive url");
  }
  checks.push("web_support_ticket_attachment");

  const supportTicketTranscript = await fetchText(
    `/api/web/support/tickets/${encodeURIComponent(supportTicket.body.data.id)}/transcript`,
  );
  expectStatus(supportTicketTranscript, 200, "web support ticket transcript status");
  expect(
    supportTicketTranscript.headers.get("content-type")?.includes("text/markdown") === true,
    "web support ticket transcript content-type",
  );
  expect(
    supportTicketTranscript.headers.get("content-disposition")?.includes("attachment") === true,
    "web support ticket transcript attachment",
  );
  expect(supportTicketTranscript.body.includes("문의 기록"), "web support ticket transcript title");
  expect(supportTicketTranscript.body.includes("## 첨부 파일"), "web support ticket transcript attachments");
  checks.push("web_support_ticket_transcript");

  const userSupportTicketMessage = await fetchJson<ActionResult<{
    id: string;
    ticketId: string;
    visibility: "public";
  }>>(`/api/web/support/tickets/${encodeURIComponent(supportTicket.body.data.id)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      body: "HTTP 검증에서 사용자 답장 저장 경로를 확인합니다.",
    }),
  });
  expectStatus(userSupportTicketMessage, 201, "web support ticket message status");
  expect(userSupportTicketMessage.body.ok === true, "web support ticket message envelope ok");
  expect(userSupportTicketMessage.body.data?.visibility === "public", "web support ticket message visibility");
  checks.push("web_support_ticket_message");

  const supportTicketStatusResolved = await fetchJson<ActionResult<{
    id: string;
    status: string;
    updatedAt: string;
    message: string;
  }>>(`/api/web/support/tickets/${encodeURIComponent(supportTicket.body.data.id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "resolve" }),
  });
  expectStatus(supportTicketStatusResolved, 200, "web support ticket status resolved status");
  expect(supportTicketStatusResolved.body.ok === true, "web support ticket status resolved envelope ok");
  expect(supportTicketStatusResolved.body.data?.status === "resolved", "web support ticket status resolved value");
  checks.push("web_support_ticket_status_resolved");

  const supportTicketStatusReopened = await fetchJson<ActionResult<{
    id: string;
    status: string;
    updatedAt: string;
  }>>(`/api/web/support/tickets/${encodeURIComponent(supportTicket.body.data.id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "reopen" }),
  });
  expectStatus(supportTicketStatusReopened, 200, "web support ticket status reopen status");
  expect(supportTicketStatusReopened.body.data?.status === "open", "web support ticket status reopen value");
  checks.push("web_support_ticket_status_reopen");
}

const adminSupportTicketMoved = await fetchJson<ApiEnvelope<null>>("/api/admin/flywheel/support-tickets/00000000-0000-4000-8000-000000000001", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: "in_progress" }),
});
expectAdminMovedApi(adminSupportTicketMoved, "admin support ticket moved boundary");
checks.push("admin_support_ticket_moved_to_ops");

const adminSupportTicketMessageMoved = await fetchJson<ApiEnvelope<null>>("/api/admin/flywheel/support-tickets/00000000-0000-4000-8000-000000000001/messages", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ body: "권한 없는 관리자 메시지" }),
});
expectAdminMovedApi(adminSupportTicketMessageMoved, "admin support ticket message moved boundary");
checks.push("admin_support_ticket_message_moved_to_ops");

const adminSupportTicketEmailHandoffMoved = await fetchJson<ApiEnvelope<null>>("/api/admin/flywheel/support-tickets/00000000-0000-4000-8000-000000000001/email-handoff");
expectAdminMovedApi(adminSupportTicketEmailHandoffMoved, "admin support ticket email handoff moved boundary");
checks.push("admin_support_ticket_email_handoff_moved_to_ops");

const adminBillingSubscriptionMoved = await fetchJson<ApiEnvelope<null>>("/api/admin/flywheel/billing-subscriptions/00000000-0000-4000-8000-000000000101", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: "manual_review" }),
});
expectAdminMovedApi(adminBillingSubscriptionMoved, "admin billing subscription moved boundary");
checks.push("admin_billing_subscription_moved_to_ops");

const adminHtml = await fetchText("/admin", { redirect: "manual" });
expectOpsAdminRedirect(adminHtml, "/admin", "admin html moved boundary");
checks.push("admin_html_moved_to_ops");

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
    body: JSON.stringify({
      kind: "saved",
      message: "HTTP 검증",
      payload: {
        source: "application_pipeline",
        assigneeName: "HTTP 검증",
        reminderAt: new Date().toISOString().slice(0, 10),
        outcomeNote: "알림센터 리마인더 검증",
      },
    }),
  },
);
expectStatus(webFeedback, 202, "web feedback status");
expect(Boolean(webFeedback.body.data?.receipt.id), "web feedback receipt id");
checks.push("web_match_feedback");

const webNotificationFeedAfterReminder = await fetchJson<ActionResult<{
  notifications: Array<{ id: string; title: string; body: string; target: string }>;
}>>("/api/web/notification-feed");
expectStatus(webNotificationFeedAfterReminder, 200, "web notification feed reminder status");
expect(
  webNotificationFeedAfterReminder.body.data?.notifications.some((item) =>
    item.id.startsWith("application_reminder:")
    && item.title.includes("리마인더")
    && item.target === "/applications"
  ) === true,
  "web notification feed exposes application reminder",
);
checks.push("web_notification_feed_application_reminder");

const webGrantDetail = await fetchJson<ActionResult<{
  grant: { id: string; title: string };
  applicationPrep: {
    autoSubmitSupported: boolean;
    profileCopyFields: Array<{ label: string; value: string }>;
    planDraftPrompts: Array<{ title: string; evidence: string[] }>;
    draftableDocuments: unknown[];
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

const webGrantPreparation = await fetchJson<ActionResult<{
  grant: { id: string; title: string };
  documents: unknown[];
  sourceAttachments: unknown[];
  applicationPrep: {
    autoSubmitSupported: boolean;
    draftableDocuments: unknown[];
    draftCoverage: { totalDocuments: number; draftableCount: number };
  };
  drafts: unknown[];
  formFields: unknown[];
  exportUrls: {
    packageMarkdown: string;
    attachmentBundleMarkdown: string;
  };
}>>(`/api/web/grants/${encodeURIComponent(webGrant!.grantId)}/preparation`);
expectStatus(webGrantPreparation, 200, "web grant preparation status");
expect(webGrantPreparation.body.ok === true, "web grant preparation envelope ok");
expect(webGrantPreparation.body.data?.grant.id === webGrant!.grantId, "web grant preparation matches dashboard grant");
expect(webGrantPreparation.body.data?.applicationPrep.autoSubmitSupported === false, "web grant preparation disables auto submit");
expect(
  webGrantPreparation.body.data?.applicationPrep.draftableDocuments.length
    === webGrantDetail.body.data?.applicationPrep.draftableDocuments.length,
  "web grant preparation matches detail draftable count",
);
expect(
  webGrantPreparation.body.data?.exportUrls.packageMarkdown.endsWith("/package") === true,
  "web grant preparation exposes package export URL",
);
expect(
  webGrantPreparation.body.data?.exportUrls.attachmentBundleMarkdown.endsWith("/package?format=attachments") === true,
  "web grant preparation exposes attachment bundle export URL",
);
checks.push("web_grant_preparation");

const webDraftGetInvalid = await fetchJson<ActionResult<null>>("/api/web/document-drafts/not-a-valid-draft");
expectStatus(webDraftGetInvalid, 400, "web document draft get invalid status");
expect(webDraftGetInvalid.body.ok === false, "web document draft get invalid envelope");
expect(webDraftGetInvalid.body.error?.code === "invalid_draft_id", "web document draft get invalid code");
checks.push("web_document_draft_get_invalid");

const webDraftPatchInvalid = await fetchJson<ActionResult<null>>(
  "/api/web/document-drafts/not-a-valid-draft",
  {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "reviewed" }),
  },
);
expectStatus(webDraftPatchInvalid, 400, "web document draft patch invalid status");
expect(webDraftPatchInvalid.body.ok === false, "web document draft patch invalid envelope");
expect(webDraftPatchInvalid.body.error?.code === "invalid_draft_id", "web document draft patch invalid code");
checks.push("web_document_draft_patch_invalid");

const webDraftDownloadInvalid = await fetchJson<ActionResult<null>>("/api/web/document-drafts/not-a-valid-draft/download");
expectStatus(webDraftDownloadInvalid, 400, "web document draft download invalid status");
expect(webDraftDownloadInvalid.body.ok === false, "web document draft download invalid envelope");
expect(webDraftDownloadInvalid.body.error?.code === "invalid_draft_id", "web document draft download invalid code");
checks.push("web_document_draft_download_invalid");

const webDraftRegenerateInvalid = await fetchJson<ActionResult<null>>(
  "/api/web/document-drafts/not-a-valid-draft/regenerate",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sectionTitle: "기본 정보" }),
  },
);
expectStatus(webDraftRegenerateInvalid, 400, "web document draft regenerate invalid status");
expect(webDraftRegenerateInvalid.body.ok === false, "web document draft regenerate invalid envelope");
expect(webDraftRegenerateInvalid.body.error?.code === "invalid_draft_id", "web document draft regenerate invalid code");
checks.push("web_document_draft_regenerate_invalid");

const webDraftFeedbackInvalid = await fetchJson<ActionResult<{ eventId: string }>>(
  "/api/web/document-drafts/not-a-valid-draft/feedback",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "too_generic", message: "HTTP invalid boundary" }),
  },
);
expectStatus(webDraftFeedbackInvalid, 400, "web document draft feedback invalid status");
expect(webDraftFeedbackInvalid.body.ok === false, "web document draft feedback invalid envelope");
expect(webDraftFeedbackInvalid.body.error?.code === "invalid_draft_id", "web document draft feedback invalid code");
checks.push("web_document_draft_feedback_invalid");

const webApplicationCalendar = await fetchText(`/api/web/applications/${encodeURIComponent(webGrant!.grantId)}/calendar`);
expectStatus(webApplicationCalendar, 200, "web application calendar status");
expect(
  webApplicationCalendar.headers.get("content-type")?.includes("text/calendar") === true,
  "web application calendar content-type",
);
expect(webApplicationCalendar.body.includes("BEGIN:VCALENDAR"), "web application calendar body");
expect(webApplicationCalendar.body.includes("BEGIN:VEVENT"), "web application calendar event");
expect(webApplicationCalendar.body.includes("리마인더"), "web application calendar reminder event");
checks.push("web_application_calendar");

const webApplicationPackage = await fetchText(`/api/web/grants/${encodeURIComponent(webGrant!.grantId)}/package`);
expectStatus(webApplicationPackage, 200, "web application package status");
expect(
  webApplicationPackage.headers.get("content-type")?.includes("text/markdown") === true,
  "web application package content-type",
);
expect(
  webApplicationPackage.headers.get("content-disposition")?.includes("attachment") === true,
  "web application package attachment",
);
expect(webApplicationPackage.body.includes("신청 패키지"), "web application package title");
expect(webApplicationPackage.body.includes("제출 서류 Taxonomy"), "web application package documents");
expect(webApplicationPackage.body.includes("원문 양식 필드 매핑"), "web application package form field mapping");
checks.push("web_application_package");

const webAttachmentBundle = await fetchText(`/api/web/grants/${encodeURIComponent(webGrant!.grantId)}/package?format=attachments`);
expectStatus(webAttachmentBundle, 200, "web attachment bundle status");
expect(
  webAttachmentBundle.headers.get("content-type")?.includes("text/markdown") === true,
  "web attachment bundle content-type",
);
expect(
  webAttachmentBundle.headers.get("content-disposition")?.includes("attachment") === true,
  "web attachment bundle attachment",
);
expect(webAttachmentBundle.body.includes("첨부 묶음"), "web attachment bundle title");
expect(webAttachmentBundle.body.includes("보관 상태"), "web attachment bundle archive status");
expect(webAttachmentBundle.body.includes("원문 양식 필드 매핑"), "web attachment bundle form field mapping");
checks.push("web_attachment_bundle");

const webGrantDetailHtml = await fetchText(`/grants/${encodeURIComponent(webGrant!.grantId)}`);
expectStatus(webGrantDetailHtml, 200, "web grant detail html status");
expect(webGrantDetailHtml.body.includes("신청 준비 시트"), "web grant detail renders apply sheet");
expect(webGrantDetailHtml.body.includes("체크리스트"), "web grant detail renders checklist");
expect(webGrantDetailHtml.body.includes("복붙 프로필"), "web grant detail renders profile copy section");
expect(webGrantDetailHtml.body.includes("필요 서류와 AI 초안"), "web grant detail renders document draft workspace");
expect(webGrantDetailHtml.body.includes("문서 준비 방식"), "web grant detail renders document preparation groups");
if ((webGrantDetail.body.data?.applicationPrep.draftableDocuments.length ?? 0) > 0) {
  expect(webGrantDetailHtml.body.includes("초안에 반영할 추가 입력"), "web grant detail renders draft answer inputs");
}
expect(webGrantDetailHtml.body.includes("패키지 내보내기"), "web grant detail renders package export action");
expect(webGrantDetailHtml.body.includes("첨부 묶음"), "web grant detail renders attachment bundle action");
expect(webGrantDetailHtml.body.includes("필드 매핑"), "web grant detail renders form field mapping");
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
  : appCompanyCreate.body.data?.company.id ?? companies.body.data?.companies[0]?.id;
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
    bizNo: appVerifyBizNo,
    ownerName: "검증 대표",
    openedOn: "2024-01-01",
  }),
});
expectStatus(appCompanyVerify, 200, "app company verify status");
expect(appCompanyVerify.body.data?.companyId === companyId, "app company verify company id");
expect(!Object.hasOwn(appCompanyVerify.body.data ?? {}, "bizNo"), "app company verify hides raw bizNo");
expect(appCompanyVerify.body.data?.bizNoMasked === maskBizNo(appVerifyBizNo), "app company verify masked bizNo");
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
  matches: Array<{ grantId: string; rulesetVer?: string; benefits?: unknown[] }>;
}>>(`/api/app/v1/companies/${companyId}/matches`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appMatches, 200, "app matches status");
const appGrant = appMatches.body.data?.matches.find((entry) => entry.grantId);
expect(Boolean(appGrant), "app matches exposes a match grant");
expect(Array.isArray(appGrant?.benefits), "app matches exposes benefit badges");
checks.push("app_matches");

const appFilteredMatches = await fetchJson<ApiEnvelope<{
  matches: Array<{ grantId: string; eligibility: string; fitScore: number; benefits?: unknown[] }>;
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
expect(
  appFilteredMatches.body.data!.matches.every((entry) => Array.isArray(entry.benefits)),
  "app filtered matches benefit badges",
);
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
    body: JSON.stringify({
      kind: "applied",
      message: "HTTP 검증",
      payload: {
        source: "application_pipeline",
        assigneeName: "앱 HTTP 검증",
        reminderAt: new Date().toISOString().slice(0, 10),
        outcomeNote: "앱 알림센터 리마인더 검증",
      },
    }),
  },
);
expectStatus(appFeedback, 202, "app feedback status");
expect(Boolean(appFeedback.body.data?.receipt.id), "app feedback receipt id");
checks.push("app_match_feedback");

const appNotificationReminderSettings = await fetchJson<ApiEnvelope<{
  deadlineReminder: boolean;
  newMatch: boolean;
}>>("/api/app/v1/notifications/settings", {
  method: "PUT",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    deadlineReminder: true,
    newMatch: true,
  }),
});
expectStatus(appNotificationReminderSettings, 200, "app notification reminder settings status");
expect(appNotificationReminderSettings.body.data?.deadlineReminder === true, "app notification reminder settings deadline");
checks.push("app_notification_reminder_settings");

const appNotificationFeedAfterReminder = await fetchJson<ApiEnvelope<{
  generatedAt: string;
  notifications: Array<{ id: string; title: string; target: string; kind: string }>;
}>>(`/api/app/v1/companies/${companyId}/notifications`, {
  headers: { authorization: `Bearer ${accessToken}` },
});
expectStatus(appNotificationFeedAfterReminder, 200, "app notification feed reminder status");
const appReminderNotification = appNotificationFeedAfterReminder.body.data?.notifications.find((item) =>
  item.id.startsWith("application_reminder:")
  && item.kind === "deadline"
  && item.target === "/applications"
);
expect(
  Boolean(appReminderNotification),
  "app notification feed exposes application reminder",
);
checks.push("app_notification_feed_application_reminder");

const appNotificationReceiptRead = await fetchJson<ApiEnvelope<{
  notification: { id: string; status: string; readAt: string | null; dismissedAt: string | null; href?: string };
}>>(`/api/app/v1/companies/${companyId}/notifications/receipt`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    notificationId: appReminderNotification!.id,
    action: "read",
  }),
});
expectStatus(appNotificationReceiptRead, 200, "app notification receipt read status");
expect(appNotificationReceiptRead.body.data?.notification.id === appReminderNotification!.id, "app notification receipt read id");
expect(appNotificationReceiptRead.body.data?.notification.status === "read", "app notification receipt read state");
expect(typeof appNotificationReceiptRead.body.data?.notification.readAt === "string", "app notification receipt read timestamp");
expect(!Object.hasOwn(appNotificationReceiptRead.body.data?.notification ?? {}, "href"), "app notification receipt hides web href");
checks.push("app_notification_receipt_read");

const appNotificationReceiptDismiss = await fetchJson<ApiEnvelope<{
  notification: { id: string; status: string; readAt: string | null; dismissedAt: string | null };
}>>(`/api/app/v1/companies/${companyId}/notifications/receipt`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    notificationId: appReminderNotification!.id,
    action: "dismiss",
  }),
});
expectStatus(appNotificationReceiptDismiss, 200, "app notification receipt dismiss status");
expect(appNotificationReceiptDismiss.body.data?.notification.status === "dismissed", "app notification receipt dismiss state");
expect(typeof appNotificationReceiptDismiss.body.data?.notification.dismissedAt === "string", "app notification receipt dismiss timestamp");
checks.push("app_notification_receipt_dismiss");

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
    signal: AbortSignal.timeout(requestTimeoutMs),
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
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const body = await response.text();
  return {
    status: response.status,
    body,
    headers: response.headers,
  };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cookieHeader(headers: Headers, name: string): string | null {
  const setCookie = headers.get("set-cookie");
  const cookie = setCookie?.split(/,(?=\s*[^;=]+=)/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  return cookie?.split(";")[0] ?? null;
}

function maskBizNo(value: string): string {
  return `${value.slice(0, 3)}-**-${value.slice(5, 7)}***`;
}

function expectStatus(response: JsonResponse, status: number, label: string) {
  expect(response.status === status, `${label}: expected ${status}, got ${response.status}`);
}

function expectAdminMovedApi(response: JsonResponse<ApiEnvelope<unknown>>, label: string) {
  expectStatus(response, 404, `${label} status`);
  expect(response.body.error?.code === "admin_moved_to_ops", `${label} error code`);
}

function expectAdminMovedText(response: JsonResponse<string>, label: string) {
  expectStatus(response, 404, `${label} status`);
  expect(response.body.includes("admin_moved_to_ops"), `${label} body`);
}

function expectOpsAdminRedirect(response: JsonResponse<string>, path: string, label: string) {
  expect(response.status === 307 || response.status === 308, `${label}: expected redirect, got ${response.status}`);
  expect(response.headers.get("location") === `${opsAdminOrigin}${path}`, `${label} location`);
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
