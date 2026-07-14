export const SETTINGS_SECTIONS = ["company", "data", "activity"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** 인증 리디렉션을 통과해도 남는 설정 섹션만 허용한다. */
export function normalizeSettingsSection(
  value: string | string[] | null | undefined,
): SettingsSection | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return SETTINGS_SECTIONS.find((section) => section === candidate) ?? null;
}

export function settingsPath(section: SettingsSection | null): string {
  if (!section) return "/settings";
  return `/settings?${new URLSearchParams({ section }).toString()}`;
}

export function legacyAccountSection(hash: string): SettingsSection | null {
  if (hash === "#account-deletion-request" || hash === "#account-deletion") return "data";
  if (hash === "#account-support-tickets") return "activity";
  if (hash === "#company-settings" || hash === "#company-settings-detail") return "company";
  return null;
}

/** 공개 레거시 별칭에서 세션 유무와 무관하게 안전한 내부 복귀 경로를 만든다. */
export function legacyAccountLoginHref(hash: string): string {
  const callbackUrl = settingsPath(legacyAccountSection(hash));
  return `/login?${new URLSearchParams({ callbackUrl }).toString()}`;
}
