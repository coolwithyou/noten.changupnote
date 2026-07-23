import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = process.cwd();
const adminRoot = resolve(workspaceRoot, "apps/admin");
const files = {
  packageJson: resolve(adminRoot, "package.json"),
  authOptions: resolve(adminRoot, "src/lib/server/auth/adminOptions.ts"),
  adminSession: resolve(adminRoot, "src/lib/server/auth/adminSession.ts"),
  adminUsers: resolve(adminRoot, "src/lib/server/auth/adminUsers.ts"),
  adminRole: resolve(adminRoot, "src/lib/server/auth/adminRole.ts"),
  routeAccess: resolve(adminRoot, "src/lib/auth/routeAccess.ts"),
  proxy: resolve(adminRoot, "src/proxy.ts"),
  statusRoute: resolve(adminRoot, "src/app/api/admin/status/route.ts"),
  legalReadinessRoute: resolve(adminRoot, "src/app/api/admin/status/legal-readiness/route.ts"),
  saasReadinessRoute: resolve(adminRoot, "src/app/api/admin/status/saas-readiness/route.ts"),
  releaseChecklistRoute: resolve(adminRoot, "src/app/api/admin/status/release-checklist/route.ts"),
  readinessStore: resolve(adminRoot, "src/lib/server/admin/readiness.ts"),
  flywheelRoute: resolve(adminRoot, "src/app/api/admin/flywheel/route.ts"),
  flywheelStore: resolve(adminRoot, "src/lib/server/admin/flywheel.ts"),
  reviewQueueRoute: resolve(adminRoot, "src/app/api/admin/flywheel/review-queue/route.ts"),
  reviewQueueStore: resolve(adminRoot, "src/lib/server/admin/reviewQueue.ts"),
  matchingEvalRoute: resolve(adminRoot, "src/app/api/admin/flywheel/matching-eval/route.ts"),
  matchingEvalStore: resolve(adminRoot, "src/lib/server/admin/matchingEval.ts"),
  supportTicketRoute: resolve(adminRoot, "src/app/api/admin/flywheel/support-tickets/[ticketId]/route.ts"),
  supportTicketReportRoute: resolve(adminRoot, "src/app/api/admin/flywheel/support-tickets/report/route.ts"),
  supportTicketMessagesRoute: resolve(adminRoot, "src/app/api/admin/flywheel/support-tickets/[ticketId]/messages/route.ts"),
  supportTicketEmailHandoffRoute: resolve(adminRoot, "src/app/api/admin/flywheel/support-tickets/[ticketId]/email-handoff/route.ts"),
  supportTicketOps: resolve(adminRoot, "src/lib/server/admin/supportTickets.ts"),
  supportTicketReport: resolve(adminRoot, "src/lib/server/admin/supportTicketReport.ts"),
  supportTicketEmailHandoff: resolve(adminRoot, "src/lib/server/admin/supportTicketEmailHandoff.ts"),
  billingSubscriptionRoute: resolve(adminRoot, "src/app/api/admin/flywheel/billing-subscriptions/[companyId]/route.ts"),
  billingSubscriptions: resolve(adminRoot, "src/lib/server/billing/subscriptions.ts"),
  liveMatchPage: resolve(adminRoot, "src/app/internal/live-match/page.tsx"),
  liveMatchRoute: resolve(adminRoot, "src/app/api/matches/live/route.ts"),
  liveMatchConsole: resolve(adminRoot, "src/components/LiveMatchConsole.tsx"),
  loginPage: resolve(adminRoot, "src/app/login/page.tsx"),
  reviewQueueApi: resolve(adminRoot, "src/app/api/admin/review/queue/route.ts"),
  reviewNoticeApi: resolve(adminRoot, "src/app/api/admin/review/notices/[id]/route.ts"),
  reviewVerdictsApi: resolve(adminRoot, "src/app/api/admin/review/notices/[id]/verdicts/route.ts"),
  reviewAdjudicateApi: resolve(adminRoot, "src/app/api/admin/review/adjudicate/[itemId]/route.ts"),
  reviewStore: resolve(adminRoot, "src/lib/server/review/dispatchReview.ts"),
  reviewPage: resolve(adminRoot, "src/app/review/page.tsx"),
  reviewNoticePage: resolve(adminRoot, "src/app/review/[noticeId]/page.tsx"),
  reviewAdjudicatePage: resolve(adminRoot, "src/app/review/adjudicate/page.tsx"),
  reviewGuidePage: resolve(adminRoot, "src/app/review/guide/page.tsx"),
  safeMarkdown: resolve(adminRoot, "src/components/review/SafeMarkdown.tsx"),
  createAdminUser: resolve(adminRoot, "src/scripts/create-admin-user.ts"),
  webProxy: resolve(workspaceRoot, "apps/web/src/proxy.ts"),
  webAuthOptions: resolve(workspaceRoot, "apps/web/src/lib/server/auth/options.ts"),
};

