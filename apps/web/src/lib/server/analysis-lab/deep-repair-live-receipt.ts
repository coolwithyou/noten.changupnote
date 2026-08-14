import { createHash } from "node:crypto";

export interface ValidatedDeepRepairLiveReceipt {
  readonly schema: "deep-repair-live-receipt-v1";
  readonly receiptSha256: string;
  readonly planSha256: string;
  readonly manifestSha256: string;
  readonly parentReceiptSha256: string | null;
  readonly authoritySha256: string;
  readonly attemptId: string;
  readonly target: {
    readonly sequence: number;
    readonly waveId: string;
    readonly grantId: string;
  };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly lifecycle: "finished";
  readonly noticeOutcome: "publishable" | "held" | "failed";
  readonly promotionEligibility: "not_evaluated";
  readonly runArtifactPath: string | null;
  readonly runArtifactSha256: string | null;
  readonly observationsSha256: string | null;
  readonly evaluatorReceiptSha256: string | null;
  readonly observedCount: number;
  readonly gateVerdict: "CONTINUE" | "GO" | "NO_GO" | "INCONCLUSIVE" | "INVALID";
  readonly nextAction: "awaiting_user_authority" | "new_user_authority_required" | "stopped";
  readonly failureCode: string | null;
}

/** live와 recovery가 같은 terminal receipt 의미를 사용하게 하는 순수 검증기다. */
export function validateDeepRepairLiveReceipt(value: unknown): ValidatedDeepRepairLiveReceipt {
  const source = record(value, "receipt");
  const target = record(source.target, "receipt.target");
  const receipt: ValidatedDeepRepairLiveReceipt = {
    schema: literal(source.schema, "deep-repair-live-receipt-v1", "receipt.schema"),
    receiptSha256: sha(source.receiptSha256, "receipt.receiptSha256"),
    planSha256: sha(source.planSha256, "receipt.planSha256"),
    manifestSha256: sha(source.manifestSha256, "receipt.manifestSha256"),
    parentReceiptSha256: nullableSha(source.parentReceiptSha256, "receipt.parentReceiptSha256"),
    authoritySha256: sha(source.authoritySha256, "receipt.authoritySha256"),
    attemptId: text(source.attemptId, "receipt.attemptId"),
    target: {
      sequence: nonNegativeInteger(target.sequence, "receipt.target.sequence"),
      waveId: text(target.waveId, "receipt.target.waveId"),
      grantId: text(target.grantId, "receipt.target.grantId"),
    },
    startedAt: iso(source.startedAt, "receipt.startedAt"),
    finishedAt: iso(source.finishedAt, "receipt.finishedAt"),
    lifecycle: literal(source.lifecycle, "finished", "receipt.lifecycle"),
    noticeOutcome: oneOf(source.noticeOutcome, ["publishable", "held", "failed"] as const, "receipt.noticeOutcome"),
    promotionEligibility: literal(source.promotionEligibility, "not_evaluated", "receipt.promotionEligibility"),
    runArtifactPath: nullableText(source.runArtifactPath, "receipt.runArtifactPath"),
    runArtifactSha256: nullableSha(source.runArtifactSha256, "receipt.runArtifactSha256"),
    observationsSha256: nullableSha(source.observationsSha256, "receipt.observationsSha256"),
    evaluatorReceiptSha256: nullableSha(source.evaluatorReceiptSha256, "receipt.evaluatorReceiptSha256"),
    observedCount: nonNegativeInteger(source.observedCount, "receipt.observedCount"),
    gateVerdict: oneOf(
      source.gateVerdict,
      ["CONTINUE", "GO", "NO_GO", "INCONCLUSIVE", "INVALID"] as const,
      "receipt.gateVerdict",
    ),
    nextAction: oneOf(
      source.nextAction,
      ["awaiting_user_authority", "new_user_authority_required", "stopped"] as const,
      "receipt.nextAction",
    ),
    failureCode: nullableText(source.failureCode, "receipt.failureCode"),
  };
  const { receiptSha256, ...body } = receipt;
  if (canonicalSha256(body) !== receiptSha256) throw new Error("receipt hash mismatch");
  if (canonicalJson(value) !== canonicalJson(receipt)) throw new Error("receipt must be canonical");
  return receipt;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function literal<const T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} must be ${allowed.join("|")}`);
  }
  return value as T[number];
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be non-empty`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function sha(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(`${label} must be SHA-256`);
  return normalized;
}

function nullableSha(value: unknown, label: string): string | null {
  return value === null ? null : sha(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be non-negative`);
  return value as number;
}

function iso(value: unknown, label: string): string {
  const normalized = text(value, label);
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
  return normalized;
}
