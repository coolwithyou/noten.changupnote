import type { ApiEnvelope } from "@cunote/contracts";
import { NextResponse } from "next/server";

export function appData<T>(
  data: T,
  init?: ResponseInit,
  meta?: ApiEnvelope<T>["meta"],
) {
  const body: ApiEnvelope<T> = meta ? { data, meta } : { data };
  return NextResponse.json(body, init);
}

export function appEmpty(init?: ResponseInit) {
  return NextResponse.json<ApiEnvelope<null>>({ data: null }, init);
}

export function appError(
  code: string,
  message: string,
  status = 500,
  field?: string,
) {
  const error: NonNullable<ApiEnvelope<null>["error"]> = { code, message };
  if (field) error.field = field;
  return NextResponse.json<ApiEnvelope<null>>({ data: null, error }, { status });
}

export function appNotImplemented(feature: string) {
  return appError("not_implemented", `${feature}은 아직 연결되지 않았습니다.`, 501);
}

export function invalidAuthRequest(message: string, field?: string) {
  return appError("invalid_auth_request", message, 400, field);
}

export function appErrorFromUnknown(error: unknown, fallbackMessage: string) {
  if (isApiStatusError(error)) {
    return appError(error.code, error.message, error.status, error.field);
  }
  if (error instanceof Error && /token|토큰/i.test(error.message)) {
    return appError("invalid_token", error.message, 401);
  }
  return appError("internal_error", error instanceof Error ? error.message : fallbackMessage);
}

function isApiStatusError(error: unknown): error is {
  code: string;
  message: string;
  status: number;
  field?: string;
} {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & {
    code?: unknown;
    status?: unknown;
    field?: unknown;
  };
  return typeof candidate.code === "string" && typeof candidate.status === "number";
}
