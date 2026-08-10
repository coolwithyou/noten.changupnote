export const LOCAL_ANALYSIS_LAB_URL = "http://127.0.0.1:4010/dev/analysis-lab#batch-ops"

export function isLocalAdminHostname(hostname: string): boolean {
  return LOCAL_ADMIN_HOSTNAMES.has(hostname.toLowerCase())
}

export function isLocalAdminRuntime(
  hostname: string,
  nodeEnv: string | undefined,
): boolean {
  return nodeEnv !== "production" && isLocalAdminHostname(hostname)
}

export function hostnameFromHostHeader(value: string | null): string {
  if (!value) return ""
  const first = value.split(",", 1)[0]?.trim() ?? ""
  if (first.startsWith("[")) return first.slice(1, first.indexOf("]"))
  return first.split(":", 1)[0]?.trim() ?? ""
}

const LOCAL_ADMIN_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "dev-ops.changupnote.com",
  "dev.ops.changupnote.com",
])
