"use client";

import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import type {
  ActionResult,
  CompanyEnrichmentResult,
  ConsentRecordDto,
  ConsentScope,
  NotificationSettingsDto,
} from "@cunote/contracts";
import type { CompanyRecord } from "@cunote/core";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { HeaderUser } from "@/lib/server/auth/session";
import type { AccountDeletionRequestHistoryItem } from "@/lib/server/account/accountDeletionRequestHistory";
import type { AccountSecurityStatus } from "@/lib/server/account/accountSecurityStatus";
import type { SettingsSection } from "@/lib/navigation/settingsDeepLink";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { AccountDeletionRequestPanel } from "@/features/account/AccountDeletionRequestPanel";
import { AccountPasswordPanel } from "@/features/account/AccountPasswordPanel";
import { AccountProfilePanel } from "@/features/account/AccountProfilePanel";
import { cn } from "@/lib/utils";
import { RepresentativeVerifySheet } from "./RepresentativeVerifySheet";

const CONSENT_ROWS: Array<{ scope: ConsentScope; title: string; description: string }> = [
  { scope: "hometax", title: "국세청 홈택스", description: "연결하면 매출·업력이 자동 확인돼요" },
  { scope: "insurance", title: "4대보험", description: "상시근로자 수가 자동 확인돼요" },
  { scope: "basic_info", title: "기본정보 자동 갱신", description: "회사 정보가 바뀌면 자동으로 최신화해요" },
];

const rowButtonClassName =
  "flex h-auto w-full items-center justify-between gap-3 rounded-none bg-transparent px-0 py-[15px] text-left font-normal shadow-none hover:bg-transparent focus-visible:relative";

