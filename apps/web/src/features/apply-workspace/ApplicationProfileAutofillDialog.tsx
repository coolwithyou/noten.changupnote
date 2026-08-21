"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ContactRound, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import {
  buildApplicationProfileAutofillPlan,
  type ApplicationAutofillFieldBinding,
  type ApplicationAutofillProfile,
  type ApplicationAutofillProfileInput,
} from "@/lib/documents/applicationProfileAutofill";
import {
  fetchApplicationAutofillProfile,
  updateApplicationAutofillProfile,
} from "@/lib/documents/applicationProfileAutofillApi";

export interface ApplicationProfileAutofillDialogProps {
  draftId: string;
  fields: readonly ConnectedDocumentField[];
  disabled?: boolean | undefined;
  inspectBindings: () => Promise<ApplicationAutofillFieldBinding[]>;
  applyEntries: (entries: readonly { fieldId: string; value: string }[]) => Promise<{
    appliedCount: number;
    fieldIds: string[];
  }>;
}

export function ApplicationProfileAutofillDialog({
  draftId,
  fields,
  disabled = false,
  inspectBindings,
  applyEntries,
}: ApplicationProfileAutofillDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<ApplicationAutofillProfile | null>(null);
  const [form, setForm] = useState<ApplicationAutofillProfileInput | null>(null);
  const [bindings, setBindings] = useState<ApplicationAutofillFieldBinding[]>([]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      fetchApplicationAutofillProfile(draftId),
      inspectBindings(),
    ]).then(([loadedProfile, inspected]) => {
      if (disposed) return;
      setProfile(loadedProfile);
      setForm(toInput(loadedProfile));
      setBindings(inspected);
    }).catch((caught) => {
      if (!disposed) setError(errorMessage(caught, "등록정보와 문서 입력 위치를 확인하지 못했습니다."));
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [draftId, inspectBindings, open]);

  const editableProfile = useMemo(() => (
    profile && form ? fromInput(form, profile.company.businessNumberVerified, profile.updatedAt) : null
  ), [form, profile]);
  const plan = useMemo(() => (
    editableProfile
      ? buildApplicationProfileAutofillPlan({ fields, profile: editableProfile, bindings })
      : null
  ), [bindings, editableProfile, fields]);
  const missingCount = plan?.items.filter((item) => item.state === "missing_profile").length ?? 0;
  const preservedCount = plan?.items.filter((item) => item.state === "already_filled").length ?? 0;
  const blockedCount = plan?.items.filter((item) => item.state === "blocked").length ?? 0;

  const updatePersonal = (key: keyof ApplicationAutofillProfileInput["personal"], value: string) => {
    setForm((current) => current ? {
      ...current,
      personal: { ...current.personal, [key]: value },
    } : current);
  };
  const updateCompany = (key: keyof ApplicationAutofillProfileInput["company"], value: string) => {
    setForm((current) => current ? {
      ...current,
      company: { ...current.company, [key]: value },
    } : current);
  };

  const submit = async () => {
    if (!form || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const saved = await updateApplicationAutofillProfile(draftId, form);
      setProfile(saved);
      setForm(toInput(saved));
      const currentBindings = await inspectBindings();
      setBindings(currentBindings);
      const currentPlan = buildApplicationProfileAutofillPlan({
        fields,
        profile: saved,
        bindings: currentBindings,
      });
      if (currentPlan.ready.length === 0) {
        toast.success("등록정보를 저장했습니다. 현재 문서에서 새로 채울 빈 칸은 없습니다.");
        return;
      }
      const result = await applyEntries(currentPlan.ready.map((item) => ({
        fieldId: item.fieldId,
        value: item.value!,
      })));
      toast.success(`등록정보를 저장하고 문서의 ${result.appliedCount}개 칸을 채웠습니다.`);
      setOpen(false);
    } catch (caught) {
      setError(errorMessage(caught, "등록정보를 저장하고 문서에 입력하지 못했습니다."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="w-full"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <ContactRound data-icon="inline-start" aria-hidden />
        등록정보로 일괄 채우기
      </Button>
      <Dialog open={open} onOpenChange={(next) => !submitting && setOpen(next)}>
        <DialogContent className="flex max-h-[min(90dvh,860px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="shrink-0 border-b px-6 py-5">
            <DialogTitle>등록정보로 신청서 채우기</DialogTitle>
            <DialogDescription>
              부족한 정보를 여기서 보완하면 계정에 저장하고, 현재 문서에서 위치가 확인된 빈 칸에만 입력합니다.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {loading ? (
              <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner /> 등록정보와 문서 입력 칸을 확인하고 있어요.
              </div>
            ) : form && profile && plan ? (
              <div className="flex flex-col gap-6">
                <Alert>
                  <CheckCircle2 aria-hidden />
                  <AlertTitle>기존 작성값은 유지합니다</AlertTitle>
                  <AlertDescription>
                    입력 위치가 하나로 확인된 빈 칸과 안전하게 교체할 수 있는 안내문만 대상으로 삼습니다.
                  </AlertDescription>
                </Alert>

                <div className="flex flex-wrap gap-2" aria-label="일괄 입력 계획 요약">
                  <Badge>{plan.ready.length}개 입력 예정</Badge>
                  {missingCount > 0 ? <Badge variant="outline">정보 부족 {missingCount}개</Badge> : null}
                  {preservedCount > 0 ? <Badge variant="secondary">기존 값 유지 {preservedCount}개</Badge> : null}
                  {blockedCount > 0 ? <Badge variant="outline">자동 입력 제외 {blockedCount}개</Badge> : null}
                </div>

                <FieldSet>
                  <FieldLegend>개인 정보</FieldLegend>
                  <FieldDescription>로그인 이메일과 별개로 신청서에 기재할 연락처를 저장합니다.</FieldDescription>
                  <FieldGroup className="grid gap-4 sm:grid-cols-2">
                    <ProfileField label="성명" value={form.personal.fullName} onChange={(value) => updatePersonal("fullName", value)} autoComplete="name" />
                    <ProfileField label="신청용 이메일" value={form.personal.applicationEmail} onChange={(value) => updatePersonal("applicationEmail", value)} type="email" autoComplete="email" />
                    <ProfileField label="휴대전화" value={form.personal.phone} onChange={(value) => updatePersonal("phone", value)} type="tel" autoComplete="tel" />
                    <ProfileField label="우편번호" value={form.personal.postalCode} onChange={(value) => updatePersonal("postalCode", value)} autoComplete="postal-code" />
                    <ProfileField label="주소" value={form.personal.addressLine1} onChange={(value) => updatePersonal("addressLine1", value)} autoComplete="street-address" className="sm:col-span-2" />
                    <ProfileField label="상세 주소" value={form.personal.addressLine2} onChange={(value) => updatePersonal("addressLine2", value)} autoComplete="address-line2" className="sm:col-span-2" />
                  </FieldGroup>
                </FieldSet>

                <FieldSet>
                  <FieldLegend>회사 정보</FieldLegend>
                  <FieldDescription>회사명과 사업자등록번호는 선택한 회사의 기본정보에도 저장합니다.</FieldDescription>
                  <FieldGroup className="grid gap-4 sm:grid-cols-2">
                    <ProfileField label="회사명" value={form.company.name} onChange={(value) => updateCompany("name", value)} autoComplete="organization" />
                    <ProfileField label="대표자명" value={form.company.representativeName} onChange={(value) => updateCompany("representativeName", value)} autoComplete="off" />
                    <Field>
                      <div className="flex items-center gap-2">
                        <FieldLabel htmlFor="autofill-company-business-number">사업자등록번호</FieldLabel>
                        {profile.company.businessNumberVerified ? <Badge variant="secondary">확인됨</Badge> : null}
                      </div>
                      <Input
                        id="autofill-company-business-number"
                        value={form.company.businessNumber ?? ""}
                        onChange={(event) => updateCompany("businessNumber", event.target.value)}
                        inputMode="numeric"
                        placeholder="000-00-00000"
                        disabled={profile.company.businessNumberVerified}
                      />
                      <FieldDescription>
                        {profile.company.businessNumberVerified
                          ? "확인된 번호는 이 화면에서 변경하지 않습니다."
                          : "형식과 체크섬을 확인해 미확인 상태로 저장합니다."}
                      </FieldDescription>
                    </Field>
                    <ProfileField label="회사 이메일" value={form.company.applicationEmail} onChange={(value) => updateCompany("applicationEmail", value)} type="email" autoComplete="off" />
                    <ProfileField label="회사 전화번호" value={form.company.phone} onChange={(value) => updateCompany("phone", value)} type="tel" autoComplete="off" />
                    <ProfileField label="회사 우편번호" value={form.company.postalCode} onChange={(value) => updateCompany("postalCode", value)} autoComplete="off" />
                    <ProfileField label="사업장 주소" value={form.company.addressLine1} onChange={(value) => updateCompany("addressLine1", value)} autoComplete="off" className="sm:col-span-2" />
                    <ProfileField label="사업장 상세 주소" value={form.company.addressLine2} onChange={(value) => updateCompany("addressLine2", value)} autoComplete="off" className="sm:col-span-2" />
                  </FieldGroup>
                </FieldSet>

                <FieldSet>
                  <FieldLegend>현재 문서 적용 대상</FieldLegend>
                  <FieldDescription>아래 칸만 저장 직후 현재 열린 문서에 입력합니다.</FieldDescription>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {plan.ready.length > 0 ? plan.ready.map((item) => (
                      <div key={item.fieldId} className="rounded-lg border bg-muted/30 px-3 py-2">
                        <p className="truncate text-sm font-medium">{item.label}</p>
                        <p className="truncate text-xs text-muted-foreground">{item.value}</p>
                      </div>
                    )) : (
                      <p className="text-sm text-muted-foreground sm:col-span-2">현재 입력 가능한 빈 칸이 없습니다. 등록정보만 저장할 수 있습니다.</p>
                    )}
                  </div>
                </FieldSet>
              </div>
            ) : null}

            {error ? (
              <Alert variant="destructive" className="mt-4">
                <TriangleAlert aria-hidden />
                <AlertTitle>확인이 필요합니다</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter className="shrink-0 border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>취소</Button>
            <Button type="button" onClick={() => void submit()} disabled={loading || !form || submitting}>
              {submitting ? <Spinner data-icon="inline-start" /> : <ContactRound data-icon="inline-start" aria-hidden />}
              {submitting
                ? "저장하고 입력하는 중…"
                : plan && plan.ready.length > 0
                  ? `정보 저장하고 ${plan.ready.length}개 칸 채우기`
                  : "정보 저장"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProfileField({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  className,
}: {
  label: string;
  value: string | null;
  onChange: (value: string) => void;
  type?: "text" | "email" | "tel";
  autoComplete: string;
  className?: string;
}) {
  const id = `autofill-${label.replace(/[^0-9a-z가-힣]+/giu, "-")}`;
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
      />
    </Field>
  );
}

function toInput(profile: ApplicationAutofillProfile): ApplicationAutofillProfileInput {
  return {
    personal: { ...profile.personal },
    company: {
      name: profile.company.name,
      representativeName: profile.company.representativeName,
      businessNumber: profile.company.businessNumber,
      applicationEmail: profile.company.applicationEmail,
      phone: profile.company.phone,
      postalCode: profile.company.postalCode,
      addressLine1: profile.company.addressLine1,
      addressLine2: profile.company.addressLine2,
    },
  };
}

function fromInput(
  input: ApplicationAutofillProfileInput,
  businessNumberVerified: boolean,
  updatedAt: string | null,
): ApplicationAutofillProfile {
  return {
    personal: { ...input.personal },
    company: {
      ...input.company,
      businessNumberVerified,
    },
    updatedAt,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
