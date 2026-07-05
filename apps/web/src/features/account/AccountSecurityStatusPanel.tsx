import { CheckCircle2, Download, KeyRound, ShieldCheck, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import type { AccountSecurityStatus } from "@/lib/server/account/accountSecurityStatus";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export function AccountSecurityStatusPanel({
  status,
}: {
  status: AccountSecurityStatus;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>보안과 세션</CardTitle>
        <CardDescription>로그인 방식, 법무 동의, 계정 식별자를 확인합니다.</CardDescription>
        <CardAction>
          <ShieldCheck className="text-muted-foreground" aria-hidden />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 md:grid-cols-3">
          <SecurityMetric
            icon={<UserRound />}
            label="로그인 방식"
            value={providerLabel(status.provider)}
            badge={status.provider === "none" ? "확인 필요" : "활성"}
            tone={status.provider === "none" ? "warning" : "brand"}
          />
          <SecurityMetric
            icon={<KeyRound />}
            label="비밀번호"
            value={passwordCredentialLabel(status.passwordCredential)}
            badge={passwordCredentialBadge(status.passwordCredential)}
            tone={passwordCredentialTone(status.passwordCredential)}
          />
          <SecurityMetric
            icon={<CheckCircle2 />}
            label="법무 동의"
            value={legalAcceptanceLabel(status.legalAcceptance)}
            badge={legalAcceptanceBadge(status.legalAcceptance)}
            tone={legalAcceptanceTone(status.legalAcceptance)}
          />
        </div>

        <Separator />

        <dl className="grid gap-3 text-sm md:grid-cols-2">
          <SecurityDetail label="계정 이메일" value={status.email ?? "확인 불가"} />
          <SecurityDetail label="사용자 ID" value={status.userId} />
          <SecurityDetail
            label="이용약관 동의"
            value={formatAcceptance(status.termsAcceptedAt, status.termsVersion, status.currentTermsVersion)}
          />
          <SecurityDetail
            label="개인정보 동의"
            value={formatAcceptance(status.privacyAcceptedAt, status.privacyVersion, status.currentPrivacyVersion)}
          />
        </dl>

        <div className="flex flex-wrap gap-2">
          <a className={buttonVariants({ variant: "secondary", size: "sm" })} href="/api/web/account/security-report">
            <Download data-icon="inline-start" />
            보안 리포트
          </a>
          <a className={buttonVariants({ variant: "secondary", size: "sm" })} href="/api/web/account/export">
            계정 데이터 내보내기
          </a>
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/privacy">
            개인정보 처리방침
          </a>
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/terms">
            이용약관
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

function SecurityMetric({
  icon,
  label,
  value,
  badge,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  badge: string;
  tone: "brand" | "success" | "warning" | "danger" | "neutral";
}) {
  return (
    <div className="grid gap-3 rounded-[var(--radius-lg)] border border-border bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex size-9 items-center justify-center rounded-[var(--radius-lg)] bg-muted text-muted-foreground" aria-hidden>
          {icon}
        </span>
        <StatusBadge tone={tone}>{badge}</StatusBadge>
      </div>
      <div>
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <strong className="mt-1 block break-words text-base font-semibold text-foreground">{value}</strong>
      </div>
    </div>
  );
}

function SecurityDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-[var(--radius-lg)] border border-border px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="break-words font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function providerLabel(provider: AccountSecurityStatus["provider"]): string {
  if (provider === "mock") return "데모 세션";
  if (provider === "nextauth") return "이메일 또는 OAuth";
  return "세션 없음";
}

function passwordCredentialLabel(status: AccountSecurityStatus["passwordCredential"]): string {
  if (status === "configured") return "이메일 비밀번호 설정됨";
  if (status === "not_configured") return "OAuth 전용 또는 미설정";
  return "DB 확인 필요";
}

function passwordCredentialBadge(status: AccountSecurityStatus["passwordCredential"]): string {
  if (status === "configured") return "설정됨";
  if (status === "not_configured") return "미설정";
  return "확인 불가";
}

function passwordCredentialTone(status: AccountSecurityStatus["passwordCredential"]): "success" | "warning" | "neutral" {
  if (status === "configured") return "success";
  if (status === "not_configured") return "warning";
  return "neutral";
}

function legalAcceptanceLabel(status: AccountSecurityStatus["legalAcceptance"]): string {
  if (status === "accepted") return "약관과 개인정보 동의 기록 있음";
  if (status === "missing") return "동의 이력 보강 필요";
  return "DB 확인 필요";
}

function legalAcceptanceBadge(status: AccountSecurityStatus["legalAcceptance"]): string {
  if (status === "accepted") return "완료";
  if (status === "missing") return "누락";
  return "확인 불가";
}

function legalAcceptanceTone(status: AccountSecurityStatus["legalAcceptance"]): "success" | "warning" | "neutral" {
  if (status === "accepted") return "success";
  if (status === "missing") return "warning";
  return "neutral";
}

function formatAcceptance(acceptedAt: string | null, version: string | null, currentVersion: string): string {
  if (!acceptedAt) return `기록 없음 · 현재 ${currentVersion}`;
  return `${formatDate(acceptedAt)} · ${version ?? "버전 미기록"} / 현재 ${currentVersion}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
