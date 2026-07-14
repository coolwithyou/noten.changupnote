"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { ActionResult, CompanyVerificationResult } from "@cunote/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";

export function RepresentativeVerifySheet({
  open,
  onOpenChange,
  initialOwnerName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialOwnerName?: string | null;
}) {
  const router = useRouter();
  const [ownerName, setOwnerName] = useState(initialOwnerName?.trim() ?? "");
  const [openedOn, setOpenedOn] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (open) {
      setError(null);
      setDone(false);
    }
  }, [open]);

  async function onSubmit() {
    setError(null);
    if (!ownerName.trim()) {
      setError("대표자명을 입력해주세요.");
      return;
    }
    const normalizedOpenedOn = normalizeOpenedOn(openedOn);
    if (!normalizedOpenedOn) {
      setError("개업일을 YYYY. MM. DD. 형식으로 입력해주세요.");
      return;
    }

    setPending(true);
    try {
      const result = await postVerify({
        ownerName: ownerName.trim(),
        openedOn: normalizedOpenedOn,
      });
      if (result.verified) {
        setDone(true);
        router.refresh();
      } else {
        setError("입력한 정보가 사업자등록 정보와 일치하지 않아요. 다시 확인해주세요.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "대표자 확인을 처리하지 못했어요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-[420px]">
        {done ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-7 text-center">
            <span className="flex size-13 items-center justify-center rounded-full bg-brand-mint text-white shadow-[var(--shadow-mint-check)]">
              <Check className="size-6" aria-hidden />
            </span>
            <SheetTitle className="text-lg font-extrabold">대표자 확인됨 ✓</SheetTitle>
            <SheetDescription className="text-sm text-text-secondary">
              이제 회사 전용 정보를 자동으로 가져와요
            </SheetDescription>
            <Badge className="bg-brand-mint-soft text-brand-mint-ink">대표자 확인됨 ✓</Badge>
            <SheetClose
              render={<Button variant="secondary" className="mt-2 w-full" />}
            >
              닫기
            </SheetClose>
          </div>
        ) : (
          <>
            <SheetHeader className="gap-2 p-7 pb-2">
              <SheetTitle className="text-lg font-extrabold">대표자 확인</SheetTitle>
              <SheetDescription className="text-sm leading-relaxed text-text-secondary">
                사업자등록증의 정보로 대표자임을 확인해요
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-1 flex-col gap-4 px-7 py-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="rep-owner-name">대표자명</FieldLabel>
                  <Input
                    id="rep-owner-name"
                    autoComplete="off"
                    placeholder="대표자명"
                    value={ownerName}
                    disabled={pending}
                    onChange={(event) => setOwnerName(event.currentTarget.value)}
                  />
                </Field>
                <Field data-invalid={error ? true : undefined}>
                  <FieldLabel htmlFor="rep-opened-on">개업일</FieldLabel>
                  <Input
                    id="rep-opened-on"
                    inputMode="numeric"
                    placeholder="YYYY. MM. DD."
                    className="tabular-nums"
                    value={openedOn}
                    aria-invalid={error ? true : undefined}
                    disabled={pending}
                    onChange={(event) => setOpenedOn(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void onSubmit();
                    }}
                  />
                </Field>
              </FieldGroup>
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <SheetFooter className="p-7 pt-2">
              <Button type="button" className="w-full" disabled={pending} onClick={() => void onSubmit()}>
                {pending ? <Spinner data-icon="inline-start" /> : null}
                {pending ? "확인 중" : "확인하기"}
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** "2024. 01. 05." · "2024-01-05" · "20240105" 등을 YYYY-MM-DD로 정규화. 실패 시 null. */
function normalizeOpenedOn(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;
  return `${year}-${month}-${day}`;
}

async function postVerify(body: { ownerName: string; openedOn: string }): Promise<CompanyVerificationResult> {
  const response = await fetch("/api/web/companies/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as ActionResult<CompanyVerificationResult>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? "대표자 확인을 처리하지 못했어요.");
  }
  return payload.data;
}
