"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  ActionResult,
  GrantConfirmationSubmitResult,
  MatchingProfileAnswerRequest,
  OwnedCompanyMatchingResult,
  ProductTeaserResult,
  TeaserRequest,
} from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { safeInternalPath } from "@/lib/navigation/safeInternalPath";
import { withCompanyContext } from "@/lib/navigation/companyContext";
import { companyCreateIntent } from "@/lib/client/companyCreateIntent";
import { companyResumeLoginPath, pendingCompanyStorage, savedCompanyDestination, savePendingCompanyRequest } from "@/lib/client/companySaveHandoff";
import { isVirtualCompanyBizNo } from "@/lib/virtualCompanies";
import { ProfileSection } from "./ProfileSection";
import { buildProfileCompletion } from "./profileCompletion";
import { loadOwnedMatching, saveOwnedMatchingAnswer } from "./ownedMatchingClient";
import { clearProfileDraft, profileDraftStorage, readProfileDraft, writeProfileDraft } from "./profileDraft";
import { ProgramsExperience } from "./Programs";
import { ResultsHero } from "./ResultsHero";
import { EmptyState, ErrorState, LoadingState, NoMatchingGrantsState } from "./States";
import { NextQuestionCard } from "./NextQuestionCard";
import { AnalysisScopeCard } from "./AnalysisScopeCard";
import {
  TEASER_FALLBACK_MESSAGE,
  TeaserError,
  confirmationResumePath,
  groupMatchesForDisplay,
  matchingProfileCoverage,
  profileQuestionIdentity,
  profileCoverageLabel,
  rememberBusinessLookup,
  summarizeAnswerImpact,
  type AnswerImpactSummary,
  type Status,
} from "./logic";

