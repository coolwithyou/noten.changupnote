import type { FeedbackKind } from "@cunote/contracts";
import type { SubmitFeedbackInput } from "@cunote/core";

export type ApplicationManagementStage =
  | "recommended"
  | "saved"
  | "preparing"
  | "submitted"
  | "selected"
  | "rejected"
  | "blocked"
  | "dismissed";

export interface ApplicationManagement {
  assigneeName: string | null;
  reminderAt: string | null;
  outcomeNote: string | null;
  /** management-only feedback가 기존 신청 단계를 바꾸지 않도록 보존하는 단계 힌트. */
  applicationStage: ApplicationManagementStage | null;
}

export interface ApplicationManagementFeedbackSnapshot {
  grantId: string;
  kind: FeedbackKind;
  ts: Date;
  management: ApplicationManagement | null;
}

const runtimeManagementFeedback = getRuntimeManagementFeedbackStore();

export function recordApplicationManagementFeedback(input: SubmitFeedbackInput, receivedAt?: string): void {
  const management = applicationManagementFromPayload(input.payload);
  if (!management) return;

  const ts = receivedAt ? new Date(receivedAt) : new Date();
  const snapshot: ApplicationManagementFeedbackSnapshot = {
    grantId: input.grantId,
    kind: input.kind,
    ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
    management,
  };
  const key = managementFeedbackKey({
    companyId: input.companyId,
    userId: input.userId ?? null,
    grantId: input.grantId,
  });
  const current = runtimeManagementFeedback.get(key);
  if (!current || snapshot.ts.getTime() >= current.ts.getTime()) {
    runtimeManagementFeedback.set(key, snapshot);
  }
}

export function listRuntimeApplicationManagementFeedback(input: {
  companyId: string;
  userId: string;
  grantIds?: string[];
}): Map<string, ApplicationManagementFeedbackSnapshot> {
  const result = new Map<string, ApplicationManagementFeedbackSnapshot>();
  const grantIds = input.grantIds ?? runtimeGrantIds(input.companyId, input.userId);
  for (const grantId of grantIds) {
    const snapshot = runtimeManagementFeedback.get(managementFeedbackKey({
      companyId: input.companyId,
      userId: input.userId,
      grantId,
    })) ?? runtimeManagementFeedback.get(managementFeedbackKey({
      companyId: input.companyId,
      userId: null,
      grantId,
    }));
    if (snapshot) result.set(grantId, snapshot);
  }
  return result;
}

function runtimeGrantIds(companyId: string, userId: string): string[] {
  const result = new Set<string>();
  const prefixes = [`${userId}:${companyId}:`, `_:${companyId}:`];
  for (const key of runtimeManagementFeedback.keys()) {
    for (const prefix of prefixes) {
      if (key.startsWith(prefix)) result.add(key.slice(prefix.length));
    }
  }
  return [...result];
}

export function applicationManagementFromPayload(value: unknown): ApplicationManagement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (payload.source !== "application_pipeline") return null;
  const assigneeName = optionalString(payload.assigneeName, 80);
  const reminderAt = dateString(payload.reminderAt);
  const outcomeNote = optionalString(payload.outcomeNote, 1000);
  const applicationStage = managementStage(payload.applicationStage);
  // source가 application_pipeline이면 all-null도 "명시적으로 모두 지움"인 최신 스냅샷이다.
  return { assigneeName, reminderAt, outcomeNote, applicationStage };
}

function managementFeedbackKey(input: {
  companyId: string;
  userId: string | null;
  grantId: string;
}): string {
  return `${input.userId ?? "_"}:${input.companyId}:${input.grantId}`;
}

function optionalString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, maxLength)
    : null;
}

function managementStage(value: unknown): ApplicationManagementStage | null {
  if (
    value === "recommended"
    || value === "saved"
    || value === "preparing"
    || value === "submitted"
    || value === "selected"
    || value === "rejected"
    || value === "blocked"
    || value === "dismissed"
  ) {
    return value;
  }
  return null;
}

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function getRuntimeManagementFeedbackStore(): Map<string, ApplicationManagementFeedbackSnapshot> {
  const key = "__cunoteApplicationManagementFeedback";
  const runtime = globalThis as typeof globalThis & {
    __cunoteApplicationManagementFeedback?: Map<string, ApplicationManagementFeedbackSnapshot>;
  };
  runtime[key] ??= new Map<string, ApplicationManagementFeedbackSnapshot>();
  return runtime[key];
}
