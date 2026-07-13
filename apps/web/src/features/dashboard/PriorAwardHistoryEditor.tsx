"use client";

import { useEffect, useState } from "react";
import type { ActionResult, CompanyProfile, PriorAwardSelfKind, PriorAwardState } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/app/status-badge";
import {
  buildPriorAwardProfileValue,
  isCanonicalProgramKnown,
  newPriorAwardRecordDraft,
  PRIOR_AWARD_PROGRAM_OPTIONS,
  priorAwardDraftFromProfile,
  setCanonicalProgramKnown,
  type PriorAwardSettingsDraft,
  type PriorAwardTriState,
} from "./priorAwardSettings";

const SELF_ROWS: Array<{ kind: PriorAwardSelfKind; label: string }> = [
  { kind: "current_similar", label: "현재 동일·유사 정부지원 수행·수혜" },
  { kind: "same_project", label: "동일 과제의 다른 지원 동시 참여" },
  { kind: "same_business_prior", label: "본 사업 과거 선정·입상" },
  { kind: "same_year_other_support", label: "당해연도 타 부처·공공기관 유사 지원" },
];
const TRI_STATE_ITEMS = [
  { value: "unknown", label: "미확인" },
  { value: "no", label: "해당 없음" },
  { value: "yes", label: "해당" },
];
const STATE_ITEMS: Array<{ value: PriorAwardState; label: string }> = [
  { value: "participating", label: "참여 중" },
  { value: "completed", label: "선정·수혜 완료" },
  { value: "graduated", label: "수료·졸업" },
];

