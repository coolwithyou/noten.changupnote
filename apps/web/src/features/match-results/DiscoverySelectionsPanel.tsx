"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionResult } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { COMPANY_CONTEXT_HEADER, withCompanyContext } from "@/lib/navigation/companyContext";
import type { DiscoveryPage, DiscoveryRow } from "@/lib/matches/discoverySelections";
import { matchDetailHref } from "./logic";

/** 회사별로 remount하여 이전 회사의 비동기 응답·목록이 섞이지 않게 한다. */
export function DiscoverySelectionsPanel({ companyId }: { companyId: string }) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return <div className="mt-6 border-t border-border-subtle">
    <DiscoveryList key={`restored:${companyId}`} companyId={companyId} view="restored" revision={revision} onChanged={refresh} />
    <DiscoveryList key={`excluded:${companyId}`} companyId={companyId} view="excluded" revision={revision} onChanged={refresh} />
  </div>;
}

function DiscoveryList({ companyId, view, revision, onChanged }: {
  companyId: string; view: "excluded" | "restored"; revision: number; onChanged: () => void;
}) {
  const [open, setOpen] = useState(view === "restored");
  const [page, setPage] = useState<DiscoveryPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const load = useCallback(async (offset = 0) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/web/company-matching/discovery?view=${view}&offset=${offset}`, {
        headers: { [COMPANY_CONTEXT_HEADER]: companyId }, signal: controller.signal, cache: "no-store",
      });
      const result = await response.json() as ActionResult<DiscoveryPage>;
      if (!response.ok || !result.ok || !result.data) throw new Error(result.error?.message ?? "목록을 불러오지 못했습니다.");
      if (controller.signal.aborted) return;
      const next = result.data;
      setPage((previous) => offset === 0 ? next : { ...next,
        rows: [...new Map([...(previous?.rows ?? []), ...next.rows].map((row) => [row.match.grantId, row])).values()],
      });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "목록을 불러오지 못했습니다.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }, [companyId, view]);
  useEffect(() => {
    if (open) { setPage(null); void load(); }
    return () => request.current?.abort();
  }, [load, open, revision, reload]);
  useEffect(() => () => saveRequest.current?.abort(), []);

  async function save(row: DiscoveryRow) {
    if (savingId) return;
    const controller = new AbortController(); saveRequest.current = controller;
    setSavingId(row.match.grantId); setError("");
    try {
      const response = await fetch("/api/web/company-matching/discovery", {
        method: "PUT", headers: { "Content-Type": "application/json", [COMPANY_CONTEXT_HEADER]: companyId }, signal: controller.signal,
        body: JSON.stringify({ grantId: row.match.grantId, restored: view === "excluded", expectedRevision: row.selection.revision }),
      });
      const result = await response.json() as ActionResult<unknown>;
      if (!response.ok || !result.ok) throw new Error(result.error?.message ?? "선택을 저장하지 못했습니다.");
      if (!controller.signal.aborted) onChanged();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "선택을 저장하지 못했습니다.");
    } finally { if (!controller.signal.aborted) setSavingId(null); }
  }
  if (view === "restored" && page?.total === 0 && !error) return null;
  const title = view === "restored" ? "다시 살펴볼 공고" : "제외된 공고 보기";
  return <section className="py-4" aria-label={title}>
    <Button type="button" variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {title}{page ? ` · ${page.total}건` : ""}
    </Button>
    {open ? <div className="mt-2 space-y-3">
      <p className="text-sm text-text-secondary">
        {view === "restored" ? "직접 복원한 후보입니다. 자격 판정은 그대로이며 마감한 공고는 이 목록에서 빠집니다."
          : "현재 확인한 필수조건 불일치로 제외한 공고입니다. 마감한 공고는 검토 목록에 포함하지 않습니다."}
      </p>
      {page?.rows.map((row) => <article key={row.match.grantId} className="rounded-xl border border-border-subtle p-4">
        <a className="font-bold text-ink" href={withCompanyContext(matchDetailHref(row.match), companyId)}>{row.match.title}</a>
        <p className="mt-1 text-sm text-text-secondary">{row.decision.reason === "confirmed_mismatch" ? "확인한 필수조건과 회사 정보가 맞지 않습니다." : "현재 조건과 원문을 다시 확인해 주세요."}</p>
        {row.match.ruleTrace.filter((trace) => trace.result === "fail" && (trace.kind === "required" || trace.kind === "exclusion"))
          .filter((trace) => row.decision.criterionIds.length === 0 || (trace.criterionId && row.decision.criterionIds.includes(trace.criterionId)))
          .map((trace, index) => <p key={`${trace.criterionId}:${index}`} className="mt-2 text-sm text-text-secondary">{trace.sourceSpan || trace.label}</p>)}
        <p className="mt-2 text-xs text-text-secondary">판단 기준: {page.asOf.replace("T", " ").slice(0, 16)} UTC</p>
        {page.canWrite ? <Button type="button" variant="outline" size="sm" className="mt-3" disabled={savingId !== null || busy} onClick={() => void save(row)}>
          {savingId === row.match.grantId ? "저장 중…" : view === "excluded" ? "다시 살펴볼 공고로 복원" : "복원 취소"}
        </Button> : null}
      </article>)}
      {busy ? <p role="status" className="text-sm">목록을 불러오는 중…</p> : null}
      {error ? <div role="alert" className="text-sm"><p>{error}</p><Button type="button" variant="outline" onClick={() => setReload((value) => value + 1)}>목록 새로고침</Button></div> : null}
      {page?.total === 0 ? <p className="text-sm text-text-secondary">표시할 공고가 없습니다.</p> : null}
      {page?.nextOffset !== null && page?.nextOffset !== undefined ? <Button type="button" variant="outline" disabled={busy || savingId !== null} onClick={() => void load(page.nextOffset!)}>더 보기</Button> : null}
    </div> : null}
  </section>;
}
