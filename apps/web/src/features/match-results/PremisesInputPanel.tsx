"use client";

import { useId, useState, type FormEvent } from "react";
import type {
  MatchingProfileAnswerRequest,
  PremisesFacilityType,
  PremisesProfileValue,
} from "@cunote/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { KOREA_REGION_OPTIONS } from "@/lib/regions";

type PremisesCompleteness = "partial" | "complete";

export interface PremisesLocationDraft {
  locationId: string | null;
  facilityType: PremisesFacilityType | null;
  sidoCode: string | null;
  validFrom: string;
  validTo: string | null;
}

export interface PremisesAnswerDraft {
  locations: PremisesLocationDraft[];
  coverageFacilityTypes: PremisesFacilityType[];
  coverageValidFrom: string;
  coverageValidTo: string;
  completeness: PremisesCompleteness | null;
}

type PremisesLocationField = "locationId" | "facilityType" | "sidoCode" | "validFrom" | "validTo";

export type PremisesAnswerField =
  | "locations"
  | `locations.${number}.${PremisesLocationField}`
  | "coverageFacilityTypes"
  | "coverageValidFrom"
  | "coverageValidTo"
  | "completeness"
  | "submit";

export type BuildPremisesAnswerResult =
  | { ok: true; answer: MatchingProfileAnswerRequest; locationIds: string[] }
  | { ok: false; field: PremisesAnswerField; error: string };

