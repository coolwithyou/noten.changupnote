"use client";

import { useCallback, useEffect, useState } from "react";
import type { ActionResult, CompanyProfile, TeaserRequest, TeaserResult } from "@cunote/contracts";
import { ProfileSection } from "./ProfileSection";
import { ProgramsExperience } from "./Programs";
import { ResultsHero } from "./ResultsHero";
import { EmptyState, ErrorState, LoadingState } from "./States";
import {
  PENDING_TEASER_STORAGE_KEY,
  TEASER_FALLBACK_MESSAGE,
  TeaserError,
  hasManualProfile,
  maskBiz,
  mergeCompanyProfileForRequest,
  readManualProfileDraft,
  rememberBusinessLookup,
  writeManualProfileDraft,
  type Status,
} from "./logic";

export function MatchResultsExperience() {
  const [status, setStatus] = useState<Status>("loading");
  const [teaser, setTeaser] = useState<TeaserResult | null>(null);
  const [bizNo, setBizNo] = useState<string | null>(null);
  const [error, setError] = useState<TeaserError | null>(null);
  const [manualProfile, setManualProfile] = useState<CompanyProfile>({});
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  const [continuing, setContinuing] = useState(false);

  const loadTeaser = useCallback(async (request: TeaserRequest) => {
    setStatus("loading");
    setError(null);
    try {
      const response = await fetch("/api/web/teaser", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const payload = (await response.json()) as ActionResult<TeaserResult>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new TeaserError(payload.error?.message ?? TEASER_FALLBACK_MESSAGE, payload.error?.code ?? null);
      }
      setTeaser(payload.data);
      setStatus("ready");
      if (request.bizNo) void rememberBusinessLookup(request.bizNo);
    } catch (caught) {
      const next =
        caught instanceof TeaserError
          ? caught
          : new TeaserError(caught instanceof Error ? caught.message : TEASER_FALLBACK_MESSAGE, null);
      setError(next);
      setStatus("error");
    }
  }, []);

  const applyManualProfile = useCallback(
    async (patch: CompanyProfile) => {
      const nextProfile = mergeCompanyProfileForRequest(manualProfile, patch);
      setManualProfile(nextProfile);
      if (bizNo) writeManualProfileDraft(bizNo, nextProfile);
      setProfileSubmitting(true);
      try {
        await loadTeaser({
          ...(bizNo ? { bizNo } : {}),
          profile: nextProfile,
        });
      } finally {
        setProfileSubmitting(false);
      }
    },
    [bizNo, loadTeaser, manualProfile],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const digits = (params.get("biz") ?? "").replace(/\D/g, "").slice(0, 10);
    if (digits.length !== 10) {
      setStatus("empty");
      return;
    }
    setBizNo(digits);
    const savedManualProfile = readManualProfileDraft(digits);
    setManualProfile(savedManualProfile ?? {});
    void loadTeaser({
      bizNo: digits,
      ...(savedManualProfile && hasManualProfile(savedManualProfile) ? { profile: savedManualProfile } : {}),
    });
  }, [loadTeaser]);

  const maskedBiz = teaser?.companyEvidence?.maskedBizNo ?? (bizNo ? maskBiz(bizNo) : null);

  async function saveAndContinue(grantId?: string) {
    if (continuing) return;
    const request: TeaserRequest | null = bizNo
      ? {
          bizNo,
          ...(hasManualProfile(manualProfile) ? { profile: manualProfile } : {}),
        }
      : null;

    if (request) {
      // 이미 로그인된 사용자는 로그인·홈 재개 경유 없이 회사 저장 후 바로 목적지로 이동
      setContinuing(true);
      try {
        const response = await fetch("/api/web/companies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        const payload = (await response.json()) as ActionResult<{ currentCompanyId: string }>;
        if (response.ok && payload.ok && payload.data?.currentCompanyId) {
          window.location.assign(grantId ? `/grants/${encodeURIComponent(grantId)}` : "/dashboard");
          return;
        }
      } catch {
        // 저장 실패 시 아래 로그인 재개 흐름으로 폴백
      }
      try {
        window.sessionStorage.setItem(PENDING_TEASER_STORAGE_KEY, JSON.stringify(request));
      } catch {
        // storage 불가 시에도 로그인은 진행
      }
    }
    const resumeTarget = grantId ? `/?resumeCompany=1&resumeGrant=${grantId}` : "/?resumeCompany=1";
    const params = new URLSearchParams({ callbackUrl: resumeTarget });
    window.location.assign(`/login?${params.toString()}`);
  }

  return (
    <div className="texture-grain relative min-h-screen w-full overflow-x-hidden bg-background text-foreground">
      <main className="relative mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        {status === "loading" ? <LoadingState /> : null}
        {status === "empty" ? <EmptyState /> : null}
        {status === "error" ? (
          <ErrorState
            error={error}
            onRetry={
              bizNo
                ? () => void loadTeaser({ bizNo, ...(hasManualProfile(manualProfile) ? { profile: manualProfile } : {}) })
                : undefined
            }
          />
        ) : null}
        {status === "ready" && teaser ? (
          <>
            <ResultsHero teaser={teaser} maskedBiz={maskedBiz} onSave={() => void saveAndContinue()} saving={continuing} />
            <ProfileSection teaser={teaser} onProfileSubmit={applyManualProfile} submitting={profileSubmitting} />
            <ProgramsExperience teaser={teaser} onPrepare={saveAndContinue} preparing={continuing} />
          </>
        ) : null}
      </main>
    </div>
  );
}
