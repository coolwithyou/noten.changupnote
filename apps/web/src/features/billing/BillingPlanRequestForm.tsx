"use client";

import { useState, type FormEvent } from "react";
import { Loader2, Send, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult } from "@cunote/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
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
import { Textarea } from "@/components/ui/textarea";

type BillingPlan = "team" | "growth" | "enterprise";
type BillingCycle = "monthly" | "annual" | "undecided";

interface BillingPlanRequestReceipt {
  id: string;
  status: "open" | "queued";
  persisted: boolean;
  desiredPlan: BillingPlan;
  seatCount: number;
  billingCycle: BillingCycle;
}

const PLAN_OPTIONS: Array<{ value: BillingPlan; label: string; description: string }> = [
  { value: "team", label: "Team", description: "소규모 팀 좌석과 초안 사용량 확장" },
  { value: "growth", label: "Growth", description: "여러 회사와 많은 신청 초안 운영" },
  { value: "enterprise", label: "Enterprise", description: "권한, 보안, 계약 조건 별도 협의" },
];

const CYCLE_OPTIONS: Array<{ value: BillingCycle; label: string }> = [
  { value: "undecided", label: "상담 후 결정" },
  { value: "monthly", label: "월간" },
  { value: "annual", label: "연간" },
];

export function BillingPlanRequestForm({
  defaultEmail,
  defaultName,
  canRequest,
}: {
  defaultEmail?: string | null | undefined;
  defaultName?: string | null | undefined;
  canRequest: boolean;
}) {
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [name, setName] = useState(defaultName ?? "");
  const [desiredPlan, setDesiredPlan] = useState<BillingPlan>("team");
  const [seatCount, setSeatCount] = useState("5");
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("undecided");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRequest) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/web/billing/plan-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          name,
          desiredPlan,
          seatCount: Number(seatCount),
          billingCycle,
          message,
        }),
      });
      const payload = await response.json() as ActionResult<BillingPlanRequestReceipt>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "플랜 전환 요청을 접수하지 못했습니다.");
      }
      toast.success(`전환 요청 접수번호 ${payload.data.id}`);
      setMessage("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "플랜 전환 요청을 접수하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  if (!canRequest) {
    return (
      <div
        className="flex items-start gap-3 rounded-[var(--radius-xl)] border border-border bg-muted/40 p-4 text-sm"
        id="billing-plan-request-form"
      >
        <ShieldCheck className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
        <div>
          <strong className="text-foreground">플랜 전환 요청 권한이 없습니다.</strong>
          <p className="mt-1 text-muted-foreground">회사 소유자, 관리자 또는 멤버에게 요청해주세요.</p>
        </div>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-5" id="billing-plan-request-form" onSubmit={(event) => void submit(event)}>
      <FieldGroup>
        <div className="grid gap-4 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="billing-request-email">상담 이메일</FieldLabel>
            <Input
              id="billing-request-email"
              type="email"
              value={email}
              autoComplete="email"
              onChange={(event) => setEmail(event.currentTarget.value)}
              disabled={pending}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="billing-request-name">담당자</FieldLabel>
            <Input
              id="billing-request-name"
              value={name}
              autoComplete="name"
              onChange={(event) => setName(event.currentTarget.value)}
              disabled={pending}
              placeholder="이름"
            />
          </Field>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="billing-request-plan">희망 플랜</FieldLabel>
            <Select value={desiredPlan} disabled={pending} onValueChange={(value) => setDesiredPlan(value as BillingPlan)}>
              <SelectTrigger id="billing-request-plan" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PLAN_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>{PLAN_OPTIONS.find((option) => option.value === desiredPlan)?.description}</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="billing-request-seats">예상 좌석</FieldLabel>
            <Input
              id="billing-request-seats"
              type="number"
              min={1}
              max={200}
              value={seatCount}
              onChange={(event) => setSeatCount(event.currentTarget.value)}
              disabled={pending}
              required
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="billing-request-cycle">청구 주기</FieldLabel>
            <Select value={billingCycle} disabled={pending} onValueChange={(value) => setBillingCycle(value as BillingCycle)}>
              <SelectTrigger id="billing-request-cycle" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {CYCLE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="billing-request-message">요청사항</FieldLabel>
          <Textarea
            id="billing-request-message"
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            placeholder="필요 좌석, 예산, 계약서/세금계산서 요청사항을 적어주세요."
            disabled={pending}
          />
        </Field>
      </FieldGroup>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Send data-icon="inline-start" />}
        전환 요청 접수
      </Button>
    </form>
  );
}