export function SettingsPageView({
  user,
  currentCompany,
  companies,
  notificationSettings,
  securityStatus,
  deletionRequests,
  initialSection,
}: {
  access: CompanyAccess;
  user: HeaderUser | null;
  currentCompany: CompanyRecord | null;
  companies: CompanyRecord[];
  notificationSettings: NotificationSettingsDto;
  securityStatus: AccountSecurityStatus;
  deletionRequests: AccountDeletionRequestHistoryItem[];
  initialSection: SettingsSection | null;
}) {
  const router = useRouter();
  const companyCardRef = useRef<HTMLDivElement>(null);

  const [consents, setConsents] = useState<ConsentRecordDto[] | null>(null);
  const [consentBusy, setConsentBusy] = useState<ConsentScope | null>(null);
  const [notifications, setNotifications] = useState<NotificationSettingsDto>(notificationSettings);
  const [notifyBusy, setNotifyBusy] = useState<"newMatch" | "deadlineReminder" | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [deletionOpen, setDeletionOpen] = useState(false);

  const email = user?.email?.trim() ?? null;
  const accountValue = [email, loginMethodLabel(securityStatus)].filter(Boolean).join(" · ");
  const companyName = currentCompany?.name?.trim() || currentCompany?.profile.name?.trim() || "내 회사";
  const companyLine = [companyName, currentCompany?.bizNoMasked].filter(Boolean).join(" · ");
  const verified = Boolean(currentCompany?.verified);
  const activeByScope = useMemo(() => {
    const map = new Map<ConsentScope, boolean>();
    for (const consent of consents ?? []) {
      map.set(consent.scope, !consent.revokedAt);
    }
    return map;
  }, [consents]);

  useEffect(() => {
    void loadConsents();
  }, []);

  const scrollToCompany = useCallback(() => {
    companyCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    if (initialSection === "data") setDeletionOpen(true);
    if (initialSection === "company") scrollToCompany();
  }, [initialSection, scrollToCompany]);

  useEffect(() => {
    function syncFromHash() {
      const hash = window.location.hash;
      if (hash === "#account-deletion" || hash === "#account-deletion-request") {
        setDeletionOpen(true);
      } else if (hash === "#company-settings" || hash === "#company-settings-detail") {
        scrollToCompany();
      }
    }
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [scrollToCompany]);

  async function loadConsents() {
    try {
      const result = await fetchJson<{ consents: ConsentRecordDto[] }>("/api/web/consents");
      setConsents(result.consents);
    } catch {
      setConsents([]);
    }
  }

  async function toggleConsent(scope: ConsentScope, active: boolean) {
    setConsentBusy(scope);
    try {
      if (active) {
        await fetchJson(`/api/web/consents/${scope}`, { method: "DELETE" });
      } else {
        await fetchJson("/api/web/consents", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope }),
        });
      }
      await loadConsents();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "연결 상태를 저장하지 못했어요.");
    } finally {
      setConsentBusy(null);
    }
  }

  async function toggleNotification(field: "newMatch" | "deadlineReminder") {
    setNotifyBusy(field);
    try {
      const next = await fetchJson<NotificationSettingsDto>("/api/web/notifications", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: !notifications[field] }),
      });
      setNotifications(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "알림 설정을 저장하지 못했어요.");
    } finally {
      setNotifyBusy(null);
    }
  }

  async function refreshCompany() {
    if (activeByScope.get("basic_info") === false) {
      toast.info("회사 정보를 새로고침하려면 데이터 연결에서 '기본정보 자동 갱신'을 먼저 켜주세요.");
      return;
    }
    setRefreshing(true);
    try {
      const result = await fetchJson<CompanyEnrichmentResult>("/api/web/companies/enrich", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      toast.success(refreshMessage(result));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "회사 정보를 확인하지 못했어요.");
    } finally {
      setRefreshing(false);
    }
  }

  async function switchCompany(companyId: string) {
    if (!companyId || companyId === currentCompany?.id) {
      setSwitchOpen(false);
      return;
    }
    setSwitchBusy(true);
    try {
      await fetchJson("/api/web/companies/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      setSwitchOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "회사를 변경하지 못했어요.");
    } finally {
      setSwitchBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col px-4 py-10 sm:px-0 sm:py-14">
      <h1 className="text-2xl font-extrabold tracking-tight">설정</h1>

      {/* 계정 */}
      <SectionLabel>계정</SectionLabel>
      <SettingsCard>
        <ValueRow title="이메일" value={accountValue || "확인 필요"} />
        <RowSeparator />
        <Dialog>
          <DialogTrigger render={<Button type="button" variant="ghost" className={rowButtonClassName} />}>
            <RowLead title="이름" />
            <ChevronRight className="text-text-quaternary" aria-hidden />
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogTitle className="sr-only">표시 이름</DialogTitle>
            <AccountProfilePanel initialName={user?.name ?? null} email={email} />
          </DialogContent>
        </Dialog>
        <RowSeparator />
        <Dialog>
          <DialogTrigger render={<Button type="button" variant="ghost" className={rowButtonClassName} />}>
            <RowLead title="비밀번호 변경" />
            <ChevronRight className="text-text-quaternary" aria-hidden />
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogTitle className="sr-only">비밀번호 변경</DialogTitle>
            <AccountPasswordPanel />
          </DialogContent>
        </Dialog>
        <RowSeparator />
        <Button
          type="button"
          variant="ghost"
          className={rowButtonClassName}
          onClick={() => void signOut({ callbackUrl: "/" })}
        >
          <RowLead title="로그아웃" />
          <ChevronRight className="text-text-quaternary" aria-hidden />
        </Button>
      </SettingsCard>

      {/* 회사 */}
      <SectionLabel>회사</SectionLabel>
      <div ref={companyCardRef} id="company-settings" className="scroll-mt-24">
        <SettingsCard>
          <div className="flex items-center gap-2.5 py-[15px]">
            <span className="text-[14.5px] font-bold tabular-nums">{companyLine}</span>
            {verified ? (
              <Badge className="bg-brand-mint-soft text-brand-mint-ink">대표자 확인됨 ✓</Badge>
            ) : (
              <Badge className="bg-surface-muted text-text-secondary">대표자 확인 전</Badge>
            )}
          </div>
          <RowSeparator />
          <a
            href="/matches#profile"
            className="flex items-center justify-between gap-3 py-[15px] text-[14.5px] font-semibold text-foreground"
          >
            내 정보 열기
            <ChevronRight className="text-text-quaternary" aria-hidden />
          </a>
          {verified ? null : (
            <>
              <RowSeparator />
              <Button
                type="button"
                variant="ghost"
                className={rowButtonClassName}
                onClick={() => setVerifyOpen(true)}
              >
                <RowLead
                  title="대표자 확인"
                  description="확인하면 회사 전용 정보를 자동으로 더 가져올 수 있어요"
                />
                <ChevronRight className="text-text-quaternary" aria-hidden />
              </Button>
            </>
          )}
          <RowSeparator />
          <Button
            type="button"
            variant="ghost"
            className={rowButtonClassName}
            disabled={refreshing}
            onClick={() => void refreshCompany()}
          >
            <RowLead title="회사 정보 새로고침" description="국세청 최신 정보로 다시 확인해요" />
            <ChevronRight className="text-text-quaternary" aria-hidden />
          </Button>
        </SettingsCard>
      </div>
      <div className="mt-2 text-right">
        {companies.length > 1 ? (
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-[12.5px] font-normal text-text-tertiary"
            onClick={() => setSwitchOpen(true)}
          >
            다른 사업자로 변경
          </Button>
        ) : (
          <a
            href="/onboarding"
            className="text-[12.5px] text-text-tertiary underline-offset-4 hover:underline"
          >
            다른 사업자로 변경
          </a>
        )}
      </div>

      {/* 데이터 연결 */}
      <SectionLabel>데이터 연결</SectionLabel>
      <SettingsCard>
        {CONSENT_ROWS.map((row, index) => {
          const active = activeByScope.get(row.scope) ?? false;
          return (
            <div key={row.scope}>
              {index > 0 ? <RowSeparator /> : null}
              <div className="flex items-center gap-3 py-3.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[14.5px] font-semibold text-foreground">{row.title}</span>
                  <span className="text-[12.5px] text-text-tertiary">{row.description}</span>
                </div>
                <Switch
                  checked={active}
                  disabled={consents === null || consentBusy === row.scope}
                  aria-label={`${row.title} ${active ? "끄기" : "켜기"}`}
                  onCheckedChange={() => void toggleConsent(row.scope, active)}
                />
              </div>
            </div>
          );
        })}
      </SettingsCard>
      <p className="mt-2 px-1 text-xs text-text-tertiary">
        연결한 정보는 매칭 판정에만 쓰여요 · 언제든 끌 수 있어요
      </p>

      {/* 멤버십 */}
      <SectionLabel>멤버십</SectionLabel>
      <SettingsCard>
        <div className="flex items-center justify-between gap-3 py-[15px]">
          <span className="text-[14.5px] font-semibold text-foreground">Free 이용 중</span>
          <a
            href="/pricing"
            className="text-[13.5px] font-bold text-primary underline-offset-4 hover:underline"
          >
            멤버십이면 공고 놓칠 일이 없어요 · 자세히 ▸
          </a>
        </div>
      </SettingsCard>

      {/* 알림 */}
      <SectionLabel>알림</SectionLabel>
      <SettingsCard>
        <NotifyRow
          title="실시간 맞춤 알림"
          checked={notifications.newMatch}
          disabled={notifyBusy === "newMatch"}
          onToggle={() => void toggleNotification("newMatch")}
        />
        <RowSeparator />
        <NotifyRow
          title="마감 리마인더"
          checked={notifications.deadlineReminder}
          disabled={notifyBusy === "deadlineReminder"}
          onToggle={() => void toggleNotification("deadlineReminder")}
        />
      </SettingsCard>

      {/* 바닥 */}
      <div className="mt-11 flex justify-center gap-5">
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-[12.5px] font-normal text-text-quaternary"
          onClick={() => setDeletionOpen(true)}
        >
          데이터 삭제 요청
        </Button>
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-[12.5px] font-normal text-text-quaternary"
          onClick={() => setDeletionOpen(true)}
        >
          회원 탈퇴
        </Button>
      </div>

      <RepresentativeVerifySheet
        open={verifyOpen}
        onOpenChange={setVerifyOpen}
        initialOwnerName={currentCompany?.profile.name ?? null}
      />

      <Dialog open={switchOpen} onOpenChange={setSwitchOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>다른 사업자로 변경</DialogTitle>
          <div className="flex flex-col gap-2">
            {companies.map((company) => {
              const isCurrent = company.id === currentCompany?.id;
              const label = company.name?.trim() || company.profile.name?.trim() || company.id;
              return (
                <Button
                  key={company.id}
                  type="button"
                  variant={isCurrent ? "secondary" : "outline"}
                  className="h-auto w-full justify-between px-4 py-3 text-left font-normal"
                  disabled={switchBusy || isCurrent}
                  onClick={() => void switchCompany(company.id)}
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-semibold text-foreground">{label}</span>
                    {company.bizNoMasked ? (
                      <span className="text-xs tabular-nums text-text-tertiary">{company.bizNoMasked}</span>
                    ) : null}
                  </span>
                  {isCurrent ? <span className="text-xs text-text-tertiary">현재</span> : null}
                </Button>
              );
            })}
          </div>
          <a href="/onboarding" className={cn(buttonVariants({ variant: "link", size: "sm" }), "self-center")}>
            새 사업자 추가하기
          </a>
        </DialogContent>
      </Dialog>

      <Dialog open={deletionOpen} onOpenChange={setDeletionOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle className="sr-only">계정 데이터 삭제 요청</DialogTitle>
          <AccountDeletionRequestPanel email={email} history={deletionRequests} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-7 mb-2 px-1 text-[13px] font-extrabold text-text-tertiary">{children}</h2>;
}

function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border-card px-5 shadow-[var(--shadow-notice)]">
      {children}
    </div>
  );
}

function RowSeparator() {
  return <Separator className="bg-border-subtle" />;
}

function RowLead({ title, description }: { title: string; description?: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-[14.5px] font-semibold text-foreground">{title}</span>
      {description ? <span className="text-[12.5px] font-normal text-text-tertiary">{description}</span> : null}
    </span>
  );
}

function ValueRow({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-[15px]">
      <span className="text-[14.5px] font-semibold text-foreground">{title}</span>
      <span className="truncate text-sm text-text-secondary">{value}</span>
    </div>
  );
}

function NotifyRow({
  title,
  checked,
  disabled,
  onToggle,
}: {
  title: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-3 py-3.5">
      <span className="flex-1 text-[14.5px] font-semibold text-foreground">{title}</span>
      <Switch
        checked={checked}
        disabled={disabled}
        aria-label={`${title} ${checked ? "끄기" : "켜기"}`}
        onCheckedChange={onToggle}
      />
    </div>
  );
}

function loginMethodLabel(status: AccountSecurityStatus): string {
  if (status.provider === "mock") return "데모 계정";
  if (status.passwordCredential === "configured") return "이메일 계정";
  if (status.provider === "nextauth") return "소셜 계정";
  return "로그인 방식 확인 필요";
}

function refreshMessage(result: CompanyEnrichmentResult): string {
  if (result.evidence?.cacheStatus === "hit") return "이미 최신 정보예요";
  return "회사 정보를 최신으로 확인했어요";
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json()) as ActionResult<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? "요청에 실패했어요.");
  }
  return payload.data;
}
