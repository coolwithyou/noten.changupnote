"use client";

import { useEffect, useState } from "react";
import { Pencil, Plus, ShieldCheck, TriangleAlert } from "lucide-react";
import type { CompanyProfile, TeaserResult } from "@cunote/contracts";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  REVENUE_UNIT_OPTIONS,
  buildProfileFields,
  buildProfilePatch,
  decimalNumberText,
  digitsOnly,
  evidenceCheckedNote,
  initialProfileInputDraft,
  profileFieldDisplayLabel,
  profileInputDescription,
  profileInputMode,
  profileInputPlaceholder,
  profileInputSuggestions,
  profileInputText,
  revenueUnitLabel,
  sparseRegistryNotice,
  toRevenueUnit,
  type ProfileFieldView,
  type ProfileInputDraft,
} from "./logic";

export function ProfileSection({
  teaser,
  onProfileSubmit,
  submitting,
}: {
  teaser: TeaserResult;
  onProfileSubmit: (patch: CompanyProfile) => Promise<void>;
  submitting: boolean;
}) {
  const fields = buildProfileFields(teaser);
  const [activeFieldKey, setActiveFieldKey] = useState<string | null>(null);
  const known = fields.filter((field) => field.available).length;
  const total = fields.length || 1;
  const pct = Math.round((known / total) * 100);
  const checkedNote = evidenceCheckedNote(teaser.companyEvidence ?? null);
  const registryNotice = sparseRegistryNotice(teaser.companyEvidence ?? null);

  useEffect(() => {
    if (!activeFieldKey) return;
    const next = fields.find((field) => field.key === activeFieldKey);
    if (!next) setActiveFieldKey(null);
  }, [activeFieldKey, fields]);

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <ShieldCheck data-icon="inline-start" className="text-success" aria-hidden />
            <h2 className="font-heading text-lg font-semibold tracking-tight">내 사업자 분석</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            사업자번호로 불러온 정보를 시스템 표준 조건으로 정규화했어요. 빈 항목을 채우면 매칭이 더 정확해져요.
          </p>
          {checkedNote ? <p className="text-xs text-muted-foreground/80">{checkedNote}</p> : null}
        </div>
        <Card size="sm" className="w-full shrink-0 md:w-72">
          <CardContent className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-muted-foreground">정보 충족도</span>
              <span className="font-semibold text-primary tabular-nums">
                {known} / {total} 확정
              </span>
            </div>
            <Progress value={pct} aria-label="정보 충족도" />
          </CardContent>
        </Card>
      </div>

      {registryNotice ? (
        <Card size="sm" className="ring-primary/20">
          <CardContent className="flex gap-3">
            <TriangleAlert className="mt-0.5 size-4 flex-none text-primary" aria-hidden />
            <div className="flex flex-col gap-1">
              <div className="font-medium text-foreground">{registryNotice.title}</div>
              <p className="text-sm leading-6 text-muted-foreground">{registryNotice.body}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => {
          const isActive = activeFieldKey === field.key;
          return (
            <Card
              key={field.key}
              size="sm"
              className={cn(
                "transition-shadow",
                !field.available && "bg-muted/30",
                isActive && "ring-primary/40",
              )}
            >
              <CardContent className="flex flex-col gap-2">
                <div className="text-xs font-medium tracking-wide text-muted-foreground">
                  {profileFieldDisplayLabel(field)}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "font-heading text-base font-semibold leading-snug",
                      !field.available && "text-muted-foreground",
                    )}
                  >
                    {field.available ? field.value : "미입력"}
                  </span>
                  {field.available ? null : (
                    <Badge variant="outline" className="text-muted-foreground">
                      선택 입력
                    </Badge>
                  )}
                </div>
                {isActive ? (
                  <ProfileInputPanel
                    field={field}
                    submitting={submitting}
                    onCancel={() => setActiveFieldKey(null)}
                    onSubmit={async (patch) => {
                      setActiveFieldKey(null);
                      await onProfileSubmit(patch);
                    }}
                  />
                ) : (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setActiveFieldKey(field.key)}
                    className="w-fit px-0 hover:bg-transparent"
                  >
                    {field.available ? (
                      <Pencil data-icon="inline-start" strokeWidth={2.25} />
                    ) : (
                      <Plus data-icon="inline-start" strokeWidth={3} />
                    )}
                    {field.available ? "수정" : "입력하기"}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function ProfileInputPanel({
  field,
  submitting,
  onCancel,
  onSubmit,
}: {
  field: ProfileFieldView;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (patch: CompanyProfile) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProfileInputDraft>(() => initialProfileInputDraft(field.key, field.value));
  const [error, setError] = useState<string | null>(null);
  const suggestions = profileInputSuggestions(field.key);
  const usesStructuredNumericInput =
    field.key === "biz_age" ||
    field.key === "bizAge" ||
    field.key === "founder_age" ||
    field.key === "employees" ||
    field.key === "revenue";

  useEffect(() => {
    setDraft(initialProfileInputDraft(field.key, field.value));
    setError(null);
  }, [field.key, field.value]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = buildProfilePatch(field.key, draft);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    await onSubmit(result.profile);
  }

  return (
    <form className="flex flex-col gap-2 pt-1" onSubmit={submit}>
      {usesStructuredNumericInput ? (
        <StructuredNumericProfileInput
          fieldKey={field.key}
          draft={draft}
          error={Boolean(error)}
          onChange={setDraft}
        />
      ) : (
        <Combobox
          items={suggestions}
          value={draft.value}
          onValueChange={(value) => {
            if (typeof value === "string") {
              setDraft((current) => ({ ...current, value }));
            }
          }}
        >
          <ComboboxInput
            aria-invalid={Boolean(error)}
            autoFocus
            className="w-full"
            inputMode={profileInputMode(field.key)}
            placeholder={profileInputPlaceholder(field.key)}
            showClear
            value={draft.value}
            onChange={(event) => {
              const next = profileInputText(field.key, event.currentTarget.value);
              setDraft((current) => ({ ...current, value: next }));
            }}
          />
          <ComboboxContent>
            <ComboboxEmpty>직접 입력 후 반영</ComboboxEmpty>
            <ComboboxList>
              {(item) => (
                <ComboboxItem key={item} value={item}>
                  {item}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      )}
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
      <p className="text-xs leading-5 text-muted-foreground">{profileInputDescription(field.key)}</p>
      <div className="flex items-center justify-end gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel} disabled={submitting}>
          닫기
        </Button>
        <Button type="submit" size="xs" disabled={submitting}>
          {submitting ? "반영 중" : "반영"}
        </Button>
      </div>
    </form>
  );
}

function StructuredNumericProfileInput({
  fieldKey,
  draft,
  error,
  onChange,
}: {
  fieldKey: string;
  draft: ProfileInputDraft;
  error: boolean;
  onChange: React.Dispatch<React.SetStateAction<ProfileInputDraft>>;
}) {
  if (fieldKey === "revenue") {
    return (
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_88px] gap-2">
        <Input
          aria-invalid={error}
          autoFocus
          inputMode="decimal"
          placeholder={profileInputPlaceholder(fieldKey)}
          value={draft.value}
          className="h-8 min-w-0 rounded-lg px-3 py-1 text-sm shadow-none"
          onChange={(event) => {
            const next = decimalNumberText(event.currentTarget.value);
            onChange((current) => ({ ...current, value: next }));
          }}
        />
        <Select
          value={draft.unit}
          onValueChange={(value) =>
            onChange((current) => ({ ...current, unit: toRevenueUnit(value) }))
          }
        >
          <SelectTrigger aria-label="연 매출 단위" size="sm" className="h-8 w-full rounded-lg px-3 text-sm">
            <SelectValue>{(value) => revenueUnitLabel(toRevenueUnit(value))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {REVENUE_UNIT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (fieldKey === "biz_age" || fieldKey === "bizAge") {
    return (
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <NumericSuffixInput
          ariaInvalid={error}
          autoFocus
          placeholder="8"
          suffix="년"
          value={draft.value}
          onValueChange={(next) => onChange((current) => ({ ...current, value: digitsOnly(next) }))}
        />
        <NumericSuffixInput
          ariaInvalid={error}
          placeholder="4"
          suffix="개월"
          value={draft.secondaryValue}
          onValueChange={(next) => onChange((current) => ({ ...current, secondaryValue: digitsOnly(next) }))}
        />
      </div>
    );
  }

  return (
    <NumericSuffixInput
      ariaInvalid={error}
      autoFocus
      placeholder={profileInputPlaceholder(fieldKey)}
      suffix={fieldKey === "founder_age" ? "년생" : "명"}
      value={draft.value}
      onValueChange={(next) => onChange((current) => ({ ...current, value: profileInputText(fieldKey, next) }))}
    />
  );
}

function NumericSuffixInput({
  ariaInvalid,
  autoFocus,
  placeholder,
  suffix,
  value,
  onValueChange,
}: {
  ariaInvalid: boolean;
  autoFocus?: boolean;
  placeholder: string;
  suffix: string;
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <div className="relative min-w-0">
      <Input
        aria-invalid={ariaInvalid}
        autoFocus={autoFocus}
        inputMode="numeric"
        placeholder={placeholder}
        value={value}
        className={cn("h-8 min-w-0 rounded-lg py-1 pl-3 text-sm shadow-none", suffix.length >= 2 ? "pr-14" : "pr-9")}
        onChange={(event) => onValueChange(event.currentTarget.value)}
      />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm font-medium text-muted-foreground">
        {suffix}
      </span>
    </div>
  );
}
