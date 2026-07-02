export function adminData<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data }, init);
}

export function adminError(code: string, message: string, status = 500, field?: string): Response {
  return Response.json({
    error: {
      code,
      message,
      ...(field ? { field } : {}),
    },
  }, { status });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
