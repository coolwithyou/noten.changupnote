export type GrantSimulationNavigationRole = "owner" | "admin" | "reviewer";

const GRANT_SIMULATION_NAVIGATION_HOSTS = new Set([
  "dev.changupnote.com",
  "127.0.0.1",
  "localhost",
]);

export function isGrantSimulationNavigationHost(
  rawHost: string | null | undefined,
): boolean {
  return GRANT_SIMULATION_NAVIGATION_HOSTS.has(normalizeRequestHost(rawHost));
}

/** 지원서 시뮬레이션 GNB는 로컬·개발 웹 호스트의 owner에게만 노출한다. */
export function isGrantSimulationNavigationAllowed(
  rawHost: string | null | undefined,
  role: GrantSimulationNavigationRole | null | undefined,
): boolean {
  return role === "owner" && isGrantSimulationNavigationHost(rawHost);
}

function normalizeRequestHost(rawHost: string | null | undefined): string {
  const firstHost = rawHost?.split(",", 1)[0]?.trim().toLowerCase() ?? "";
  if (firstHost.startsWith("[")) {
    const closingBracket = firstHost.indexOf("]");
    return closingBracket >= 0 ? firstHost.slice(1, closingBracket) : firstHost;
  }
  return firstHost.split(":", 1)[0] ?? "";
}