const errors: string[] = [];

for (const [label, file] of Object.entries(files)) {
  if (!existsSync(file)) errors.push(`${label} is missing: ${file}`);
}

const authOptions = readIfExists(files.authOptions);
const adminSession = readIfExists(files.adminSession);
const adminUsers = readIfExists(files.adminUsers);
const adminRole = readIfExists(files.adminRole);
const routeAccess = readIfExists(files.routeAccess);
const proxy = readIfExists(files.proxy);
const statusRoute = readIfExists(files.statusRoute);
const legalReadinessRoute = readIfExists(files.legalReadinessRoute);
const saasReadinessRoute = readIfExists(files.saasReadinessRoute);
const releaseChecklistRoute = readIfExists(files.releaseChecklistRoute);
const readinessStore = readIfExists(files.readinessStore);
const flywheelRoute = readIfExists(files.flywheelRoute);
const flywheelStore = readIfExists(files.flywheelStore);
const reviewQueueRoute = readIfExists(files.reviewQueueRoute);
const reviewQueueStore = readIfExists(files.reviewQueueStore);
const matchingEvalRoute = readIfExists(files.matchingEvalRoute);
const matchingEvalStore = readIfExists(files.matchingEvalStore);
const supportTicketRoute = readIfExists(files.supportTicketRoute);
const supportTicketReportRoute = readIfExists(files.supportTicketReportRoute);
const supportTicketMessagesRoute = readIfExists(files.supportTicketMessagesRoute);
const supportTicketEmailHandoffRoute = readIfExists(files.supportTicketEmailHandoffRoute);
const supportTicketOps = readIfExists(files.supportTicketOps);
const supportTicketReport = readIfExists(files.supportTicketReport);
const supportTicketEmailHandoff = readIfExists(files.supportTicketEmailHandoff);
const billingSubscriptionRoute = readIfExists(files.billingSubscriptionRoute);
const billingSubscriptions = readIfExists(files.billingSubscriptions);
const liveMatchPage = readIfExists(files.liveMatchPage);
const liveMatchRoute = readIfExists(files.liveMatchRoute);
const liveMatchConsole = readIfExists(files.liveMatchConsole);
const loginPage = readIfExists(files.loginPage);
const reviewQueueApi = readIfExists(files.reviewQueueApi);
const reviewNoticeApi = readIfExists(files.reviewNoticeApi);
const reviewVerdictsApi = readIfExists(files.reviewVerdictsApi);
const reviewAdjudicateApi = readIfExists(files.reviewAdjudicateApi);
const reviewStore = readIfExists(files.reviewStore);
const reviewPage = readIfExists(files.reviewPage);
const reviewNoticePage = readIfExists(files.reviewNoticePage);
const reviewAdjudicatePage = readIfExists(files.reviewAdjudicatePage);
const reviewGuidePage = readIfExists(files.reviewGuidePage);
const safeMarkdown = readIfExists(files.safeMarkdown);
const createAdminUser = readIfExists(files.createAdminUser);
const packageJson = readIfExists(files.packageJson);
const webProxy = readIfExists(files.webProxy);

