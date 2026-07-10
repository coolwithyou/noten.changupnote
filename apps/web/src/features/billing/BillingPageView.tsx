import { Building2, CheckCircle2, CircleAlert, CreditCard, Download, ExternalLink, FileText, LifeBuoy, Mail, ReceiptText, ShieldCheck, Sparkles } from "lucide-react";
import type { BillingReadiness, BillingReadinessItem } from "@/lib/server/billing/billingReadiness";
import type { BillingInvoiceItem } from "@/lib/server/billing/invoices";
import type { BillingPaymentMethodItem } from "@/lib/server/billing/paymentMethods";
import type { BillingPlanRequestHistoryItem } from "@/lib/server/billing/planRequestHistory";
import type { BillingTaxDocumentItem } from "@/lib/server/billing/taxDocuments";
import type { BillingTaxProfileItem } from "@/lib/server/billing/taxProfile";
import type { HeaderUser } from "@/lib/server/auth/session";
import type { WorkspaceOverview, WorkspaceUsageMetric } from "@/lib/server/workspace/overview";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { BillingPlanRequestForm } from "./BillingPlanRequestForm";
import { BillingTaxDocumentsPanel } from "./BillingTaxDocumentsPanel";
import { BillingTaxProfileForm } from "./BillingTaxProfileForm";
import { CreditPlanSection } from "./CreditPlanSection";

