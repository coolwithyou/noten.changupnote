import { Crown, Download, ShieldCheck, UserPlus, UsersRound } from "lucide-react";
import type { ReactNode } from "react";
import type { WorkspaceOverview } from "@/lib/server/workspace/overview";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { TeamManagementPanel } from "./TeamManagementPanel";

export function TeamPageView({
  overview,
}: {
  overview: WorkspaceOverview;
}) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-3xl flex-col gap-3">
            <span className="text-sm font-medium text-muted-foreground">팀과 권한</span>
            <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">
              {overview.currentCompany.name}의 접근 권한
            </h1>
            <p className="text-base leading-7 text-muted-foreground">
              회사별 멤버, 역할, 초대 링크를 한 화면에서 관리합니다. 초대는 감사 기록으로 남고 수락 시 멤버 권한으로 연결됩니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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

        <section className="grid gap-3 md:grid-cols-3" aria-label="팀 요약">
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

        <section>
          <Card>
          <CardHeader>
            <CardTitle>팀 멤버</CardTitle>
            <CardDescription>현재 회사에 접근할 수 있는 사용자와 초대 상태입니다.</CardDescription>
            <CardAction>
              <StatusBadge tone="brand">{overview.members.length}</StatusBadge>
            </CardAction>
          </CardHeader>
          <CardContent>
            {overview.members.length > 0 ? (
              <TeamManagementPanel
                members={overview.members}
                invitations={overview.invitations}
                roleChangeEvents={overview.roleChangeEvents}
                seatUsage={overview.seatUsage}
                currentUserRole={overview.currentCompany.role}
              />
            ) : (
              <Empty>
                <EmptyDescription>아직 연결된 멤버가 없습니다.</EmptyDescription>
              </Empty>
            )}
          </CardContent>
        </Card>
      </section>

        <details className="rounded-[var(--radius-xl)] border bg-card text-card-foreground shadow-[var(--shadow-subtle)]">
          <summary className="flex cursor-pointer items-center justify-between gap-3 p-5">
            <span className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">보조 정보</span>
              <strong className="text-base font-semibold text-foreground">워크스페이스 목록</strong>
          </span>
          <StatusBadge tone="neutral">{overview.companies.length}</StatusBadge>
        </summary>
        <div className="border-t p-5">
          <Card>
          <CardHeader>
            <CardTitle>워크스페이스</CardTitle>
            <CardDescription>현재 계정이 접근할 수 있는 회사 목록입니다.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {overview.companies.map((company) => (
              <div className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border bg-background p-4" key={company.id}>
                <div className="min-w-0">
                  <strong className="block truncate text-sm font-semibold text-foreground">{company.name}</strong>
                  <span className="text-sm text-muted-foreground">{company.region ?? "지역 미확인"} · {company.bizNoMasked ?? "사업자번호 미등록"}</span>
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
    </div>
  );
}

function WorkspaceMetric({
  icon,
  label,
  value,
  description,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  description: string;
}) {
  return (
    <Card>
      <CardContent className="flex min-h-32 flex-col gap-3">
        <span className="flex size-9 items-center justify-center rounded-[var(--radius-lg)] bg-muted text-muted-foreground" aria-hidden>
          {icon}
        </span>
        <div className="flex flex-col gap-1">
          <em className="not-italic text-xs font-medium text-muted-foreground">{label}</em>
          <strong className="text-2xl font-semibold tracking-normal text-foreground">{value}</strong>
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
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
