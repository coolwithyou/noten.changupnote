"use client";

import { useState, type FormEvent } from "react";
import { CheckCircle2, Loader2, Save, ShieldCheck } from "lucide-react";
import type { ActionResult } from "@cunote/contracts";
import type { BillingTaxProfileItem, BillingTaxProfileUpdateResult } from "@/lib/server/billing/taxProfile";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export function BillingTaxProfileForm({
  initialProfile,
  canUpdate,
}: {
  initialProfile: BillingTaxProfileItem;
  canUpdate: boolean;
}) {
  const [businessName, setBusinessName] = useState(initialProfile.businessName ?? "");
  const [businessRegistrationNumber, setBusinessRegistrationNumber] = useState("");
  const [recipientName, setRecipientName] = useState(initialProfile.recipientName ?? "");
  const [recipientEmail, setRecipientEmail] = useState(initialProfile.recipientEmail ?? "");
  const [recipientPhone, setRecipientPhone] = useState(initialProfile.recipientPhone ?? "");
  const [taxInvoiceEmail, setTaxInvoiceEmail] = useState(initialProfile.taxInvoiceEmail ?? initialProfile.recipientEmail ?? "");
  const [billingAddressLine1, setBillingAddressLine1] = useState(initialProfile.billingAddressLine1 ?? "");
  const [billingAddressLine2, setBillingAddressLine2] = useState(initialProfile.billingAddressLine2 ?? "");
  const [postalCode, setPostalCode] = useState(initialProfile.postalCode ?? "");
  const [taxInvoiceEnabled, setTaxInvoiceEnabled] = useState(initialProfile.taxInvoiceEnabled);
  const [notes, setNotes] = useState(initialProfile.notes ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedProfile, setSavedProfile] = useState<BillingTaxProfileItem | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canUpdate) return;
    setPending(true);
    setError(null);
    setSavedProfile(null);
    try {
      const response = await fetch("/api/web/billing/tax-profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessName,
          ...(businessRegistrationNumber.trim() ? { businessRegistrationNumber } : {}),
          recipientName,
          recipientEmail,
          recipientPhone,
          taxInvoiceEmail,
          billingAddressLine1,
          billingAddressLine2,
          postalCode,
          taxInvoiceEnabled,
          notes,
        }),
      });
      const payload = await response.json() as ActionResult<BillingTaxProfileUpdateResult>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "청구 프로필을 저장하지 못했습니다.");
      }
      setSavedProfile(payload.data.profile);
      setBusinessRegistrationNumber("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "청구 프로필을 저장하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  const visibleProfile = savedProfile ?? initialProfile;

  if (!canUpdate) {
    return (
      <div className="billing-request-permission" id="billing-tax-profile-form">
        <ShieldCheck aria-hidden />
        <div>
          <strong>청구 프로필 수정 권한이 없습니다.</strong>
          <p>회사 소유자, 관리자 또는 멤버에게 요청해주세요.</p>
        </div>
      </div>
    );
  }

  return (
    <form className="billing-plan-request-form" id="billing-tax-profile-form" onSubmit={(event) => void submit(event)}>
      <FieldGroup>
        <div className="billing-request-grid two">
          <Field>
            <FieldLabel htmlFor="billing-tax-business-name">상호/법인명</FieldLabel>
            <Input
              id="billing-tax-business-name"
              value={businessName}
              onChange={(event) => setBusinessName(event.currentTarget.value)}
              disabled={pending}
              placeholder="회사명"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="billing-tax-biz-no">사업자등록번호</FieldLabel>
            <Input
              id="billing-tax-biz-no"
              value={businessRegistrationNumber}
              onChange={(event) => setBusinessRegistrationNumber(event.currentTarget.value)}
              disabled={pending}
              inputMode="numeric"
              placeholder={visibleProfile.businessRegistrationNumberMasked ?? "10자리"}
            />
            <FieldDescription>
              {visibleProfile.businessRegistrationNumberMasked
                ? `현재 저장값: ${visibleProfile.businessRegistrationNumberMasked}`
                : "저장 후 화면과 export에는 마스킹된 값만 표시합니다."}
            </FieldDescription>
          </Field>
        </div>

        <div className="billing-request-grid three">
          <Field>
            <FieldLabel htmlFor="billing-tax-recipient-name">청구 담당자</FieldLabel>
            <Input
              id="billing-tax-recipient-name"
              value={recipientName}
              onChange={(event) => setRecipientName(event.currentTarget.value)}
              disabled={pending}
              placeholder="이름"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="billing-tax-recipient-email">담당자 이메일</FieldLabel>
            <Input
              id="billing-tax-recipient-email"
              type="email"
              value={recipientEmail}
              onChange={(event) => setRecipientEmail(event.currentTarget.value)}
              disabled={pending}
              placeholder="billing@company.com"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="billing-tax-recipient-phone">담당자 연락처</FieldLabel>
            <Input
              id="billing-tax-recipient-phone"
              value={recipientPhone}
              onChange={(event) => setRecipientPhone(event.currentTarget.value)}
              disabled={pending}
              placeholder="010-0000-0000"
            />
          </Field>
        </div>

        <div className="billing-request-grid three">
          <Field>
            <FieldLabel htmlFor="billing-tax-email">세금계산서 이메일</FieldLabel>
            <Input
              id="billing-tax-email"
              type="email"
              value={taxInvoiceEmail}
              onChange={(event) => setTaxInvoiceEmail(event.currentTarget.value)}
              disabled={pending}
              placeholder="tax@company.com"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="billing-tax-postal-code">우편번호</FieldLabel>
            <Input
              id="billing-tax-postal-code"
              value={postalCode}
              onChange={(event) => setPostalCode(event.currentTarget.value)}
              disabled={pending}
              placeholder="00000"
            />
          </Field>
          <Field orientation="horizontal" className="items-center justify-between rounded-[var(--radius-lg)] border border-border bg-muted/30 p-4">
            <div>
              <FieldLabel htmlFor="billing-tax-invoice-enabled">세금계산서 수신</FieldLabel>
              <FieldDescription>provider 연동 후 발행 요청 기본값으로 사용합니다.</FieldDescription>
            </div>
            <Switch
              id="billing-tax-invoice-enabled"
              checked={taxInvoiceEnabled}
              onCheckedChange={setTaxInvoiceEnabled}
              disabled={pending}
            />
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="billing-tax-address-1">사업장 주소</FieldLabel>
          <Input
            id="billing-tax-address-1"
            value={billingAddressLine1}
            onChange={(event) => setBillingAddressLine1(event.currentTarget.value)}
            disabled={pending}
            placeholder="기본 주소"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="billing-tax-address-2">상세 주소</FieldLabel>
          <Input
            id="billing-tax-address-2"
            value={billingAddressLine2}
            onChange={(event) => setBillingAddressLine2(event.currentTarget.value)}
            disabled={pending}
            placeholder="상세 주소"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="billing-tax-notes">청구 메모</FieldLabel>
          <Textarea
            id="billing-tax-notes"
            value={notes}
            onChange={(event) => setNotes(event.currentTarget.value)}
            disabled={pending}
            placeholder="계약서, 세금계산서, 내부 결재에 필요한 메모를 남겨주세요."
          />
        </Field>
      </FieldGroup>

      {error ? <div className="billing-request-feedback error" role="alert">{error}</div> : null}
      {savedProfile ? (
        <div className="billing-request-feedback success" role="status">
          <CheckCircle2 aria-hidden />
          <span>{savedProfile.source === "database" ? "청구 프로필을 저장했습니다." : "청구 프로필 임시 저장 응답을 확인했습니다."}</span>
        </div>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
        청구 프로필 저장
      </Button>
    </form>
  );
}
