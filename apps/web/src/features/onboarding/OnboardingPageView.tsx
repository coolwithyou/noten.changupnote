import type { ReactNode } from "react";
import { ArrowRight, Bell, Building2, CheckCircle2, ClipboardList, ShieldCheck } from "lucide-react";
import { appHeaderLinks } from "@/components/app/app-navigation";
import type { HeaderUser } from "@/lib/server/auth/session";
import type { OnboardingProgress, OnboardingProgressStep, OnboardingStepKey } from "@/lib/server/onboarding/onboardingProgress";
import { ServiceHeader } from "@/components/app/service-header";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CompanySettingsPanel } from "@/features/dashboard/CompanySettingsPanel";
import { InitialCompanySetupPanel } from "@/features/onboarding/InitialCompanySetupPanel";

const STEP_ICONS: Record<OnboardingStepKey, ReactNode> = {
  company: <Building2 />,
  consents: <ShieldCheck />,
  profile: <ClipboardList />,
  notifications: <Bell />,
};

export function OnboardingPageView({
  user,
  progress,
  nextHref,
}: {
  user: HeaderUser | null;
  progress: OnboardingProgress | null;
  nextHref: string;
}) {
  const primaryHref = progress?.nextStep?.actionHref ?? (progress ? nextHref : "#initial-company-setup");
  const primaryLabel = progress?.nextStep?.actionLabel ?? (progress ? "이어서 진행" : "회사 프로필 만들기");
  const secondaryHref = progress ? nextHref : "/support";
  const secondaryLabel = progress ? "나중에 하기" : "도움말";

  return (
    <main className="saas-shell onboarding-shell">
      <ServiceHeader user={user} links={appHeaderLinks({ currentHref: "/onboarding", includeSupport: true })} />

      <section className="saas-hero">
        <div>
          <p className="eyebrow">온보딩</p>
          <h1>지원사업 추천이 바로 작동하도록 기본값을 완성하세요</h1>
          <p>
            {progress
              ? `${progress.companyName}의 설정 완료도는 ${progress.completedCount}/${progress.totalCount}입니다. ${progress.summary}`
              : "첫 회사 프로필을 만들면 매칭, 로드맵, 신청서류 초안 기능이 같은 회사 데이터를 기준으로 움직입니다."}
          </p>
        </div>
        <div className="saas-hero-actions">
          <a className={buttonVariants()} href={primaryHref}>
            {primaryLabel}
            <ArrowRight data-icon="inline-end" />
          </a>
          <a className={buttonVariants({ variant: "outline" })} href={secondaryHref}>
            {secondaryLabel}
          </a>
        </div>
      </section>

      {progress ? <OnboardingProgressSection progress={progress} nextHref={nextHref} /> : <InitialCompanySetupPanel nextHref={nextHref} />}
    </main>
  );
}

function OnboardingProgressSection({ progress, nextHref }: { progress: OnboardingProgress; nextHref: string }) {
  return (
    <>
      <Card className="saas-panel onboarding-progress-panel">
        <CardHeader>
          <div>
            <span className="eyebrow">온보딩 진행 상태</span>
            <h2>설정 완료도</h2>
          </div>
          <StatusBadge tone={progress.completedCount === progress.totalCount ? "success" : "warning"}>
            {progress.completionRatio}%
          </StatusBadge>
        </CardHeader>
        <CardContent className="onboarding-progress-content">
          <div
            className="onboarding-progress-meter"
            aria-label={`온보딩 완료도 ${progress.completionRatio}%`}
            role="img"
          >
            <span style={{ width: `${progress.completionRatio}%` }} />
          </div>
          <p>{progress.summary}</p>
        </CardContent>
      </Card>

      <section className="onboarding-steps" aria-label="온보딩 진행 상태">
        {progress.steps.map((step, index) => (
          <Card className={`onboarding-step ${step.status}`} key={step.key}>
            <CardContent className="p-0">
              <div className="onboarding-step-header">
                <div className="step-icon" aria-hidden>{STEP_ICONS[step.key]}</div>
                <StatusBadge tone={stepTone(step.status)}>{step.badge}</StatusBadge>
              </div>
              <span className="step-index">{String(index + 1).padStart(2, "0")}</span>
              <h2>{step.title}</h2>
              <p>{step.description}</p>
              <strong className="onboarding-step-detail">{step.detail}</strong>
              <a
                className={buttonVariants({
                  variant: step.status === "complete" ? "secondary" : "outline",
                  size: "sm",
                  className: "onboarding-step-action",
                })}
                href={step.actionHref}
              >
                {step.actionLabel}
              </a>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card className="saas-panel onboarding-panel">
        <CardHeader>
          <div>
            <span className="eyebrow">필수 설정</span>
            <h2>회사 데이터 연결</h2>
          </div>
          <CheckCircle2 aria-hidden />
        </CardHeader>
        <CardContent className="p-0">
          <CompanySettingsPanel />
          <div className="onboarding-complete">
            <a className={buttonVariants()} href={nextHref}>
              이어서 진행
              <ArrowRight data-icon="inline-end" />
            </a>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function stepTone(status: OnboardingProgressStep["status"]): "success" | "warning" | "neutral" {
  if (status === "complete") return "success";
  if (status === "attention") return "warning";
  return "neutral";
}
