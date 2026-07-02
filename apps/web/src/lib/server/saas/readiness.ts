import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildLegalReadiness } from "@/lib/server/legal/legalReadiness";

export type SaasReadinessStatus = "ready" | "attention";

export interface SaasReadinessItem {
  key: string;
  label: string;
  description: string;
  status: SaasReadinessStatus;
  evidence: string[];
  missing: string[];
}

export interface SaasReadinessSection {
  key: string;
  label: string;
  status: SaasReadinessStatus;
  readyCount: number;
  totalCount: number;
  items: SaasReadinessItem[];
}

export interface SaasReadiness {
  status: SaasReadinessStatus;
  score: number;
  readyCount: number;
  totalCount: number;
  sections: SaasReadinessSection[];
  missingKeys: string[];
}

interface ReadinessRequirement {
  key: string;
  label: string;
  description: string;
  pages?: string[];
  apiRoutes?: string[];
  env?: string[];
  verifierScripts?: string[];
}

interface ReadinessSectionSpec {
  key: string;
  label: string;
  items: ReadinessRequirement[];
}

const WORKSPACE_ROOT = process.cwd();
const APP_ROOT = resolve(WORKSPACE_ROOT, "apps/web/src/app");
const ADMIN_APP_ROOT = resolve(WORKSPACE_ROOT, "apps/admin/src/app");

