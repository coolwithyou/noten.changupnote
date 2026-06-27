"use client";

import { FormEvent, useMemo, useState } from "react";
import { MetricCard } from "@/components/app/metric-card";
import { StatusBadge, eligibilityTone } from "@/components/app/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
        <Card className="control-panel">
          <CardContent className="p-0">
            <form className="control-panel-form" onSubmit={submit}>
              <FieldGroup>
                <Field>
                  <FieldLabel>사업자번호</FieldLabel>
                  <Input
                    inputMode="numeric"
                    placeholder="기본 테스트 번호 사용"
                    value={form.bizNo}
                    onChange={(event) => setForm((current) => ({ ...current, bizNo: event.target.value }))}
                  />
                </Field>

                <div className="field-row">
                  <Field>
                    <FieldLabel>K-Startup 건수</FieldLabel>
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={form.kstartupLimit}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        kstartupLimit: Number(event.target.value),
                      }))}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>기업마당 건수</FieldLabel>
                    <Input
                      type="number"
                      min={0}
                      max={5}
                      value={form.bizinfoLimit}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        bizinfoLimit: Number(event.target.value),
                      }))}
                    />
                  </Field>
                </div>

                <Field className="toggle-row" orientation="horizontal">
                  <Checkbox
                    checked={form.bizinfoLlm}
                    onCheckedChange={(checked) => setForm((current) => ({ ...current, bizinfoLlm: checked === true }))}
                  />
                  <FieldContent>
                    <FieldLabel>기업마당 LLM criteria 추출 사용</FieldLabel>
                  </FieldContent>
                </Field>

                <Button type="submit" disabled={isLoading}>
                  {isLoading ? <Spinner data-icon="inline-start" /> : null}
                  {isLoading ? "조회 중" : "실시간 매칭 실행"}
                </Button>

                {error ? (
                  <Alert variant="destructive" className="error-box">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
              </FieldGroup>
            </form>
          </CardContent>
        </Card>

        <Card className="result-panel" aria-live="polite">
          {report ? (
            <CardContent className="grid gap-4 p-0">
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
            </CardContent>
          ) : (
            <Empty className="empty-state">
              <EmptyHeader>
                <EmptyTitle>매칭 결과 대기</EmptyTitle>
                <EmptyDescription>
                  사업자번호를 조회하면 회사 프로필과 지원사업 매칭 결과가 여기에 표시됩니다. 기본값은 `.env`의 테스트 사업자번호를 사용합니다.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </Card>
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
      <MetricCard label="회사" value={report.company.name ?? "회사명 미확인"} />
      <MetricCard label="사업자번호" value={report.company.masked_biz_no} />
      <MetricCard label="소재지" value={report.company.region?.label ?? "미확인"} />
      <MetricCard label="업력" value={report.company.biz_age_months === null ? "미확인" : `${report.company.biz_age_months}개월`} />
      <MetricCard label="규모" value={report.company.size ?? "미확인"} />
      <MetricCard label="업종" value={report.company.industries.join(", ") || "미확인"} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <MetricCard className="metric" label={label} value={value} />;
}

function MatchCounts({ title, counts }: { title: string; counts: Array<[string, number]> }) {
  return (
    <Card className="count-box" size="sm">
      <h2>{title}</h2>
      {counts.length > 0 ? counts.map(([key, value]) => (
        <div key={key} className="count-row">
          <span>{eligibilityLabel(key)}</span>
          <strong>{value}</strong>
        </div>
      )) : <p>판정 없음</p>}
    </Card>
  );
}

function MatchList({ title, matches }: { title: string; matches: LiveMatchReport["kstartup"]["top_matches"] }) {
  return (
    <Card className="match-list">
      <div className="section-title">
        <h2>{title}</h2>
        <span>{matches.length}건</span>
      </div>
      {matches.length > 0 ? (
        <Table className="match-table">
          <TableHeader>
            <TableRow>
              <TableHead>판정</TableHead>
              <TableHead>공고</TableHead>
              <TableHead>상태</TableHead>
              <TableHead className="text-right">점수</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {matches.map((match) => (
              <TableRow key={`${match.source}:${match.source_id}`}>
                <TableCell>
                  <StatusBadge className={`badge ${match.eligibility}`} tone={eligibilityTone(match.eligibility as "eligible" | "conditional" | "ineligible")}>
                    {eligibilityLabel(match.eligibility)}
                  </StatusBadge>
                </TableCell>
                <TableCell className="match-title-cell">
                  <h3>{match.title}</h3>
                  <p>{match.trace.join(" / ")}</p>
                </TableCell>
                <TableCell>{match.status}</TableCell>
                <TableCell className="score-cell">
                  <strong>{match.fit_score}</strong>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Empty className="empty-list">
          <EmptyDescription>표시할 후보가 없습니다.</EmptyDescription>
        </Empty>
      )}
    </Card>
  );
}

function eligibilityLabel(value: string) {
  if (value === "eligible") return "적격";
  if (value === "conditional") return "조건부";
  if (value === "ineligible") return "부적격";
  return value;
}
