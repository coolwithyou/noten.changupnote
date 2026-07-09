"use client";

import { useState } from "react";

type RuleType = "model_token" | "feature_flat" | "feature_free";

interface IssueBody {
  ruleType: RuleType;
  effectiveFrom: string;
  confirmed: boolean;
  featureCode?: string;
  model?: string;
  inputMillicreditsPer1k?: number;
  outputMillicreditsPer1k?: number;
  cacheReadMillicreditsPer1k?: number;
  cacheWriteMillicreditsPer1k?: number;
  flatCredits?: number;
  note?: string;
}

function numOrEmpty(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default function PricingForm() {
  // ── (A) 새 요율 발행 폼 상태 ──────────────────────────────
  const [ruleType, setRuleType] = useState<RuleType>("model_token");
  const [featureCode, setFeatureCode] = useState("");
  const [model, setModel] = useState("");
  const [inputMc, setInputMc] = useState("");
  const [outputMc, setOutputMc] = useState("");
  const [cacheReadMc, setCacheReadMc] = useState("");
  const [cacheWriteMc, setCacheWriteMc] = useState("");
  const [flatCredits, setFlatCredits] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!effectiveFrom) {
      setMessage({ tone: "error", text: "적용 시각(effectiveFrom)을 입력하세요." });
      return;
    }
    setPending(true);
    setMessage(null);

    const body: IssueBody = {
      ruleType,
      effectiveFrom: new Date(effectiveFrom).toISOString(),
      confirmed,
    };
    if (featureCode.trim() !== "") body.featureCode = featureCode.trim();
    if (model.trim() !== "") body.model = model.trim();
    const inN = numOrEmpty(inputMc);
    if (inN !== null) body.inputMillicreditsPer1k = inN;
    const outN = numOrEmpty(outputMc);
    if (outN !== null) body.outputMillicreditsPer1k = outN;
    const crN = numOrEmpty(cacheReadMc);
    if (crN !== null) body.cacheReadMillicreditsPer1k = crN;
    const cwN = numOrEmpty(cacheWriteMc);
    if (cwN !== null) body.cacheWriteMillicreditsPer1k = cwN;
    const flatN = numOrEmpty(flatCredits);
    if (flatN !== null) body.flatCredits = flatN;
    if (note.trim() !== "") body.note = note.trim();

    try {
      const res = await fetch("/api/admin/credits/pricing-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();

      if (res.ok) {
        setMessage({ tone: "success", text: "요율 발행 완료. 새로고침합니다." });
        setTimeout(() => location.reload(), 600);
        return;
      }

      const code: string | undefined = json?.error?.code;
      if (code === "rate_change_exceeds_10x") {
        setMessage({
          tone: "error",
          text: "10배 이상 변화 — confirmed 체크 후 재제출하세요.",
        });
      } else if (code === "rate_increase_requires_7d_notice") {
        setMessage({
          tone: "error",
          text: "인상은 7일 예고가 필요합니다. 적용 시각을 7일 이후로 설정하세요.",
        });
      } else {
        setMessage({ tone: "error", text: json?.error?.message ?? "요청을 처리하지 못했습니다." });
      }
      setPending(false);
    } catch {
      setMessage({ tone: "error", text: "네트워크 오류가 발생했습니다." });
      setPending(false);
    }
  }

  // ── (B) 요율 계산기 상태 ──────────────────────────────────
  const [usdInputPer1M, setUsdInputPer1M] = useState("");
  const [usdOutputPer1M, setUsdOutputPer1M] = useState("");
  const [krwPerUsd, setKrwPerUsd] = useState("1350");
  const [margin, setMargin] = useState("0");
  const [krwPerCredit, setKrwPerCredit] = useState("1");

  function calcMillicreditsPer1k(usdPer1M: number): number | null {
    const rate = Number(krwPerUsd);
    const m = Number(margin);
    const perCredit = Number(krwPerCredit);
    if (!Number.isFinite(usdPer1M) || !Number.isFinite(rate) || !Number.isFinite(m) || !Number.isFinite(perCredit) || perCredit <= 0) {
      return null;
    }
    // usdPer1M: 1,000,000 토큰당 USD → 1,000 토큰당 USD = usdPer1M / 1000
    // KRW 원가 = (usdPer1M / 1000) * krwPerUsd
    // 마진 적용 = 원가 * (1 + margin/100)
    // 크레딧 = KRW / krwPerCredit
    // 밀리크레딧 = 크레딧 * 1000
    const millicreditsPer1k = ((usdPer1M / 1000) * rate * (1 + m / 100)) / perCredit * 1000;
    return millicreditsPer1k;
  }

  const inputCalc = usdInputPer1M.trim() !== "" ? calcMillicreditsPer1k(Number(usdInputPer1M)) : null;
  const outputCalc = usdOutputPer1M.trim() !== "" ? calcMillicreditsPer1k(Number(usdOutputPer1M)) : null;

  function copyToForm() {
    if (inputCalc !== null) setInputMc(String(Math.round(inputCalc)));
    if (outputCalc !== null) setOutputMc(String(Math.round(outputCalc)));
  }

  return (
    <div>
      {/* ── (A) 발행 폼 ── */}
      <form className="ops-panel" onSubmit={handleSubmit} style={{ marginBottom: 16 }}>
        <h3 className="ops-section-title">새 요율 발행</h3>

        <div className="ops-field">
          <label htmlFor="pricing-ruletype">규칙 유형</label>
          <select
            id="pricing-ruletype"
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value as RuleType)}
            disabled={pending}
          >
            <option value="model_token">model_token (토큰 기반)</option>
            <option value="feature_flat">feature_flat (기능 정액)</option>
            <option value="feature_free">feature_free (기능 무료)</option>
          </select>
        </div>

        <div className="ops-field">
          <label htmlFor="pricing-feature">featureCode</label>
          <input
            id="pricing-feature"
            type="text"
            value={featureCode}
            onChange={(e) => setFeatureCode(e.target.value)}
            disabled={pending}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="pricing-model">model</label>
          <input
            id="pricing-model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={pending}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="pricing-input">inputMillicreditsPer1k</label>
          <input
            id="pricing-input"
            type="number"
            value={inputMc}
            onChange={(e) => setInputMc(e.target.value)}
            disabled={pending}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="pricing-output">outputMillicreditsPer1k</label>
          <input
            id="pricing-output"
            type="number"
            value={outputMc}
            onChange={(e) => setOutputMc(e.target.value)}
            disabled={pending}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="pricing-cacheread">cacheReadMillicreditsPer1k</label>
          <input
            id="pricing-cacheread"
            type="number"
            value={cacheReadMc}
            onChange={(e) => setCacheReadMc(e.target.value)}
            disabled={pending}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="pricing-cachewrite">cacheWriteMillicreditsPer1k</label>
          <input
            id="pricing-cachewrite"
            type="number"
            value={cacheWriteMc}
            onChange={(e) => setCacheWriteMc(e.target.value)}
            disabled={pending}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="pricing-flat">flatCredits</label>
          <input
            id="pricing-flat"
            type="number"
            value={flatCredits}
            onChange={(e) => setFlatCredits(e.target.value)}
            disabled={pending}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="pricing-effective">effectiveFrom (적용 시각)</label>
          <input
            id="pricing-effective"
            type="datetime-local"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            required
            disabled={pending}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="pricing-note">비고</label>
          <input
            id="pricing-note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="pricing-confirmed" style={{ flexDirection: "row", display: "flex", gap: 8, alignItems: "center" }}>
            <input
              id="pricing-confirmed"
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={pending}
              style={{ width: "auto" }}
            />
            10배 이상 변화 2차 확인 (confirmed)
          </label>
        </div>

        <div className="ops-actions">
          <button className="ops-button" type="submit" disabled={pending}>
            {pending ? "발행 중…" : "발행"}
          </button>
        </div>

        {message ? (
          <p className={`ops-note ${message.tone === "error" ? "error" : message.tone === "success" ? "success" : ""}`}>
            {message.text}
          </p>
        ) : null}
      </form>

      {/* ── (B) 요율 계산기 ── */}
      <div className="ops-panel">
        <h3 className="ops-section-title">요율 계산기</h3>
        <p className="ops-note">
          USD 단가·환율·마진·크레딧당 KRW로 밀리크레딧/1k 토큰을 산출합니다. (API 호출 없음)
        </p>

        <div className="ops-field">
          <label htmlFor="calc-usd-input">Input USD / 1M tokens</label>
          <input
            id="calc-usd-input"
            type="number"
            step="any"
            value={usdInputPer1M}
            onChange={(e) => setUsdInputPer1M(e.target.value)}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="calc-usd-output">Output USD / 1M tokens</label>
          <input
            id="calc-usd-output"
            type="number"
            step="any"
            value={usdOutputPer1M}
            onChange={(e) => setUsdOutputPer1M(e.target.value)}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="calc-fx">환율 (KRW / USD)</label>
          <input
            id="calc-fx"
            type="number"
            step="any"
            value={krwPerUsd}
            onChange={(e) => setKrwPerUsd(e.target.value)}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="calc-margin">마진 (%)</label>
          <input
            id="calc-margin"
            type="number"
            step="any"
            value={margin}
            onChange={(e) => setMargin(e.target.value)}
          />
        </div>

        <div className="ops-field">
          <label htmlFor="calc-krw-per-credit">크레딧당 KRW (예: 1)</label>
          <input
            id="calc-krw-per-credit"
            type="number"
            step="any"
            value={krwPerCredit}
            onChange={(e) => setKrwPerCredit(e.target.value)}
          />
        </div>

        <div style={{ margin: "8px 0" }}>
          <p className="ops-note">
            Input: {inputCalc !== null ? `${inputCalc.toFixed(2)} 밀리크레딧 / 1k` : "—"}
          </p>
          <p className="ops-note">
            Output: {outputCalc !== null ? `${outputCalc.toFixed(2)} 밀리크레딧 / 1k` : "—"}
          </p>
        </div>

        <div className="ops-actions">
          <button
            className="ops-button ghost"
            type="button"
            onClick={copyToForm}
            disabled={inputCalc === null && outputCalc === null}
          >
            발행 폼에 복사
          </button>
        </div>
      </div>
    </div>
  );
}
