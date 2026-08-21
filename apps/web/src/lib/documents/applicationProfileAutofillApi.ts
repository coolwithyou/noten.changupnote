import type { ActionResult } from "@cunote/contracts";
import type {
  ApplicationAutofillProfile,
  ApplicationAutofillProfileInput,
} from "./applicationProfileAutofill";

export async function fetchApplicationAutofillProfile(
  draftId: string,
): Promise<ApplicationAutofillProfile> {
  return requestProfile(draftId, { method: "GET" });
}

export async function updateApplicationAutofillProfile(
  draftId: string,
  profile: ApplicationAutofillProfileInput,
): Promise<ApplicationAutofillProfile> {
  return requestProfile(draftId, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(profile),
  });
}

async function requestProfile(draftId: string, init: RequestInit): Promise<ApplicationAutofillProfile> {
  const response = await fetch(
    `/api/web/document-drafts/${encodeURIComponent(draftId)}/profile-autofill`,
    { ...init, cache: "no-store" },
  );
  const payload = await response.json().catch(() => null) as ActionResult<ApplicationAutofillProfile> | null;
  if (!response.ok || !payload?.ok || !payload.data) {
    throw new Error(payload?.error?.message ?? "신청서 등록정보 요청에 실패했습니다.");
  }
  return payload.data;
}
