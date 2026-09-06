/** 페이지당 observer 하나. 신호 유실은 허용하지만 매칭·탐색을 기다리게 하지 않는다. */
export function observeProductCards(root: HTMLElement, tokens: ReadonlyMap<string, string>, companyId: string): () => void {
  if (typeof IntersectionObserver === "undefined" || tokens.size === 0) return () => {};
  const seen = new Set<string>();
  const registered = new Set<Element>();
  const visible = new Set<Element>();
  const pending = new Map<Element, ReturnType<typeof setTimeout>>();
  function cancel(element: Element) { const timer = pending.get(element); if (timer) clearTimeout(timer); pending.delete(element); }
  function schedule(element: Element) {
    cancel(element);
    const token = tokens.get((element as HTMLElement).dataset.productGrant ?? "");
    if (!token || seen.has(token) || document.visibilityState !== "visible") return;
    pending.set(element, setTimeout(() => {
      pending.delete(element);
      if (!element.isConnected || !visible.has(element) || document.visibilityState !== "visible") return;
      seen.add(token);
      void fetch("/api/web/company-matching/exposure", { method: "POST", credentials: "same-origin", keepalive: true,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ companyId, token }) }).catch(() => {});
    }, 500));
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) { visible.add(entry.target); schedule(entry.target); }
      else { visible.delete(entry.target); cancel(entry.target); }
    }
  }, { threshold: 0.5 });
  function register() {
    for (const element of registered) {
      if (!root.contains(element)) { observer.unobserve(element); registered.delete(element); visible.delete(element); cancel(element); }
    }
    for (const element of root.querySelectorAll<HTMLElement>("[data-product-grant]")) {
      if (!registered.has(element) && tokens.has(element.dataset.productGrant ?? "")) { registered.add(element); observer.observe(element); }
    }
  }
  function visibilityChanged() { for (const element of visible) schedule(element); }
  register();
  const mutations = new MutationObserver(register);
  mutations.observe(root, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", visibilityChanged);
  return () => { observer.disconnect(); mutations.disconnect(); for (const element of pending.keys()) cancel(element); document.removeEventListener("visibilitychange", visibilityChanged); };
}
