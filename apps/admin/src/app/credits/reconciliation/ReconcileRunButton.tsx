"use client";

import { useState } from "react";

// 수동 대사 재실행 버튼(설계 11.8 / 14.3). admin+ 만 실제 실행됨(서버 role 검사).
// POST /api/admin/credits/reconciliation → 웹 내부 엔드포인트 호출 → 5 scope 즉시 실행 후 새로고침.
export default function ReconcileRunButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function handleClick() {
    if (pending) return;
    if (!window.confirm("전체 5개 범위 대사를 즉시 재실행합니다. 계속할까요?")) return;

    setPending(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/credits/reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (res.ok) {
        const overall = json?.data?.overallStatus ?? "완료";
        setResult(`대사 완료 (전체 상태: ${overall})`);
        setPending(false);
        // 결과 행을 반영하기 위해 잠시 후 새로고침.
        setTimeout(() => location.reload(), 800);
        return;
      }
      setError(json?.error?.message ?? "대사 재실행에 실패했습니다.");
      setPending(false);
    } catch {
      setError("네트워크 오류가 발생했습니다.");
      setPending(false);
    }
  }

  return (
    <>
      <button className="ops-button" type="button" onClick={handleClick} disabled={pending}>
        {pending ? "대사 실행 중…" : "수동 재실행"}
      </button>
      {result ? <span className="ops-note">{result}</span> : null}
      {error ? <span className="ops-note error">{error}</span> : null}
    </>
  );
}
