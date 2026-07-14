/** 외부 origin·protocol-relative URL을 거부하고 앱 내부 복귀 경로만 보존한다. */
export function safeInternalPath(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return null;
  }
  try {
    const base = "https://changupnote.internal";
    const url = new URL(candidate, base);
    if (url.origin !== base) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
