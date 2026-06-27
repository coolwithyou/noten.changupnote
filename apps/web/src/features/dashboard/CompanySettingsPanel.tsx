"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type {
  ActionResult,
  CompanyProfile,
  CompanyEnrichmentResult,
  CompanyVerificationResult,
  ConsentRecordDto,
  ConsentScope,
  CriterionDimension,
  NotificationSettingsDto,
} from "@cunote/contracts";
import type { CompanyRecord } from "@cunote/core";

interface WebCompaniesResult {
  currentCompanyId: string;
  companies: CompanyRecord[];
}

interface ConsentListResult {
  companyId: string;
  consents: ConsentRecordDto[];
}

interface ProfileDraft {
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
const EMPTY_PROFILE_DRAFT: ProfileDraft = {
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
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(EMPTY_PROFILE_DRAFT);
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
      setStatus(result.facts.hasBizAge || result.facts.hasIndustry ? "회사정보 보강됨" : "보강 결과 확인 필요");
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

    setBusyKey("verify");
    try {
      const result = await fetchJson<CompanyVerificationResult>("/api/web/companies/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bizNo: normalizedBizNo }),
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
    <section id="company-settings" className="dashboard-settings-panel" aria-label="회사, 동의 및 알림 설정">
      <div className="settings-block">
        <label htmlFor="company-switcher">
          회사
          <select
            id="company-switcher"
            value={currentCompanyId}
            disabled={busyKey === "company" || companies.length <= 1}
            onChange={(event) => void switchCompany(event.target.value)}
          >
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name ?? company.profile.name ?? company.id}
              </option>
            ))}
          </select>
          <span className={currentCompany?.verified ? "settings-company-status verified" : "settings-company-status"}>
            {currentCompany?.verified
              ? `검증됨${currentCompany.bizNoMasked ? ` · ${currentCompany.bizNoMasked}` : ""}`
              : "소유권 미검증"}
          </span>
        </label>
      </div>

      <div className="settings-enrich-form">
        <label htmlFor="company-enrich-biz-no">
          회사정보 보강
          <div className="settings-enrich-row">
            <input
              id="company-enrich-biz-no"
              inputMode="numeric"
              placeholder="사업자번호 10자리"
              value={bizNo}
              disabled={busyKey === "enrich" || busyKey === "verify"}
              onChange={(event) => setBizNo(event.currentTarget.value)}
            />
            <button
              type="button"
              disabled={busyKey === "enrich" || busyKey === "verify" || !basicInfoConsent}
              onClick={() => void enrichCompany()}
            >
              {busyKey === "enrich" ? "조회 중" : "보강"}
            </button>
            <button
              type="button"
              disabled={busyKey === "enrich" || busyKey === "verify"}
              onClick={() => void verifyCompany()}
            >
              {busyKey === "verify" ? "검증 중" : "검증"}
            </button>
          </div>
        </label>
      </div>

      <div className="settings-consent-list">
        {CONSENT_SCOPES.map((scope) => {
          const consent = latestByScope.get(scope);
          const active = Boolean(consent && !consent.revokedAt);
          return (
            <button
              key={scope}
              type="button"
              className={active ? "consent-toggle active" : "consent-toggle"}
              disabled={busyKey === scope}
              onClick={() => void toggleConsent(scope, active)}
            >
              <span>{CONSENT_LABELS[scope]}</span>
              <strong>{active ? "활성" : "미동의"}</strong>
            </button>
          );
        })}
      </div>

      <div className="settings-notification-list">
        {NOTIFICATION_FIELDS.map((item) => {
          const active = Boolean(notifications?.[item.field]);
          return (
            <button
              key={item.field}
              type="button"
              className={active ? "notification-toggle active" : "notification-toggle"}
              disabled={busyKey === item.field || !notifications}
              onClick={() => void toggleNotification(item.field)}
            >
              <span>{item.label}</span>
              <strong>{active ? "켬" : "끔"}</strong>
            </button>
          );
        })}
      </div>

      <p className="settings-status">{status}</p>

      <div className="settings-profile-form" aria-label="수기 프로필 입력">
        <div className="settings-profile-heading">
          <span>수기 프로필</span>
          <strong>자가신고</strong>
        </div>
        <div className="settings-profile-grid">
          <label htmlFor="manual-revenue">
            매출
            <input
              id="manual-revenue"
              inputMode="numeric"
              placeholder="120000000"
              value={profileDraft.revenue}
              disabled={busyKey === "manual-profile"}
              onChange={(event) => updateDraft("revenue", event.currentTarget.value.replace(/\D/g, ""))}
            />
          </label>
          <label htmlFor="manual-employees">
            고용
            <input
              id="manual-employees"
              inputMode="numeric"
              placeholder="12"
              value={profileDraft.employees}
              disabled={busyKey === "manual-profile"}
              onChange={(event) => updateDraft("employees", event.currentTarget.value.replace(/\D/g, ""))}
            />
          </label>
          <label htmlFor="manual-target-type">
            신청대상
            <select
              id="manual-target-type"
              value={profileDraft.targetType}
              disabled={busyKey === "manual-profile"}
              onChange={(event) => updateDraft("targetType", event.currentTarget.value)}
            >
              {TARGET_TYPE_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label htmlFor="manual-certifications">
            인증
            <input
              id="manual-certifications"
              placeholder="벤처기업, 이노비즈"
              value={profileDraft.certifications}
              disabled={busyKey === "manual-profile"}
              onChange={(event) => updateDraft("certifications", event.currentTarget.value)}
            />
          </label>
          <label htmlFor="manual-ip">
            지식재산
            <input
              id="manual-ip"
              placeholder="특허, 상표"
              value={profileDraft.ip}
              disabled={busyKey === "manual-profile"}
              onChange={(event) => updateDraft("ip", event.currentTarget.value)}
            />
          </label>
          <label htmlFor="manual-prior-awards">
            기수혜
            <input
              id="manual-prior-awards"
              placeholder="TIPS, 초기창업패키지"
              value={profileDraft.priorAwards}
              disabled={busyKey === "manual-profile" || profileDraft.noPriorAwards}
              onChange={(event) => updateDraft("priorAwards", event.currentTarget.value)}
            />
          </label>
          <label className="settings-profile-checkbox" htmlFor="manual-no-prior-awards">
            <input
              id="manual-no-prior-awards"
              type="checkbox"
              checked={profileDraft.noPriorAwards}
              disabled={busyKey === "manual-profile"}
              onChange={(event) => updateDraft("noPriorAwards", event.currentTarget.checked)}
            />
            <span>기수혜 없음</span>
          </label>
          <button
            type="button"
            className="settings-profile-save"
            disabled={busyKey === "manual-profile"}
            onClick={() => void saveManualProfile()}
          >
            {busyKey === "manual-profile" ? "저장 중" : "수기 정보 저장"}
          </button>
        </div>
      </div>
    </section>
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

function draftFromProfile(profile: CompanyProfile | undefined): ProfileDraft {
  if (!profile) return EMPTY_PROFILE_DRAFT;
  const priorAwards = profile.prior_awards ?? [];
  return {
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
  const revenue = numberValue(draft.revenue);
  const employees = numberValue(draft.employees);
  const certifications = splitList(draft.certifications);
  const ip = splitList(draft.ip);
  const priorAwards = splitList(draft.priorAwards);

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
