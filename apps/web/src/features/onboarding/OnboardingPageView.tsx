import type { ReactNode } from "react";
import { ArrowRight, Bell, Building2, ClipboardList, ShieldCheck } from "lucide-react";
import type { OnboardingProgress, OnboardingProgressStep, OnboardingStepKey } from "@/lib/server/onboarding/onboardingProgress";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { CompanySettingsPanel } from "@/features/dashboard/CompanySettingsPanel";
import { InitialCompanySetupPanel } from "@/features/onboarding/InitialCompanySetupPanel";

const STEP_ICONS: Record<OnboardingStepKey, ReactNode> = {
  company: <Building2 />,
  consents: <ShieldCheck />,
  profile: <ClipboardList />,
  notifications: <Bell />,
};

export function OnboardingPageView({
  progress,
  nextHref,
}: {
  progress: OnboardingProgress | null;
  nextHref: string;
}) {
  const primaryHref = progress?.nextStep?.actionHref ?? (progress ? nextHref : "#initial-company-setup");
  const primaryLabel = progress?.nextStep?.actionLabel ?? (progress ? "이어서 진행" : "회사 프로필 만들기");
  const secondaryHref = progress ? nextHref : "/support";
  const secondaryLabel = progress ? "나중에 하기" : "도움말";

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-3xl flex-col gap-3">
            <span className="text-sm font-medium text-muted-foreground">온보딩</span>
            <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">
              지원사업 추천이 바로 작동하도록 기본값을 완성하세요
            </h1>
            <p className="text-base leading-7 text-muted-foreground">
            {progress
              ? `${progress.companyName}의 설정 완료도는 ${progress.completedCount}/${progress.totalCount}입니다. ${progress.summary}`
              : "첫 회사 프로필을 만들면 매칭, 로드맵, 신청서류 초안 기능이 같은 회사 데이터를 기준으로 움직입니다."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
    </div>
  );
}

function OnboardingProgressSection({ progress, nextHref }: { progress: OnboardingProgress; nextHref: string }) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>설정 완료도</CardTitle>
          <CardDescription>{progress.summary}</CardDescription>
          <CardAction>
            <StatusBadge tone={progress.completedCount === progress.totalCount ? "success" : "warning"}>
              {progress.completionRatio}%
            </StatusBadge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Progress value={progress.completionRatio} aria-label={`온보딩 완료도 ${progress.completionRatio}%`} />
        </CardContent>
      </Card>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="온보딩 진행 상태">
        {progress.steps.map((step, index) => (
          <Card key={step.key}>
            <CardContent className="flex min-h-64 flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex size-9 items-center justify-center rounded-[var(--radius-lg)] bg-muted text-muted-foreground" aria-hidden>
                  {STEP_ICONS[step.key]}
                </div>
                <StatusBadge tone={stepTone(step.status)}>{step.badge}</StatusBadge>
              </div>
              <span className="text-xs font-medium text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
              <div className="flex flex-1 flex-col gap-2">
                <h2 className="text-base font-semibold text-foreground">{step.title}</h2>
                <p className="text-sm leading-6 text-muted-foreground">{step.description}</p>
                <strong className="text-sm font-medium text-foreground">{step.detail}</strong>
              </div>
              <a
                className={buttonVariants({
                  variant: step.status === "complete" ? "secondary" : "outline",
                  size: "sm",
                  className: "w-full",
                })}
                href={step.actionHref}
              >
                {step.actionLabel}
              </a>
            </CardContent>
          </Card>
        ))}
      </section>

      <CompanySettingsPanel />
      <div className="flex justify-end">
        <a className={buttonVariants()} href={nextHref}>
          이어서 진행
          <ArrowRight data-icon="inline-end" />
        </a>
      </div>
    </>
  );
}

function stepTone(status: OnboardingProgressStep["status"]): "success" | "warning" | "neutral" {
  if (status === "complete") return "success";
  if (status === "attention") return "warning";
  return "neutral";
}
