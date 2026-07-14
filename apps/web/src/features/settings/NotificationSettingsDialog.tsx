"use client";

import { useState } from "react";
import { Bell, ChevronRight } from "lucide-react";
import type { ActionResult, NotificationSettingsDto } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

export function NotificationSettingsDialog({
  initialSettings,
}: {
  initialSettings: NotificationSettingsDto;
}) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState(initialSettings);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/web/notifications", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deadlineReminder: draft.deadlineReminder,
          newMatch: draft.newMatch,
        }),
      });
      const payload = await response.json().catch(() => ({})) as ActionResult<NotificationSettingsDto>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "알림 설정을 저장하지 못했습니다.");
      }
      setSettings(payload.data);
      setDraft(payload.data);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "알림 설정을 저장하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setDraft(settings);
          setError(null);
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-between rounded-none px-0 py-4 text-left"
          />
        }
      >
        <span className="flex min-w-0 items-center gap-3">
          <Bell data-icon="inline-start" />
          <span className="flex min-w-0 flex-col items-start gap-1">
            <span>알림 설정</span>
            <span className="text-xs font-normal text-muted-foreground">
              새 공고 {settings.newMatch ? "켬" : "끔"} · 마감 알림 {settings.deadlineReminder ? "켬" : "끔"}
            </span>
          </span>
        </span>
        <ChevronRight data-icon="inline-end" className="text-muted-foreground" />
      </DialogTrigger>

      <DialogContent className="gap-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">알림 설정</DialogTitle>
          <DialogDescription>새로 맞는 공고와 신청 가능한 공고의 마감을 알려드려요.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1 rounded-[var(--radius-xl)] border px-4">
          <NotificationField
            title="새 공고 알림"
            description="내 회사 조건에 새로 맞는 공고가 등록되면 알려드려요."
            checked={draft.newMatch}
            disabled={pending}
            onCheckedChange={(checked) => setDraft((current) => ({ ...current, newMatch: checked }))}
          />
          <NotificationField
            title="마감 임박 알림"
            description="신청 가능한 공고의 마감이 가까워지면 알려드려요."
            checked={draft.deadlineReminder}
            disabled={pending}
            onCheckedChange={(checked) => setDraft((current) => ({ ...current, deadlineReminder: checked }))}
          />
        </div>

        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

        <DialogFooter>
          <Button type="button" disabled={pending} onClick={() => void save()} className="w-full sm:w-auto">
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {pending ? "저장 중" : "저장"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NotificationField({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field className="border-b py-4 last:border-b-0" orientation="horizontal" data-disabled={disabled || undefined}>
      <FieldContent>
        <FieldTitle>{title}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch
        checked={checked}
        disabled={disabled}
        aria-label={`${title} ${checked ? "끄기" : "켜기"}`}
        onCheckedChange={onCheckedChange}
      />
    </Field>
  );
}
