import { Bell, Building2, Download, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { appHeaderLinks } from "@/components/app/app-navigation";
import type { HeaderUser } from "@/lib/server/auth/session";
import { ServiceHeader } from "@/components/app/service-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CompanySettingsPanel } from "@/features/dashboard/CompanySettingsPanel";

export function SettingsPageView({ user }: { user: HeaderUser | null }) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <ServiceHeader user={user} links={appHeaderLinks({ currentHref: "/settings", includeOnboarding: true })} />

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-3xl flex-col gap-3">
            <span className="text-sm font-medium text-muted-foreground">설정</span>
            <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">
              회사와 신청 준비 데이터를 관리하세요
            </h1>
            <p className="text-base leading-7 text-muted-foreground">
              매칭 정확도에 직접 영향을 주는 동의, 사업자 검증, 자가신고 프로필, 알림을 한 화면에서 조정합니다.
            </p>
          </div>
          <a className={buttonVariants({ variant: "secondary" })} href="/api/web/settings/report">
            <Download data-icon="inline-start" />
            설정 리포트
          </a>
        </section>

        <section className="grid gap-3 md:grid-cols-3" aria-label="설정 범위">
          <InfoCard icon={<Building2 />} title="회사" description="회사 전환, 사업자번호 보강, 소유권 검증" />
          <InfoCard icon={<ShieldCheck />} title="동의" description="기본정보, 홈택스, 4대보험 연결 상태" />
          <InfoCard icon={<Bell />} title="알림" description="마감 임박과 새 매칭 알림 수신 설정" />
        </section>

        <CompanySettingsPanel />
      </div>
    </main>
  );
}

function InfoCard({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardContent className="flex min-h-32 flex-col gap-3">
        <span className="flex size-9 items-center justify-center rounded-[var(--radius-lg)] bg-muted text-muted-foreground" aria-hidden>
          {icon}
        </span>
        <div className="flex flex-col gap-1">
          <strong className="text-sm font-semibold text-foreground">{title}</strong>
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </CardContent>
    </Card>
  );
}
