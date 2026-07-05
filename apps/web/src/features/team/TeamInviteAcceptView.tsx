"use client";

import { useState } from "react";
import { Check, LogIn, ShieldCheck } from "lucide-react";
import type { ActionResult } from "@cunote/contracts";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface InvitationAcceptance {
  companyId: string;
  role: "admin" | "member" | "viewer";
  acceptedAt: string;
}

export function TeamInviteAcceptView({
  token,
  signedIn,
  loginHref,
}: {
  token: string;
  signedIn: boolean;
  loginHref: string;
}) {
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function acceptInvitation() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/web/team/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = await response.json() as ActionResult<InvitationAcceptance>;
      if (!payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "초대를 수락하지 못했습니다.");
      }
      setAccepted(true);
      setMessage(`초대를 수락했습니다. 역할은 ${roleLabel(payload.data.role)}입니다.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "초대를 수락하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-12">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <span className="flex size-10 items-center justify-center rounded-[var(--radius-lg)] bg-muted text-muted-foreground" aria-hidden>
            {accepted ? <Check /> : <ShieldCheck />}
          </span>
          <CardTitle>창업노트 워크스페이스에 참여</CardTitle>
          <CardDescription>로그인한 이메일과 초대 이메일이 일치해야 멤버 권한으로 연결됩니다.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {signedIn ? (
            <>
              <Button type="button" onClick={acceptInvitation} disabled={pending || accepted}>
                <ShieldCheck data-icon="inline-start" />
                {accepted ? "수락 완료" : pending ? "수락 중" : "초대 수락"}
              </Button>
              {accepted ? (
                <a className={buttonVariants({ variant: "secondary" })} href="/team">
                  팀 화면으로 이동
                </a>
              ) : null}
            </>
          ) : (
            <a className={buttonVariants()} href={loginHref}>
              <LogIn data-icon="inline-start" />
              로그인하고 수락
            </a>
          )}
          {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
        </CardContent>
      </Card>
    </section>
  );
}

function roleLabel(role: string): string {
  if (role === "admin") return "관리자";
  if (role === "member") return "멤버";
  return "뷰어";
}
