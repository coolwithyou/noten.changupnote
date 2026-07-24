"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  ActionResult,
  GrantConfirmationSubmitResult,
  MatchingProfileAnswerRequest,
  ProductTeaserResult,
  TeaserRequest,
} from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { safeInternalPath } from "@/lib/navigation/safeInternalPath";
import { ProfileSection } from "./ProfileSection";
import { ProgramsExperience } from "./Programs";
import { ResultsHero } from "./ResultsHero";
import { EmptyState, ErrorState, LoadingState, NoMatchingGrantsState } from "./States";
import { NextQuestionCard } from "./NextQuestionCard";
import {
  PENDING_TEASER_STORAGE_KEY,
  TEASER_FALLBACK_MESSAGE,
  TeaserError,
  confirmationResumePath,
  groupMatchesForDisplay,
  matchingPrecision,
  rememberBusinessLookup,
  summarizeAnswerImpact,
  type AnswerImpactSummary,
  type Status,
} from "./logic";

export function MatchResultsExperience() {
  const [status, setStatus] = useState<Status>("loading");
  const [teaser, setTeaser] = useState<ProductTeaserResult | null>(null);
  const [bizNo, setBizNo] = useState<string | null>(null);
  const [error, setError] = useState<TeaserError | null>(null);
  const [answers, setAnswers] = useState<MatchingProfileAnswerRequest[]>([]);
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [answerImpact, setAnswerImpact] = useState<AnswerImpactSummary | null>(null);
  const [resumeConfirmationGrantId, setResumeConfirmationGrantId] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const loadTeaser = useCallback(async (
    request: TeaserRequest,
    options: { preserveReady?: boolean } = {},
  ): Promise<ProductTeaserResult | null> => {
    const seq = ++requestSeqRef.current;
    if (!options.preserveReady) setStatus("loading");
    setError(null);
    try {
      const response = await fetch("/api/web/teaser", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        // 서버 무응답(외부 조회 행) 시 로딩이 무한히 걸리지 않도록 하고, 에러 상태의 재시도 UI로 떨어뜨린다.
        signal: AbortSignal.timeout(20_000),
      });
      const payload = (await response.json()) as ActionResult<ProductTeaserResult>;
      if (seq !== requestSeqRef.current) return null;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new TeaserError(payload.error?.message ?? TEASER_FALLBACK_MESSAGE, payload.error?.code ?? null);
      }
      setTeaser(payload.data);
      setStatus("ready");
      if (request.bizNo) void rememberBusinessLookup(request.bizNo);
      return payload.data;
    } catch (caught) {
      if (seq !== requestSeqRef.current) return null;
      const next =
        caught instanceof TeaserError
          ? caught
          : caught instanceof DOMException && caught.name === "TimeoutError"
            ? new TeaserError("응답이 지연되고 있어요. 잠시 후 다시 시도해주세요.", null)
            : new TeaserError(caught instanceof Error ? caught.message : TEASER_FALLBACK_MESSAGE, null);
      setError(next);
      setStatus("error");
      return null;
    }
  }, []);

  const applyAnswer = useCallback(
    async (answer: MatchingProfileAnswerRequest) => {
      const previousTeaser = teaser;
      const nextAnswers = mergeAnswers(answers, answer);
      setAnswers(nextAnswers);
      setProfileSubmitting(true);
      try {
        const nextTeaser = await loadTeaser({
          ...(bizNo ? { bizNo } : {}),
          answers: nextAnswers,
        }, { preserveReady: true });
        if (previousTeaser && nextTeaser) {
          setAnswerImpact(summarizeAnswerImpact(previousTeaser, nextTeaser));
        }
      } finally {
        setProfileSubmitting(false);
      }
    },
    [answers, bizNo, loadTeaser, teaser],
  );

  // 확인 질문 저장 응답의 재계산 카드로 목록을 치환한다. 티저 재조회는 confirmations 를
  // 반영하지 않는 경로라(buildTeaser 미배선) 응답 카드 치환이 이 화면의 유일한 정합 반영 수단이다.
  const applyConfirmationResult = useCallback((result: GrantConfirmationSubmitResult) => {
    const updated = result.match;
    if (!updated) return;
    setTeaser((current) =>
      current
        ? {
            ...current,
            matches: current.matches.map((match) =>
              match.grantId === updated.grantId ? updated : match,
            ),
          }
        : current,
    );
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const digits = (params.get("biz") ?? "").replace(/\D/g, "").slice(0, 10);
    setResumeConfirmationGrantId(params.get("confirm"));
    if (digits.length !== 10) {
      setStatus("empty");
      return;
    }
    setBizNo(digits);
    setAnswers([]);
    setAnswerImpact(null);
    void loadTeaser({ bizNo: digits });
  }, [loadTeaser]);

  useEffect(() => {
    const openFromHash = () => setProfileOpen(window.location.hash === "#profile");
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  async function saveAndContinue(grantId?: string, nextOverride?: string) {
    if (continuing) return;
    const returnTarget =
      safeInternalPath(nextOverride)
      ?? safeInternalPath(new URLSearchParams(window.location.search).get("next"));
    const request: TeaserRequest | null = bizNo
      ? {
          bizNo,
          ...(answers.length > 0 ? { answers } : {}),
        }
      : null;

    if (request) {
      // 이미 로그인된 사용자는 로그인·홈 재개 경유 없이 회사 저장 후 바로 목적지로 이동
      setContinuing(true);
      try {
        const response = await fetch("/api/web/companies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          // 서버가 응답하지 않는 행(외부 조회 지연·커넥션 고갈)에 "저장 중…"이 무한히 걸리지 않도록 한다.
          signal: AbortSignal.timeout(15_000),
        });
        const payload = (await response.json()) as ActionResult<{ currentCompanyId: string }>;
        if (response.ok && payload.ok && payload.data?.currentCompanyId) {
          window.location.assign(
            returnTarget
              ?? (grantId ? `/grants/${encodeURIComponent(grantId)}` : "/dashboard"),
          );
          return;
        }
      } catch (caught) {
        // 타임아웃은 로그인 문제와 무관하므로 로그인 재개로 보내지 않고 버튼을 복구해 재시도를 유도한다.
        if (caught instanceof DOMException && caught.name === "TimeoutError") {
          setContinuing(false);
          toast.error("저장이 지연되고 있어요. 잠시 후 다시 시도해주세요.");
          return;
        }
        // 그 외 저장 실패 시 아래 로그인 재개 흐름으로 폴백
      }
      try {
        window.sessionStorage.setItem(PENDING_TEASER_STORAGE_KEY, JSON.stringify(request));
      } catch {
        // storage 불가 시에도 로그인은 진행
      }
    }
    const resumeParams = new URLSearchParams({ resumeCompany: "1" });
    if (returnTarget) resumeParams.set("resumeNext", returnTarget);
    else if (grantId) resumeParams.set("resumeGrant", grantId);
    const resumeTarget = `/?${resumeParams.toString()}`;
    const params = new URLSearchParams({ callbackUrl: resumeTarget });
    window.location.assign(`/login?${params.toString()}`);
  }

  const displayGroups = teaser ? groupMatchesForDisplay(teaser.matches) : null;
  const noMatchingGrants = Boolean(
    teaser &&
      (teaser.counts.openNow ?? displayGroups?.open.length ?? 0) === 0 &&
      (teaser.counts.oneAnswer ?? displayGroups?.oneAnswer.length ?? 0) === 0 &&
      (teaser.counts.preparable ?? displayGroups?.preparable.length ?? 0) === 0 &&
      (teaser.counts.needsCoreReview ?? displayGroups?.checkSource.length ?? 0) === 0 &&
      (displayGroups?.checkSource.length ?? 0) === 0 &&
      (displayGroups?.upcoming.length ?? 0) === 0 &&
      teaser.nextQuestion === null,
  );
  const precision = teaser ? matchingPrecision(teaser) : null;

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-background text-foreground">
      <main className="relative mx-auto w-full max-w-[760px] px-5 py-6 sm:px-6 sm:py-[52px]">
        {status === "loading" ? <LoadingState /> : null}
        {status === "empty" ? <EmptyState /> : null}
        {status === "error" ? (
          <ErrorState
            error={error}
            onRetry={
              bizNo
                ? () => void loadTeaser({ bizNo, ...(answers.length > 0 ? { answers } : {}) })
                : undefined
            }
          />
        ) : null}
        {status === "ready" && teaser ? (
          <>
            <ResultsHero
              teaser={teaser}
              onSave={() => void saveAndContinue()}
              saving={continuing}
              {...(answerImpact ? { precisionDelta: answerImpact.precisionDelta } : {})}
              empty={noMatchingGrants}
              questionsExhausted={teaser.nextQuestion === null}
            />
            {noMatchingGrants ? (
              <NoMatchingGrantsState
                onSubscribe={() => void saveAndContinue()}
                onOpenProfile={() => setProfileOpen(true)}
                saving={continuing}
              />
            ) : (
              <>
                <div className="mt-7">
                  <NextQuestionCard
                    question={teaser.nextQuestion}
                    impact={answerImpact}
                    onAnswer={applyAnswer}
                    submitting={profileSubmitting}
                  />
                </div>
                <ProgramsExperience
                  teaser={teaser}
                  onPrepare={saveAndContinue}
                  onOpenProfile={() => setProfileOpen(true)}
                  preparing={continuing}
                  newGrantIds={new Set(answerImpact?.newlyOpenGrantIds ?? [])}
                  onConfirmationSaved={applyConfirmationResult}
                  autoOpenConfirmationGrantId={resumeConfirmationGrantId}
                  {...(!resumeConfirmationGrantId && bizNo
                    ? {
                        onRequestConfirmation: (match: { grantId: string }) =>
                          void saveAndContinue(
                            undefined,
                            confirmationResumePath(bizNo, match.grantId),
                          ),
                      }
                    : {})}
                />
                {precision ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setProfileOpen(true)}
                    className="mx-auto mt-7 flex h-auto max-w-full rounded-full border border-border-subtle bg-surface-soft px-[22px] py-2.5 text-center text-sm font-medium whitespace-normal text-text-secondary hover:bg-surface-muted"
                  >
                    자동으로 확인한 정보 {precision.known}개 · 직접 채울 정보 {precision.remaining}개 ·
                    <span className="font-bold text-brand">보기</span>
                  </Button>
                ) : null}
              </>
            )}
            <ProfileSection
              teaser={teaser}
              onAnswer={applyAnswer}
              submitting={profileSubmitting}
              open={profileOpen}
              onOpenChange={setProfileOpen}
              answerImpact={answerImpact}
            />
          </>
        ) : null}
      </main>
    </div>
  );
}

function mergeAnswers(
  current: readonly MatchingProfileAnswerRequest[],
  answer: MatchingProfileAnswerRequest,
): MatchingProfileAnswerRequest[] {
  if (answer.mode === "merge") return [...current, answer];
  return [...current.filter((entry) => entry.field !== answer.field), answer];
}
