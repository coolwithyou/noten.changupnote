"use client";

import { useEffect, useMemo, useState } from "react";
import type { ActionResult, ConsentRecordDto, ConsentScope } from "@cunote/contracts";
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

export function CompanySettingsPanel() {
  const [companies, setCompanies] = useState<CompanyRecord[]>([]);
  const [currentCompanyId, setCurrentCompanyId] = useState("");
  const [consents, setConsents] = useState<ConsentRecordDto[]>([]);
  const [status, setStatus] = useState("불러오는 중");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    void refreshSettings();
  }, []);

  const latestByScope = useMemo(() => {
    return new Map(consents.map((consent) => [consent.scope, consent]));
  }, [consents]);

  async function refreshSettings() {
    setStatus("불러오는 중");
    try {
      const [companyResult, consentResult] = await Promise.all([
        fetchJson<WebCompaniesResult>("/api/web/companies"),
        fetchJson<ConsentListResult>("/api/web/consents"),
      ]);
      setCompanies(companyResult.companies);
      setCurrentCompanyId(companyResult.currentCompanyId);
      setConsents(consentResult.consents);
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

  return (
    <section className="dashboard-settings-panel" aria-label="회사 및 동의 설정">
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
