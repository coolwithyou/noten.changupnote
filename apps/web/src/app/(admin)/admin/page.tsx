import { Download } from "lucide-react";
import { getOptionalAdminAccess } from "@/lib/server/auth/adminGuard";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";
import { MetricCard } from "@/components/app/metric-card";
import { ServiceHeader } from "@/components/app/service-header";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { AdminSupportTicketPanel } from "@/features/admin/AdminSupportTicketPanel";
import {
  getAdminFlywheelSnapshot,
  type AdminFlywheelSnapshot,
} from "@/lib/server/admin/flywheelStore";
import {
  getAdminRuntimeStatus,
  type AdminRuntimeStatus,
} from "@/lib/server/admin/runtimeStatus";
import { loadDueMatchTransitionPlan } from "@/lib/server/matches/transitionPlan";
import type {
  MatchTransitionAction,
  MatchTransitionPlan,
} from "@cunote/core";

export const dynamic = "force-dynamic";

const SURFACES: Array<{
  key: keyof AdminFlywheelSnapshot["counts"];
  title: string;
  body: string;
}> = [
  {
    key: "extractionLog",
    title: "extraction_log",
    body: "추출 이력과 confidence 리뷰 큐",
  },
  {
    key: "feedback",
    title: "feedback",
    body: "사용자 명시 피드백과 outcome 신호",
  },
  {
    key: "reviewQueue",
    title: "review_queue",
    body: "오류/막힘 피드백 기반 매칭 보정 후보",
  },
  {
    key: "matchEvents",
    title: "match_events",
    body: "노출, 저장, 신청 클릭 행동 신호",
  },
  {
    key: "goldenSet",
    title: "golden_set",
    body: "추출/매칭 정답 기준셋",
  },
  {
    key: "evalRuns",
    title: "eval_runs",
    body: "버전별 회귀 평가 결과",
  },
  {
    key: "grantInsightSnapshots",
    title: "grant_insight_snapshots",
    body: "지원사업 아카이브 커버리지와 운영 인사이트",
  },
  {
    key: "grantAttachmentArchives",
    title: "grant_attachment_archives",
    body: "첨부 원본 R2 보관본과 HWP Markdown 변환 상태",
  },
  {
    key: "grantDocumentDrafts",
    title: "grant_document_drafts",
    body: "지원서 초안 저장본과 자동채움 준비 상태",
  },
  {
    key: "grantDocumentDraftQualityEvents",
    title: "grant_document_draft_quality_events",
    body: "초안 품질 피드백과 개선 신호",
  },
  {
    key: "supportTickets",
    title: "support_tickets",
    body: "고객지원 문의와 운영 응답 큐",
  },
  {
    key: "billingSubscriptions",
    title: "billing_subscriptions",
    body: "회사별 구독 상태와 provider 전환 상태",
  },
  {
    key: "billingTaxProfiles",
    title: "billing_tax_profiles",
    body: "청구 담당자와 세금계산서 수신 정보",
  },
  {
    key: "billingTaxDocuments",
    title: "billing_tax_documents",
    body: "청구 증빙 파일 R2 보관 상태",
  },
  {
    key: "billingInvoices",
    title: "billing_invoices",
    body: "provider 청구서와 영수증 projection",
  },
  {
    key: "billingPaymentMethods",
    title: "billing_payment_methods",
    body: "provider 결제수단 표시용 snapshot",
  },
  {
    key: "billingWebhookEvents",
    title: "billing_webhook_events",
    body: "결제 provider webhook 수신과 처리 결과",
  },
];

