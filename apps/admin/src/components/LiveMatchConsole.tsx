"use client";

import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import type { LiveCompanyMatchReport } from "@cunote/core/matching/live-company-match";

interface LiveMatchFormState {
  bizNo: string;
  kstartupLimit: number;
  bizinfoLimit: number;
  bizinfoLlm: boolean;
}

const initialForm: LiveMatchFormState = {
  bizNo: "",
  kstartupLimit: 5,
  bizinfoLimit: 1,
  bizinfoLlm: true,
};

export function LiveMatchConsole() {
  const [form, setForm] = useState(initialForm);
  const [report, setReport] = useState<LiveCompanyMatchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/matches/live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bizNo: form.bizNo.trim() || undefined,
          kstartupLimit: form.kstartupLimit,
          bizinfoLimit: form.bizinfoLimit,
          bizinfoLlm: form.bizinfoLlm,
        }),
      });
      const payload = await response.json() as LiveCompanyMatchReport | { error?: { message?: string } };
      if (!response.ok) {
        const errorPayload = payload as { error?: { message?: string } };
        throw new Error(errorPayload.error?.message ?? "매칭 요청에 실패했습니다.");
      }
      setReport(payload as LiveCompanyMatchReport);
    } catch (caught) {
      setReport(null);
      setError(caught instanceof Error ? caught.message : "매칭 요청에 실패했습니다.");
    } finally {
      setIsLoading(false);
    }
  }

  const combinedCounts = useMemo(() => {
    if (!report) return null;
    return {
      kstartup: Object.entries(report.kstartup.match_counts),
      bizinfo: Object.entries(report.bizinfo.match_counts),
    };
  }, [report]);

  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">Cunote Ops</p>
          <h1 className="ops-title">실사업자 지원사업 매칭</h1>
          <p className="ops-subtitle">
            Popbill, K-Startup, 기업마당, LLM 추출을 한 번에 실행하는 운영자 전용 검증 콘솔입니다.
          </p>
        </div>
        <a className="ops-link-button" href="/">Ops home</a>
      </header>

      <section className="ops-grid">
        <article className="ops-panel">
          <h2>실시간 조회</h2>
          <form className="ops-form" onSubmit={submit}>
            <label>
              <span>사업자번호</span>
              <input
                inputMode="numeric"
                placeholder="기본 테스트 번호 사용"
                value={form.bizNo}
                onChange={(event) => setForm((current) => ({ ...current, bizNo: event.target.value }))}
              />
            </label>
            <div className="ops-form-row">
              <label>
                <span>K-Startup 건수</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={form.kstartupLimit}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    kstartupLimit: Number(event.target.value),
                  }))}
                />
              </label>
              <label>
                <span>기업마당 건수</span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={form.bizinfoLimit}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    bizinfoLimit: Number(event.target.value),
                  }))}
                />
              </label>
            </div>
            <label className="ops-check">
              <input
                type="checkbox"
                checked={form.bizinfoLlm}
                onChange={(event) => setForm((current) => ({ ...current, bizinfoLlm: event.target.checked }))}
              />
              <span>기업마당 LLM criteria 추출 사용</span>
            </label>
            <button className="ops-primary-button" type="submit" disabled={isLoading}>
              {isLoading ? "조회 중" : "실시간 매칭 실행"}
            </button>
            {error ? <p className="ops-error">{error}</p> : null}
          </form>
        </article>

        <article className="ops-panel" style={{ gridColumn: "span 2" }}>
          <h2>결과</h2>
          {report ? (
            <div className="ops-result-stack">
              <div className="ops-metric-grid">
                <Metric label="회사" value={report.company.name ?? "회사명 미확인"} />
                <Metric label="사업자번호" value={report.company.masked_biz_no} />
                <Metric label="소재지" value={report.company.region?.label ?? "미확인"} />
                <Metric label="업력" value={report.company.biz_age_months === null ? "미확인" : `${report.company.biz_age_months}개월`} />
                <Metric label="K-Startup 수집" value={`${report.kstartup.normalized_count}건`} />
                <Metric label="기업마당 평가" value={`${report.bizinfo.evaluated_count}건`} />
              </div>
              {combinedCounts ? (
                <div className="ops-grid compact">
                  <MatchCounts title="K-Startup 판정" counts={combinedCounts.kstartup} />
                  <MatchCounts title="기업마당 판정" counts={combinedCounts.bizinfo} />
                </div>
              ) : null}
            </div>
          ) : (
            <p className="ops-muted">사업자번호를 조회하면 회사 프로필과 지원사업 매칭 결과가 여기에 표시됩니다.</p>
          )}
        </article>
      </section>

      {report ? (
        <section className="ops-grid" style={{ marginTop: 16 }}>
          <MatchList title="K-Startup 후보" matches={report.kstartup.top_matches} />
          <MatchList title="기업마당 후보" matches={report.bizinfo.top_matches} />
        </section>
      ) : null}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function MatchCounts({ title, counts }: { title: string; counts: Array<[string, number]> }) {
  return (
    <div className="ops-panel compact-panel">
      <h3>{title}</h3>
      {counts.length > 0 ? counts.map(([key, value]) => (
        <p className="ops-row" key={key}>
          <span>{eligibilityLabel(key)}</span>
          <strong>{value}</strong>
        </p>
      )) : <p className="ops-muted">판정 없음</p>}
    </div>
  );
}

function MatchList({ title, matches }: { title: string; matches: LiveCompanyMatchReport["kstartup"]["top_matches"] }) {
  return (
    <article className="ops-panel">
      <h2>{title}</h2>
      {matches.length === 0 ? (
        <p className="ops-muted">표시할 후보가 없습니다.</p>
      ) : (
        <ul className="ops-list">
          {matches.map((match) => (
            <li key={`${match.source}:${match.source_id}`}>
              <strong>{match.title}</strong>
              <span>{eligibilityLabel(match.eligibility)} · fit {match.fit_score}</span>
              <small>{match.trace.join(" / ") || "trace 없음"}</small>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function eligibilityLabel(value: string): string {
  if (value === "eligible") return "적합";
  if (value === "conditional") return "확인 필요";
  if (value === "ineligible") return "부적합";
  return value;
}