const SAAS_SECTIONS: ReadinessSectionSpec[] = [
  {
    key: "public_trust",
    label: "공개 신뢰 흐름",
    items: [
      {
        key: "landing_entry",
        label: "랜딩과 매칭 프리뷰",
        description: "방문자가 서비스 가치와 사업자번호 기반 매칭 진입점을 확인한다.",
        pages: ["/", "/matches", "/login"],
        apiRoutes: ["/api/web/teaser", "/api/web/stats"],
        verifierScripts: ["verify:web-regions", "verify:landing-grants"],
      },
      {
        key: "legal_pages",
        label: "약관/개인정보/지원 창구",
        description: "비로그인 방문자가 TOS, 개인정보 처리방침, 고객지원 창구를 직접 확인한다.",
        pages: ["/terms", "/privacy", "/support"],
        verifierScripts: ["verify:legal-readiness"],
      },
    ],
  },
  {
    key: "activation",
    label: "가입과 온보딩",
    items: [
      {
        key: "auth_register_reset",
        label: "회원가입/비밀번호 재설정",
        description: "이메일 회원가입, 법무 동의 gate, 비밀번호 재설정 화면과 API가 연결되어 있다.",
        pages: ["/forgot-password", "/reset-password"],
        apiRoutes: [
          "/api/web/auth/register",
          "/api/web/auth/password-reset/request",
          "/api/web/auth/password-reset/confirm",
        ],
        verifierScripts: ["verify:app-auth", "verify:outbound-email", "verify:password-reset-email-handoff"],
      },
      {
        key: "onboarding_company",
        label: "첫 회사 생성과 설정 완료도",
        description: "회사 없는 사용자가 온보딩에서 회사를 만들고 설정 상태를 확인한다.",
        pages: ["/onboarding", "/settings"],
        apiRoutes: ["/api/web/companies", "/api/web/companies/verify", "/api/web/consents"],
        verifierScripts: ["verify:company-access", "verify:consent-store", "verify:settings-report"],
      },
    ],
  },
  {
    key: "core_workflow",
    label: "핵심 사용 흐름",
    items: [
      {
        key: "dashboard_and_roadmap",
        label: "기회 맵과 로드맵",
        description: "사용자가 현재 기회와 곧 열릴 기회를 확인하고 프로필 보강으로 이어진다.",
        pages: ["/dashboard", "/roadmap"],
        apiRoutes: ["/api/web/dashboard", "/api/web/roadmap", "/api/web/profile/field"],
        verifierScripts: ["verify:dashboard-report", "verify:service-data"],
      },
      {
        key: "grant_preparation",
        label: "공고 상세와 신청 준비",
        description: "공고 상세, 제출서류 taxonomy, 초안 생성, 패키지 내보내기가 연결되어 있다.",
        pages: ["/grants/[grantId]"],
        apiRoutes: [
          "/api/web/grants/[grantId]",
          "/api/web/grants/[grantId]/preparation",
          "/api/web/grants/[grantId]/drafts",
          "/api/web/grants/[grantId]/package",
          "/api/web/document-drafts/[draftId]",
          "/api/web/document-drafts/[draftId]/download",
          "/api/web/document-drafts/[draftId]/regenerate",
          "/api/web/document-drafts/[draftId]/feedback",
        ],
        verifierScripts: [
          "verify:grant-document-taxonomy",
          "verify:grant-document-fields",
          "verify:grant-document-drafts",
          "verify:document-draft-html-export",
          "verify:grant-document-draft-metrics",
        ],
      },
      {
        key: "application_pipeline",
        label: "신청 파이프라인",
        description: "저장/준비/제출/결과 관리와 캘린더·리포트 export가 연결되어 있다.",
        pages: ["/applications"],
        apiRoutes: [
          "/api/web/applications/report",
          "/api/web/applications/calendar",
          "/api/web/applications/[grantId]/calendar",
          "/api/web/matches/[grantId]/feedback",
        ],
        verifierScripts: [
          "verify:application-calendar-subscription",
          "verify:application-reminder-email-handoff",
          "verify:match-feedback-loop",
        ],
      },
    ],
  },
  {
    key: "workspace_operations",
    label: "워크스페이스 운영",
    items: [
      {
        key: "team_management",
        label: "팀과 권한",
        description: "팀 초대, 수락, 재발행, 철회, 역할 변경, 좌석 제한이 하나의 화면에서 이어진다.",
        pages: ["/team", "/team/invite/[token]"],
        apiRoutes: [
          "/api/web/team/invitations",
          "/api/web/team/invitations/accept",
          "/api/web/team/invitations/[invitationId]/resend",
          "/api/web/team/invitations/[invitationId]",
          "/api/web/team/members/[userId]",
        ],
        verifierScripts: ["verify:team-seat-limit", "verify:team-operations-report", "verify:outbound-email", "verify:team-invitation-email-handoff"],
      },
      {
        key: "account_settings",
        label: "계정/설정/알림",
        description: "계정 프로필, 비밀번호, 데이터 export, 삭제 요청, 알림센터 receipt가 연결되어 있다.",
        pages: ["/account", "/settings"],
        apiRoutes: [
          "/api/web/account/profile",
          "/api/web/account/password",
          "/api/web/account/export",
          "/api/web/account/deletion-request",
          "/api/web/notification-feed",
          "/api/web/notification-feed/receipt",
        ],
        verifierScripts: [
          "verify:account-security-report",
          "verify:account-deletion-email-handoff",
          "verify:notification-center-report",
        ],
      },
    ],
  },
  {
    key: "commercial_operations",
    label: "상업 운영",
    items: [
      {
        key: "billing_surface",
        label: "플랜/청구/증빙",
        description: "플랜 전환 요청, 구독 상태, 청구 프로필, 증빙, 영수증 기록이 같은 청구 화면으로 모인다.",
        pages: ["/billing"],
        apiRoutes: [
          "/api/web/billing/plan-request",
          "/api/web/billing/statement",
          "/api/web/billing/tax-profile",
          "/api/web/billing/tax-documents",
          "/api/web/billing/invoices/[invoiceId]/receipt",
        ],
        verifierScripts: [
          "verify:billing-payment-instructions",
          "verify:billing-webhook",
          "verify:billing-invoice-email-handoff",
          "verify:billing-plan-request-email-handoff",
        ],
      },
      {
        key: "support_loop",
        label: "고객지원 루프",
        description: "문의 접수, 답장, 첨부, transcript, 사용자 해결/재오픈이 연결되어 있다.",
        pages: ["/support", "/account"],
        apiRoutes: [
          "/api/web/support/tickets",
          "/api/web/support/tickets/[ticketId]",
          "/api/web/support/tickets/[ticketId]/messages",
          "/api/web/support/tickets/[ticketId]/attachments",
          "/api/web/support/tickets/[ticketId]/transcript",
        ],
        verifierScripts: [
          "verify:support-ticket-intake-email-handoff",
          "verify:support-ticket-transcript",
          "verify:admin-support-email-handoff",
        ],
      },
    ],
  },
  {
    key: "admin_operations",
    label: "운영 콘솔",
    items: [
      {
        key: "admin_flywheel",
        label: "플라이휠 운영 콘솔",
        description: "운영팀이 ops.changupnote.com 전용 세션으로 추출/피드백/고객지원/청구/provider 이벤트를 같은 콘솔에서 본다.",
        pages: ["https://ops.changupnote.com/"],
        apiRoutes: [
          "https://ops.changupnote.com/api/admin/status",
          "https://ops.changupnote.com/api/admin/flywheel",
          "https://ops.changupnote.com/api/admin/flywheel/support-tickets/report",
          "https://ops.changupnote.com/api/admin/flywheel/support-tickets/[ticketId]",
          "https://ops.changupnote.com/api/admin/flywheel/billing-subscriptions/[companyId]",
        ],
        verifierScripts: [
          "verify:admin-routes",
          "verify:ops-admin",
          "verify:admin-support-report",
          "verify:admin-review-queue",
          "verify:admin-matching-eval",
          "verify:saas-release-checklist",
        ],
      },
      {
        key: "legal_readiness",
        label: "운영 법무 readiness",
        description: "배포 환경의 운영자/문의처/정책 버전/수탁사/국외이전 설정 확정 여부를 확인한다.",
        env: ["CUNOTE_LEGAL_OPERATOR_NAME", "CUNOTE_SUPPORT_EMAIL", "CUNOTE_PRIVACY_EMAIL"],
        verifierScripts: ["verify:legal-readiness", "verify:saas-readiness", "verify:saas-release-checklist"],
      },
    ],
  },
];

