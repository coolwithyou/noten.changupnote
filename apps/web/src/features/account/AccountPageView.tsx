import { Bell, Building2, CreditCard, Download, FileText, LifeBuoy, LockKeyhole, Settings, UserRound, UsersRound } from "lucide-react";
import type { ReactNode } from "react";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { HeaderUser } from "@/lib/server/auth/session";
import type { NotificationCenterResult } from "@/lib/notifications/types";
import type { AccountDeletionRequestHistoryItem } from "@/lib/server/account/accountDeletionRequestHistory";
import type { AccountSecurityStatus } from "@/lib/server/account/accountSecurityStatus";
import type { AccountSupportTicketItem } from "@/lib/server/support/supportTicketMessages";
import { appHeaderLinks } from "@/components/app/app-navigation";
import { ServiceHeader } from "@/components/app/service-header";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotificationFeedPanel } from "@/features/dashboard/NotificationFeedPanel";
import { AccountDeletionRequestPanel } from "./AccountDeletionRequestPanel";
import { AccountPasswordPanel } from "./AccountPasswordPanel";
import { AccountProfilePanel } from "./AccountProfilePanel";
import { AccountSecurityStatusPanel } from "./AccountSecurityStatusPanel";
import { AccountSupportTicketsPanel } from "./AccountSupportTicketsPanel";

export function AccountPageView({
  access,
  user,
  securityStatus,
  supportTickets,
  deletionRequests,
  notificationCenter,
}: {
  access: CompanyAccess;
  user: HeaderUser | null;
  securityStatus: AccountSecurityStatus;
  supportTickets: AccountSupportTicketItem[];
  deletionRequests: AccountDeletionRequestHistoryItem[];
  notificationCenter: NotificationCenterResult;
}) {
  const label = user?.name?.trim() || user?.email?.trim() || "내 계정";

  return (
    <main className="min-h-screen bg-background text-foreground">
      <ServiceHeader user={user} links={appHeaderLinks({ currentHref: "/account" })} />

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-3xl flex-col gap-3">
            <span className="text-sm font-medium text-muted-foreground">내 계정</span>
            <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">{label}</h1>
            <p className="text-base leading-7 text-muted-foreground">
              계정, 회사 접근 권한, 알림과 지원 채널을 한 곳에서 확인합니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a className={buttonVariants({ variant: "secondary" })} href="/settings">
              <Settings data-icon="inline-start" />
              설정 열기
            </a>
            <a className={buttonVariants({ variant: "outline" })} href="/support">
              <LifeBuoy data-icon="inline-start" />
              고객지원
            </a>
            <a className={buttonVariants({ variant: "outline" })} href="/api/web/account/export">
              <Download data-icon="inline-start" />
              데이터 내보내기
            </a>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-3" aria-label="계정 요약">
          <AccountSummaryCard
            icon={<UserRound />}
            label="로그인 계정"
            title={label}
            description={user?.email ?? "세션에서 이메일을 확인하지 못했습니다."}
            badge={access.mode === "demo" ? "데모" : "활성"}
          />
          <AccountSummaryCard
            icon={<Building2 />}
            label="현재 회사"
            title={access.companyId}
            description={`역할: ${roleLabel(access.role)}`}
            badge={roleLabel(access.role)}
          />
          <AccountSummaryCard
            icon={<LockKeyhole />}
            label="보안"
            title="세션 보호"
            description="회사 데이터는 회사 멤버십과 RLS 정책으로 분리됩니다."
            badge="RLS"
          />
        </section>

        <section aria-label="계정 프로필">
          <AccountProfilePanel initialName={user?.name ?? null} email={user?.email ?? null} />
        </section>

        <section aria-label="계정 보안 상태">
          <AccountSecurityStatusPanel status={securityStatus} />
        </section>

        <section aria-label="내 알림">
          <NotificationFeedPanel feed={notificationCenter} title="내 알림센터" limit={6} />
        </section>

        <details className="rounded-[var(--radius-xl)] border bg-card text-card-foreground shadow-[var(--shadow-subtle)]">
          <summary className="flex cursor-pointer items-center justify-between gap-3 p-5">
            <span className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">보조 관리</span>
              <strong className="text-base font-semibold text-foreground">지원, 비밀번호, 데이터 요청</strong>
            </span>
            <StatusBadge tone="neutral">보조</StatusBadge>
          </summary>
          <div className="flex flex-col gap-6 border-t p-5">
            <section aria-label="고객지원 기록">
              <AccountSupportTicketsPanel tickets={supportTickets} />
            </section>

            <section aria-label="계정 보안">
              <AccountPasswordPanel />
            </section>

            <section aria-label="계정 데이터 삭제 요청">
              <AccountDeletionRequestPanel email={user?.email ?? null} history={deletionRequests} />
            </section>

            <section className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>다음 작업</CardTitle>
                <CardDescription>계정에서 자주 이동하는 관리 화면입니다.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                <ActionLink href="/onboarding" icon={<Building2 />} title="온보딩 다시 확인" description="회사 동의, 알림, 수기 프로필을 순서대로 점검합니다." />
                <ActionLink href="/settings" icon={<Settings />} title="회사 설정" description="사업자 검증, 동의, 알림과 프로필 필드를 관리합니다." />
                <ActionLink href="/team" icon={<UsersRound />} title="팀과 권한" description="회사 멤버와 역할, 초대 준비 상태를 확인합니다." />
                <ActionLink href="/billing" icon={<CreditCard />} title="플랜과 청구" description="현재 플랜, 사용량, 결제 연동 상태를 봅니다." />
                <ActionLink href="/dashboard" icon={<Bell />} title="기회 맵" description="지금 적격, 확인 필요, 마감 임박 항목을 봅니다." />
                <ActionLink href="/roadmap" icon={<FileText />} title="로드맵" description="앞으로 열릴 가능성이 있는 지원사업을 추적합니다." />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>약관과 지원</CardTitle>
                <CardDescription>계정 데이터와 서비스 문서로 이동합니다.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                <a className={buttonVariants({ variant: "outline", className: "justify-start" })} href="/terms">이용약관</a>
                <a className={buttonVariants({ variant: "outline", className: "justify-start" })} href="/privacy">개인정보 처리방침</a>
                <a className={buttonVariants({ variant: "outline", className: "justify-start" })} href="/api/web/account/export">계정 데이터 내보내기</a>
                <a className={buttonVariants({ variant: "outline", className: "justify-start" })} href="/support">고객지원</a>
              </CardContent>
            </Card>
            </section>
          </div>
        </details>
      </div>
    </main>
  );
}

function AccountSummaryCard({
  icon,
  label,
  title,
  description,
  badge,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  description: string;
  badge: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardAction>
          <StatusBadge tone="brand">{badge}</StatusBadge>
        </CardAction>
        <div className="flex size-9 items-center justify-center rounded-[var(--radius-lg)] bg-muted text-muted-foreground" aria-hidden>
          {icon}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <h2 className="truncate text-base font-semibold text-foreground">{title}</h2>
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function ActionLink({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <a className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-[var(--radius-lg)] border bg-background p-3 transition-colors hover:bg-muted/50" href={href}>
      <span className="flex size-8 items-center justify-center rounded-[var(--radius-md)] bg-muted text-muted-foreground" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <strong className="block text-sm font-semibold text-foreground">{title}</strong>
        <em className="not-italic text-sm leading-6 text-muted-foreground">{description}</em>
      </span>
    </a>
  );
}

function roleLabel(role: string): string {
  if (role === "owner") return "소유자";
  if (role === "admin") return "관리자";
  if (role === "member") return "멤버";
  return "뷰어";
}
