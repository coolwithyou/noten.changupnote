import { CompanySourcesView } from "@/features/company-sources/CompanySourcesView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { listCompanyWritingSources, type CompanyWritingSources } from "@/lib/server/documents/companyWritingSources";
import { WritingContextError } from "@/lib/server/documents/writingContext";

export const dynamic = "force-dynamic";

/** 설정 › 회사 자료(계획 §3.2 경로 `/settings/writing-sources`). 세션이 선택한 회사의 자료함을 연다. */
export default async function WritingSourcesSettingsPage() {
  const access = await loadAccess();
  let initial: CompanyWritingSources | null = null;
  let loadError: string | null = null;
  try {
    initial = await listCompanyWritingSources({ access });
  } catch (error) {
    // 데모 세션(로그인 필요)·권한 없음은 화면에서 이유를 보여 준다. 그 밖의 오류는 그대로 올린다.
    if (!(error instanceof WritingContextError)) throw error;
    loadError = error.message;
  }
  return <CompanySourcesView companyId={access.companyId} initial={initial} loadError={loadError} />;
}

async function loadAccess() {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, "/settings/writing-sources");
  }
}
