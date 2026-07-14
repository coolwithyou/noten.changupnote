"use client";

import { signOut } from "next-auth/react";
import { Button, buttonVariants } from "@/components/ui/button";

export function SettingsAccountActions() {
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={() => void signOut({ callbackUrl: "/" })}>
        로그아웃
      </Button>
      <a className={buttonVariants({ variant: "link", size: "sm" })} href="#account-deletion">
        탈퇴하기
      </a>
    </div>
  );
}