export default async function AdminPage() {
  const access = await getOptionalAdminAccess();
  const runtime = access ? getAdminRuntimeStatus() : null;
  const [snapshot, transitionPlan] = access
    ? await Promise.all([loadSnapshot(), loadTransitionPlan()])
    : [null, null];
  const user = await getOptionalHeaderUser();

  return (
    <main className="admin-shell">
      <ServiceHeader
        user={user}
        links={[
          { href: "/dashboard", label: "기회 맵" },
          { href: "/internal/live-match", label: "내부 검증" },
        ]}
      />

      <section className="admin-hero">
        <p className="eyebrow">Admin</p>
        <h1>플라이휠 운영 콘솔</h1>
        <p>라벨링, 골든셋, 평가 리포트가 붙을 어드민 경계입니다.</p>
      </section>

      {access ? (
        <>
          {runtime ? <RuntimePanel runtime={runtime} /> : null}
          {runtime ? <SaasReadinessPanel readiness={runtime.saasReadiness} /> : null}
          <TransitionPanel plan={transitionPlan} />

          <section className="admin-grid">
            {SURFACES.map((item) => (
              <MetricCard
                className="admin-panel"
                key={item.title}
                label={item.title}
                value={snapshot ? snapshot.counts[item.key].toLocaleString("ko-KR") : "대기"}
                detail={item.body}
              />
            ))}
          </section>

          <Card className="admin-panel admin-feed">
            <StatusBadge tone="neutral">{snapshot ? formatTimestamp(snapshot.generatedAt) : "대기"}</StatusBadge>
            <h2>최근 플라이휠 이벤트</h2>
            {snapshot ? (
              <div className="admin-feed-grid">
                <RecentList
                  title="extraction"
                  items={snapshot.recent.extractionLog.map((item) => `${item.status} · ${item.inputRef}`)}
                />
                <RecentList
                  title="feedback"
                  items={snapshot.recent.feedback.map((item) =>
                    [
                      item.type,
                      item.kind ?? "kind?",
                      item.outcome ?? item.reasonCode ?? "signal",
                      item.hasCorrection ? "correction" : null,
                      `${item.targetType}:${item.targetId}`,
                    ].filter(Boolean).join(" · ")
                  )}
                />
                <RecentList
                  title="review"
                  items={snapshot.recent.reviewQueue.map((item) =>
                    [
                      item.priority,
                      item.reasonCode ?? item.kind ?? "review",
                      item.correction?.dimension ?? "match",
                      item.goldenCandidate?.ready ? "golden-ready" : "needs-label",
                      item.grantId ?? item.targetId,
                    ].filter(Boolean).join(" · ")
                  )}
                />
                <RecentList
                  title="events"
                  items={snapshot.recent.matchEvents.map((item) => `${item.event} · ${item.rulesetVer} · ${item.grantId}`)}
                />
                <RecentList
                  title="golden"
                  items={snapshot.recent.goldenSet.map((item) => `${item.kind} · ${item.goldenVer}`)}
                />
                <RecentList
                  title="eval"
                  items={snapshot.recent.evalRuns.map((item) =>
                    [
                      item.target,
                      item.goldenVer,
                      item.accuracy === null ? null : `acc ${formatPercent(item.accuracy)}`,
                      item.coverage === null ? null : `coverage ${formatPercent(item.coverage)}`,
                      item.evaluable === null ? null : `${item.evaluable} eval`,
                    ].filter(Boolean).join(" · ")
                  )}
                />
                <RecentList
                  title="insights"
                  items={snapshot.recent.grantInsightSnapshots.map((item) => `${item.kind} · ${item.insightCount} signals`)}
                />
                <RecentList
                  title="attachments"
                  items={snapshot.recent.grantAttachmentArchives.map((item) => `${item.conversionStatus ?? "archived"} · ${item.filename}`)}
                />
                <RecentList
                  title="drafts"
                  items={snapshot.recent.grantDocumentDrafts.map((item) =>
                    `${item.status} · ${item.documentName} · 입력필요 ${item.missingFieldCount} · 자동채움 ${item.filledFieldCount}`
                  )}
                />
                <RecentList
                  title="draft feedback"
                  items={snapshot.recent.grantDocumentDraftQualityEvents.map((item) =>
                    `${item.kind ?? "unknown"} · ${item.documentName ?? "document?"} · ${item.status ?? "status?"}`
                  )}
                />
                <RecentList
                  title="billing"
                  items={snapshot.recent.billingSubscriptions.map((item) =>
                    `${item.statusLabel} · ${item.planName} · ${item.providerLabel} · ${item.companyName}`
                  )}
                />
                <RecentList
                  title="tax"
                  items={snapshot.recent.billingTaxProfiles.map((item) =>
                    `${item.taxInvoiceEnabled ? "tax-on" : "tax-off"} · ${item.taxInvoiceEmail ?? item.recipientEmail ?? "email?"} · ${item.companyName}`
                  )}
                />
                <RecentList
                  title="tax docs"
                  items={snapshot.recent.billingTaxDocuments.map((item) =>
                    `${item.statusLabel} · ${item.documentKindLabel} · ${item.filename} · ${item.companyName}`
                  )}
                />
                <RecentList
                  title="invoices"
                  items={snapshot.recent.billingInvoices.map((item) =>
                    `${item.statusLabel} · ${formatMoney(item.amountPaid || item.amountDue, item.currency)} · ${item.companyName}`
                  )}
                />
                <RecentList
                  title="payment"
                  items={snapshot.recent.billingPaymentMethods.map((item) =>
                    `${item.statusLabel} · ${item.displayLabel} · ${item.companyName}`
                  )}
                />
                <RecentList
                  title="webhooks"
                  items={snapshot.recent.billingWebhookEvents.map((item) =>
                    `${item.processingStatus} · ${item.provider} · ${item.eventType}`
                  )}
                />
                <AdminSupportTicketPanel tickets={snapshot.recent.supportTickets} />
              </div>
            ) : (
              <Empty>
                <EmptyDescription>DB 연결 전에는 카운트와 최근 항목을 대기 상태로 표시합니다.</EmptyDescription>
              </Empty>
            )}
          </Card>
        </>
      ) : (
        <Card className="admin-panel admin-denied">
          <StatusBadge tone="danger">403</StatusBadge>
          <h2>어드민 접근 권한 필요</h2>
          <p>현재 세션에는 어드민 role이 없습니다.</p>
        </Card>
      )}
    </main>
  );
}

