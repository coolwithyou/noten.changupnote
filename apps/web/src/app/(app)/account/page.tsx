import { LegacyAccountRedirect } from "@/features/settings/LegacyAccountRedirect";

export const dynamic = "force-dynamic";

/** 프래그먼트를 쿼리 기반 설정 섹션으로 옮기는 공개 호환 별칭이다. */
export default function AccountPage() {
  return <LegacyAccountRedirect />;
}
