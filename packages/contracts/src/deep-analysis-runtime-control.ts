export const DEEP_ANALYSIS_RUNTIME_MODES = [
  "paused",
  "production_api",
  "local_subscription",
] as const;

export type DeepAnalysisRuntimeMode = (typeof DEEP_ANALYSIS_RUNTIME_MODES)[number];

export interface DeepAnalysisRuntimeControl {
  controlKey: "global";
  mode: DeepAnalysisRuntimeMode;
  generation: number;
  changedBy: string;
  changeReason: string | null;
  localOwnerId: string | null;
  localLeaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeepAnalysisRuntimeControlStatus extends DeepAnalysisRuntimeControl {
  effectiveMode: DeepAnalysisRuntimeMode;
  productionAllowed: boolean;
  localAllowed: boolean;
  activeDeepLeases: number;
  activeApplicationLeases: number;
}

export function isDeepAnalysisRuntimeMode(value: unknown): value is DeepAnalysisRuntimeMode {
  return typeof value === "string"
    && (DEEP_ANALYSIS_RUNTIME_MODES as readonly string[]).includes(value);
}

export function parseDeepAnalysisRuntimeMode(value: unknown): DeepAnalysisRuntimeMode {
  if (!isDeepAnalysisRuntimeMode(value)) {
    throw new Error(`Unknown deep analysis runtime mode: ${String(value)}`);
  }
  return value;
}

export function effectiveDeepAnalysisRuntimeMode(
  control: Pick<DeepAnalysisRuntimeControl, "mode" | "localOwnerId" | "localLeaseExpiresAt">,
  now: Date = new Date(),
): DeepAnalysisRuntimeMode {
  if (control.mode !== "local_subscription") return control.mode;
  if (!control.localOwnerId || !control.localLeaseExpiresAt) return "paused";
  const expiresAt = Date.parse(control.localLeaseExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return "paused";
  return "local_subscription";
}

export function canRunProductionDeepAnalysis(
  control: Pick<DeepAnalysisRuntimeControl, "mode" | "localOwnerId" | "localLeaseExpiresAt">,
  now: Date = new Date(),
): boolean {
  return effectiveDeepAnalysisRuntimeMode(control, now) === "production_api";
}

export function canRunLocalSubscriptionAnalysis(
  control: Pick<DeepAnalysisRuntimeControl, "mode" | "localOwnerId" | "localLeaseExpiresAt">,
  ownerId: string,
  now: Date = new Date(),
): boolean {
  return ownerId.trim().length > 0
    && effectiveDeepAnalysisRuntimeMode(control, now) === "local_subscription"
    && control.localOwnerId === ownerId;
}