const MAX_LOCATIONS = 10;
const FACILITY_OPTIONS: ReadonlyArray<{ value: PremisesFacilityType; label: string }> = [
  { value: "headquarters", label: "본사" },
  { value: "factory", label: "공장" },
  { value: "research_institute", label: "연구소" },
];
const COMPLETENESS_OPTIONS: ReadonlyArray<{ value: PremisesCompleteness; label: string }> = [
  { value: "partial", label: "일부만 확인" },
  { value: "complete", label: "이 범위를 모두 확인" },
];
const FACILITY_TYPES = new Set<PremisesFacilityType>(FACILITY_OPTIONS.map((option) => option.value));
const SIDO_CODES = new Set<string>(KOREA_REGION_OPTIONS.map((option) => option.code));
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function PremisesInputPanel({
  initialValue,
  readOnly,
  readOnlyMessage,
  submitting,
  onCancel,
  onSubmit,
}: {
  initialValue?: PremisesProfileValue | null;
  readOnly: boolean;
  readOnlyMessage?: string;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (answer: MatchingProfileAnswerRequest) => Promise<void>;
}) {
  // The parent keys this editor by company/open lifecycle. Background profile refreshes must not erase edits.
  const [draft, setDraft] = useState<PremisesAnswerDraft>(() => premisesAnswerDraftFromValue(initialValue));
  const [error, setError] = useState<Extract<BuildPremisesAnswerResult, { ok: false }> | null>(null);
  const coverageValidFromId = useId();
  const coverageValidToId = useId();
  const completenessId = useId();
  const today = koreaCalendarDate(new Date());
  const controlsDisabled = readOnly || submitting;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly || submitting) return;

    const result = buildPremisesAnswer(draft, {
      createLocationId: () => globalThis.crypto.randomUUID(),
      today,
    });
    if (!result.ok) {
      setError(result);
      return;
    }

    // Keep IDs assigned to new rows stable if the request fails and the user retries.
    setDraft((current) => ({
      ...current,
      locations: current.locations.map((location, index) => ({
        ...location,
        locationId: location.locationId ?? result.locationIds[index] ?? null,
      })),
    }));
    setError(null);
    try {
      await onSubmit(result.answer);
    } catch (caught) {
      setError({
        ok: false,
        field: "submit",
        error: caught instanceof Error ? caught.message : "사업장 정보를 반영하지 못했어요. 다시 시도해주세요.",
      });
    }
  }

  function changeLocation(index: number, change: Partial<PremisesLocationDraft>) {
    setDraft((current) => ({
      ...current,
      locations: current.locations.map((location, locationIndex) =>
        locationIndex === index ? { ...location, ...change } : location),
    }));
    setError(null);
  }

  function selectLocationFacility(index: number, facilityType: PremisesFacilityType) {
    setDraft((current) => ({
      ...current,
      locations: current.locations.map((location, locationIndex) =>
        locationIndex === index ? { ...location, facilityType } : location),
      coverageFacilityTypes: current.coverageFacilityTypes.includes(facilityType)
        ? current.coverageFacilityTypes
        : [...current.coverageFacilityTypes, facilityType],
    }));
    setError(null);
  }

  function addLocation() {
    setDraft((current) => current.locations.length >= MAX_LOCATIONS
      ? current
      : { ...current, locations: [...current.locations, emptyPremisesLocationDraft()] });
    setError(null);
  }

  function removeLocation(index: number) {
    setDraft((current) => ({
      ...current,
      locations: current.locations.filter((_, locationIndex) => locationIndex !== index),
    }));
    setError(null);
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={submit}>
      <Alert>
        <AlertTitle>{readOnlyMessage ? "등록 사업장은 저장 회사에서 입력해요" : "내 개인 매칭 정보로 저장돼요"}</AlertTitle>
        <AlertDescription>
          <p>
            {readOnlyMessage
              ? "현재 익명 결과에는 등록 사업장 답변을 임시로 반영하지 않습니다."
              : "이 답변은 같은 회사의 다른 구성원과 공유되지 않습니다."}
          </p>
          <p>
            완전으로 표시해도 선택한 시설 유형과 입력한 확인 기간에만 적용됩니다. 모든 행을 지우거나
            기간이 맞지 않는 정보만으로 탈락을 자동 확정하지 않습니다.
          </p>
        </AlertDescription>
      </Alert>

      {readOnly ? (
        <Alert>
          <AlertTitle>읽기 전용 정보예요</AlertTitle>
          <AlertDescription>
            {readOnlyMessage ?? "이 회사 정보를 수정할 권한이 없어 저장·추가·삭제할 수 없습니다."}
          </AlertDescription>
        </Alert>
      ) : null}

      <FieldSet>
        <FieldLegend>등록 사업장</FieldLegend>
        <FieldDescription>
          현재 등록된 사업장만 최대 {MAX_LOCATIONS}개까지 입력하세요. 이전 예정지나 시군구·상세 주소는
          저장하지 않습니다.
        </FieldDescription>
        <FieldGroup>
          {draft.locations.length === 0 ? (
            <Alert>
              <AlertTitle>입력한 사업장이 없습니다</AlertTitle>
              <AlertDescription>
                목록이 비어 있어도 자동 탈락으로 확정되지 않으며, 매칭에는 확인할 정보가 필요한 상태로
                남습니다.
              </AlertDescription>
            </Alert>
          ) : null}
          {draft.locations.map((location, index) => (
            <PremisesLocationFields
              key={location.locationId ?? `new-${index}`}
              index={index}
              location={location}
              disabled={controlsDisabled}
              readOnly={readOnly}
              today={today}
              errorField={error?.field}
              onChange={(change) => changeLocation(index, change)}
              onFacilityChange={(facilityType) => selectLocationFacility(index, facilityType)}
              onRemove={() => removeLocation(index)}
            />
          ))}
        </FieldGroup>
        {!readOnly ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={submitting || draft.locations.length >= MAX_LOCATIONS}
            onClick={addLocation}
          >
            사업장 추가 ({draft.locations.length}/{MAX_LOCATIONS})
          </Button>
        ) : null}
      </FieldSet>

      <FieldSet>
        <FieldLegend>확인한 범위</FieldLegend>
        <FieldDescription>
          아래 시설 유형과 날짜 구간에 대해서만 목록의 완전성을 표시합니다.
        </FieldDescription>
        <FieldGroup className="grid gap-3 sm:grid-cols-2">
          <Field
            className="sm:col-span-2"
            data-invalid={error?.field === "coverageFacilityTypes" || undefined}
          >
            <FieldLabel>확인한 시설 유형</FieldLabel>
            <ToggleGroup
              aria-label="확인한 시설 유형"
              variant="outline"
              spacing={1}
              value={draft.coverageFacilityTypes}
              disabled={controlsDisabled}
              onValueChange={(values) => {
                const facilityTypes = values.filter(isFacilityType);
                setDraft((current) => ({ ...current, coverageFacilityTypes: facilityTypes }));
                setError(null);
              }}
            >
              {FACILITY_OPTIONS.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value}>{option.label}</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>등록 사업장 행에서 선택하면 자동으로 포함되며 직접 조정할 수 있습니다.</FieldDescription>
          </Field>

          <DateField
            id={coverageValidFromId}
            label="확인 범위 시작일"
            description="선택한 시설 유형을 확인한 기간의 시작일입니다."
            value={draft.coverageValidFrom}
            max={today}
            disabled={controlsDisabled}
            invalid={error?.field === "coverageValidFrom"}
            onChange={(value) => {
              setDraft((current) => ({ ...current, coverageValidFrom: value }));
              setError(null);
            }}
          />

          <DateField
            id={coverageValidToId}
            label="확인 범위 종료일"
            description="오늘까지 확인했다면 오늘 날짜를 선택해 주세요."
            value={draft.coverageValidTo}
            max={today}
            disabled={controlsDisabled}
            invalid={error?.field === "coverageValidTo"}
            onChange={(value) => {
              setDraft((current) => ({ ...current, coverageValidTo: value }));
              setError(null);
            }}
          />

          <Field className="sm:col-span-2" data-invalid={error?.field === "completeness" || undefined}>
            <FieldLabel htmlFor={completenessId}>확인 범위 완전성</FieldLabel>
            <Select
              items={COMPLETENESS_OPTIONS}
              value={draft.completeness}
              disabled={controlsDisabled}
              onValueChange={(value) => {
                if (isCompleteness(value)) {
                  setDraft((current) => ({ ...current, completeness: value }));
                  setError(null);
                }
              }}
            >
              <SelectTrigger
                id={completenessId}
                className="w-full"
                aria-invalid={error?.field === "completeness" || undefined}
              >
                <SelectValue placeholder="확인 범위 선택" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {COMPLETENESS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>완전은 선택한 시설 유형과 위 날짜 구간에만 적용됩니다.</FieldDescription>
          </Field>
        </FieldGroup>
      </FieldSet>

      {error ? <FieldError>{error.error}</FieldError> : null}

      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel} disabled={submitting}>
          {readOnly ? "닫기" : "취소"}
        </Button>
        {!readOnly ? (
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting ? "반영 중" : "사업장 답변 반영"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function premisesAnswerDraftFromValue(
  value: PremisesProfileValue | null | undefined,
): PremisesAnswerDraft {
  if (!value) return emptyPremisesAnswerDraft();
  return {
    locations: value.locations.map((location) => ({
      locationId: location.locationId,
      facilityType: location.facilityType,
      sidoCode: location.sidoCode,
      validFrom: location.validFrom,
      validTo: location.validTo,
    })),
    coverageFacilityTypes: [...value.coverage.facilityTypes],
    coverageValidFrom: value.coverage.validFrom,
    coverageValidTo: value.coverage.validTo,
    completeness: value.coverage.completeness,
  };
}

export function buildPremisesAnswer(
  draft: PremisesAnswerDraft,
  options: { createLocationId: () => string; today: string },
): BuildPremisesAnswerResult {
  if (!validCalendarDate(options.today)) {
    return invalid("coverageValidTo", "현재 날짜를 확인하지 못했어요. 다시 시도해주세요.");
  }
  if (draft.locations.length > MAX_LOCATIONS) {
    return invalid("locations", `사업장은 최대 ${MAX_LOCATIONS}개까지 입력할 수 있습니다.`);
  }

  for (const [index, location] of draft.locations.entries()) {
    if (!location.facilityType || !FACILITY_TYPES.has(location.facilityType)) {
      return invalid(locationField(index, "facilityType"), `${index + 1}번 사업장 유형을 선택해 주세요.`);
    }
    if (!location.sidoCode || !SIDO_CODES.has(location.sidoCode)) {
      return invalid(locationField(index, "sidoCode"), `${index + 1}번 사업장의 지원 시도를 선택해 주세요.`);
    }
    if (!validCalendarDate(location.validFrom)) {
      return invalid(locationField(index, "validFrom"), `${index + 1}번 사업장 등록 유효 시작일을 선택해 주세요.`);
    }
    if (location.validTo !== null && !validCalendarDate(location.validTo)) {
      return invalid(locationField(index, "validTo"), `${index + 1}번 사업장 유효 종료일을 확인해 주세요.`);
    }
    if (location.validFrom > options.today || (location.validTo !== null && location.validTo > options.today)) {
      return invalid(locationField(index, "validTo"), "이전 예정지나 미래 날짜는 입력할 수 없습니다.");
    }
    if (location.validTo !== null && location.validFrom > location.validTo) {
      return invalid(locationField(index, "validTo"), `${index + 1}번 사업장 종료일은 시작일보다 빠를 수 없습니다.`);
    }
    if (location.locationId !== null && !UUID_PATTERN.test(location.locationId)) {
      return invalid(locationField(index, "locationId"), `${index + 1}번 사업장 식별자가 올바르지 않습니다.`);
    }
  }

  const coverageFacilityTypes = [...new Set(draft.coverageFacilityTypes)];
  if (
    coverageFacilityTypes.length === 0 ||
    coverageFacilityTypes.length > FACILITY_OPTIONS.length ||
    coverageFacilityTypes.some((facilityType) => !FACILITY_TYPES.has(facilityType))
  ) {
    return invalid("coverageFacilityTypes", "확인한 시설 유형을 하나 이상 선택해 주세요.");
  }
  if (!validCalendarDate(draft.coverageValidFrom)) {
    return invalid("coverageValidFrom", "확인 범위 시작일을 선택해 주세요.");
  }
  if (!validCalendarDate(draft.coverageValidTo)) {
    return invalid("coverageValidTo", "확인 범위 종료일을 선택해 주세요.");
  }
  if (draft.coverageValidFrom > options.today || draft.coverageValidTo > options.today) {
    return invalid("coverageValidTo", "미래 날짜는 입력할 수 없습니다.");
  }
  if (draft.coverageValidFrom > draft.coverageValidTo) {
    return invalid("coverageValidTo", "확인 범위 종료일은 시작일과 같거나 뒤여야 합니다.");
  }
  const locationOutsideCoverage = draft.locations.findIndex(
    (location) => location.validFrom > draft.coverageValidTo,
  );
  if (locationOutsideCoverage >= 0) {
    return invalid(
      locationField(locationOutsideCoverage, "validFrom"),
      `${locationOutsideCoverage + 1}번 사업장 등록 유효 시작일은 확인 범위 종료일보다 늦을 수 없습니다.`,
    );
  }
  if (!draft.completeness || !isCompleteness(draft.completeness)) {
    return invalid("completeness", "확인 범위의 완전성을 선택해 주세요.");
  }

  const locationIds: string[] = [];
  const seenLocationIds = new Set<string>();
  for (const [index, location] of draft.locations.entries()) {
    let locationId = location.locationId;
    if (locationId === null) {
      try {
        locationId = options.createLocationId();
      } catch {
        return invalid(locationField(index, "locationId"), "사업장 답변 식별자를 만들지 못했어요. 다시 시도해주세요.");
      }
    }
    if (!UUID_PATTERN.test(locationId)) {
      return invalid(locationField(index, "locationId"), "사업장 답변 식별자를 만들지 못했어요. 다시 시도해주세요.");
    }
    const normalizedId = locationId.toLowerCase();
    if (seenLocationIds.has(normalizedId)) {
      return invalid(locationField(index, "locationId"), "사업장 답변 식별자는 서로 달라야 합니다.");
    }
    seenLocationIds.add(normalizedId);
    locationIds.push(locationId);
  }

  return {
    ok: true,
    locationIds,
    answer: {
      field: "premises",
      mode: "replace",
      value: {
        schemaVersion: "premises-v1",
        locations: draft.locations.map((location, index) => ({
          locationId: locationIds[index]!,
          facilityType: location.facilityType!,
          sidoCode: location.sidoCode!,
          validFrom: location.validFrom,
          validTo: location.validTo,
        })),
        coverage: {
          facilityTypes: coverageFacilityTypes,
          validFrom: draft.coverageValidFrom,
          validTo: draft.coverageValidTo,
          completeness: draft.completeness,
        },
      },
    },
  };
}

function PremisesLocationFields({
  index,
  location,
  disabled,
  readOnly,
  today,
  errorField,
  onChange,
  onFacilityChange,
  onRemove,
}: {
  index: number;
  location: PremisesLocationDraft;
  disabled: boolean;
  readOnly: boolean;
  today: string;
  errorField: PremisesAnswerField | undefined;
  onChange: (change: Partial<PremisesLocationDraft>) => void;
  onFacilityChange: (facilityType: PremisesFacilityType) => void;
  onRemove: () => void;
}) {
  const facilityId = useId();
  const sidoId = useId();
  const validFromId = useId();
  const validToId = useId();

  return (
    <FieldSet className="gap-3 rounded-lg border p-4">
      <FieldLegend variant="label">사업장 {index + 1}</FieldLegend>
      {!readOnly ? (
        <Button
          className="self-end"
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={onRemove}
        >
          이 행 삭제
        </Button>
      ) : null}
      <FieldGroup className="grid gap-3 sm:grid-cols-2">
        <Field data-invalid={errorField === locationField(index, "facilityType") || undefined}>
          <FieldLabel htmlFor={facilityId}>사업장 유형</FieldLabel>
          <Select
            items={FACILITY_OPTIONS}
            value={location.facilityType}
            disabled={disabled}
            onValueChange={(value) => {
              if (isFacilityType(value)) onFacilityChange(value);
            }}
          >
            <SelectTrigger
              id={facilityId}
              className="w-full"
              aria-invalid={errorField === locationField(index, "facilityType") || undefined}
            >
              <SelectValue placeholder="시설 유형 선택" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {FACILITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field data-invalid={errorField === locationField(index, "sidoCode") || undefined}>
          <FieldLabel htmlFor={sidoId}>시도</FieldLabel>
          <Select
            items={KOREA_REGION_OPTIONS.map((option) => ({ value: option.code, label: option.label }))}
            value={location.sidoCode}
            disabled={disabled}
            onValueChange={(value) => {
              if (typeof value === "string" && SIDO_CODES.has(value)) onChange({ sidoCode: value });
            }}
          >
            <SelectTrigger
              id={sidoId}
              className="w-full"
              aria-invalid={errorField === locationField(index, "sidoCode") || undefined}
            >
              <SelectValue placeholder="시도 선택" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {KOREA_REGION_OPTIONS.map((option) => (
                  <SelectItem key={option.code} value={option.code}>{option.label}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>시군구나 상세 주소는 이 답변에 저장하지 않습니다.</FieldDescription>
        </Field>

        <DateField
          id={validFromId}
          label="등록 유효 시작일"
          description="이 시설이 현재 사업장으로 유효해진 날짜입니다."
          value={location.validFrom}
          max={today}
          disabled={disabled}
          invalid={errorField === locationField(index, "validFrom")}
          onChange={(value) => onChange({ validFrom: value })}
        />

        <DateField
          id={validToId}
          label="유효 종료일 (선택)"
          description="현재도 유효하면 비워두세요. 미래 이전 예정일은 입력하지 않습니다."
          value={location.validTo ?? ""}
          max={today}
          disabled={disabled}
          invalid={errorField === locationField(index, "validTo")}
          onChange={(value) => onChange({ validTo: value || null })}
        />
      </FieldGroup>
    </FieldSet>
  );
}

function DateField({
  id,
  label,
  description,
  value,
  max,
  disabled,
  invalid: isInvalid,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  max: string;
  disabled: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field data-invalid={isInvalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="date"
        value={value}
        max={max}
        disabled={disabled}
        aria-invalid={isInvalid || undefined}
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          onChange(nextValue);
        }}
      />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}

function emptyPremisesAnswerDraft(): PremisesAnswerDraft {
  return {
    locations: [emptyPremisesLocationDraft()],
    coverageFacilityTypes: [],
    coverageValidFrom: "",
    coverageValidTo: "",
    completeness: null,
  };
}

function emptyPremisesLocationDraft(): PremisesLocationDraft {
  return {
    locationId: null,
    facilityType: null,
    sidoCode: null,
    validFrom: "",
    validTo: null,
  };
}

function locationField(index: number, field: PremisesLocationField): PremisesAnswerField {
  return `locations.${index}.${field}`;
}

function invalid(field: PremisesAnswerField, error: string): BuildPremisesAnswerResult {
  return { ok: false, field, error };
}

function isFacilityType(value: unknown): value is PremisesFacilityType {
  return typeof value === "string" && FACILITY_TYPES.has(value as PremisesFacilityType);
}

function isCompleteness(value: unknown): value is PremisesCompleteness {
  return value === "partial" || value === "complete";
}

function validCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

function koreaCalendarDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year") ?? ""}-${part("month") ?? ""}-${part("day") ?? ""}`;
}
