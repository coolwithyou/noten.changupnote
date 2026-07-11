"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import type { ActionResult, CompanyPreviewResult, TeaserRequest } from "@cunote/contracts";
import { isValidBizNoChecksum } from "@cunote/contracts";
import type { BusinessLookupSuggestion } from "@/lib/businessLookupSuggestions";
import {
  fetchBusinessLookupSuggestions,
  readLocalBusinessLookupSuggestions,
} from "@/lib/client/businessLookupSuggestions";
import { recordLandingEvent } from "@/lib/client/landingEvents";
import {
  clearResumeFlag,
  filterLandingLookupSuggestions,
  fmtBiz,
  onlyDigits,
  readPendingTeaserRequest,
  redirectToLoginForDashboard,
  titleForPreviewError,
  type BizLookupModalState,
} from "./biz-lookup-utils";

export interface BizLookupController {
  biz: string;
  currentBizNo: string;
  onBizInput: (value: string) => void;
  submitBiz: (event: FormEvent<HTMLFormElement>) => void;
  isSubmitting: boolean;
  lookup: BizLookupModalState | null;
  confirmLookup: () => void;
  rejectLookup: () => void;
  closeLookup: () => void;
  heroInputRef: RefObject<HTMLInputElement | null>;
  /** 마지막으로 포커스된 입력을 기억해 dismiss/select 후 그 폼으로 포커스를 되돌린다. */
  markActiveInput: (input: HTMLInputElement | null) => void;
  suggestions: BusinessLookupSuggestion[];
  selectSuggestion: (suggestion: BusinessLookupSuggestion) => void;
}

/**
 * 랜딩 사업자번호 조회의 전체 상태·부수효과를 캡슐화한다.
 * - 입력 포맷/검증(checksum) → /api/web/company-preview 조회 → 확인 다이얼로그
 * - 최근 조회 제안(local + 서버) 로드·필터
 * - 로그인 후 재개(resume) 플로우 → /api/web/companies
 * 경합 방지를 위해 lookupSeqRef로 최신 요청만 반영한다.
 */
