import { isValidBizNoChecksum } from "@cunote/contracts";

export const VIRTUAL_COMPANY_IDENTITIES = [
  { id: "virtual-chungnam-disabled-perfect", bizNo: "0000000001" },
  { id: "virtual-chungnam-disabled-region-fail", bizNo: "0000000002" },
  { id: "virtual-chungnam-disabled-cert-missing", bizNo: "0000000003" },
] as const;

const VIRTUAL_BIZ_NO_SET = new Set<string>(
  VIRTUAL_COMPANY_IDENTITIES.map((identity) => identity.bizNo),
);

export type VirtualCompanyId = typeof VIRTUAL_COMPANY_IDENTITIES[number]["id"];

export function normalizeVirtualCompanyBizNo(value: string): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function isVirtualCompanyBizNo(value: string): boolean {
  return VIRTUAL_BIZ_NO_SET.has(normalizeVirtualCompanyBizNo(value));
}

export function isAcceptedLandingBizNo(
  value: string,
  options: { allowVirtual: boolean },
): boolean {
  const digits = normalizeVirtualCompanyBizNo(value);
  return isValidBizNoChecksum(digits) || (options.allowVirtual && isVirtualCompanyBizNo(digits));
}

export function isEnabledFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isVirtualCompanyClientEnabled(): boolean {
  return isEnabledFlag(process.env.NEXT_PUBLIC_CUNOTE_VIRTUAL_COMPANY_ENABLED);
}
