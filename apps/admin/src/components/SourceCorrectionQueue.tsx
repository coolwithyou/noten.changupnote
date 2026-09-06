"use client";
import { useState } from "react";
import { canVerifySourceCorrection, SOURCE_CORRECTION_LABELS, sourceCorrectionIsOpen, type SourceCorrectionRecord } from "@cunote/contracts";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { reviewDimensionLabel } from "@/lib/review/itemPresentation";

export function SourceCorrectionQueue({ initialRecords }: { initialRecords: SourceCorrectionRecord[] }) {
  const [records, setRecords] = useState(initialRecords);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(record: SourceCorrectionRecord, action: string) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/source-corrections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: record.id, revision: record.revision, action, note: notes[record.id] ?? "" }) });
      const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload.error?.message ?? "처리하지 못했습니다.");
      setRecords((current) => current.map((item) => item.id === record.id ? payload.data : item));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "처리하지 못했습니다."); }
    finally { setBusy(false); }
  }
  return <div className="flex flex-col gap-4">
    <Alert><AlertDescription>공식값 직접 입력·덮어쓰기는 제공하지 않습니다. 기관 갱신 또는 내부 수집·해석 오류를 기존 원천 처리 경로에서 수정한 뒤, 요청자가 서비스 보유 원천을 재확인하면 그 결과를 검수합니다. 처리 근거는 사용자에게 공개됩니다.</AlertDescription></Alert>
    {error ? <p role="alert">{error}</p> : null}
    {records.length === 0 ? <p>접수한 정정 요청이 없습니다.</p> : null}
    {records.map((record) => <Card key={record.id}>
      <CardHeader><CardTitle>{reviewDimensionLabel(record.dimension)}</CardTitle><CardDescription>회사 {record.companyId} · 문의 {record.ticketId}</CardDescription><Badge variant="secondary">{SOURCE_CORRECTION_LABELS[record.status]}</Badge></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p>접수 원천: {record.baseline.displayValue ?? "값 없음"} · {record.baseline.evidence.provider} · {record.baseline.evidence.asOf ?? "기준일 없음"}</p>
        <p className="whitespace-pre-wrap">사용자 설명: {record.statement}</p>
        <p>재확인 원천: {record.observation ? `${record.observation.displayValue ?? "값 없음"} · ${record.observation.evidence.provider} · ${record.observation.evidence.asOf ?? "기준일 없음"}` : "아직 없음"}</p>
        <details><summary>처리 이력 ({record.events.length})</summary>{record.events.map((event, index) => <p key={index}>{event.at} · {event.actor} · {event.note}</p>)}</details>
        {sourceCorrectionIsOpen(record.status) ? <FieldGroup><Field><FieldLabel htmlFor={`note-${record.id}`}>사용자에게 안내할 처리 근거</FieldLabel><Textarea id={`note-${record.id}`} minLength={10} maxLength={2000} disabled={busy} value={notes[record.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [record.id]: event.target.value }))} /></Field></FieldGroup> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">{sourceCorrectionIsOpen(record.status) ? <>
        <Button variant="outline" disabled={busy} onClick={() => void act(record, "review")}>검토 시작</Button>
        <Button variant="outline" disabled={busy} onClick={() => void act(record, "wait")}>원천 확인 대기</Button>
        <Button disabled={busy || record.status !== "reviewing" || !canVerifySourceCorrection(record)} onClick={() => void act(record, "verify")}>갱신값 검수 완료</Button>
        <Button variant="outline" disabled={busy} onClick={() => void act(record, "reject")}>사유 안내 후 종결</Button>
      </> : <p>처리 완료 이력은 수정하지 않습니다.</p>}</CardFooter>
    </Card>)}
    <p>최근 갱신된 요청 최대 100건입니다.</p>
  </div>;
}