expect(authOptions.includes("CredentialsProvider"), "admin auth must include email/password provider");
expect(authOptions.includes("GoogleProvider"), "admin auth must include Google provider");
expect(authOptions.includes("process.env.GOOGLE_CLIENT_ID"), "admin Google provider must reuse the web GOOGLE_CLIENT_ID");
expect(authOptions.includes("process.env.GOOGLE_CLIENT_SECRET"), "admin Google provider must reuse the web GOOGLE_CLIENT_SECRET");
expect(!authOptions.includes("KakaoProvider"), "admin auth must not include Kakao provider");
expect(!authOptions.includes('id: "demo"'), "admin auth must not include demo credentials provider");
expect(authOptions.includes("ADMIN_ALLOWED_GOOGLE_DOMAIN") && authOptions.includes("noten.im"), "admin auth must enforce noten.im domain default");
expect(authOptions.includes("isAllowedAdminEmail"), "admin auth must enforce explicit admin email allowlist hook");
expect(authOptions.includes("email_verified") && authOptions.includes("=== false"), "admin Google auth must reject unverified Google email profiles");
expect(authOptions.includes("findOrLinkGoogleAdminUser"), "admin Google auth must require an active admin_users row before sign-in");
expect(authOptions.includes("authenticateAdminPassword"), "admin password auth must use the admin password store");
expect(authOptions.includes("__Secure-cunote-admin.session-token"), "admin auth must use a distinct admin session cookie");
expect(authOptions.includes("__Host-cunote-admin.csrf-token"), "admin auth must use a distinct admin csrf cookie");
expect(!/\bdomain\s*:/.test(authOptions), "admin auth cookies must remain host-only and must not set a shared cookie domain");
expect(
  authOptions.includes("process.env.ADMIN_AUTH_SECRET ?? process.env.NEXTAUTH_SECRET"),
  "admin auth must prefer ADMIN_AUTH_SECRET over framework fallback secrets",
);
expect(!authOptions.includes("ADMIN_GOOGLE_CLIENT_ID"), "admin auth must not read a separate ADMIN_GOOGLE_CLIENT_ID — reuse the web GOOGLE_CLIENT_ID");
expect(!authOptions.includes("ADMIN_GOOGLE_CLIENT_SECRET"), "admin auth must not read a separate ADMIN_GOOGLE_CLIENT_SECRET — reuse the web GOOGLE_CLIENT_SECRET");
expect(!adminSession.includes("getOptionalWebSession"), "admin session must not read web session");
expect(!adminSession.includes("CUNOTE_AUTH_MODE"), "admin session must not support web mock auth");
expect(adminUsers.includes("from admin_users"), "admin user lookup must read the admin_users table");
expect(adminUsers.includes("status !== \"active\""), "admin user lookup must reject disabled admin users");
expect(adminUsers.includes("password_hash"), "admin password login must use admin_users.password_hash");
expect(adminUsers.includes('"reviewer"'), "admin roles must include the reviewer role");
expect(
  adminRole.includes('["reviewer", "viewer", "support", "admin", "owner"]'),
  "reviewer must remain the lowest ordered admin role",
);
expect(adminRole.includes("requireAnyAdminRole"), "review APIs must have an explicit role-set guard");
expect(!adminUsers.includes("from users"), "admin auth must not read the public users table");
expect(!adminUsers.includes("insert into users"), "admin auth must not auto-create public users");
expect(proxy.includes("getToken"), "admin proxy must validate an admin auth token");
expect(proxy.includes("__Secure-cunote-admin.session-token"), "admin proxy must read the admin session cookie");
expect(proxy.includes("/api/auth"), "admin proxy must allow NextAuth routes");
expect(proxy.includes("admin_auth_required"), "admin proxy must block unauthenticated admin API requests");
expect(proxy.includes("canAccessAdminPath"), "admin proxy must share the role-to-path matrix");
expect(routeAccess.includes('role !== "reviewer"'), "reviewer must be denied outside /review");
expect(routeAccess.includes("REVIEW_ADJUDICATION_ROLES"), "adjudication must have a narrower admin/owner role set");
expect(statusRoute.includes("requireAdminSession("), "admin status route must require admin session");
expect(statusRoute.includes("sharedWithWeb: false"), "admin status route must expose non-shared session boundary");
expect(statusRoute.includes("grant_document_draft_quality_events"), "admin status route must expose migrated ops surfaces");
expect(legalReadinessRoute.includes("requireAdminSession("), "admin legal readiness route must require admin session");
expect(saasReadinessRoute.includes("requireAdminSession("), "admin saas readiness route must require admin session");
expect(releaseChecklistRoute.includes("requireAdminSession("), "admin release checklist route must require admin session");
expect(readinessStore.includes("ADMIN_ALLOWED_GOOGLE_DOMAIN") && readinessStore.includes("noten.im"), "admin readiness must report noten.im domain policy");
expect(readinessStore.includes("web session cookie cannot authenticate ops APIs"), "admin release checklist must include session split gate");
expect(flywheelRoute.includes("requireAdminSession("), "admin flywheel route must require admin session");
expect(flywheelRoute.includes("getOpsFlywheelSnapshot("), "admin flywheel route must use the ops flywheel store");
expect(flywheelStore.includes("getAdminSql"), "admin flywheel store must use the ops admin DB client");
expect(!flywheelStore.includes("@/lib/server/auth/session"), "admin flywheel store must not import web auth session");
expect(reviewQueueRoute.includes("requireAdminSession("), "admin review queue route must require admin session");
expect(reviewQueueStore.includes("getAdminSql"), "admin review queue store must use the ops admin DB client");
expect(!reviewQueueStore.includes("requireAdminAccess"), "admin review queue store must not use web admin guard");
expect(matchingEvalRoute.includes("requireAdminSession("), "admin matching eval route must require admin session");
expect(matchingEvalStore.includes("getAdminSql"), "admin matching eval store must use the ops admin DB client");
expect(!matchingEvalStore.includes("requireAdminAccess"), "admin matching eval store must not use web admin guard");
expect(supportTicketRoute.includes("requireAdminSession("), "admin support ticket update route must require admin session");
expect(supportTicketReportRoute.includes("requireAdminSession("), "admin support ticket report route must require admin session");
expect(supportTicketMessagesRoute.includes("requireAdminSession("), "admin support ticket message route must require admin session");
expect(supportTicketEmailHandoffRoute.includes("requireAdminSession("), "admin support ticket email handoff route must require admin session");
expect(supportTicketOps.includes("getAdminSql"), "admin support ticket ops must use the ops admin DB client");
expect(!supportTicketOps.includes("requireAdminAccess"), "admin support ticket ops must not use web admin guard");
expect(supportTicketReport.includes("getAdminSql"), "admin support ticket report must use the ops admin DB client");
expect(supportTicketReport.includes("renderAdminSupportTicketReport"), "admin support ticket report must render the markdown report");
expect(!supportTicketReport.includes("requireAdminAccess"), "admin support ticket report must not use web admin guard");
expect(supportTicketEmailHandoff.includes("message/rfc822"), "admin support ticket email handoff must emit an eml download");
expect(!supportTicketEmailHandoff.includes("requireAdminAccess"), "admin support ticket email handoff must not use web admin guard");
expect(billingSubscriptionRoute.includes("requireAdminSession("), "admin billing subscription route must require admin session");
expect(billingSubscriptions.includes("getAdminSql"), "admin billing subscription ops must use the ops admin DB client");
expect(!billingSubscriptions.includes("updated_by = ${input.admin.user.id}"), "admin billing subscription ops must not write admin user id into web users FK");
expect(liveMatchPage.includes("LiveMatchConsole"), "admin live match page must render the live match console");
expect(liveMatchRoute.includes("requireAdminSession("), "admin live match API must require admin session");
expect(liveMatchRoute.includes("runLiveCompanyMatch"), "admin live match API must call the live matching core use case");
expect(liveMatchConsole.includes("/api/matches/live"), "admin live match console must call the admin live match API");
expect(loginPage.includes("GOOGLE_CLIENT_ID") && loginPage.includes("GOOGLE_CLIENT_SECRET"), "admin login page must gate the Google button on the shared GOOGLE_CLIENT_ID/SECRET");
for (const [label, source] of [
  ["review queue API", reviewQueueApi],
  ["review notice API", reviewNoticeApi],
  ["review verdict API", reviewVerdictsApi],
  ["review adjudication API", reviewAdjudicateApi],
] as const) {
  expect(source.includes("requireAdminSession("), `${label} must require an admin session`);
  expect(source.includes("requireAnyAdminRole("), `${label} must use an explicit role set`);
}
expect(reviewStore.includes("assignee_id = ${session.user.id}::uuid"), "reviewer queue/detail/writes must enforce assignee ownership in SQL");
expect(reviewStore.includes("review_revision_conflict") && reviewStore.includes("409"), "review verdict writes must use optimistic revision conflicts");
expect(reviewStore.includes("sanitizeReviewPayload"), "review notice payloads must pass through blind redaction");
expect(reviewStore.includes("status = 'conflict'"), "overlap disagreement must become a first-class conflict");
expect(reviewPage.includes("REVIEW_WORKSPACE_ROLES"), "review queue page must have a server role guard");
expect(reviewNoticePage.includes("REVIEW_WORKSPACE_ROLES"), "review detail page must have a server role guard");
expect(reviewAdjudicatePage.includes("REVIEW_ADJUDICATION_ROLES"), "adjudication page must be admin/owner only");
expect(reviewGuidePage.includes("REVIEW_WORKSPACE_ROLES"), "review guide page must have a server role guard");
expect(safeMarkdown.includes("rehype-sanitize"), "review markdown must sanitize untrusted analysis content");
expect(
  safeMarkdown.includes('rel="noopener noreferrer"'),
  "review markdown external links must prevent opener access",
);
expect(createAdminUser.includes("--generate-password"), "admin account CLI must support safe generated passwords");
expect(createAdminUser.includes('startsWith("--password=")'), "admin account CLI must reject argv passwords");
expect(createAdminUser.includes("isAllowedAdminEmail"), "admin account CLI must verify the configured allowlist");
expect(createAdminUser.includes("chmod(path, 0o600)"), "credential handoff file must be owner-readable only");
expect(packageJson.includes('"name": "@cunote/admin"'), "admin package must be a separate workspace app");
expect(webProxy.includes("CUNOTE_OPS_ADMIN_ORIGIN"), "web proxy must know the ops admin origin");
expect(webProxy.includes("/api/admin") && webProxy.includes("/api/matches/live"), "web proxy must close web admin APIs");
expect(webProxy.includes("/admin") && webProxy.includes("/internal/live-match"), "web proxy must redirect web admin pages");
expect(webProxy.includes("admin_moved_to_ops"), "web proxy must return an explicit moved-to-ops API error");

if (errors.length > 0) {
  console.error("Ops admin verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Ops admin verification passed.");

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function expect(condition: boolean, message: string) {
  if (!condition) errors.push(message);
}
