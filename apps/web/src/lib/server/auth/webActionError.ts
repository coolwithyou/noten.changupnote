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

  return NextResponse.json<ActionResult<T>>({
    ok: false,
    error: {
      code: fallback.code,
      message: error instanceof Error ? error.message : fallback.message,
    },
  }, { status: 500 });
}
