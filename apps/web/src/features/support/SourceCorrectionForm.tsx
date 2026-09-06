"use client";
import { useState } from "react";
import { SOURCE_CORRECTION_LABELS, sourceCorrectionIsOpen, type MatchingProfileViewRow, type SourceCorrectionRecord } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select";
import { PROFILE_DIMENSION_LABELS } from "@/features/match-results/logic";

export function SourceCorrectionForm({ companyId, rows, initialRecords, canWrite }: {
  companyId: string; rows: MatchingProfileViewRow[]; initialRecords: SourceCorrectionRecord[]; canWrite: boolean;
}) {
  const official = rows.filter((row) => row.sourceKind === "authoritative_api" || row.sourceKind === "public_registry");
  const [dimension, setDimension] = useState(official[0]?.dimension ?? "");
  const [statement, setStatement] = useState("");
  const [records, setRecords] = useState(initialRecords);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const selected = official.find((row) => row.dimension === dimension);
  async function act(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/web/profile/source-corrections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, companyId }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? "요청을 처리하지 못했습니다.");
      const record = payload.data as SourceCorrectionRecord;
      setRecords((current) => [record, ...current.filter((item) => item.id !== record.id)]);
      setNotice(body.action === "submit" ? "정정 요청을 접수했습니다. 공식값은 보존되며 해당 조건은 확인 필요로 표시됩니다." : "처리 상태를 저장했습니다. 매칭 화면을 다시 조회하면 반영됩니다.");
      if (body.action === "submit") setStatement("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "요청을 처리하지 못했습니다."); }
    finally { setBusy(false); }
  }
  return <div className="flex flex-col gap-6">
    <Alert><AlertDescription>직접 입력한 정보는 프로필에서 바로 수정할 수 있습니다. 공식값 정정은 관리자 검수 후 반영합니다. 주민등록번호·서명·비밀번호는 적지 마세요.</AlertDescription></Alert>
    <form onSubmit={(event) => { event.preventDefault(); void act({ action: "submit", dimension, statement }); }}>
      <FieldGroup>
        <Field><FieldLabel htmlFor="correction-field">정정할 정보</FieldLabel>
          <Select value={dimension} onValueChange={(value) => { if (value) setDimension(value); }} disabled={!canWrite || busy || !official.length}>
            <SelectTrigger id="correction-field"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{official.map((row) => <SelectItem key={row.dimension} value={row.dimension}>{PROFILE_DIMENSION_LABELS[row.dimension]}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
          <FieldDescription>{selected ? `${selected.displayValue ?? "값 없음"} · ${selected.sourceLabel} · 기준일 ${selected.asOf ?? "확인 필요"}` : "정정을 요청할 공식 확인값이 없습니다."}</FieldDescription>
        </Field>
        <Field><FieldLabel htmlFor="correction-statement">실제 상황과 다른 점</FieldLabel>
          <Textarea id="correction-statement" required minLength={10} maxLength={2000} value={statement} disabled={!canWrite || busy} onChange={(event) => setStatement(event.target.value)} />
          <FieldDescription>사용자 설명은 공식값과 별도로 보관하며, 설명만으로 적격 여부를 확정하지 않습니다.</FieldDescription>
        </Field>
        <Button type="submit" disabled={busy || !canWrite || !selected}>{busy ? "처리 중…" : "정정 요청 접수"}</Button>
      </FieldGroup>
    </form>
    {notice ? <p role="status">{notice}</p> : null}
    <h2>내 정정 요청</h2>
    {records.length === 0 ? <p>접수한 정정 요청이 없습니다.</p> : null}
    {records.map((record) => <section key={record.id} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2"><h3>{PROFILE_DIMENSION_LABELS[record.dimension]}</h3><Badge variant="secondary">{SOURCE_CORRECTION_LABELS[record.status]}</Badge></div>
      <p>접수 당시: {record.baseline.displayValue ?? "값 없음"} · {record.baseline.evidence.provider} · {record.baseline.evidence.asOf ?? "기준일 확인 필요"}</p>
      <p className="whitespace-pre-wrap">{record.statement}</p>
      {record.events.map((event, index) => <p key={index}>{event.at} · {event.note}</p>)}
      {canWrite && sourceCorrectionIsOpen(record.status) ? <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void act({ action: "recheck", id: record.id, revision: record.revision })}>서비스 보유 원천 재확인</Button>
        <Button variant="outline" disabled={busy} onClick={() => void act({ action: "withdraw", id: record.id, revision: record.revision })}>요청 철회</Button>
      </div> : null}
      <p>재확인은 현재 보유한 공식 자료를 읽습니다. 외부 기관 정보 갱신이나 관리자 검수 완료를 뜻하지 않습니다.</p>
    </section>)}
  </div>;
}