export function BillingPageView({
  overview,
  planRequests,
  invoices,
  paymentMethods,
  taxProfile,
  taxDocuments,
  readiness,
  user,
}: {
  overview: WorkspaceOverview;
  planRequests: BillingPlanRequestHistoryItem[];
  invoices: BillingInvoiceItem[];
  paymentMethods: BillingPaymentMethodItem[];
  taxProfile: BillingTaxProfileItem;
  taxDocuments: BillingTaxDocumentItem[];
  readiness: BillingReadiness;
  user: HeaderUser | null;
}) {
  const subscription = overview.billingSubscription;
  const primaryPaymentMethod = paymentMethods.find((method) => method.isDefault) ?? paymentMethods[0] ?? null;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <section className="grid gap-4 rounded-[var(--radius-xl)] border bg-card p-6 shadow-[var(--shadow-subtle)] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div>
          <p className="text-xs font-medium uppercase text-muted-foreground">플랜과 청구</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal sm:text-3xl">{overview.plan.planName} 플랜</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            현재 사용량과 구독 상태를 확인합니다. 결제 수단과 청구서는 provider 연동 상태에 맞춰 표시합니다.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          <a className={buttonVariants({ variant: "secondary" })} href="/api/web/billing/statement">
            <Download data-icon="inline-start" />
            명세서
          </a>
          <a className={buttonVariants({ variant: "outline" })} href="/api/web/billing/payment-instructions">
            <ReceiptText data-icon="inline-start" />
            결제 안내
          </a>
          <a className={buttonVariants()} href="/support">
            <LifeBuoy data-icon="inline-start" />
            플랜 상담
          </a>
          <a className={buttonVariants({ variant: "outline" })} href="/team">
            <ShieldCheck data-icon="inline-start" />
            팀 권한
          </a>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(360px,0.7fr)]">
        <Card>
          <CardHeader>
            <div>
              <span className="text-xs font-medium uppercase text-muted-foreground">현재 플랜</span>
              <h2 className="mt-1 text-lg font-semibold tracking-normal">{overview.plan.planName}</h2>
            </div>
            <StatusBadge tone={subscriptionTone(subscription.status)}>{overview.plan.status}</StatusBadge>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="rounded-[var(--radius-xl)] border bg-muted/30 p-4">
              <strong className="block text-3xl font-semibold tracking-normal">{overview.plan.priceLabel}</strong>
              <span className="mt-1 block text-sm text-muted-foreground">{overview.plan.renewalLabel}</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {overview.plan.included.map((feature) => (
                <span key={feature} className="inline-flex items-center gap-2 rounded-[var(--radius-lg)] border bg-card px-3 py-2 text-sm">
                  <Sparkles className="size-4 text-primary" aria-hidden />
                  {feature}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <span className="text-xs font-medium uppercase text-muted-foreground">청구 상태</span>
              <h2 className="mt-1 text-lg font-semibold tracking-normal">구독 상태</h2>
            </div>
            <CreditCard className="size-5 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent className="grid gap-3">
            <BillingState
              icon={<FileText />}
              title="구독 상태"
              description={`${subscription.statusLabel} · ${subscription.sourceLabel} · ${subscription.providerLabel}`}
            />
            <BillingState icon={<ReceiptText />} title="청구서" description={subscription.invoiceStatusLabel} />
            <BillingState
              icon={<Building2 />}
              title="청구 프로필"
              description={taxProfile.taxInvoiceEnabled ? `세금계산서 수신 정보와 증빙 ${taxDocuments.length}개를 관리합니다.` : "청구 담당자와 수신 정보를 저장할 수 있습니다."}
            />
            <BillingState
              icon={<CreditCard />}
              title="결제 수단"
              description={primaryPaymentMethod ? primaryPaymentMethod.displayLabel : subscription.paymentMethodLabel}
            />
            {subscription.providerPortalUrl ? (
              <BillingState
                icon={<ExternalLink />}
                title="provider 포털"
                description="결제 수단과 청구서를 provider 포털에서 관리할 수 있습니다."
              />
            ) : (
              <BillingState icon={<FileText />} title="계약 전환" description="유료 전환은 지원팀 상담 후 활성화합니다." />
            )}
          </CardContent>
        </Card>
      </section>

      <CreditPlanSection />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="플랜 사용량">
        {overview.usage.map((metric) => (
          <UsageCard key={metric.label} metric={metric} />
        ))}
      </section>

      <Card>
        <CardHeader>
          <div>
            <span className="text-xs font-medium uppercase text-muted-foreground">청구 준비도</span>
            <h2 className="mt-1 text-lg font-semibold tracking-normal">유료 전환 체크</h2>
          </div>
          <StatusBadge tone={readinessTone(readiness.status)}>{readiness.statusLabel}</StatusBadge>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="rounded-[var(--radius-xl)] border bg-muted/30 p-4">
            <strong className="block text-3xl font-semibold tracking-normal">{readiness.score}%</strong>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{readiness.summary}</p>
            <span className="mt-3 block text-xs text-muted-foreground">결제 provider: {readiness.providerLabel}</span>
            <span className="mt-1 block text-xs text-muted-foreground">구독 상태: {subscription.statusLabel}</span>
          </div>
          <div className="grid gap-3">
            {readiness.items.map((item) => (
              <BillingReadinessRow item={item} key={item.key} />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <span className="text-xs font-medium uppercase text-muted-foreground">다음 단계</span>
            <h2 className="mt-1 text-lg font-semibold tracking-normal">유료 플랜 전환 전 확인할 것</h2>
          </div>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm leading-6 text-muted-foreground">
          {overview.plan.nextSteps.map((step) => (
            <p key={step}>{step}</p>
          ))}
        </CardContent>
      </Card>

      <details className="rounded-[var(--radius-xl)] border bg-card shadow-[var(--shadow-subtle)]">
        <summary className="flex cursor-pointer items-center justify-between gap-4 px-5 py-4">
          <span className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase text-muted-foreground">세금계산서</span>
            <strong className="text-sm font-semibold">수신 정보와 증빙 파일</strong>
          </span>
          <StatusBadge tone={taxProfile.taxInvoiceEnabled || taxDocuments.length > 0 ? "brand" : "neutral"}>
            {taxDocuments.length.toLocaleString("ko-KR")}
          </StatusBadge>
        </summary>
        <div className="grid gap-4 border-t p-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <span className="text-xs font-medium uppercase text-muted-foreground">청구 프로필</span>
                <h2 className="mt-1 text-lg font-semibold tracking-normal">세금계산서 수신 정보</h2>
              </div>
              <StatusBadge tone={taxProfile.taxInvoiceEnabled ? "success" : "neutral"}>
                {taxProfile.taxInvoiceEnabled ? "수신" : "미설정"}
              </StatusBadge>
            </CardHeader>
            <CardContent>
              <div className="mb-4 grid gap-2 rounded-[var(--radius-lg)] border border-border bg-muted/30 p-4 text-sm text-muted-foreground md:grid-cols-2">
                <span>상호: <strong className="text-foreground">{taxProfile.businessName ?? "미입력"}</strong></span>
                <span>사업자번호: <strong className="text-foreground">{taxProfile.businessRegistrationNumberMasked ?? "미입력"}</strong></span>
                <span>담당자: <strong className="text-foreground">{taxProfile.recipientName ?? "미입력"}</strong></span>
                <span>세금계산서 이메일: <strong className="text-foreground">{taxProfile.taxInvoiceEmail ?? "미입력"}</strong></span>
              </div>
              <BillingTaxProfileForm
                initialProfile={taxProfile}
                canUpdate={canRequestPlanChange(overview.currentCompany.role)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <span className="text-xs font-medium uppercase text-muted-foreground">청구 증빙</span>
                <h2 className="mt-1 text-lg font-semibold tracking-normal">청구 증빙 파일</h2>
              </div>
              <StatusBadge tone={taxDocuments.length > 0 ? "brand" : "neutral"}>{taxDocuments.length}</StatusBadge>
            </CardHeader>
            <CardContent>
              <BillingTaxDocumentsPanel
                initialDocuments={taxDocuments}
                canUpdate={canRequestPlanChange(overview.currentCompany.role)}
              />
            </CardContent>
          </Card>
        </div>
      </details>

      <details className="rounded-[var(--radius-xl)] border bg-card shadow-[var(--shadow-subtle)]">
        <summary className="flex cursor-pointer items-center justify-between gap-4 px-5 py-4">
          <span className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase text-muted-foreground">결제 기록</span>
            <strong className="text-sm font-semibold">결제수단과 최근 청구 이력</strong>
          </span>
          <StatusBadge tone={paymentMethods.length + invoices.length > 0 ? "brand" : "neutral"}>
            {(paymentMethods.length + invoices.length).toLocaleString("ko-KR")}
          </StatusBadge>
        </summary>
        <div className="grid gap-4 border-t p-4 xl:grid-cols-2">
          <Card>
        <CardHeader>
          <div>
            <span className="text-xs font-medium uppercase text-muted-foreground">결제수단 기록</span>
            <h2 className="mt-1 text-lg font-semibold tracking-normal">등록된 결제수단</h2>
          </div>
          <StatusBadge tone={paymentMethods.length > 0 ? "brand" : "neutral"}>{paymentMethods.length}</StatusBadge>
        </CardHeader>
        <CardContent className="grid gap-3">
          {paymentMethods.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-border bg-muted/30 p-4">
              <strong className="block text-sm font-extrabold text-foreground">아직 등록된 결제수단이 없습니다.</strong>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                카드 번호는 창업노트가 직접 저장하지 않습니다. 결제 provider에서 안전한 표시용 정보가 들어오면 이곳에 표시됩니다.
              </p>
            </div>
          ) : (
            paymentMethods.map((method) => (
              <div className="grid gap-3 rounded-[var(--radius-lg)] border border-border p-4 md:grid-cols-[minmax(0,1fr)_auto]" key={method.id}>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm font-extrabold text-foreground">{method.displayLabel}</strong>
                    <StatusBadge tone={paymentMethodStatusTone(method.status)}>{method.statusLabel}</StatusBadge>
                    {method.isDefault ? <StatusBadge tone="brand">기본</StatusBadge> : null}
                  </div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {method.expiryLabel} · {method.provider}
                  </p>
                  <span className="mt-2 block text-xs font-bold text-muted-foreground">
                    최근 업데이트 {formatDate(method.updatedAt)}
                    {method.lastUsedAt ? ` · 최근 사용 ${formatDate(method.lastUsedAt)}` : ""}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  {method.providerPortalUrl ? (
                    <a className={buttonVariants({ variant: "outline" })} href={method.providerPortalUrl} rel="noreferrer" target="_blank">
                      <ExternalLink data-icon="inline-start" />
                      provider
                    </a>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <span className="text-xs font-medium uppercase text-muted-foreground">청구/영수증 기록</span>
            <h2 className="mt-1 text-lg font-semibold tracking-normal">최근 청구 이력</h2>
          </div>
          <StatusBadge tone={invoices.length > 0 ? "brand" : "neutral"}>{invoices.length}</StatusBadge>
        </CardHeader>
        <CardContent className="grid gap-3">
          {invoices.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-border bg-muted/30 p-4">
              <strong className="block text-sm font-extrabold text-foreground">아직 수신된 청구서가 없습니다.</strong>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                결제 provider webhook으로 청구 이벤트가 들어오면 금액, 상태, 영수증 다운로드가 이곳에 표시됩니다.
              </p>
            </div>
          ) : (
            invoices.map((invoice) => (
              <div className="grid gap-3 rounded-[var(--radius-lg)] border border-border p-4 md:grid-cols-[minmax(0,1fr)_auto]" key={invoice.id}>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm font-extrabold text-foreground">
                      {invoice.invoiceNumber ?? invoice.providerInvoiceId}
                    </strong>
                    <StatusBadge tone={invoiceStatusTone(invoice.status)}>{invoice.statusLabel}</StatusBadge>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {formatMoney(invoice.amountPaid || invoice.amountDue, invoice.currency)}
                    {invoice.periodStart || invoice.periodEnd ? ` · ${formatDate(invoice.periodStart ?? invoice.periodEnd ?? invoice.updatedAt)}` : ""}
                  </p>
                  <span className="mt-2 block text-xs font-bold text-muted-foreground">
                    {invoice.provider} · 최근 업데이트 {formatDate(invoice.updatedAt)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  {invoice.hostedInvoiceUrl ? (
                    <a className={buttonVariants({ variant: "outline" })} href={invoice.hostedInvoiceUrl} rel="noreferrer" target="_blank">
                      <ExternalLink data-icon="inline-start" />
                      원본
                    </a>
                  ) : null}
                  <a className={buttonVariants({ variant: "secondary" })} href={`/api/web/billing/invoices/${encodeURIComponent(invoice.id)}/receipt`}>
                    <Download data-icon="inline-start" />
                    영수증
                  </a>
                  <a className={buttonVariants({ variant: "outline" })} href={`/api/web/billing/invoices/${encodeURIComponent(invoice.id)}/email-handoff`}>
                    <Mail data-icon="inline-start" />
                    메일 파일
                  </a>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
        </div>
      </details>

      <Card>
        <CardHeader>
          <div>
            <span className="text-xs font-medium uppercase text-muted-foreground">유료 전환</span>
            <h2 className="mt-1 text-lg font-semibold tracking-normal">플랜 전환 요청</h2>
          </div>
          <StatusBadge tone="neutral">상담 접수</StatusBadge>
        </CardHeader>
        <CardContent>
          <BillingPlanRequestForm
            defaultEmail={user?.email}
            defaultName={user?.name}
            canRequest={canRequestPlanChange(overview.currentCompany.role)}
          />
        </CardContent>
      </Card>

      <details className="rounded-[var(--radius-xl)] border bg-card shadow-[var(--shadow-subtle)]">
        <summary className="flex cursor-pointer items-center justify-between gap-4 px-5 py-4">
          <span className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase text-muted-foreground">상담 기록</span>
            <strong className="text-sm font-semibold">최근 전환 요청</strong>
          </span>
          <StatusBadge tone={planRequests.length > 0 ? "brand" : "neutral"}>{planRequests.length}</StatusBadge>
        </summary>
        <div className="border-t p-4">
          <Card>
        <CardHeader>
          <div>
            <span className="text-xs font-medium uppercase text-muted-foreground">전환 요청 기록</span>
            <h2 className="mt-1 text-lg font-semibold tracking-normal">최근 상담 요청</h2>
          </div>
          <StatusBadge tone={planRequests.length > 0 ? "brand" : "neutral"}>{planRequests.length}</StatusBadge>
        </CardHeader>
        <CardContent className="grid gap-3">
          {planRequests.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-border bg-muted/30 p-4">
              <strong className="block text-sm font-extrabold text-foreground">아직 접수된 전환 요청이 없습니다.</strong>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                플랜 전환 요청을 남기면 이곳에서 접수 상태와 최근 업데이트를 확인할 수 있습니다.
              </p>
            </div>
          ) : (
            planRequests.map((request) => (
              <div className="grid gap-3 rounded-[var(--radius-lg)] border border-border p-4 md:grid-cols-[minmax(0,1fr)_auto]" key={request.id}>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm font-extrabold text-foreground">{planLabel(request.desiredPlan)} 전환 요청</strong>
                    <StatusBadge tone={statusTone(request.status)}>{statusLabel(request.status)}</StatusBadge>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{request.messagePreview}</p>
                  <span className="mt-2 block text-xs font-bold text-muted-foreground">
                    {request.email} · {formatDate(request.requestedAt)}
                  </span>
                </div>
                <div className="grid gap-2 text-sm md:justify-items-end md:text-right">
                  <span className="font-bold text-foreground">
                    {request.seatCount ? `${request.seatCount.toLocaleString("ko-KR")}석` : "좌석 미확인"}
                  </span>
                  <span className="text-muted-foreground">{cycleLabel(request.billingCycle)}</span>
                  <span className="text-xs font-bold text-muted-foreground">최근 업데이트 {formatDate(request.updatedAt)}</span>
                  <a
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                    href={`/api/web/billing/plan-requests/${encodeURIComponent(request.id)}/email-handoff`}
                  >
                    <Mail data-icon="inline-start" />
                    메일 파일
                  </a>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
        </div>
      </details>
    </div>
  );
}

function UsageCard({ metric }: { metric: WorkspaceUsageMetric }) {
  const ratio = metric.limit ? Math.min(100, Math.round((metric.value / metric.limit) * 100)) : 100;
  return (
    <Card size="sm">
      <CardContent className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">{metric.label}</span>
          <StatusBadge tone={metric.tone}>{metric.limit ? `${ratio}%` : "활성"}</StatusBadge>
        </div>
        <strong className="text-2xl font-semibold tracking-normal">
          {metric.value.toLocaleString("ko-KR")}
          {metric.limit ? ` / ${metric.limit.toLocaleString("ko-KR")}` : ""}
          {metric.unit}
        </strong>
        <p className="text-sm leading-6 text-muted-foreground">{metric.description}</p>
        <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className="block h-full rounded-full bg-primary" style={{ width: `${ratio}%` }} />
        </div>
      </CardContent>
    </Card>
  );
}

function BillingState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-lg)] border bg-muted/30 p-3">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4" aria-hidden>{icon}</span>
      <div>
        <strong className="text-sm font-semibold text-foreground">{title}</strong>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function BillingReadinessRow({ item }: { item: BillingReadinessItem }) {
  const Icon = item.status === "ready" ? CheckCircle2 : CircleAlert;
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-lg)] border bg-muted/30 p-4">
      <span aria-hidden className={item.status === "ready" ? "mt-0.5 text-primary" : "mt-0.5 text-muted-foreground"}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="text-sm font-semibold text-foreground">{item.label}</strong>
          <StatusBadge tone={readinessTone(item.status)}>{readinessItemLabel(item.status)}</StatusBadge>
        </div>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.detail}</p>
        {item.actionHref && item.actionLabel ? (
          <a className="mt-2 inline-flex text-sm font-medium text-primary hover:underline" href={item.actionHref}>{item.actionLabel}</a>
        ) : null}
      </div>
    </div>
  );
}

function canRequestPlanChange(role: string): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

function planLabel(value: string | null): string {
  if (value === "team") return "Team";
  if (value === "growth") return "Growth";
  if (value === "enterprise") return "Enterprise";
  return "플랜";
}

function cycleLabel(value: string | null): string {
  if (value === "monthly") return "월간";
  if (value === "annual") return "연간";
  if (value === "undecided") return "상담 후 결정";
  return "청구 주기 미정";
}

function statusTone(status: string): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (status === "open" || status === "in_progress") return "brand";
  if (status === "waiting") return "warning";
  if (status === "resolved" || status === "closed") return "success";
  return "neutral";
}

function readinessTone(status: BillingReadiness["status"]): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (status === "ready") return "success";
  if (status === "blocked") return "warning";
  return "brand";
}

function subscriptionTone(status: string): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (status === "active" || status === "trialing") return "success";
  if (status === "past_due" || status === "canceled") return "danger";
  if (status === "paused" || status === "manual_review") return "warning";
  return "brand";
}

function invoiceStatusTone(status: string): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (status === "paid") return "success";
  if (status === "open") return "brand";
  if (status === "draft") return "neutral";
  if (status === "void" || status === "uncollectible") return "danger";
  return "warning";
}

function paymentMethodStatusTone(status: string): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (status === "active") return "success";
  if (status === "requires_action") return "warning";
  if (status === "expired" || status === "detached") return "danger";
  if (status === "inactive") return "neutral";
  return "brand";
}

function readinessItemLabel(status: BillingReadinessItem["status"]): string {
  if (status === "ready") return "준비됨";
  if (status === "blocked") return "연동 필요";
  return "확인 필요";
}

function statusLabel(status: string): string {
  if (status === "open") return "접수";
  if (status === "in_progress") return "처리중";
  if (status === "waiting") return "답변 완료";
  if (status === "resolved") return "해결";
  if (status === "closed") return "종료";
  return status;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatMoney(amount: number, currency: string): string {
  const normalizedCurrency = /^[A-Z]{3}$/.test(currency) ? currency : "KRW";
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: normalizedCurrency,
    maximumFractionDigits: normalizedCurrency === "KRW" ? 0 : 2,
  }).format(amount);
}