function RuntimePanel({ runtime }: { runtime: AdminRuntimeStatus }) {
  const rows = [
    ["repository", runtime.repositoryAdapter],
    ["data source", runtime.webDataSource],
    ["auth required", runtime.authRequired ? "true" : "false"],
    ["auth mode", runtime.authMode],
    ["providers", runtime.authProviders.length > 0 ? runtime.authProviders.join(", ") : "none"],
    ["database", runtime.databaseConfigured ? "configured" : "missing"],
    ["SaaS readiness", `${runtime.saasReadiness.score}% · ${runtime.saasReadiness.readyCount}/${runtime.saasReadiness.totalCount}`],
    ["SaaS missing", runtime.saasReadiness.missingKeys.length > 0 ? runtime.saasReadiness.missingKeys.slice(0, 4).join(", ") : "none"],
    ["legal readiness", `${runtime.legalReadiness.score}% · ${runtime.legalReadiness.statusLabel}`],
    ["legal missing", runtime.legalReadiness.missingKeys.length > 0 ? runtime.legalReadiness.missingKeys.join(", ") : "none"],
  ] as const;

  return (
    <Card className="admin-panel admin-runtime">
      <StatusBadge tone={runtime.saasReadiness.status === "ready" ? "success" : "warning"}>runtime</StatusBadge>
      <h2>실행 구성</h2>
      <p>{runtime.legalReadiness.summary}</p>
      <div className="admin-readiness-actions">
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/api/admin/status/legal-readiness">
          <Download className="size-3.5" aria-hidden />
          법무 Markdown
        </a>
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/api/admin/status/release-checklist">
          <Download className="size-3.5" aria-hidden />
          Release checklist
        </a>
      </div>
      <Table className="admin-runtime-list">
        <TableBody>
        {rows.map(([label, value]) => (
          <TableRow key={label}>
            <TableCell>{label}</TableCell>
            <TableCell>{value}</TableCell>
          </TableRow>
        ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function SaasReadinessPanel({ readiness }: { readiness: AdminRuntimeStatus["saasReadiness"] }) {
  return (
    <Card className="admin-panel admin-readiness">
      <StatusBadge tone={readiness.status === "ready" ? "success" : "warning"}>
        SaaS readiness {readiness.score}%
      </StatusBadge>
      <h2>SaaS MVP readiness</h2>
      <p>
        완결형 SaaS 흐름을 공개 신뢰, 가입/온보딩, 핵심 사용, 워크스페이스, 상업 운영, 운영 콘솔 기준으로 점검합니다.
      </p>
      <div className="admin-readiness-actions">
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/api/admin/status/saas-readiness">
          <Download className="size-3.5" aria-hidden />
          Markdown
        </a>
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/api/admin/status/release-checklist">
          <Download className="size-3.5" aria-hidden />
          Release checklist
        </a>
      </div>
      <div className="admin-readiness-sections">
        {readiness.sections.map((section) => (
          <section className="admin-readiness-section" key={section.key}>
            <div className="admin-readiness-section-head">
              <div>
                <span>{section.key}</span>
                <h3>{section.label}</h3>
              </div>
              <StatusBadge tone={section.status === "ready" ? "success" : "warning"}>
                {section.readyCount}/{section.totalCount}
              </StatusBadge>
            </div>
            <ul>
              {section.items.map((item) => (
                <li key={item.key}>
                  <div>
                    <strong>{item.label}</strong>
                    <p>{item.description}</p>
                    <small>{readinessEvidenceSummary(item.evidence, item.missing)}</small>
                    {item.missing.length > 0 ? (
                      <small>missing: {item.missing.slice(0, 3).join(", ")}</small>
                    ) : (
                      <small>evidence: {item.evidence.slice(0, 3).join(", ")}</small>
                    )}
                  </div>
                  <StatusBadge tone={item.status === "ready" ? "success" : "warning"}>
                    {item.status}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Card>
  );
}

function readinessEvidenceSummary(evidence: string[], missing: string[]): string {
  const signals = [...evidence, ...missing];
  const counts = {
    page: countSignals(signals, "page:"),
    api: countSignals(signals, "api:"),
    script: countSignals(signals, "script:"),
    test: countSignals(signals, "test:"),
    env: countSignals(signals, "env:"),
  };
  const parts = [
    counts.page > 0 ? `페이지 ${counts.page}` : null,
    counts.api > 0 ? `API ${counts.api}` : null,
    counts.script > 0 ? `검증 스크립트 ${counts.script}` : null,
    counts.test > 0 ? `검증 체인 ${counts.test}` : null,
    counts.env > 0 ? `환경값 ${counts.env}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "증거 없음";
}

function countSignals(signals: string[], prefix: string): number {
  return signals.filter((signal) => signal.startsWith(prefix)).length;
}

async function loadSnapshot(): Promise<AdminFlywheelSnapshot | null> {
  try {
    return await getAdminFlywheelSnapshot();
  } catch {
    return null;
  }
}

async function loadTransitionPlan(): Promise<MatchTransitionPlan | null> {
  try {
    return await loadDueMatchTransitionPlan({ limit: 10 });
  } catch {
    return null;
  }
}

function TransitionPanel({ plan }: { plan: MatchTransitionPlan | null }) {
  const total = plan
    ? plan.counts.becomes_eligible + plan.counts.becomes_ineligible
    : null;

  return (
    <Card className="admin-panel admin-transitions">
      <StatusBadge tone="neutral">{total === null ? "대기" : `${total.toLocaleString("ko-KR")}건`}</StatusBadge>
      <h2>상태 전이 예정</h2>
      {plan ? (
        <>
          <div className="admin-transition-counts">
            <strong>해금 {plan.counts.becomes_eligible.toLocaleString("ko-KR")}</strong>
            <strong>마감 {plan.counts.becomes_ineligible.toLocaleString("ko-KR")}</strong>
            <time dateTime={plan.asOf}>{formatTimestamp(plan.asOf)}</time>
          </div>
          {plan.transitions.length > 0 ? (
            <ul className="admin-transition-list">
              {plan.transitions.slice(0, 10).map((item) => (
                <TransitionItem item={item} key={`${item.companyId}:${item.grantId}:${item.kind}`} />
              ))}
            </ul>
          ) : (
            <Empty>
              <EmptyDescription>현재 처리할 전이 대상이 없습니다.</EmptyDescription>
            </Empty>
          )}
        </>
      ) : (
        <Empty>
          <EmptyDescription>전이 플랜을 불러오지 못했습니다.</EmptyDescription>
        </Empty>
      )}
    </Card>
  );
}

function TransitionItem({ item }: { item: MatchTransitionAction }) {
  return (
    <li>
      <strong>{transitionLabel(item)}</strong>
      <p>{shortId(item.companyId)} · {shortId(item.grantId)}</p>
      <time dateTime={item.dueAt}>{formatTimestamp(item.dueAt)}</time>
    </li>
  );
}

function transitionLabel(item: MatchTransitionAction): string {
  return item.kind === "becomes_eligible" ? "해금 전이" : "마감 전이";
}

function RecentList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {items.length > 0 ? (
        <ul>
          {items.slice(0, 5).map((item, index) => (
            <li key={`${title}:${index}:${item}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>최근 항목 없음</p>
      )}
    </div>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatMoney(amount: number, currency: string): string {
  const normalizedCurrency = /^[A-Z]{3}$/.test(currency) ? currency : "KRW";
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: normalizedCurrency,
    maximumFractionDigits: normalizedCurrency === "KRW" ? 0 : 2,
  }).format(amount);
}

function shortId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
