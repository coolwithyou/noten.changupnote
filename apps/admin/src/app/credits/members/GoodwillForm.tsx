"use client";

import { useState } from "react";

export default function GoodwillForm({ userId }: { userId: string }) {
  const [nonce] = useState(() => crypto.randomUUID());
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const [ticketRef, setTicketRef] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage(null);

    try {
      const res = await fetch(`/api/admin/credits/members/${userId}/goodwill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credits: Number(credits),
          reason,
          ticketRef,
          nonce,
        }),
      });
      const json = await res.json();

      if (res.ok) {
        setMessage({ tone: "success", text: "굿윌 지급 완료. 새로고침합니다." });
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
      <h3 className="ops-section-title">굿윌 지급 (Support)</h3>

      <div className="ops-field">
        <label htmlFor="goodwill-credits">크레딧 (양의 정수)</label>
        <input
          id="goodwill-credits"
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
        <label htmlFor="goodwill-reason">사유 (필수)</label>
        <input
          id="goodwill-reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          disabled={pending}
        />
      </div>

      <div className="ops-field">
        <label htmlFor="goodwill-ticket">티켓 번호 (필수)</label>
        <input
          id="goodwill-ticket"
          type="text"
          value={ticketRef}
          onChange={(e) => setTicketRef(e.target.value)}
          required
          disabled={pending}
        />
      </div>

      <div className="ops-actions">
        <button className="ops-button" type="submit" disabled={pending}>
          {pending ? "처리 중…" : "지급"}
        </button>
      </div>

      {message ? (
        <p className={`ops-note ${message.tone === "error" ? "error" : "success"}`}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
