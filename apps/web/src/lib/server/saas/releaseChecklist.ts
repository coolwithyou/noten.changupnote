import type { LegalReadiness } from "@/lib/server/legal/legalReadiness";
import type { SaasReadiness } from "./readiness";

export interface SaasReleaseChecklist {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

export interface SaasReleaseRuntimeSnapshot {
  repositoryAdapter: string;
  webDataSource: string;
  authRequired: boolean;
  authMode: string;
  authProviders: string[];
  databaseConfigured: boolean;
}

interface ReleaseCommand {
  command: string;
  purpose: string;
  required: boolean;
}

const RELEASE_COMMANDS: ReleaseCommand[] = [
  {
    command: "pnpm typecheck",
    purpose: "contracts/core/web TypeScript 경계를 확인합니다.",
    required: true,
  },
  {
    command: "pnpm verify:route-policy",
    purpose: "공개/세션/앱 라우트 보호 정책 drift를 확인합니다.",
    required: true,
  },
  {
    command: "pnpm verify:openapi",
    purpose: "앱 API 계약 산출물과 OpenAPI 스키마를 확인합니다.",
    required: true,
  },
  {
    command: "pnpm verify:legal-readiness",
    purpose: "운영 법무 환경값과 공개 문서 readiness 경계를 확인합니다.",
    required: true,
  },
  {
    command: "pnpm verify:saas-readiness",
    purpose: "MVP route/API/verifier/test-chain evidence를 확인합니다.",
    required: true,
  },
  {
    command: "pnpm verify:outbound-email",
    purpose: "운영 이메일 webhook adapter와 실패 처리를 확인합니다.",
    required: true,
  },
  {
    command: "CUNOTE_HTTP_VERIFY_BASE_URL=http://127.0.0.1:4010 pnpm verify:web-http",
    purpose: "로컬 dev 서버 기준 사용자/앱/admin 주요 HTTP 흐름을 확인합니다.",
    required: true,
  },
  {
    command: "pnpm build:web",
    purpose: "Next production build와 route compilation을 확인합니다.",
    required: true,
  },
  {
    command: "git diff --check",
    purpose: "공백/줄끝 오류를 확인합니다.",
    required: true,
  },
];

export function buildSaasReleaseChecklist(input: {
  legalReadiness: LegalReadiness;
  saasReadiness: SaasReadiness;
  runtime?: SaasReleaseRuntimeSnapshot;
  generatedAt?: Date;
}): SaasReleaseChecklist {
  const generatedAt = input.generatedAt ?? new Date();
  const stamp = generatedAt.toISOString().slice(0, 10);
  return {
    filename: `창업노트-SaaS-release-checklist-${stamp}.md`,
    fallbackFilename: `cunote-saas-release-checklist-${stamp}.md`,
    markdown: renderSaasReleaseChecklist({
      legalReadiness: input.legalReadiness,
      saasReadiness: input.saasReadiness,
      ...(input.runtime ? { runtime: input.runtime } : {}),
      generatedAt,
    }),
  };
}

export function renderSaasReleaseChecklist(input: {
  legalReadiness: LegalReadiness;
  saasReadiness: SaasReadiness;
  runtime?: SaasReleaseRuntimeSnapshot;
  generatedAt?: Date;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const lines = [
    "# 창업노트 SaaS release checklist",
    "",
    `- 생성 시각: ${formatDateTime(generatedAt)}`,
    `- SaaS readiness: ${input.saasReadiness.status} · ${input.saasReadiness.score}% · ${input.saasReadiness.readyCount}/${input.saasReadiness.totalCount}`,
    `- Legal readiness: ${input.legalReadiness.statusLabel} · ${input.legalReadiness.score}% · ${input.legalReadiness.configuredCount}/${input.legalReadiness.requiredCount}`,
    "",
    "## Release Gate",
    "",
    ...releaseGateLines(input),
    "",
    "## Required Commands",
    "",
    "| Command | Required | Purpose |",
    "| --- | --- | --- |",
    ...RELEASE_COMMANDS.map((command) => commandRow(command)),
    "",
    "## Execution Evidence",
    "",
    "| Command | Result | Started At | Finished At | Notes |",
    "| --- | --- | --- | --- | --- |",
    ...RELEASE_COMMANDS.map((command) => evidenceRow(command)),
    "",
    "## Runtime Snapshot",
    "",
    ...runtimeSnapshotLines(input.runtime),
    "",
    "## Readiness Missing Keys",
    "",
    ...missingLines(input.saasReadiness.missingKeys, "SaaS readiness 기준 누락 항목이 없습니다."),
    "",
    "## Legal Missing Keys",
    "",
    ...missingLines(input.legalReadiness.missingKeys, "운영 법무 readiness 기준 누락 환경값이 없습니다."),
    "",
    "## Operator Notes",
    "",
    "- `verify:web-http`는 dev server가 떠 있는 상태에서 실행합니다.",
    "- `pnpm build:web` 이후 `apps/web/next-env.d.ts`가 production route type으로 바뀌면 개발 워크트리에서는 dev route type 참조로 복구합니다.",
    "- HWP markdown Turbopack NFT 경고는 알려진 경고입니다. 새 경고나 실패가 추가되면 별도 이슈로 분리합니다.",
    "",
    "## Sign-off",
    "",
    "- 배포 담당자:",
    "- 검토자:",
    "- 배포 창:",
    "- 승인 여부: pending",
    "",
    "## Rollback Gate",
    "",
    "- 사용자 인증, 회사 접근권한, 결제/고객지원/문서 다운로드 중 하나라도 release 후 smoke에서 실패하면 rollback 또는 feature flag off를 우선 검토합니다.",
    "- 데이터 migration이 포함된 경우 rollback 전 DB backup, migration id, affected table을 먼저 기록합니다.",
    "",
  ];

  return `${lines.join("\n").trim()}\n`;
}

function releaseGateLines(input: {
  legalReadiness: LegalReadiness;
  saasReadiness: SaasReadiness;
}): string[] {
  const blocking: string[] = [];
  if (input.saasReadiness.status !== "ready") {
    blocking.push(`SaaS readiness attention: ${input.saasReadiness.missingKeys.slice(0, 5).join(", ")}`);
  }
  if (input.legalReadiness.status !== "ready") {
    blocking.push(`Legal readiness attention: ${input.legalReadiness.missingKeys.slice(0, 5).join(", ")}`);
  }
  if (blocking.length === 0) {
    return [
      "- status: ready",
      "- 배포 전 required commands를 현재 워크트리와 배포 환경값 기준으로 다시 실행합니다.",
    ];
  }
  return [
    "- status: attention",
    ...blocking.map((item) => `- ${item}`),
  ];
}

function commandRow(command: ReleaseCommand): string {
  return [
    escapeCell(`\`${command.command}\``),
    command.required ? "yes" : "no",
    escapeCell(command.purpose),
  ].join(" | ").replace(/^/, "| ").concat(" |");
}

function evidenceRow(command: ReleaseCommand): string {
  return [
    escapeCell(`\`${command.command}\``),
    "pending",
    "",
    "",
    "",
  ].join(" | ").replace(/^/, "| ").concat(" |");
}

function runtimeSnapshotLines(runtime?: SaasReleaseRuntimeSnapshot): string[] {
  if (!runtime) return ["- runtime snapshot: unavailable"];
  return [
    `- repository adapter: ${runtime.repositoryAdapter}`,
    `- web data source: ${runtime.webDataSource}`,
    `- auth required: ${runtime.authRequired ? "true" : "false"}`,
    `- auth mode: ${runtime.authMode}`,
    `- auth providers: ${runtime.authProviders.length > 0 ? runtime.authProviders.join(", ") : "none"}`,
    `- database configured: ${runtime.databaseConfigured ? "true" : "false"}`,
  ];
}

function missingLines(values: string[], emptyMessage: string): string[] {
  if (values.length === 0) return [emptyMessage];
  return values.map((value) => `- ${value}`);
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(value);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
