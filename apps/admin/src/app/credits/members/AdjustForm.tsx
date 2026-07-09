"use client";

import { useState } from "react";

type Direction = "grant" | "deduct";

interface AdjustBody {
  direction: Direction;
  credits: number;
  reason: string;
  nonce: string;
  expiryDays?: number;
}

export default function AdjustForm({ userId }: { userId: string }) {
  const [nonce] = useState(() => crypto.randomUUID());
  const [direction, setDirection] = useState<Direction>("grant");
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const [expiryDays, setExpiryDays] = useState("90");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage(null);

    const body: AdjustBody = {
      direction,
      credits: Number(credits),
      reason,
      nonce,
    };
    if (direction === "grant" && expiryDays) {
      body.expiryDays = Number(expiryDays);
    }

    try {
      const res = await fetch(`/api/admin/credits/members/${userId}/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();

      if (res.status === 202) {
        setMessage({
          tone: "info",
          text: "승인 대기 등록됨 — owner 승인이 필요합니다.",
        });
        setPending(false);
        return;
      }

      if (res.ok) {
        const balanceAfter =
          json?.data && typeof json.data.balanceAfter !== "undefined"
            ? String(json.data.balanceAfter)
            : null;
        setMessage({
          tone: "success",
          text: balanceAfter
            ? `처리 완료 — 새 잔액 ${balanceAfter} 크레딧. 새로고침합니다.`
            : "처리 완료. 새로고침합니다.",
        });
        setTimeout(() => location.reload(), 600);
        return;
      }

      const errMsg = json?.error?.message ?? "요청을 처리하지 못했습니다.";
      setMessage({ tone: "error", text: errMsg });
      setPending(false);
    } catch {
      setMessage({ tone: "error", text: "네트워크 오류가 발생했습니다." });
      setPending(false);
    }
  }

  return (
    <form className="ops-panel" onSubmit={handleSubmit}>
      <h3 className="ops-section-title">지급 / 차감</h3>

      <div className="ops-field">
        <label htmlFor="adjust-direction">방향</label>
        <select
          id="adjust-direction"
          value={direction}
          onChange={(e) => setDirection(e.target.value as Direction)}
          disabled={pending}
        >
          <option value="grant">지급</option>
          <option value="deduct">차감</option>
        </select>
      </div>

      <div className="ops-field">
        <label htmlFor="adjust-credits">크레딧 (양의 정수)</label>
        <input
          id="adjust-credits"
          type="number"
          min={1}
          step={1}
          value={credits}
          onChange={(e) => setCredits(e.target.value)}
          required
          disabled={pending}
        />
      </div>

      <div className="ops-field">
        <label htmlFor="adjust-reason">사유 (필수)</label>
        <input
          id="adjust-reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          disabled={pending}
        />
      </div>

      {direction === "grant" ? (
        <div className="ops-field">
          <label htmlFor="adjust-expiry">만료일 (일 단위, 기본 90일)</label>
          <input
            id="adjust-expiry"
            type="number"
            min={1}
            step={1}
            placeholder="90"
            value={expiryDays}
            onChange={(e) => setExpiryDays(e.target.value)}
            disabled={pending}
          />
        </div>
      ) : null}

      <div className="ops-actions">
        <button className="ops-button" type="submit" disabled={pending}>
          {pending ? "처리 중…" : "실행"}
        </button>
      </div>

      {message ? (
        <p className={`ops-note ${message.tone === "error" ? "error" : message.tone === "success" ? "success" : ""}`}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