export function useBizLookup(): BizLookupController {
  const [biz, setBiz] = useState("");
  const [rawSuggestions, setRawSuggestions] = useState<BusinessLookupSuggestion[]>([]);
  const [lookup, setLookup] = useState<BizLookupModalState | null>(null);
  const lookupSeqRef = useRef(0);
  const heroInputRef = useRef<HTMLInputElement | null>(null);
  // 마지막으로 포커스된 입력. hero/CTA 어느 폼에서 조작했든 그 입력으로 포커스를 복원한다.
  const activeInputRef = useRef<HTMLInputElement | null>(null);

  function focusActiveInput() {
    (activeInputRef.current ?? heroInputRef.current)?.focus();
  }

  const currentBizNo = onlyDigits(biz);
  const suggestions = useMemo(
    () => filterLandingLookupSuggestions(rawSuggestions, currentBizNo),
    [rawSuggestions, currentBizNo],
  );

  // 로그인 후 재개(resume) 플로우 — 마운트 1회.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("resumeCompany") !== "1") return;
    const resumeGrant = params.get("resumeGrant");
    clearResumeFlag(params);
    const pending = readPendingTeaserRequest();
    if (pending?.bizNo) void createCompanyAndOpenDashboard(pending, resumeGrant);
  }, []);

  // 최근 조회 제안 — 로컬 먼저, 서버(로그인 시) 갱신.
  useEffect(() => {
    let cancelled = false;
    const localSuggestions = readLocalBusinessLookupSuggestions();
    if (localSuggestions.length > 0) setRawSuggestions(localSuggestions);

    void fetchBusinessLookupSuggestions().then((result) => {
      if (cancelled || !result) return;
      if (result.authenticated) {
        setRawSuggestions(result.suggestions);
      } else if (localSuggestions.length === 0) {
        setRawSuggestions(readLocalBusinessLookupSuggestions());
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  function onBizInput(value: string) {
    setBiz(fmtBiz(value));
  }

  function selectSuggestion(suggestion: BusinessLookupSuggestion) {
    setBiz(fmtBiz(suggestion.bizNo));
    focusActiveInput();
  }

  function submitBiz(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lookup?.phase === "loading") return;
    const digits = onlyDigits(biz);
    const requestId = crypto.randomUUID();

    if (digits.length !== 10) {
      recordLandingEvent({
        event: "biz_no_validation_failed",
        requestId,
        inputLength: digits.length,
        reason: "length_not_10",
      });
      setLookup({
        phase: "error",
        bizNo: digits,
        title: "사업자번호를 확인해 주세요",
        message: "사업자번호 10자리를 입력해주세요.",
      });
      return;
    }
    if (!isValidBizNoChecksum(digits)) {
      recordLandingEvent({
        event: "biz_no_validation_failed",
        requestId,
        inputLength: digits.length,
        reason: "checksum_failed",
      });
      setLookup({
        phase: "error",
        bizNo: digits,
        title: "사업자번호를 다시 확인해 주세요",
        message: "유효하지 않은 사업자등록번호입니다. 입력한 번호를 다시 확인해주세요.",
      });
      return;
    }
    void requestCompanyPreview(digits, requestId);
  }

  async function requestCompanyPreview(digits: string, requestId: string) {
    const seq = ++lookupSeqRef.current;
    setLookup({ phase: "loading", bizNo: digits });
    recordLandingEvent({ event: "company_preview_requested", requestId, inputLength: digits.length });
    const startedAt = performance.now();

    try {
      const response = await fetch("/api/web/company-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bizNo: digits }),
      });
      const payload = (await response.json()) as ActionResult<CompanyPreviewResult>;
      if (seq !== lookupSeqRef.current) return;
      if (!response.ok || !payload.ok || !payload.data) {
        recordLandingEvent({
          event: "company_preview_failed",
          requestId,
          durationMs: performance.now() - startedAt,
          errorCode: payload.error?.code ?? `http_${response.status}`,
        });
        setLookup({
          phase: "error",
          bizNo: digits,
          title: titleForPreviewError(payload.error?.code),
          message: payload.error?.message ?? "회사 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
        });
        return;
      }
      recordLandingEvent({
        event: "company_preview_succeeded",
        requestId,
        durationMs: performance.now() - startedAt,
      });
      setLookup({ phase: "confirm", bizNo: digits, preview: payload.data });
    } catch {
      if (seq !== lookupSeqRef.current) return;
      recordLandingEvent({
        event: "company_preview_failed",
        requestId,
        durationMs: performance.now() - startedAt,
        errorCode: "network_error",
      });
      setLookup({
        phase: "error",
        bizNo: digits,
        title: "잠시 후 다시 시도해 주세요",
        message: "네트워크 문제로 회사 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
      });
    }
  }

  function confirmLookup() {
    if (lookup?.phase !== "confirm") return;
    recordLandingEvent({ event: "company_confirmed" });
    window.location.assign(`/matches?biz=${lookup.bizNo}`);
  }

  function dismiss(reason: "rejected" | "closed") {
    if (lookup?.phase === "confirm" && reason === "rejected") {
      recordLandingEvent({ event: "company_rejected" });
    }
    lookupSeqRef.current += 1; // 진행 중인 preview 응답은 무시
    setLookup(null);
    focusActiveInput();
  }

  async function createCompanyAndOpenDashboard(requestBody: TeaserRequest, resumeGrant?: string | null) {
    try {
      const response = await fetch("/api/web/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: { currentCompanyId?: string };
        error?: { code?: string };
      };
      if (response.status === 401 && payload.error?.code === "auth_required") {
        redirectToLoginForDashboard();
        return;
      }
      if (response.ok && payload.ok && payload.data?.currentCompanyId) {
        window.location.assign(resumeGrant ? `/grants/${encodeURIComponent(resumeGrant)}` : "/dashboard");
      }
    } catch {
      /* noop — 사용자는 입력으로 재시도 */
    }
  }

  return {
    biz,
    currentBizNo,
    onBizInput,
    submitBiz,
    isSubmitting: lookup?.phase === "loading",
    lookup,
    confirmLookup,
    rejectLookup: () => dismiss("rejected"),
    closeLookup: () => dismiss("closed"),
    heroInputRef,
    markActiveInput: (input) => {
      activeInputRef.current = input;
    },
    suggestions,
    selectSuggestion,
  };
}
