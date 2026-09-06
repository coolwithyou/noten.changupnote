import type { ActionResult, TeaserRequest } from "@cunote/contracts";
import { safeInternalPath } from "@/lib/navigation/safeInternalPath";
import { companyCreateIntent } from "./companyCreateIntent";

export const PENDING_TEASER_STORAGE_KEY = "cunote.pendingTeaserRequest";
type HandoffStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type ResumeTarget = { grantId?: string | null; next?: string | null };
type PendingSave = {
  version: 1;
  id: string;
  createdAt: number;
  state: "pending" | "sending" | "uncertain" | "saved";
  request: TeaserRequest;
  companyId?: string;
};
export type CompanySaveResumeResult =
  | { status: "saved"; companyId: string; bizNo: string; destination: string }
  | { status: "login"; destination: string }
  | { status: "missing" | "failed" | "uncertain"; message: string; recoveryPath: string };

const MAX_LENGTH = 100_000;
const TTL = 24 * 60 * 60 * 1_000;
const active = new WeakMap<HandoffStorage, Promise<CompanySaveResumeResult>>();

export function pendingCompanyStorage(): HandoffStorage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** 로그인 전 보관에 실패하면 현재 입력 화면을 떠나지 않는다. */
export function savePendingCompanyRequest(storage: HandoffStorage | null, request: TeaserRequest): boolean {
  if (!validRequest(request)) return false;
  return write(storage, { version: 1, id: crypto.randomUUID(), createdAt: Date.now(), state: "pending", request });
}

export function readPendingCompanyRequest(storage: HandoffStorage | null): TeaserRequest | null {
  return storage ? read(storage)?.request ?? null : null;
}

export function companyResumeLoginPath(target: ResumeTarget = {}): string {
  const query = new URLSearchParams({ resumeCompany: "1" });
  const next = safeInternalPath(target.next);
  if (next) query.set("resumeNext", next);
  if (target.grantId) query.set("resumeGrant", target.grantId);
  return `/login?${new URLSearchParams({ callbackUrl: `/?${query}` })}`;
}

/** 익명 확인 질문 복귀도 방금 저장한 회사의 매칭으로 바꾼다. */
export function savedCompanyDestination(companyId: string, target: ResumeTarget = {}): string {
  const owned = `/matches?${new URLSearchParams({ companyId })}#profile`;
  const next = safeInternalPath(target.next);
  if (next) {
    const url = new URL(next, "https://local.invalid");
    if (url.pathname !== "/matches" && !url.pathname.startsWith("/grants/")) return next;
    url.searchParams.delete("biz");
    url.searchParams.set("companyId", companyId);
    return `${url.pathname}${url.search}${url.hash}`;
  }
  return target.grantId ? `/grants/${encodeURIComponent(target.grantId)}?${new URLSearchParams({ companyId })}` : owned;
}

/** 같은 탭의 동시 effect는 한 요청만 공유한다. 새로고침 중단/응답 유실은 자동 재생성하지 않는다. */
export function resumePendingCompanySave(
  storage: HandoffStorage | null,
  target: ResumeTarget = {},
  fetcher: typeof fetch = fetch,
): Promise<CompanySaveResumeResult> {
  if (!storage) return Promise.resolve(missing());
  const running = active.get(storage);
  if (running) return running;
  const promise = resume(storage, target, fetcher).finally(() => active.delete(storage));
  active.set(storage, promise);
  return promise;
}

