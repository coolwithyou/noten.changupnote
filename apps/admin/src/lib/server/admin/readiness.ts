export interface OpsReadinessItem {
  key: string;
  label: string;
  ready: boolean;
  evidence: string;
}

export interface OpsReadinessReport {
  title: string;
  score: number;
  generatedAt: string;
  items: OpsReadinessItem[];
}

export function buildOpsLegalReadiness(): OpsReadinessReport {
  const items: OpsReadinessItem[] = [
    envItem("admin_auth_url", "Admin auth URL", "ADMIN_AUTH_URL", process.env.ADMIN_AUTH_URL ?? process.env.NEXTAUTH_URL),
    envItem("admin_auth_secret", "Admin auth secret", "ADMIN_AUTH_SECRET", process.env.ADMIN_AUTH_SECRET),
    envItem("admin_google_client", "Admin Google OAuth client (shared with web)", "GOOGLE_CLIENT_ID", process.env.GOOGLE_CLIENT_ID),
    envItem("admin_google_secret", "Admin Google OAuth secret (shared with web)", "GOOGLE_CLIENT_SECRET", process.env.GOOGLE_CLIENT_SECRET),
    {
      key: "admin_google_domain",
      label: "Google hosted domain restriction",
      ready: (process.env.ADMIN_ALLOWED_GOOGLE_DOMAIN ?? "noten.im") === "noten.im",
      evidence: `ADMIN_ALLOWED_GOOGLE_DOMAIN=${process.env.ADMIN_ALLOWED_GOOGLE_DOMAIN ?? "noten.im"}`,
    },
    envItem("admin_allowed_emails", "Explicit admin email allowlist", "ADMIN_ALLOWED_EMAILS", process.env.ADMIN_ALLOWED_EMAILS),
  ];
  return report("창업노트 Ops legal readiness", items);
}

export function buildOpsSaasReadiness(): OpsReadinessReport {
  const items: OpsReadinessItem[] = [
    staticItem("separate_app", "Separate admin app", true, "apps/admin workspace package exists"),
    staticItem("separate_session_cookie", "Separate admin session cookie", true, "__Secure-cunote-admin.session-token"),
    staticItem("no_web_session", "No changupnote.com web session reuse", true, "admin uses requireAdminSession/getToken with admin cookie"),
    staticItem("email_password_only", "Email/password admin provider", true, "CredentialsProvider reads admin_users"),
    staticItem("google_only_oauth", "Google-only admin OAuth", true, "Kakao/demo providers are absent from adminAuthOptions"),
    staticItem("flywheel_api", "Ops flywheel API", true, "/api/admin/flywheel"),
    staticItem("support_ticket_report", "Support ticket report", true, "/api/admin/flywheel/support-tickets/report"),
    staticItem("support_ticket_write", "Support ticket write API", true, "/api/admin/flywheel/support-tickets/[ticketId]"),
    staticItem("billing_subscription_write", "Billing subscription write API", true, "/api/admin/flywheel/billing-subscriptions/[companyId]"),
  ];
  return report("창업노트 Ops SaaS readiness", items);
}

export function buildOpsReleaseChecklist(): string {
  const legal = buildOpsLegalReadiness();
  const saas = buildOpsSaasReadiness();
  return [
    "# 창업노트 Ops release checklist",
    "",
    `- generatedAt: ${new Date().toISOString()}`,
    `- legal readiness: ${legal.score}%`,
    `- SaaS readiness: ${saas.score}%`,
    "",
    "## Required Commands",
    "",
    "- pnpm verify:ops-admin",
    "- pnpm verify:admin-routes",
    "- pnpm --filter @cunote/admin typecheck",
    "- pnpm --filter @cunote/admin build",
    "- pnpm typecheck",
    "- pnpm verify:db-migrations",
    "- git diff --check",
    "",
    "## Runtime Env",
    "",
    "- NEXTAUTH_URL or ADMIN_AUTH_URL must be https://ops.changupnote.com",
    "- ADMIN_AUTH_SECRET must be different from the changupnote.com web auth secret",
    "- GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are shared with changupnote.com web login; https://ops.changupnote.com/api/auth/callback/google must be registered as an authorized redirect URI on that same client",
    "- ADMIN_ALLOWED_GOOGLE_DOMAIN must be noten.im",
    "- ADMIN_ALLOWED_EMAILS should list active operators explicitly",
    "",
    "## Cutover Gate",
    "",
    "- ops.changupnote.com Google callback is registered as /api/auth/callback/google",
    "- changupnote.com/admin is closed or redirected only after ops parity is verified",
    "- web session cookie cannot authenticate ops APIs",
    "- ops session cookie cannot authenticate web user APIs",
    "",
  ].join("\n");
}

export function renderOpsReadinessMarkdown(report: OpsReadinessReport): string {
  return [
    `# ${report.title}`,
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- score: ${report.score}%`,
    "",
    "## Items",
    "",
    ...report.items.map((item) => [
      `### ${item.ready ? "READY" : "ATTENTION"} ${item.label}`,
      "",
      `- key: ${item.key}`,
      `- evidence: ${item.evidence}`,
      "",
    ].join("\n")),
  ].join("\n");
}

export function markdownDownloadResponse(input: {
  markdown: string;
  filename: string;
}): Response {
  const encoded = encodeURIComponent(input.filename);
  return new Response(input.markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
      "Cache-Control": "no-store",
    },
  });
}

function report(title: string, items: OpsReadinessItem[]): OpsReadinessReport {
  const readyCount = items.filter((item) => item.ready).length;
  return {
    title,
    score: Math.round((readyCount / items.length) * 100),
    generatedAt: new Date().toISOString(),
    items,
  };
}

function envItem(key: string, label: string, envName: string, value: string | undefined): OpsReadinessItem {
  return {
    key,
    label,
    ready: Boolean(value),
    evidence: value ? `${envName}=set` : `${envName}=missing`,
  };
}

function staticItem(key: string, label: string, ready: boolean, evidence: string): OpsReadinessItem {
  return { key, label, ready, evidence };
}
