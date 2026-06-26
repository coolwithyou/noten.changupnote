import type { ApiEnvelope } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { AuthRequiredError } from "@/lib/server/auth/session";

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

export function appErrorFromUnknown(error: unknown, fallbackMessage: string) {
  if (error instanceof AuthRequiredError) {
    return appError(error.code, error.message, error.status);
  }
  return appError("internal_error", error instanceof Error ? error.message : fallbackMessage);
}
