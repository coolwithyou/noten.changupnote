import { Bell, Building2, Download, ShieldCheck } from "lucide-react";
import { appHeaderLinks } from "@/components/app/app-navigation";
import type { HeaderUser } from "@/lib/server/auth/session";
import { ServiceHeader } from "@/components/app/service-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CompanySettingsPanel } from "@/features/dashboard/CompanySettingsPanel";

export function SettingsPageView({ user }: { user: HeaderUser | null }) {
  return (
    <main className="saas-shell">
      <ServiceHeader user={user} links={appHeaderLinks({ currentHref: "/settings", includeOnboarding: true })} />

      <section className="saas-hero compact">
        <div>
          <p className="eyebrow">설정</p>
          <h1>회사와 신청 준비 데이터를 관리하세요</h1>
          <p>매칭 정확도에 직접 영향을 주는 동의, 사업자 검증, 자가신고 프로필, 알림을 한 화면에서 조정합니다.</p>
        </div>
        <div className="saas-hero-actions">
          <a className={buttonVariants({ variant: "secondary" })} href="/api/web/settings/report">
            <Download data-icon="inline-start" />
            설정 리포트
          </a>
        </div>
      </section>

      <section className="saas-grid three" aria-label="설정 범위">
        <InfoCard icon={<Building2 />} title="회사" description="회사 전환, 사업자번호 보강, 소유권 검증" />
        <InfoCard icon={<ShieldCheck />} title="동의" description="기본정보, 홈택스, 4대보험 연결 상태" />
        <InfoCard icon={<Bell />} title="알림" description="마감 임박과 새 매칭 알림 수신 설정" />
      </section>

      <CompanySettingsPanel />
    </main>
  );
}

function InfoCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Card className="saas-info-card">
      <CardContent className="p-0">
        <span aria-hidden>{icon}</span>
        <strong>{title}</strong>
        <p>{description}</p>
      </CardContent>
    </Card>
  );
}