export function PriorAwardHistoryEditor({
  profile,
  onSaved,
}: {
  profile: CompanyProfile | undefined;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<PriorAwardSettingsDraft>(() => priorAwardDraftFromProfile(profile));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setDraft(priorAwardDraftFromProfile(profile));
    setMessage("");
  }, [profile]);

  function setSelf(kind: PriorAwardSelfKind, value: PriorAwardTriState) {
    setDraft((current) => ({ ...current, self: { ...current.self, [kind]: value } }));
  }

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const value = buildPriorAwardProfileValue(draft);
      await fetchProfileField({
        field: "prior_award",
        value,
        confidence: 0.6,
        mode: "replace",
      });
      setMessage("수혜·참여 이력을 저장하고 재판정했습니다.");
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "수혜 이력을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius-lg)] border bg-background p-4" aria-label="수혜 참여 이력 수정">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">수혜·참여 이력 정정</h3>
          <p className="text-xs text-muted-foreground">
            미확인은 판정을 보류합니다. 해당 없음으로 답한 범위만 지원 가능 여부 판정에 사용합니다.
          </p>
        </div>
        <StatusBadge tone="neutral">자가신고</StatusBadge>
      </div>

      <FieldGroup className="grid gap-3 md:grid-cols-2">
        {SELF_ROWS.map((row) => (
          <TriStateField
            key={row.kind}
            id={`prior-award-${row.kind}`}
            label={row.label}
            value={draft.self[row.kind]}
            disabled={busy}
            onChange={(value) => setSelf(row.kind, value)}
          />
        ))}
        <TriStateField
          id="prior-award-incubation"
          label="다른 창업보육센터·BI 중복입주"
          value={draft.incubationTenancy}
          disabled={busy}
          onChange={(value) => setDraft((current) => ({ ...current, incubationTenancy: value }))}
        />
      </FieldGroup>

      <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-medium text-foreground">선정·수혜·수료 이력</h4>
            <p className="text-xs text-muted-foreground">사업별 상태와 연도를 입력하세요. 연도는 기간 조건이 있는 공고 판정에 사용됩니다.</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setDraft((current) => ({
              ...current,
              records: [...current.records, newPriorAwardRecordDraft(crypto.randomUUID())],
            }))}
          >
            이력 추가
          </Button>
        </div>
        {draft.records.length === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-dashed p-3 text-xs text-muted-foreground">등록된 이력이 없습니다.</p>
        ) : null}
        {draft.records.map((record, index) => (
          <div key={record.id} className="grid gap-2 rounded-[var(--radius-md)] border bg-card p-3 md:grid-cols-[2fr_1.2fr_1.2fr_0.8fr_auto]">
            <Input
              aria-label={`${index + 1}번째 사업명`}
              placeholder="사업명"
              value={record.program}
              disabled={busy}
              onChange={(event) => updateRecord(setDraft, record.id, { program: event.currentTarget.value })}
            />
            <Input
              aria-label={`${index + 1}번째 주관기관`}
              placeholder="주관기관 (선택)"
              value={record.agency}
              disabled={busy}
              onChange={(event) => updateRecord(setDraft, record.id, { agency: event.currentTarget.value })}
            />
            <Select
              items={STATE_ITEMS}
              value={record.state}
              disabled={busy}
              onValueChange={(value) => {
                if (value === "participating" || value === "completed" || value === "graduated") {
                  updateRecord(setDraft, record.id, { state: value });
                }
              }}
            >
              <SelectTrigger aria-label={`${index + 1}번째 상태`}><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{STATE_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
              ))}</SelectGroup></SelectContent>
            </Select>
            <Input
              aria-label={`${index + 1}번째 연도`}
              inputMode="numeric"
              placeholder="연도"
              value={record.year}
              disabled={busy}
              onChange={(event) => updateRecord(setDraft, record.id, { year: event.currentTarget.value.replace(/\D/g, "") })}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft((current) => ({ ...current, records: current.records.filter((item) => item.id !== record.id) }))}
            >
              삭제
            </Button>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border bg-muted/20 p-3">
        <div>
          <h4 className="text-sm font-medium text-foreground">확인 완료한 대표 사업</h4>
          <p className="text-xs text-muted-foreground">체크 후 이력이 없으면 해당 사업 이력 없음으로 판정합니다. 확인하지 않은 사업은 미확인으로 남습니다.</p>
        </div>
        <FieldGroup className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {PRIOR_AWARD_PROGRAM_OPTIONS.map((program) => (
            <Field key={program.key} orientation="horizontal" className="rounded-[var(--radius-md)] border bg-card p-3">
              <Checkbox
                id={`known-prior-award-${program.key}`}
                checked={isCanonicalProgramKnown(draft, program.key)}
                disabled={busy}
                onCheckedChange={(checked) => setDraft((current) => setCanonicalProgramKnown(current, program.key, checked === true))}
              />
              <FieldLabel htmlFor={`known-prior-award-${program.key}`}>{program.label}</FieldLabel>
            </Field>
          ))}
        </FieldGroup>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={busy} onClick={() => void save()}>
          {busy ? <Spinner data-icon="inline-start" /> : null}
          {busy ? "저장 중" : "수혜 이력 저장"}
        </Button>
        {message ? <p className="text-xs text-muted-foreground" aria-live="polite">{message}</p> : null}
      </div>
    </div>
  );
}

function TriStateField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: PriorAwardTriState;
  disabled: boolean;
  onChange: (value: PriorAwardTriState) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={TRI_STATE_ITEMS}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === "unknown" || next === "yes" || next === "no") onChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>{TRI_STATE_ITEMS.map((item) => (
          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
        ))}</SelectGroup></SelectContent>
      </Select>
    </Field>
  );
}

function updateRecord(
  setDraft: React.Dispatch<React.SetStateAction<PriorAwardSettingsDraft>>,
  id: string,
  patch: Partial<PriorAwardSettingsDraft["records"][number]>,
) {
  setDraft((current) => ({
    ...current,
    records: current.records.map((record) => record.id === id ? { ...record, ...patch } : record),
  }));
}

async function fetchProfileField(body: Record<string, unknown>): Promise<void> {
  const response = await fetch("/api/web/profile/field", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as ActionResult<{ profile: CompanyProfile }>;
  if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? "요청에 실패했습니다.");
}