async function resume(storage: HandoffStorage, target: ResumeTarget, fetcher: typeof fetch): Promise<CompanySaveResumeResult> {
  const pending = read(storage);
  if (!pending) return missing();
  if (pending.state === "saved" && pending.companyId) {
    // 이전 성공 뒤 이동만 중단된 경우. 쿠키를 추정하지 않고 소유 회사 조회부터 재개한다.
    const query = new URLSearchParams({ companyId: pending.companyId });
    if (safeInternalPath(target.next) || target.grantId) query.set("next", savedCompanyDestination(pending.companyId, target));
    return { status: "saved", companyId: pending.companyId, bizNo: pending.request.bizNo!,
      destination: `/matches?${query}#profile` };
  }
  if (pending.state !== "pending") return uncertain();
  const intent = await companyCreateIntent(storage, pending.request);
  if (!intent) return { status: "failed", message: "저장 요청을 안전하게 보관할 수 없어 시작하지 않았어요.", recoveryPath: recovery(pending, target) };
  if (read(storage)?.id !== pending.id) return uncertain();
  if (!write(storage, { ...pending, state: "sending" })) {
    return { status: "failed", message: "입력 정보를 안전하게 보관할 수 없어 저장을 시작하지 않았어요.", recoveryPath: recovery(pending, target) };
  }
  try {
    const response = await fetcher("/api/web/companies", {
      method: "POST", headers: { "content-type": "application/json", "x-cunote-create-intent": intent },
      body: JSON.stringify(pending.request), signal: AbortSignal.timeout(15_000),
    });
    // 비인증은 회사 생성 전 거절된다. 응답 본문이 없어도 재로그인에 입력/목적지를 보존한다.
    if (response.status === 401) {
      if (!writeIfCurrent(storage, pending, { ...pending, state: "pending" })) return uncertain();
      return { status: "login", destination: companyResumeLoginPath(target) };
    }
    const payload = await response.json() as ActionResult<{ currentCompanyId: string }>;
    if (response.ok && payload.ok && typeof payload.data?.currentCompanyId === "string" && payload.data.currentCompanyId.trim()) {
      const companyId = payload.data.currentCompanyId;
      if (!writeIfCurrent(storage, pending, { ...pending, state: "saved", companyId })) {
        return { status: "uncertain", message: "저장 응답은 받았지만 재개 정보가 변경됐어요. 회사 설정에서 저장 결과를 확인해주세요.", recoveryPath: "/settings" };
      }
      // 성공 영수증을 먼저 남겨 removeItem 실패/이동 중단에도 새 회사를 다시 만들지 않는다.
      try { storage.removeItem(PENDING_TEASER_STORAGE_KEY); } catch { /* saved 상태로 재개 */ }
      return { status: "saved", companyId, bizNo: pending.request.bizNo!, destination: savedCompanyDestination(companyId, target) };
    }
    if (response.status >= 400 && response.status < 500) {
      writeIfCurrent(storage, pending, { ...pending, state: "pending" });
      return { status: "failed", message: payload.error?.message ?? "회사 저장이 거절됐어요. 입력한 정보는 보관되어 있습니다.", recoveryPath: recovery(pending, target) };
    }
    writeIfCurrent(storage, pending, { ...pending, state: "uncertain" });
    return uncertain();
  } catch {
    writeIfCurrent(storage, pending, { ...pending, state: "uncertain" });
    return uncertain();
  }
}

function read(storage: HandoffStorage): PendingSave | null {
  try {
    const raw = storage.getItem(PENDING_TEASER_STORAGE_KEY);
    if (!raw || raw.length > MAX_LENGTH) return null;
    const parsed = JSON.parse(raw);
    // 이전 세션에서 보관한 raw TeaserRequest를 무손실로 인계한다.
    if (validRequest(parsed)) return { version: 1, id: raw, createdAt: Date.now(), state: "pending", request: parsed };
    if (!parsed || parsed.version !== 1 || typeof parsed.id !== "string" || !validRequest(parsed.request)
      || !["pending", "sending", "uncertain", "saved"].includes(parsed.state)
      || !Number.isFinite(parsed.createdAt) || parsed.createdAt > Date.now() || Date.now() - parsed.createdAt >= TTL
      || (parsed.state === "saved" && (typeof parsed.companyId !== "string" || !parsed.companyId.trim()))) return null;
    return parsed;
  } catch { return null; }
}

function validRequest(value: unknown): value is TeaserRequest & { bizNo: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as TeaserRequest;
  return typeof request.bizNo === "string" && /^\d{10}$/.test(request.bizNo)
    && (request.answers === undefined || (Array.isArray(request.answers) && request.answers.length <= 200));
}
function write(storage: HandoffStorage | null, value: PendingSave): boolean {
  if (!storage) return false;
  try { const raw = JSON.stringify(value); if (raw.length > MAX_LENGTH) return false; storage.setItem(PENDING_TEASER_STORAGE_KEY, raw); return true; }
  catch { return false; }
}
function writeIfCurrent(storage: HandoffStorage, expected: PendingSave, value: PendingSave): boolean {
  return read(storage)?.id === expected.id && write(storage, value);
}
function missing(): CompanySaveResumeResult {
  return { status: "missing", message: "이어갈 입력 정보가 없거나 보관 기간이 지났어요. 같은 탭의 결과에서 다시 저장해주세요.", recoveryPath: "/" };
}
function uncertain(): CompanySaveResumeResult {
  return { status: "uncertain", message: "저장 결과를 확인하지 못했어요. 중복 생성을 막기 위해 자동으로 재시도하지 않습니다. 회사 설정에서 저장 여부를 먼저 확인해주세요.", recoveryPath: "/settings" };
}
function recovery(pending: PendingSave, target: ResumeTarget): string {
  const query = new URLSearchParams({ biz: pending.request.bizNo! });
  const next = safeInternalPath(target.next) ?? (target.grantId ? `/grants/${encodeURIComponent(target.grantId)}` : null);
  if (next) query.set("next", next);
  return `/matches?${query}#profile`;
}
