import { Bell, Building2, CreditCard, Download, FileText, LifeBuoy, LockKeyhole, Settings, UserRound, UsersRound } from "lucide-react";
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
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
    <main className="saas-shell">
      <ServiceHeader user={user} links={appHeaderLinks({ currentHref: "/account" })} />

      <section className="saas-hero compact">
        <div>
          <p className="eyebrow">내 계정</p>
          <h1>{label}</h1>
          <p>계정, 회사 접근 권한, 알림과 지원 채널을 한 곳에서 확인합니다.</p>
        </div>
        <div className="saas-hero-actions">
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

      <section className="saas-grid three" aria-label="계정 요약">
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

      <section className="account-support-section" aria-label="계정 프로필">
        <AccountProfilePanel initialName={user?.name ?? null} email={user?.email ?? null} />
      </section>

      <section className="account-support-section" aria-label="계정 보안 상태">
        <AccountSecurityStatusPanel status={securityStatus} />
      </section>

      <section className="account-notification-section" aria-label="내 알림">
        <NotificationFeedPanel feed={notificationCenter} title="내 알림센터" limit={6} />
      </section>

      <details className="saas-disclosure">
        <summary>
          <span className="saas-disclosure-summary-copy">
            <span className="eyebrow">보조 관리</span>
            <strong>지원, 비밀번호, 데이터 요청</strong>
          </span>
          <StatusBadge tone="neutral">보조</StatusBadge>
        </summary>
        <div className="saas-disclosure-content">
          <section className="account-support-section" aria-label="고객지원 기록">
            <AccountSupportTicketsPanel tickets={supportTickets} />
          </section>

          <section className="account-support-section" aria-label="계정 보안">
            <AccountPasswordPanel />
          </section>

          <section className="account-support-section" aria-label="계정 데이터 삭제 요청">
            <AccountDeletionRequestPanel email={user?.email ?? null} history={deletionRequests} />
          </section>

          <section className="saas-two-column">
            <Card className="saas-panel">
              <CardHeader>
                <div>
                  <span className="eyebrow">바로가기</span>
                  <h2>다음 작업</h2>
                </div>
              </CardHeader>
              <CardContent className="saas-action-list">
                <ActionLink href="/onboarding" icon={<Building2 />} title="온보딩 다시 확인" description="회사 동의, 알림, 수기 프로필을 순서대로 점검합니다." />
                <ActionLink href="/settings" icon={<Settings />} title="회사 설정" description="사업자 검증, 동의, 알림과 프로필 필드를 관리합니다." />
                <ActionLink href="/team" icon={<UsersRound />} title="팀과 권한" description="회사 멤버와 역할, 초대 준비 상태를 확인합니다." />
                <ActionLink href="/billing" icon={<CreditCard />} title="플랜과 청구" description="현재 플랜, 사용량, 결제 연동 상태를 봅니다." />
                <ActionLink href="/dashboard" icon={<Bell />} title="기회 맵" description="지금 적격, 확인 필요, 마감 임박 항목을 봅니다." />
                <ActionLink href="/roadmap" icon={<FileText />} title="로드맵" description="앞으로 열릴 가능성이 있는 지원사업을 추적합니다." />
              </CardContent>
            </Card>

            <Card className="saas-panel">
              <CardHeader>
                <div>
                  <span className="eyebrow">서비스 문서</span>
                  <h2>약관과 지원</h2>
                </div>
              </CardHeader>
              <CardContent className="saas-doc-links">
                <a href="/terms">이용약관</a>
                <a href="/privacy">개인정보 처리방침</a>
                <a href="/api/web/account/export">계정 데이터 내보내기</a>
                <a href="/support">고객지원</a>
              </CardContent>
            </Card>
          </section>
        </div>
      </details>
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
  icon: React.ReactNode;
  label: string;
  title: string;
  description: string;
  badge: string;
}) {
  return (
    <Card className="saas-summary-card">
      <CardContent className="p-0">
        <div className="saas-summary-icon" aria-hidden>{icon}</div>
        <div>
          <span>{label}</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <StatusBadge tone="brand">{badge}</StatusBadge>
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
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <a className="saas-action-link" href={href}>
      <span aria-hidden>{icon}</span>
      <strong>{title}</strong>
      <em>{description}</em>
    </a>
  );
}

function roleLabel(role: string): string {
  if (role === "owner") return "소유자";
  if (role === "admin") return "관리자";
  if (role === "member") return "멤버";
  return "뷰어";
}
