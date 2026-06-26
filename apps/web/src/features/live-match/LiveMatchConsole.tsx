"use client";

import { FormEvent, useMemo, useState } from "react";
import type { LiveMatchFormState, LiveMatchReport } from "./types";

const initialForm: LiveMatchFormState = {
  bizNo: "",
  kstartupLimit: 5,
  bizinfoLimit: 1,
  bizinfoLlm: true,
};

export function LiveMatchConsole() {
  const [form, setForm] = useState(initialForm);
  const [report, setReport] = useState<LiveMatchReport | null>(null);
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
      const payload = await response.json() as LiveMatchReport | { error?: string };
      if (!response.ok) {
        const errorPayload = payload as { error?: string };
        throw new Error(errorPayload.error ?? "매칭 요청에 실패했습니다.");
      }
      setReport(payload as LiveMatchReport);
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
    <main className="app-shell">
      <section className="workspace-header">
        <div>
          <p className="eyebrow">창업노트 내부 MVP</p>
          <h1>실사업자 지원사업 매칭</h1>
        </div>
        <div className="status-strip" aria-label="현재 연결 상태">
          <span>Popbill</span>
          <span>K-Startup</span>
          <span>기업마당</span>
          <span>LLM 추출</span>
        </div>
      </section>

      <section className="workspace-grid">
        <form className="control-panel" onSubmit={submit}>
          <label>
            사업자번호
            <input
              inputMode="numeric"
              placeholder="기본 테스트 번호 사용"
              value={form.bizNo}
              onChange={(event) => setForm((current) => ({ ...current, bizNo: event.target.value }))}
            />
          </label>

          <div className="field-row">
            <label>
              K-Startup 건수
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
              기업마당 건수
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

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={form.bizinfoLlm}
              onChange={(event) => setForm((current) => ({ ...current, bizinfoLlm: event.target.checked }))}
            />
            기업마당 LLM criteria 추출 사용
          </label>

          <button type="submit" disabled={isLoading}>
            {isLoading ? "조회 중" : "실시간 매칭 실행"}
          </button>

          {error ? <p className="error-box">{error}</p> : null}
        </form>

        <section className="result-panel" aria-live="polite">
          {report ? (
            <>
              <CompanySummary report={report} />
              <div className="metric-grid">
                <Metric label="K-Startup 수집" value={`${report.kstartup.normalized_count}건`} />
                <Metric label="기업마당 평가" value={`${report.bizinfo.evaluated_count}건`} />
                <Metric label="LLM 모델" value={report.bizinfo.llm_model ?? "사용 안 함"} />
              </div>
              {combinedCounts ? (
                <div className="count-grid">
                  <MatchCounts title="K-Startup 판정" counts={combinedCounts.kstartup} />
                  <MatchCounts title="기업마당 판정" counts={combinedCounts.bizinfo} />
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty-state">
              <h2>사업자번호를 조회하면 회사 프로필과 지원사업 매칭 결과가 여기에 표시됩니다.</h2>
              <p>기본값은 `.env`의 테스트 사업자번호를 사용합니다.</p>
            </div>
          )}
        </section>
      </section>

      {report ? (
        <section className="matches-section">
          <MatchList title="K-Startup 후보" matches={report.kstartup.top_matches} />
          <MatchList title="기업마당 후보" matches={report.bizinfo.top_matches} />
        </section>
      ) : null}
    </main>
  );
}

function CompanySummary({ report }: { report: LiveMatchReport }) {
  return (
    <div className="company-summary">
      <div>
        <span className="label">회사</span>
        <strong>{report.company.name ?? "회사명 미확인"}</strong>
      </div>
      <div>
        <span className="label">사업자번호</span>
        <strong>{report.company.masked_biz_no}</strong>
      </div>
      <div>
        <span className="label">소재지</span>
        <strong>{report.company.region?.label ?? "미확인"}</strong>
      </div>
      <div>
        <span className="label">업력</span>
        <strong>{report.company.biz_age_months === null ? "미확인" : `${report.company.biz_age_months}개월`}</strong>
      </div>
      <div>
        <span className="label">규모</span>
        <strong>{report.company.size ?? "미확인"}</strong>
      </div>
      <div>
        <span className="label">업종</span>
        <strong>{report.company.industries.join(", ") || "미확인"}</strong>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MatchCounts({ title, counts }: { title: string; counts: Array<[string, number]> }) {
  return (
    <div className="count-box">
      <h2>{title}</h2>
      {counts.length > 0 ? counts.map(([key, value]) => (
        <div key={key} className="count-row">
          <span>{eligibilityLabel(key)}</span>
          <strong>{value}</strong>
        </div>
      )) : <p>판정 없음</p>}
    </div>
  );
}

function MatchList({ title, matches }: { title: string; matches: LiveMatchReport["kstartup"]["top_matches"] }) {
  return (
    <section className="match-list">
      <div className="section-title">
        <h2>{title}</h2>
        <span>{matches.length}건</span>
      </div>
      <div className="match-table">
        {matches.length > 0 ? matches.map((match) => (
          <article key={`${match.source}:${match.source_id}`} className="match-row">
            <div>
              <span className={`badge ${match.eligibility}`}>{eligibilityLabel(match.eligibility)}</span>
              <h3>{match.title}</h3>
              <p>{match.trace.join(" / ")}</p>
            </div>
            <div className="score-cell">
              <strong>{match.fit_score}</strong>
              <span>{match.status}</span>
            </div>
          </article>
        )) : <p className="empty-list">표시할 후보가 없습니다.</p>}
      </div>
    </section>
  );
}

function eligibilityLabel(value: string) {
  if (value === "eligible") return "적격";
  if (value === "conditional") return "조건부";
  if (value === "ineligible") return "부적격";
  return value;
}
