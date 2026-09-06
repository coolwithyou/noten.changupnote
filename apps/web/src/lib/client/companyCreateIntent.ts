import type { TeaserRequest } from "@cunote/contracts";

const PREFIX = "cunote:company-create-intent:v1:";
type StorageLike = Pick<Storage, "getItem" | "setItem">;
/** 새로고침/다른 탭으로 복제된 동일 의도도 같은 요청 ID를 쓴다. 다른 브라우저의 신규 의도는 별개다. */
export async function companyCreateIntent(storage: StorageLike | null, request: TeaserRequest, now = Date.now()): Promise<string | null> {
  if (!storage || !request.bizNo) return null;
  const key = PREFIX + request.bizNo;
  const serialized = JSON.stringify(request);
  if (serialized.length > 100_000) return null;
  try {
    // 저장 성공 후 답변을 지워도 멱등 영수증에 원문 답변이 남지 않게 해시만 보관한다.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
    const signature = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const raw = storage.getItem(key);
    if (raw) {
      try {
        const previous = JSON.parse(raw);
        if (previous.signature === signature && typeof previous.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previous.id)
          && Number.isFinite(previous.createdAt) && now >= previous.createdAt && now - previous.createdAt < 86_400_000) return previous.id;
      } catch { /* 손상된 캐시는 새로운 저장 의도로 교체한다. */ }
    }
    const id = crypto.randomUUID();
    storage.setItem(key, JSON.stringify({ signature, id, createdAt: now }));
    return id;
  } catch { return null; }
}