export function MatchResultsExperience() {
  const [status, setStatus] = useState<Status>("loading");
  const [teaser, setTeaser] = useState<ProductTeaserResult | null>(null);
  const [bizNo, setBizNo] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const profileRevisionRef = useRef<string | undefined>(undefined);
  const ownedRequestRef = useRef<string | undefined>(undefined);
  const [error, setError] = useState<TeaserError | null>(null);
  const [answers, setAnswers] = useState<MatchingProfileAnswerRequest[]>([]);
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [answerImpact, setAnswerImpact] = useState<AnswerImpactSummary | null>(null);
  const [answeredQuestionIdentities, setAnsweredQuestionIdentities] = useState<Set<string>>(
    () => new Set(),
  );
  const [resumeConfirmationGrantId, setResumeConfirmationGrantId] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const answerPendingRef = useRef(false);
  const [draftNotice, setDraftNotice] = useState("입력한 정보는 회사 저장 전까지 이 탭에서만 임시 보관됩니다.");

  const acceptOwnedMatching = useCallback((result: OwnedCompanyMatchingResult) => {
    setCompanyId(result.companyId);
    setCompanyName(result.companyName ?? null);
    profileRevisionRef.current = result.profileRevision;
    ownedRequestRef.current = result.companyId;
    setTeaser(result.teaser);
    setAnswers(result.unknownDimensions.map((field) => ({ field, unknown: true })));
    setDraftNotice("계정에 저장된 정보입니다. 답변을 반영할 때마다 이 회사에 저장됩니다.");
    setStatus("ready");
  }, []);

  const loadCompanyMatching = useCallback(async (id?: string) => {
    const seq = ++requestSeqRef.current;
    setStatus("loading");
    setError(null);
    try {
      const result = await loadOwnedMatching(id);
      if (seq !== requestSeqRef.current) return;
      acceptOwnedMatching(result);
      const params = new URLSearchParams(window.location.search);
      params.set("companyId", result.companyId);
      window.history.replaceState(null, "", `/matches?${params}${window.location.hash}`);
      if (!params.has("confirm") && buildProfileCompletion(result.teaser.profileView).remaining.length > 0) setProfileOpen(true);
    } catch (caught) {
      if (seq !== requestSeqRef.current) return;
      setError(caught instanceof TeaserError ? caught : new TeaserError("저장된 정보를 불러오지 못했어요. 다시 시도해주세요.", null));
      setStatus("error");
    }
  }, [acceptOwnedMatching]);

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
      if (options.preserveReady) throw next;
      setStatus("error");
      return null;
    }
  }, []);

  const applyAnswer = useCallback(
    async (answer: MatchingProfileAnswerRequest) => {
      if (answerPendingRef.current) throw new Error("이전 답변을 반영하고 있어요. 잠시 후 다시 시도해주세요.");
      answerPendingRef.current = true;
      const previousTeaser = teaser;
      const answeredQuestion = previousTeaser?.nextQuestion?.dimension === answer.field
        ? previousTeaser.nextQuestion
        : null;
      const nextAnswers = mergeAnswers(answers, answer);
      setProfileSubmitting(true);
      try {
        const ownedResult = companyId ? await saveOwnedMatchingAnswer(companyId, answer, profileRevisionRef.current) : null;
        const nextTeaser = ownedResult?.teaser ?? await loadTeaser({
          ...(bizNo ? { bizNo } : {}),
          answers: nextAnswers,
        }, { preserveReady: true });
        if (!nextTeaser) throw new Error("답변을 반영하지 못했어요. 다시 시도해주세요.");
        if (ownedResult) {
          acceptOwnedMatching(ownedResult);
          setDraftNotice("답변이 이 회사에 저장됐어요. 다시 방문해도 이어갈 수 있습니다.");
        } else {
          setAnswers(nextAnswers);
          const stored = bizNo && writeProfileDraft(profileDraftStorage(), bizNo, nextAnswers);
          setDraftNotice(stored
            ? "이 탭에 임시 보관됐어요. 새로고침해도 24시간 안에 이어갈 수 있습니다."
            : "이 브라우저에서는 임시 보관할 수 없어요. 이동 전에 회사에 저장해주세요.");
        }
        if (previousTeaser && nextTeaser) {
          setAnswerImpact(summarizeAnswerImpact(previousTeaser, nextTeaser));
        }
        if (answeredQuestion && nextTeaser) {
          const identity = profileQuestionIdentity(answeredQuestion);
          setAnsweredQuestionIdentities((current) => {
            if (current.has(identity)) return current;
            const next = new Set(current);
            next.add(identity);
            return next;
          });
        }
      } finally {
        answerPendingRef.current = false;
        setProfileSubmitting(false);
      }
    },
    [answers, bizNo, companyId, acceptOwnedMatching, loadTeaser, teaser],
  );

  // 저장 회사는 확인 답변을 포함해 건수·질문까지 재조회한다. 익명 복귀의 카드 치환은 호환 유지.
  const applyConfirmationResult = useCallback((result: GrantConfirmationSubmitResult) => {
    const updated = result.match;
    if (!updated) return;
    if (companyId) {
      void loadCompanyMatching(companyId);
      return;
    }
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
  }, [companyId, loadCompanyMatching]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const digits = (params.get("biz") ?? "").replace(/\D/g, "").slice(0, 10);
    setResumeConfirmationGrantId(params.get("confirm"));
    if (params.has("companyId") || !params.has("biz")) {
      const id = params.get("companyId") ?? undefined;
      ownedRequestRef.current = id;
      void loadCompanyMatching(id);
      return () => { requestSeqRef.current += 1; };
    }
    if (digits.length !== 10) {
      setStatus("empty");
      return;
    }
    setBizNo(digits);
    const restoredAnswers = readProfileDraft(profileDraftStorage(), digits);
    setAnswers(restoredAnswers);
    if (restoredAnswers.length > 0) setDraftNotice("이 탭에 보관된 답변을 복원했어요. 회사 저장은 별도입니다.");
    setAnswerImpact(null);
    setAnsweredQuestionIdentities(new Set());
    void loadTeaser({ bizNo: digits, ...(restoredAnswers.length ? { answers: restoredAnswers } : {}) }).then((result) => {
      if (result && !params.has("confirm") && buildProfileCompletion(result.profileView).remaining.length > 0) {
        setProfileOpen(true);
      }
    });
    return () => { requestSeqRef.current += 1; };
  }, [loadTeaser, loadCompanyMatching]);

  useEffect(() => {
    const openFromHash = () => setProfileOpen(window.location.hash === "#profile");
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  async function saveAndContinue(grantId?: string, nextOverride?: string) {
    if (continuing || answerPendingRef.current) return;
    const returnTarget =
      safeInternalPath(nextOverride)
      ?? safeInternalPath(new URLSearchParams(window.location.search).get("next"));
    if (companyId) {
      // 후속 상세/대시보드는 선택 쿠키를 소비하므로 이동 전에 명시한 회사로 맞춘다.
      setContinuing(true);
      try {
        const response = await fetch("/api/web/companies/switch", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ companyId }), signal: AbortSignal.timeout(15_000),
        });
        const payload = await response.json() as ActionResult<unknown>;
        if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? "회사를 선택하지 못했어요.");
        window.location.assign(withCompanyContext(returnTarget ?? (grantId ? `/grants/${encodeURIComponent(grantId)}` : "/dashboard"), companyId));
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : "이동하지 못했어요. 다시 시도해주세요.");
        setContinuing(false);
      }
      return;
    }
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
        const intent = await companyCreateIntent(pendingCompanyStorage(), request);
        if (!intent) throw new Error("저장 요청을 안전하게 보관할 수 없어요. 브라우저 저장소 설정을 확인해주세요.");
        const response = await fetch("/api/web/companies", {
          method: "POST",
          headers: { "content-type": "application/json", "x-cunote-create-intent": intent },
          body: JSON.stringify(request),
          // 서버가 응답하지 않는 행(외부 조회 지연·커넥션 고갈)에 "저장 중…"이 무한히 걸리지 않도록 한다.
          signal: AbortSignal.timeout(15_000),
        });
        const payload = (await response.json()) as ActionResult<{ currentCompanyId: string }>;
        if (response.ok && payload.ok && payload.data?.currentCompanyId) {
          if (bizNo) clearProfileDraft(profileDraftStorage(), bizNo);
          window.location.assign(
            savedCompanyDestination(payload.data.currentCompanyId, { next: returnTarget, ...(grantId ? { grantId } : {}) }),
          );
          return;
        }
        if (response.status !== 401) {
          throw new Error(payload.error?.message ?? "회사 정보를 저장하지 못했어요. 다시 시도해주세요.");
        }
      } catch (caught) {
        // 타임아웃은 로그인 문제와 무관하므로 로그인 재개로 보내지 않고 버튼을 복구해 재시도를 유도한다.
        if (caught instanceof DOMException && caught.name === "TimeoutError") {
          setContinuing(false);
          toast.error("저장이 지연되고 있어요. 잠시 후 다시 시도해주세요.");
          return;
        }
        setContinuing(false);
        toast.error(caught instanceof Error ? caught.message : "회사 정보를 저장하지 못했어요. 다시 시도해주세요.");
        return;
      }
      if (!savePendingCompanyRequest(pendingCompanyStorage(), request)) {
        setContinuing(false);
        toast.error("로그인 후 이어갈 정보를 보관할 수 없어요. 이 탭을 유지하고 브라우저 저장 설정을 확인해주세요.");
        return;
      }
    }
    window.location.assign(companyResumeLoginPath({ next: returnTarget, ...(grantId ? { grantId } : {}) }));
  }

  const displayGroups = teaser ? groupMatchesForDisplay(teaser.matches) : null;
  const noMatchingGrants = Boolean(
    teaser &&
      (teaser.counts.openNow ?? displayGroups?.open.length ?? 0) === 0 &&
      (teaser.counts.oneAnswer ?? displayGroups?.oneAnswer.length ?? 0) === 0 &&
      (teaser.counts.preparable ?? displayGroups?.preparable.length ?? 0) === 0 &&
      (displayGroups?.upcoming.length ?? 0) === 0 &&
      teaser.nextQuestion === null,
  );
  const coverage = teaser ? matchingProfileCoverage(teaser) : null;
  const visibleNextQuestion = teaser?.nextQuestion &&
    !answeredQuestionIdentities.has(profileQuestionIdentity(teaser.nextQuestion))
    ? teaser.nextQuestion
    : null;
  const answeredCurrentQuestion = Boolean(teaser?.nextQuestion && !visibleNextQuestion);

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
                : () => void loadCompanyMatching(ownedRequestRef.current)
            }
            owned={!bizNo}
          />
        ) : null}
        {status === "ready" && teaser ? (
          <>
            <ResultsHero
              teaser={teaser}
              onSave={() => void saveAndContinue()}
              saving={continuing}
              savedCompany={Boolean(companyId)}
              companyName={companyName}
              {...(answerImpact ? { coverageDelta: answerImpact.coverageDelta } : {})}
              empty={noMatchingGrants}
              questionsExhausted={teaser.nextQuestion === null}
              answeredCurrentQuestion={answeredCurrentQuestion}
            />
            <AnalysisScopeCard context={teaser.searchContext} />
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
                    question={visibleNextQuestion}
                    impact={answerImpact}
                    onAnswer={applyAnswer}
                    submitting={profileSubmitting}
                  />
                </div>
                <ProgramsExperience
                  teaser={teaser}
                  companyId={companyId}
                  virtualBizNo={bizNo && isVirtualCompanyBizNo(bizNo) ? bizNo : null}
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
                {coverage ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setProfileOpen(true)}
                    className="mx-auto mt-7 flex h-auto max-w-full rounded-full border border-border-subtle bg-surface-soft px-[22px] py-2.5 text-center text-sm font-medium whitespace-normal text-text-secondary hover:bg-surface-muted"
                  >
                    {profileCoverageLabel(coverage)} ·
                    <span className="font-bold text-brand">보기</span>
                  </Button>
                ) : null}
              </>
            )}
            <ProfileSection
              teaser={teaser}
              onAnswer={applyAnswer}
              submitting={profileSubmitting || continuing}
              open={profileOpen}
              onOpenChange={setProfileOpen}
              answerImpact={answerImpact}
              answers={answers}
              draftNotice={draftNotice}
              onSaveCompany={() => void saveAndContinue()}
              savingCompany={continuing}
              savedCompany={Boolean(companyId)}
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
