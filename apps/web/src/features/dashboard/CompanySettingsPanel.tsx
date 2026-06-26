"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type {
  ActionResult,
  CompanyEnrichmentResult,
  CompanyVerificationResult,
  ConsentRecordDto,
  ConsentScope,
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

export function CompanySettingsPanel() {
  const router = useRouter();
  const [companies, setCompanies] = useState<CompanyRecord[]>([]);
  const [currentCompanyId, setCurrentCompanyId] = useState("");
  const [consents, setConsents] = useState<ConsentRecordDto[]>([]);
  const [notifications, setNotifications] = useState<NotificationSettingsDto | null>(null);
  const [bizNo, setBizNo] = useState("");
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
