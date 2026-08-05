"use client";

import type { DeepAnalysisRuntimeControlStatus } from "@cunote/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

const RUNTIME_URL = "/api/dev/analysis-lab/ops/runtime-control";
const OWNER_STORAGE_KEY = "cunote:local-analysis-owner";
export const LOCAL_ANALYSIS_OWNER_HEADER = "x-cunote-local-analysis-owner";

export interface LocalAnalysisRuntimeAccess {
  ownerId: string | null;
  status: DeepAnalysisRuntimeControlStatus | null;
  allowed: boolean;
  busy: boolean;
  error: string | null;
  acquire: () => Promise<void>;
  release: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useLocalAnalysisRuntime(): LocalAnalysisRuntimeAccess {
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [status, setStatus] = useState<DeepAnalysisRuntimeControlStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(OWNER_STORAGE_KEY);
    const next = saved || crypto.randomUUID();
    if (!saved) window.localStorage.setItem(OWNER_STORAGE_KEY, next);
    setOwnerId(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(RUNTIME_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(await readErrorMessage(response, "실행 모드를 불러오지 못했습니다."));
      setStatus(await response.json() as DeepAnalysisRuntimeControlStatus);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "실행 모드를 불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const runAction = useCallback(async (action: "acquire" | "renew" | "release") => {
    if (!ownerId) return;
    if (action !== "renew") setBusy(true);
    try {
      const response = await fetch(RUNTIME_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ownerId }),
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, "로컬 분석 권한을 처리하지 못했습니다."));
      setStatus(await response.json() as DeepAnalysisRuntimeControlStatus);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "로컬 분석 권한을 처리하지 못했습니다.");
      if (action === "renew") void refresh();
    } finally {
      if (action !== "renew") setBusy(false);
    }
  }, [ownerId, refresh]);

  const allowed = useMemo(() => {
    if (!ownerId || !status || status.effectiveMode !== "local_subscription") return false;
    if (status.localOwnerId !== ownerId || !status.localLeaseExpiresAt) return false;
    return Date.parse(status.localLeaseExpiresAt) > Date.now();
  }, [ownerId, status]);

  useEffect(() => {
    if (!allowed) return;
    const timer = window.setInterval(() => void runAction("renew"), 45_000);
    return () => window.clearInterval(timer);
  }, [allowed, runAction]);

  return {
    ownerId,
    status,
    allowed,
    busy,
    error,
    acquire: () => runAction("acquire"),
    release: () => runAction("release"),
    refresh,
  };
}

export function localAnalysisRequestHeaders(ownerId: string | null): Record<string, string> {
  return ownerId ? { [LOCAL_ANALYSIS_OWNER_HEADER]: ownerId } : {};
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { message?: string; error?: string };
    return payload.message ?? payload.error ?? `${fallback} (HTTP ${response.status})`;
  } catch {
    return `${fallback} (HTTP ${response.status})`;
  }
}
