"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type {
  ActionResult,
  CompanyEvidence,
  CompanyProfile,
  CompanyEnrichmentResult,
  CompanyVerificationResult,
  ConsentRecordDto,
  ConsentScope,
  CriterionDimension,
  NotificationSettingsDto,
} from "@cunote/contracts";
import type { CompanyRecord } from "@cunote/core";
import { StatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { CompanyEvidenceSummary } from "@/features/company-evidence/CompanyEvidenceSummary";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface WebCompaniesResult {
  currentCompanyId: string;
  companies: CompanyRecord[];
}

interface ConsentListResult {
  companyId: string;
  consents: ConsentRecordDto[];
}

interface ProfileDraft {
  founderAge: string;
  revenue: string;
  employees: string;
  targetType: string;
  certifications: string;
  ip: string;
  priorAwards: string;
  noPriorAwards: boolean;
}

interface ProfileFieldMutation {
  field: CriterionDimension;
  value: unknown;
  confidence: number;
}

const CONSENT_LABELS: Record<ConsentScope, string> = {
  basic_info: "기본정보",
  hometax: "홈택스",
  insurance: "4대보험",
};

const CONSENT_SCOPES: ConsentScope[] = ["basic_info", "hometax", "insurance"];

const NOTIFICATION_FIELDS: Array<{
  field: keyof Pick<NotificationSettingsDto, "deadlineReminder" | "newMatch">;
  label: string;
}> = [
  { field: "deadlineReminder", label: "마감 알림" },
  { field: "newMatch", label: "새 매칭" },
];

const TARGET_TYPE_OPTIONS = ["예비창업자", "개인사업자", "법인", "일반기업", "1인 창조기업", "대학", "연구기관"];
const TARGET_TYPE_ITEMS = TARGET_TYPE_OPTIONS.map((option) => ({ label: option, value: option }));
const EMPTY_PROFILE_DRAFT: ProfileDraft = {
  founderAge: "",
  revenue: "",
  employees: "",
  targetType: "법인",
  certifications: "",
  ip: "",
  priorAwards: "",
  noPriorAwards: false,
};

export function CompanySettingsPanel() {
  const router = useRouter();
  const [companies, setCompanies] = useState<CompanyRecord[]>([]);
  const [currentCompanyId, setCurrentCompanyId] = useState("");
  const [consents, setConsents] = useState<ConsentRecordDto[]>([]);
  const [notifications, setNotifications] = useState<NotificationSettingsDto | null>(null);
  const [bizNo, setBizNo] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [openedOn, setOpenedOn] = useState("");
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(EMPTY_PROFILE_DRAFT);
  const [lastEvidence, setLastEvidence] = useState<CompanyEvidence | null>(null);
  const [status, setStatus] = useState("불러오는 중");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    void refreshSettings();
  }, []);

  const latestByScope = useMemo(() => {
    return new Map(consents.map((consent) => [consent.scope, consent]));
  }, [consents]);
  const basicInfoConsent = Boolean(latestByScope.get("basic_info") && !latestByScope.get("basic_info")?.revokedAt);
  const currentCompany = useMemo(
    () => companies.find((company) => company.id === currentCompanyId) ?? null,
    [companies, currentCompanyId],
  );

  useEffect(() => {
    setProfileDraft(draftFromProfile(currentCompany?.profile));
  }, [currentCompany]);

  async function refreshSettings() {
    setStatus("불러오는 중");
    try {
      const [companyResult, consentResult, notificationResult] = await Promise.all([
        fetchJson<WebCompaniesResult>("/api/web/companies"),
        fetchJson<ConsentListResult>("/api/web/consents"),
        fetchJson<NotificationSettingsDto>("/api/web/notifications"),
      ]);
      setCompanies(companyResult.companies);
      setCurrentCompanyId(companyResult.currentCompanyId);
      setConsents(consentResult.consents);
      setNotifications(notificationResult);
      setStatus("동기화됨");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "설정을 불러오지 못했습니다.");
    }
  }

  async function switchCompany(companyId: string) {
    if (!companyId || companyId === currentCompanyId) return;
    setBusyKey("company");
    try {
      const result = await fetchJson<{ currentCompanyId: string }>("/api/web/companies/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      setCurrentCompanyId(result.currentCompanyId);
      window.location.reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "회사 전환에 실패했습니다.");
    } finally {
      setBusyKey(null);
    }
  }

  async function toggleConsent(scope: ConsentScope, active: boolean) {
    setBusyKey(scope);
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
      await refreshSettings();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "동의 상태를 저장하지 못했습니다.");
    } finally {
      setBusyKey(null);
    }
  }

  async function toggleNotification(field: keyof Pick<NotificationSettingsDto, "deadlineReminder" | "newMatch">) {
    if (!notifications) return;
    setBusyKey(field);
    try {
      const next = await fetchJson<NotificationSettingsDto>("/api/web/notifications", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: !notifications[field] }),
      });
      setNotifications(next);
      setStatus("동기화됨");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "알림 설정을 저장하지 못했습니다.");
    } finally {
      setBusyKey(null);
    }
  }

  function updateDraft<K extends keyof ProfileDraft>(field: K, value: ProfileDraft[K]) {
    setProfileDraft((current) => ({ ...current, [field]: value }));
  }

  async function saveManualProfile() {
    const updates = buildProfileUpdates(profileDraft);
    if (updates.length === 0) {
      setStatus("저장할 수기 정보가 없습니다.");
      return;
    }

    setBusyKey("manual-profile");
    try {
      for (const update of updates) {
        await fetchJson<{ profile: CompanyProfile }>("/api/web/profile/field", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(update),
        });
      }
      await refreshSettings();
      setStatus(`${updates.length}개 수기 정보 저장됨`);
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "수기 정보를 저장하지 못했습니다.");
    } finally {
      setBusyKey(null);
    }
  }

  async function enrichCompany() {
    if (!basicInfoConsent) {
      setStatus("기본정보 동의가 필요합니다.");
      return;
    }
    const normalizedBizNo = bizNo.replace(/\D/g, "");
    if (normalizedBizNo.length !== 10) {
      setStatus("사업자번호 10자리를 입력하세요.");
      return;
    }

    setBusyKey("enrich");
    try {
      const result = await fetchJson<CompanyEnrichmentResult>("/api/web/companies/enrich", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bizNo: normalizedBizNo }),
      });
      setBizNo("");
      setLastEvidence(result.evidence ?? null);
      setStatus(enrichmentStatusMessage(result));
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "회사 정보를 보강하지 못했습니다.");
    } finally {
      setBusyKey(null);
    }
  }

  async function verifyCompany() {
    const normalizedBizNo = bizNo.replace(/\D/g, "");
    if (normalizedBizNo.length !== 10) {
      setStatus("사업자번호 10자리를 입력하세요.");
      return;
    }
    if (!ownerName.trim()) {
      setStatus("대표자명을 입력하세요.");
      return;
    }
    if (!openedOn) {
      setStatus("개업일을 입력하세요.");
      return;
    }

    setBusyKey("verify");
    try {
      const result = await fetchJson<CompanyVerificationResult>("/api/web/companies/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bizNo: normalizedBizNo,
          ownerName: ownerName.trim(),
          openedOn,
        }),
      });
      setStatus(result.verified ? "회사 소유권 검증됨" : "검증 결과 확인 필요");
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "회사 소유권을 검증하지 못했습니다.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Card id="company-settings" aria-label="회사, 동의 및 알림 설정">
      <CardHeader>
        <CardTitle>회사 설정</CardTitle>
        <CardDescription>매칭 정확도와 알림에 영향을 주는 기본 설정입니다.</CardDescription>
        <CardAction>
          <StatusBadge role="status" aria-live="polite" tone={status === "동기화됨" ? "success" : "neutral"}>
            {status}
          </StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-[var(--radius-lg)] border bg-background p-4">
            <Field>
              <FieldLabel htmlFor="company-switcher">회사</FieldLabel>
              <Select
                items={companies.map((company) => ({
                  label: company.name ?? company.profile.name ?? company.id,
                  value: company.id,
                }))}
                value={currentCompanyId || null}
                disabled={busyKey === "company" || companies.length <= 1}
                onValueChange={(value) => {
                  if (typeof value === "string") void switchCompany(value);
                }}
              >
                <SelectTrigger id="company-switcher" className="w-full">
                  <SelectValue placeholder="회사 선택" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {companies.map((company) => (
                      <SelectItem key={company.id} value={company.id}>
                        {company.name ?? company.profile.name ?? company.id}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <StatusBadge tone={currentCompany?.verified ? "success" : "neutral"}>
                {currentCompany?.verified
                  ? `검증됨${currentCompany.bizNoMasked ? ` · ${currentCompany.bizNoMasked}` : ""}`
                  : "소유권 미검증"}
              </StatusBadge>
            </Field>
          </div>

          <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border bg-background p-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-foreground">동의 범위</h3>
              <p className="text-xs text-muted-foreground">자동 보강에 사용할 정보 접근 범위입니다.</p>
            </div>
            {CONSENT_SCOPES.map((scope) => {
              const consent = latestByScope.get(scope);
              const active = Boolean(consent && !consent.revokedAt);
              return (
                <Field key={scope} className="rounded-[var(--radius-md)] border bg-muted/20 p-3" orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{CONSENT_LABELS[scope]}</FieldTitle>
                    <FieldDescription>{active ? "활성" : "미동의"}</FieldDescription>
                  </FieldContent>
                  <Switch
                    checked={active}
                    disabled={busyKey === scope}
                    aria-label={`${CONSENT_LABELS[scope]} 동의 ${active ? "철회" : "활성화"}`}
                    onCheckedChange={() => void toggleConsent(scope, active)}
                  />
                </Field>
              );
            })}
          </div>

          <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border bg-background p-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-foreground">알림</h3>
              <p className="text-xs text-muted-foreground">마감과 새 매칭 알림을 제어합니다.</p>
            </div>
            {NOTIFICATION_FIELDS.map((item) => {
              const active = Boolean(notifications?.[item.field]);
              return (
                <Field key={item.field} className="rounded-[var(--radius-md)] border bg-muted/20 p-3" orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{item.label}</FieldTitle>
                    <FieldDescription>{active ? "켬" : "끔"}</FieldDescription>
                  </FieldContent>
                  <Switch
                    checked={active}
                    disabled={busyKey === item.field || !notifications}
                    aria-label={`${item.label} ${active ? "끄기" : "켜기"}`}
                    onCheckedChange={() => void toggleNotification(item.field)}
                  />
                </Field>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-4 rounded-[var(--radius-lg)] border bg-background p-4" aria-label="회사정보 보강 및 검증">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">회사정보 보강</h3>
              <p className="text-xs text-muted-foreground">저장된 결과를 먼저 확인하고 필요한 경우에만 보강합니다.</p>
            </div>
            <StatusBadge tone="neutral">캐시 우선 확인</StatusBadge>
          </div>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto] lg:items-end">
            <Field>
              <FieldLabel htmlFor="company-enrich-biz-no">사업자번호</FieldLabel>
              <Input
                id="company-enrich-biz-no"
                inputMode="numeric"
                placeholder="사업자번호 10자리"
                value={bizNo}
                disabled={busyKey === "enrich" || busyKey === "verify"}
                onChange={(event) => setBizNo(event.currentTarget.value.replace(/\D/g, "").slice(0, 10))}
              />
              <FieldDescription>저장된 팝빌 결과가 있으면 추가 조회 없이 재사용합니다.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="company-verify-owner-name">대표자명</FieldLabel>
              <Input
                id="company-verify-owner-name"
                autoComplete="off"
                placeholder="대표자명"
                value={ownerName}
                disabled={busyKey === "enrich" || busyKey === "verify"}
                onChange={(event) => setOwnerName(event.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="company-verify-opened-on">개업일</FieldLabel>
              <Input
                id="company-verify-opened-on"
                type="date"
                value={openedOn}
                disabled={busyKey === "enrich" || busyKey === "verify"}
                onChange={(event) => setOpenedOn(event.currentTarget.value)}
              />
            </Field>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    disabled={busyKey === "enrich" || busyKey === "verify" || !basicInfoConsent}
                    onClick={() => void enrichCompany()}
                  >
                    {busyKey === "enrich" ? <Spinner data-icon="inline-start" /> : null}
                    {busyKey === "enrich" ? "확인 중" : "캐시 확인 후 보강"}
                  </Button>
                }
              />
              <TooltipContent>저장된 결과를 먼저 확인하고, 없을 때만 회사정보 보강을 시도합니다.</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busyKey === "enrich" || busyKey === "verify"}
                    onClick={() => void verifyCompany()}
                  >
                    {busyKey === "verify" ? <Spinner data-icon="inline-start" /> : null}
                    {busyKey === "verify" ? "검증 중" : "소유권 검증"}
                  </Button>
                }
              />
              <TooltipContent>대표자명과 개업일로 회사 소유권을 검증합니다.</TooltipContent>
            </Tooltip>
          </div>
          {lastEvidence ? <CompanyEvidenceSummary evidence={lastEvidence} compact /> : null}
        </div>

        <div className="flex flex-col gap-4 rounded-[var(--radius-lg)] border bg-background p-4" aria-label="수기 프로필 입력">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">수기 프로필</h3>
              <p className="text-xs text-muted-foreground">자동 확인이 어려운 조건을 직접 보강합니다.</p>
            </div>
            <StatusBadge tone="neutral">자가신고</StatusBadge>
          </div>
          <FieldGroup className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Field>
              <FieldLabel htmlFor="manual-founder-age">대표자 연령(만)</FieldLabel>
              <Input
                id="manual-founder-age"
                inputMode="numeric"
                placeholder="39"
                value={profileDraft.founderAge}
                disabled={busyKey === "manual-profile"}
                onChange={(event) => updateDraft("founderAge", event.currentTarget.value.replace(/\D/g, ""))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-revenue">매출</FieldLabel>
              <Input
                id="manual-revenue"
                inputMode="numeric"
                placeholder="120000000"
                value={profileDraft.revenue}
                disabled={busyKey === "manual-profile"}
                onChange={(event) => updateDraft("revenue", event.currentTarget.value.replace(/\D/g, ""))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-employees">고용</FieldLabel>
              <Input
                id="manual-employees"
                inputMode="numeric"
                placeholder="12"
                value={profileDraft.employees}
                disabled={busyKey === "manual-profile"}
                onChange={(event) => updateDraft("employees", event.currentTarget.value.replace(/\D/g, ""))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-target-type">신청대상</FieldLabel>
              <Select
                items={TARGET_TYPE_ITEMS}
                value={profileDraft.targetType}
                disabled={busyKey === "manual-profile"}
                onValueChange={(value) => {
                  if (typeof value === "string") updateDraft("targetType", value);
                }}
              >
                <SelectTrigger id="manual-target-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {TARGET_TYPE_ITEMS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-certifications">인증</FieldLabel>
              <Input
                id="manual-certifications"
                placeholder="벤처기업, 이노비즈"
                value={profileDraft.certifications}
                disabled={busyKey === "manual-profile"}
                onChange={(event) => updateDraft("certifications", event.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-ip">지식재산</FieldLabel>
              <Input
                id="manual-ip"
                placeholder="특허, 상표"
                value={profileDraft.ip}
                disabled={busyKey === "manual-profile"}
                onChange={(event) => updateDraft("ip", event.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-prior-awards">기수혜</FieldLabel>
              <Input
                id="manual-prior-awards"
                placeholder="TIPS, 초기창업패키지"
                value={profileDraft.priorAwards}
                disabled={busyKey === "manual-profile" || profileDraft.noPriorAwards}
                onChange={(event) => updateDraft("priorAwards", event.currentTarget.value)}
              />
            </Field>
            <Field className="rounded-[var(--radius-lg)] border bg-muted/20 p-3" orientation="horizontal">
              <Checkbox
                id="manual-no-prior-awards"
                checked={profileDraft.noPriorAwards}
                disabled={busyKey === "manual-profile"}
                onCheckedChange={(checked) => updateDraft("noPriorAwards", checked === true)}
              />
              <FieldLabel htmlFor="manual-no-prior-awards">기수혜 없음</FieldLabel>
            </Field>
            <Button type="button" disabled={busyKey === "manual-profile"} onClick={() => void saveManualProfile()}>
              {busyKey === "manual-profile" ? <Spinner data-icon="inline-start" /> : null}
              {busyKey === "manual-profile" ? "저장 중" : "수기 정보 저장"}
            </Button>
          </FieldGroup>
        </div>
      </CardContent>
    </Card>
  );
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json() as ActionResult<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? "요청에 실패했습니다.");
  }
  return payload.data;
}

function enrichmentStatusMessage(result: CompanyEnrichmentResult): string {
  if (result.evidence?.cacheStatus === "hit") return "DB 캐시로 회사정보 보강됨";
  if (result.evidence?.cacheStatus === "stored") return "팝빌 조회 후 캐시 저장됨";
  if (result.facts.hasBizAge || result.facts.hasIndustry) return "회사정보 보강됨";
  return "보강 결과 확인 필요";
}

function draftFromProfile(profile: CompanyProfile | undefined): ProfileDraft {
  if (!profile) return EMPTY_PROFILE_DRAFT;
  const priorAwards = profile.prior_awards ?? [];
  return {
    founderAge: numberString(profile.founder_age),
    revenue: numberString(profile.revenue_krw),
    employees: numberString(profile.employees_count),
    targetType: profile.target_types?.[0] ?? EMPTY_PROFILE_DRAFT.targetType,
    certifications: (profile.certs ?? []).join(", "),
    ip: (profile.ip ?? []).join(", "),
    priorAwards: priorAwards.join(", "),
    noPriorAwards: Array.isArray(profile.prior_awards) && priorAwards.length === 0 && typeof profile.confidence?.prior_award === "number",
  };
}

function buildProfileUpdates(draft: ProfileDraft): ProfileFieldMutation[] {
  const updates: ProfileFieldMutation[] = [];
  const founderAge = numberValue(draft.founderAge);
  const revenue = numberValue(draft.revenue);
  const employees = numberValue(draft.employees);
  const certifications = splitList(draft.certifications);
  const ip = splitList(draft.ip);
  const priorAwards = splitList(draft.priorAwards);

  if (founderAge !== null) updates.push({ field: "founder_age", value: founderAge, confidence: 0.78 });
  if (revenue !== null) updates.push({ field: "revenue", value: revenue, confidence: 0.78 });
  if (employees !== null) updates.push({ field: "employees", value: employees, confidence: 0.78 });
  if (draft.targetType) updates.push({ field: "target_type", value: [draft.targetType], confidence: 0.72 });
  if (certifications.length > 0) updates.push({ field: "certification", value: certifications, confidence: 0.68 });
  if (ip.length > 0) updates.push({ field: "ip", value: ip, confidence: 0.68 });
  if (draft.noPriorAwards) {
    updates.push({ field: "prior_award", value: [], confidence: 0.8 });
  } else if (priorAwards.length > 0) {
    updates.push({ field: "prior_award", value: priorAwards, confidence: 0.72 });
  }

  return updates;
}

function numberString(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function numberValue(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function splitList(value: string): string[] {
  const items = value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(items)];
}
