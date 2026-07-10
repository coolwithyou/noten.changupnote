"use client";

import { useState, type FormEvent } from "react";
import { Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface AccountProfileUpdateResult {
  id: string;
  email: string | null;
  name: string | null;
}

export function AccountProfilePanel({
  initialName,
  email,
}: {
  initialName: string | null;
  email: string | null;
}) {
  const [savedName, setSavedName] = useState(initialName ?? "");
  const [name, setName] = useState(initialName ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedName = name.replace(/\s+/g, " ").trim();
  const savedNormalizedName = savedName.replace(/\s+/g, " ").trim();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const response = await fetch("/api/web/account/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json().catch(() => ({})) as ActionResult<AccountProfileUpdateResult>;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error?.message ?? "프로필을 저장하지 못했습니다.");
      }

      const nextName = payload.data?.name ?? "";
      setSavedName(nextName);
      setName(nextName);
      toast.success(nextName ? "표시 이름을 저장했습니다." : "표시 이름을 비웠습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "프로필을 저장하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>표시 이름</CardTitle>
        <CardDescription>계정 메뉴와 지원 기록에 표시되는 이름입니다.</CardDescription>
        <CardAction>
          <UserRound className="text-muted-foreground" aria-hidden />
        </CardAction>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end" onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="accountProfileName">이름</FieldLabel>
              <Input
                id="accountProfileName"
                type="text"
                value={name}
                maxLength={80}
                autoComplete="name"
                placeholder={email ?? "내 계정"}
                aria-describedby={error ? "accountProfileNameError accountProfileNameDescription" : "accountProfileNameDescription"}
                aria-invalid={Boolean(error)}
                onChange={(event) => setName(event.currentTarget.value)}
                disabled={pending}
              />
              <FieldDescription id="accountProfileNameDescription">비워두면 계정 이메일을 표시합니다.</FieldDescription>
              {error ? <FieldError id="accountProfileNameError">{error}</FieldError> : null}
            </Field>
          </FieldGroup>

          <Button type="submit" disabled={pending || normalizedName === savedNormalizedName}>
            {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            {pending ? "저장 중" : "저장"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