export function buildSaasReadiness(env: NodeJS.ProcessEnv = process.env): SaasReadiness {
  const legalReadiness = buildLegalReadiness(env);
  const sections = SAAS_SECTIONS.map((section) => {
    const items = section.items.map((item) => buildReadinessItem(item, legalReadiness.status, env));
    const readyCount = items.filter((item) => item.status === "ready").length;
    return {
      key: section.key,
      label: section.label,
      status: readyCount === items.length ? "ready" : "attention",
      readyCount,
      totalCount: items.length,
      items,
    } satisfies SaasReadinessSection;
  });
  const readyCount = sections.reduce((sum, section) => sum + section.readyCount, 0);
  const totalCount = sections.reduce((sum, section) => sum + section.totalCount, 0);
  const missingKeys = sections.flatMap((section) =>
    section.items.flatMap((item) => item.missing.map((missing) => `${section.key}.${item.key}:${missing}`))
  );
  return {
    status: readyCount === totalCount ? "ready" : "attention",
    score: totalCount > 0 ? Math.round((readyCount / totalCount) * 100) : 100,
    readyCount,
    totalCount,
    sections,
    missingKeys,
  };
}

function buildReadinessItem(
  requirement: ReadinessRequirement,
  legalStatus: SaasReadinessStatus,
  env: NodeJS.ProcessEnv,
): SaasReadinessItem {
  const pageChecks = (requirement.pages ?? []).map((page) => ({
    label: `page:${page}`,
    ok: pageExists(page),
  }));
  const apiChecks = (requirement.apiRoutes ?? []).map((route) => ({
    label: `api:${route}`,
    ok: apiRouteExists(route),
  }));
  const envChecks = (requirement.env ?? []).map((key) => ({
    label: `env:${key}`,
    ok: Boolean(env[key]?.trim()),
  }));
  const verifierScriptChecks = (requirement.verifierScripts ?? []).map((script) => ({
    label: `script:${script}`,
    ok: packageScriptExists(script),
  }));
  const verifierTestChecks = (requirement.verifierScripts ?? []).map((script) => ({
    label: `test:${script}`,
    ok: packageTestIncludesScript(script),
  }));
  const legalChecks = requirement.key === "legal_readiness"
    ? [{ label: "legal:readiness", ok: legalStatus === "ready" }]
    : [];
  const checks = [...pageChecks, ...apiChecks, ...envChecks, ...verifierScriptChecks, ...verifierTestChecks, ...legalChecks];
  const missing = checks.filter((check) => !check.ok).map((check) => check.label);
  return {
    key: requirement.key,
    label: requirement.label,
    description: requirement.description,
    status: missing.length === 0 ? "ready" : "attention",
    evidence: checks.filter((check) => check.ok).map((check) => check.label),
    missing,
  };
}

function pageExists(route: string): boolean {
  return routeCandidateRoots(route).some((root) => existsSync(resolve(root, "page.tsx")));
}

function apiRouteExists(route: string): boolean {
  const appRoot = route.startsWith("https://ops.changupnote.com") ? ADMIN_APP_ROOT : APP_ROOT;
  return existsSync(resolve(appRoot, routePathToSegments(route).join("/"), "route.ts"));
}

function packageScriptExists(script: string): boolean {
  return Boolean(readPackageScripts()[script]);
}

function packageTestIncludesScript(script: string): boolean {
  return readPackageScripts().test?.includes(`pnpm ${script}`) ?? false;
}

let packageScriptsCache: Record<string, string> | null = null;

function readPackageScripts(): Record<string, string> {
  if (packageScriptsCache) return packageScriptsCache;
  try {
    const parsed = JSON.parse(readFileSync(resolve(WORKSPACE_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    packageScriptsCache = Object.fromEntries(
      Object.entries(parsed.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    packageScriptsCache = {};
  }
  return packageScriptsCache;
}

function routeCandidateRoots(route: string): string[] {
  if (route.startsWith("https://ops.changupnote.com")) {
    return [resolve(ADMIN_APP_ROOT, routePathToSegments(route).join("/"))];
  }
  const relativePath = routePathToSegments(route).join("/");
  const candidates = [resolve(APP_ROOT, relativePath)];
  try {
    for (const entry of readdirSync(APP_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("(") && entry.name.endsWith(")")) {
        candidates.push(resolve(APP_ROOT, entry.name, relativePath));
      }
    }
  } catch {
    return candidates;
  }
  return candidates;
}

function routePathToSegments(route: string): string[] {
  if (route.startsWith("http://") || route.startsWith("https://")) {
    try {
      return new URL(route).pathname.split("/").filter(Boolean);
    } catch {
      return [];
    }
  }
  return route.split("/").filter(Boolean);
}
