import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { AuthRequiredError } from "./session";

export function webActionError<T>(
  error: unknown,
  fallback: {
    code: string;
    message: string;
  },
): NextResponse<ActionResult<T>> {
  if (error instanceof AuthRequiredError) {
    return NextResponse.json<ActionResult<T>>({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
      },
    }, { status: error.status });
  }
  if (isStatusError(error)) {
    const actionError: NonNullable<ActionResult<T>["error"]> = {
      code: error.code,
      message: error.message,
    };
    if (error.field) actionError.field = error.field;
    return NextResponse.json<ActionResult<T>>({
      ok: false,
      error: actionError,
    }, { status: error.status });
  }

  return NextResponse.json<ActionResult<T>>({
    ok: false,
    error: {
      code: fallback.code,
      message: error instanceof Error ? error.message : fallback.message,
    },
  }, { status: 500 });
}

function isStatusError(error: unknown): error is {
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
