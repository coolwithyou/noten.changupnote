import { GrantArchivePageView } from "@/features/archive/GrantArchivePageView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { fallbackHeaderUserForDemoAccess, getOptionalHeaderUser } from "@/lib/server/auth/session";
import { loadGrantArchive, loadGrantArchiveFacets } from "@/lib/server/archive/grantArchiveData";
import { parseGrantArchiveSearchParams } from "@/lib/server/archive/grantArchiveQuery";

export const dynamic = "force-dynamic";

interface ArchivePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ArchivePage({ searchParams }: ArchivePageProps) {
  const access = await loadArchiveAccess();
  const params = await searchParams;
  const urlSearchParams = toUrlSearchParams(params);
  const parsedQuery = parseGrantArchiveSearchParams(urlSearchParams);
  const query = parsedQuery.ok ? parsedQuery.query : {};
  const [user, archive, facets] = await Promise.all([
    getOptionalHeaderUser().then((user) => user ?? fallbackHeaderUserForDemoAccess(access)),
    loadGrantArchive({ access, query }),
    loadGrantArchiveFacets({ access, query }),
  ]);

  return (
    <GrantArchivePageView
      archive={archive}
      currentParams={urlSearchParams}
      facets={facets}
      query={query}
      queryError={parsedQuery.ok ? null : parsedQuery.error.message}
      user={user}
    />
  );
}

async function loadArchiveAccess() {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, "/archive");
  }
}

function toUrlSearchParams(input: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }
  return params;
}
