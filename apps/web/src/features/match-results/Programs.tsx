"use client";

import { useEffect, useRef, useState } from "react";
import type {
  CriterionDimension,
  GrantConfirmationSubmitResult,
  MatchCard,
  MatchingProfileAnswerRequest,
  NextQuestionDto,
  ProductTeaserResult,
} from "@cunote/contracts";
import { explainMatch } from "@cunote/core";
import { createMatchJourneyRecorder } from "@/lib/client/matchJourney";
import { observeProductCards } from "@/lib/client/productCardExposure";
import { ConfirmationSheet } from "./ConfirmationSheet";
import { EXCLUSION_POLICY_NOTE, MatchGroupSections } from "./MatchGroupSections";
import { groupMatchesForDisplay } from "./logic";

export { EXCLUSION_POLICY_NOTE };

/**
 * 익명·회사 결과의 기회 맵 목록(디자인 01). 섹션 구성은 MatchGroupSections가 담당하고, 이 컴포넌트는
 * 여정 기록·노출 계측·확인 시트(및 저장·로그인 복귀 자동 열기)만 맡는다. 카드 클릭으로 펼치는
 * 조건 표는 두지 않는다(공고 요약 페이지의 자격 조건 아코디언이 담당).
 */
export function ProgramsExperience({
  teaser,
  onPrepare,
  newGrantIds = new Set<string>(),
  onConfirmationSaved,
  onRequestConfirmation,
  autoOpenConfirmationGrantId,
  autoOpenConfirmationQuestionId,
  virtualBizNo = null,
  companyId = null,
}: {
  teaser: ProductTeaserResult;
  onPrepare: (grantId?: string) => void;
  /** 호출 계약 유지용 — 목록은 회사 정보 시트를 직접 열지 않는다(공고 요약 페이지·다음 질문 카드 담당). */
  onOpenProfile: (dimension?: CriterionDimension) => void;
  profileQuestion?: NextQuestionDto | null;
  onProfileAnswer?: (answer: MatchingProfileAnswerRequest) => Promise<void>;
  profileSubmitting?: boolean;
  preparing: boolean;
  newGrantIds?: ReadonlySet<string>;
  /** 확인 질문 저장 성공 시 재계산 카드를 상위 teaser 상태에 반영한다(4상태 버킷 이동). */
  onConfirmationSaved?: ((result: GrantConfirmationSubmitResult) => void) | undefined;
  /** 익명 결과에서는 회사 저장·로그인 후 같은 질문으로 복귀시키는 경계. */
  onRequestConfirmation?: (match: MatchCard) => void;
  /** 저장·로그인 복귀 후 자동으로 열 확인 질문 대상. */
  autoOpenConfirmationGrantId?: string | null;
  /** 익명 handoff가 보존한 exact 질문. 현재 proof와 같을 때만 inline 복귀를 인정한다. */
  autoOpenConfirmationQuestionId?: string | null;
  /** 등록된 개발용 가상 기업만 공고 상세의 읽기 전용 맥락으로 전달한다. */
  virtualBizNo?: string | null;
  companyId?: string | null;
}) {
  const [recordJourney] = useState(createMatchJourneyRecorder);
  useEffect(() => { recordJourney.begin(companyId); }, [companyId, recordJourney]);
  const groups = groupMatchesForDisplay(teaser.matches);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!rootRef.current || !companyId) return;
    const tokens = new Map(teaser.matches.flatMap((match) => match.exposureToken ? [[match.grantId, match.exposureToken] as const] : []));
    return observeProductCards(rootRef.current, tokens, companyId);
  }, [companyId, teaser.matches]);
  // 시트 내용은 닫힘 애니메이션 동안 유지해야 하므로 대상과 열림 상태를 분리한다.
  const [confirmTarget, setConfirmTarget] = useState<MatchCard | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const autoOpenedGrantIdRef = useRef<string | null>(null);

  function openConfirmation(match: MatchCard) {
    recordJourney(companyId, match, "confirmation_start");
    if (onRequestConfirmation) {
      onRequestConfirmation(match);
      return;
    }
    setConfirmTarget(match);
    setConfirmOpen(true);
  }
  useEffect(() => {
    if (
      !autoOpenConfirmationGrantId
      || autoOpenedGrantIdRef.current === autoOpenConfirmationGrantId
    ) return;
    const match = teaser.matches.find((item) => item.grantId === autoOpenConfirmationGrantId);
    if (!match) return;
    if (autoOpenConfirmationQuestionId) {
      const currentQuestionId = explainMatch(match).confirmationReadiness.representativeQuestionId;
      if (currentQuestionId !== autoOpenConfirmationQuestionId) return;
      autoOpenedGrantIdRef.current = autoOpenConfirmationGrantId;
      return;
    }
    autoOpenedGrantIdRef.current = autoOpenConfirmationGrantId;
    setConfirmTarget(match);
    setConfirmOpen(true);
  }, [autoOpenConfirmationGrantId, autoOpenConfirmationQuestionId, teaser.matches]);

  return (
    <div ref={rootRef}>
      <MatchGroupSections
        groups={groups}
        companyId={companyId}
        virtualBizNo={virtualBizNo}
        newGrantIds={newGrantIds}
        onOpenConfirmation={openConfirmation}
        onConfirmationSaved={onConfirmationSaved}
        onPrepare={(grantId) => {
          const match = teaser.matches.find((item) => item.grantId === grantId);
          if (match) recordJourney(companyId, match, "preparation_start");
          onPrepare(grantId);
        }}
        onDetailOpen={(match) => recordJourney(companyId, match, "detail_open")}
      />

      {confirmTarget ? (
        <ConfirmationSheet
          companyId={companyId}
          grantId={confirmTarget.grantId}
          grantTitle={confirmTarget.title}
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          {...(onConfirmationSaved ? { onSaved: onConfirmationSaved } : {})}
        />
      ) : null}
    </div>
  );
}
