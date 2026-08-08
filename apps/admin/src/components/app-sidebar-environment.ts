export const LOCAL_ANALYSIS_LAB_URL = "http://127.0.0.1:4010/dev/analysis-lab#batch-ops"

export function isLocalAdminHostname(hostname: string): boolean {
  return LOCAL_ADMIN_HOSTNAMES.has(hostname.toLowerCase())
}

const LOCAL_ADMIN_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "dev-ops.changupnote.com",
  "dev.ops.changupnote.com",
])
