"use client";

import { useState } from "react";

interface SettingItem {
  key: string;
  value: unknown;
  updatedAt: string | null;
}

interface SettingsFormProps {
  settings: Array<SettingItem>;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // JSON 파싱 실패 시 raw 문자열 그대로 전송
    return raw;
  }
}

function SettingRow({ item }: { item: SettingItem }) {
  const [valueStr, setValueStr] = useState(() => JSON.stringify(item.value));
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const reasonId = `setting-reason-${item.key}`;
  const valueId = `setting-value-${item.key}`;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!reason.trim()) {
      setMessage({ tone: "error", text: "사유를 입력해야 합니다." });
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/credits/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: item.key,
          value: parseValue(valueStr),
          reason: reason.trim(),
        }),
      });
      const json = await res.json();
      if (res.ok) {
        setMessage({ tone: "success", text: "저장됨" });
        setPending(false);
        return;
      }
      setMessage({ tone: "error", text: json?.error?.message ?? "저장에 실패했습니다." });
      setPending(false);
    } catch {
      setMessage({ tone: "error", text: "네트워크 오류가 발생했습니다." });
      setPending(false);
    }
  }

  return (
    <form
      className="ops-panel"
      onSubmit={handleSubmit}
      style={{ marginBottom: 12 }}
    >
      <div className="ops-field">
        <label htmlFor={valueId}>{item.key}</label>
        <input
          id={valueId}
          type="text"
          value={valueStr}
          onChange={(e) => setValueStr(e.target.value)}
          disabled={pending}
        />
        {item.updatedAt ? (
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            최근 수정: {item.updatedAt}
          </span>
        ) : null}
      </div>

      <div className="ops-field">
        <label htmlFor={reasonId}>사유 (필수)</label>
        <input
          id={reasonId}
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          disabled={pending}
        />
      </div>

      <div className="ops-actions">
        <button className="ops-button" type="submit" disabled={pending}>
          {pending ? "저장 중…" : "저장"}
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

export default function SettingsForm({ settings }: SettingsFormProps) {
  return (
    <div>
      <h3 className="ops-section-title">크레딧 설정</h3>
      {settings.map((item) => (
        <SettingRow item={item} key={item.key} />
      ))}
    </div>
  );
}
