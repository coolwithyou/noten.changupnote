import { Crown, Download, ShieldCheck, UserPlus, UsersRound } from "lucide-react";
import { appHeaderLinks } from "@/components/app/app-navigation";
import type { HeaderUser } from "@/lib/server/auth/session";
import type { WorkspaceOverview } from "@/lib/server/workspace/overview";
import { ServiceHeader } from "@/components/app/service-header";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { TeamManagementPanel } from "./TeamManagementPanel";

export function TeamPageView({
  overview,
  user,
}: {
  overview: WorkspaceOverview;
  user: HeaderUser | null;
}) {
  return (
    <main className="saas-shell workspace-shell">
      <ServiceHeader user={user} links={appHeaderLinks({ currentHref: "/team" })} />

      <section className="saas-hero compact">
        <div>
          <p className="eyebrow">팀과 권한</p>
          <h1>{overview.currentCompany.name}의 접근 권한</h1>
          <p>회사별 멤버, 역할, 초대 링크를 한 화면에서 관리합니다. 초대는 감사 기록으로 남고 수락 시 멤버 권한으로 연결됩니다.</p>
        </div>
        <div className="saas-hero-actions">
          <a className={buttonVariants()} href="#team-invite-panel">
            <UserPlus data-icon="inline-start" />
            팀 초대
          </a>
          <a className={buttonVariants({ variant: "secondary" })} href="/api/web/team/report">
            <Download data-icon="inline-start" />
            팀 리포트
          </a>
          <a className={buttonVariants({ variant: "outline" })} href="/settings">
            <ShieldCheck data-icon="inline-start" />
            회사 설정
          </a>
        </div>
      </section>

      <section className="workspace-summary-grid" aria-label="팀 요약">
        <WorkspaceMetric
          icon={<UsersRound />}
          label="현재 멤버"
          value={`${overview.members.length.toLocaleString("ko-KR")}명`}
          description="현재 회사에 연결된 사용자"
        />
        <WorkspaceMetric
          icon={<UserPlus />}
          label="좌석 사용"
          value={`${overview.seatUsage.reservedSeats.toLocaleString("ko-KR")}/${overview.seatUsage.seatLimit.toLocaleString("ko-KR")}`}
          description={`대기 초대 ${overview.seatUsage.pendingInvitations.toLocaleString("ko-KR")}명 포함`}
        />
        <WorkspaceMetric
          icon={<Crown />}
          label="내 역할"
          value={roleLabel(overview.currentCompany.role)}
          description={overview.currentCompany.verified ? "검증된 회사" : "회사 검증 필요"}
        />
      </section>

      <section className="workspace-two-column">
        <Card className="workspace-panel">
          <CardHeader>
            <div>
              <span className="eyebrow">멤버</span>
              <h2>팀 멤버</h2>
            </div>
            <StatusBadge tone="brand">{overview.members.length}</StatusBadge>
          </CardHeader>
          <CardContent className="team-members-list">
            {overview.members.length > 0 ? (
              <TeamManagementPanel
                members={overview.members}
                invitations={overview.invitations}
                roleChangeEvents={overview.roleChangeEvents}
                seatUsage={overview.seatUsage}
                currentUserRole={overview.currentCompany.role}
              />
            ) : (
              <Empty className="panel-empty">
                <EmptyDescription>아직 연결된 멤버가 없습니다.</EmptyDescription>
              </Empty>
            )}
          </CardContent>
        </Card>
      </section>

      <details className="saas-disclosure">
        <summary>
          <span className="saas-disclosure-summary-copy">
            <span className="eyebrow">보조 정보</span>
            <strong>워크스페이스 목록</strong>
          </span>
          <StatusBadge tone="neutral">{overview.companies.length}</StatusBadge>
        </summary>
        <div className="saas-disclosure-content">
          <Card className="workspace-panel">
          <CardHeader>
            <div>
              <span className="eyebrow">회사</span>
              <h2>워크스페이스</h2>
            </div>
          </CardHeader>
          <CardContent className="workspace-company-list">
            {overview.companies.map((company) => (
              <div className="workspace-company-row" key={company.id}>
                <div>
                  <strong>{company.name}</strong>
                  <span>{company.region ?? "지역 미확인"} · {company.bizNoMasked ?? "사업자번호 미등록"}</span>
                </div>
                <StatusBadge tone={company.id === overview.currentCompany.id ? "brand" : "neutral"}>
                  {company.id === overview.currentCompany.id ? "현재" : roleLabel(company.role)}
                </StatusBadge>
              </div>
            ))}
          </CardContent>
        </Card>
        </div>
      </details>
    </main>
  );
}

function WorkspaceMetric({
  icon,
  label,
  value,
  description,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  description: string;
}) {
  return (
    <Card className="workspace-metric-card">
      <CardContent className="p-0">
        <span aria-hidden>{icon}</span>
        <div>
          <em>{label}</em>
          <strong>{value}</strong>
          <p>{description}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function roleLabel(role: string): string {
  if (role === "owner") return "소유자";
  if (role === "admin") return "관리자";
  if (role === "member") return "멤버";
  return "뷰어";
}
