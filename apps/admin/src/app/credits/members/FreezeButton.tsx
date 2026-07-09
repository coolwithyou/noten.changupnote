"use client";

import { useState } from "react";

interface FreezeButtonProps {
  userId: string;
  walletId: string | null;
  frozen: boolean;
}

export default function FreezeButton({ userId, walletId, frozen }: FreezeButtonProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (walletId === null) {
    return (
      <button className="ops-button ghost" type="button" disabled>
        지갑 없음
      </button>
    );
  }

  async function handleClick() {
    if (pending) return;
    const reason = window.prompt(
      frozen ? "동결 해제 사유를 입력하세요." : "지갑 동결 사유를 입력하세요.",
    );
    if (reason === null) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("사유를 입력해야 합니다.");
      return;
    }

    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/credits/members/${userId}/freeze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frozen: !frozen, reason: trimmed }),
      });
      const json = await res.json();
      if (res.ok) {
        location.reload();
        return;
      }
      setError(json?.error?.message ?? "요청을 처리하지 못했습니다.");
      setPending(false);
    } catch {
      setError("네트워크 오류가 발생했습니다.");
      setPending(false);
    }
  }

  return (
    <div>
      <button
        className={`ops-button ${frozen ? "ghost" : "danger"}`}
        type="button"
        onClick={handleClick}
        disabled={pending}
      >
        {pending ? "처리 중…" : frozen ? "동결 해제" : "지갑 동결"}
      </button>
      {error ? <p className="ops-note error">{error}</p> : null}
    </div>
  );
}
