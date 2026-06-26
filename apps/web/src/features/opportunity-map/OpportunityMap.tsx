import type { MatchCard, OpportunityBucket } from "@cunote/contracts";

const BUCKETS: Array<{ bucket: OpportunityBucket; title: string; description: string }> = [
  { bucket: "now", title: "지금 받을 수 있어요", description: "필수 조건이 충족된 공고" },
  { bucket: "conditional", title: "확인이 필요해요", description: "입력 또는 원문 확인이 필요한 공고" },
  { bucket: "preparable", title: "준비하면 열려요", description: "잠금 조건을 해소해야 하는 공고" },
  { bucket: "soon", title: "곧 받을 수 있어요", description: "시간 조건으로 열릴 가능성" },
];

export function OpportunityMap({ matches }: { matches: MatchCard[] }) {
  return (
    <section className="dashboard-panel opportunity-panel" aria-labelledby="opportunity-map-title">
      <div className="panel-heading">
        <span className="eyebrow">기회 맵</span>
        <h2 id="opportunity-map-title">지원사업 상태 보드</h2>
      </div>
      <div className="opportunity-lanes">
        {BUCKETS.map((bucket) => {
          const bucketMatches = matches.filter((match) => match.bucket === bucket.bucket);
          return (
            <section key={bucket.bucket} className={`opportunity-lane ${bucket.bucket}`}>
              <header>
                <div>
                  <h3>{bucket.title}</h3>
                  <p>{bucket.description}</p>
                </div>
                <strong>{bucketMatches.length}</strong>
              </header>
              <div className="lane-card-list">
                {bucketMatches.slice(0, 4).map((match) => (
                  <OpportunityCard key={match.grantId} match={match} />
                ))}
                {bucketMatches.length === 0 ? <p className="panel-empty">해당 공고가 없습니다.</p> : null}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function OpportunityCard({ match }: { match: MatchCard }) {
  const unlock = match.ruleTrace.find((trace) => trace.unlock)?.unlock;
  const content = (
    <>
      <div className="card-topline">
        <span className={`match-status ${match.eligibility}`}>{eligibilityLabel(match.eligibility)}</span>
        <span>{match.dDay === null ? "일정 확인" : match.dDay < 0 ? "마감 확인" : `D-${match.dDay}`}</span>
      </div>
      <h4>{match.title}</h4>
      <p>{match.ruleTrace.slice(0, 2).map((trace) => trace.label).join(" / ") || "조건 확인 필요"}</p>
      {unlock ? (
        <span className="card-unlock">
          {unlock.detail}{unlock.etaDate ? ` · ${formatEtaDate(unlock.etaDate)}` : ""}
        </span>
      ) : null}
      <div className="card-foot">
        <span>{match.agency ?? "기관 미확인"}</span>
        <strong>적합도 {match.fitScore}</strong>
      </div>
      <span className="card-amount">{formatSupportAmount(match.supportAmount)}</span>
    </>
  );

  if (match.detailUrl) {
    return (
      <a className="opportunity-card" href={match.detailUrl} aria-label={`${match.title} 신청 준비 시트 보기`}>
        {content}
      </a>
    );
  }

  return (
    <article className="opportunity-card">
      {content}
    </article>
  );
}

function eligibilityLabel(value: MatchCard["eligibility"]): string {
  if (value === "eligible") return "적격";
  if (value === "conditional") return "확인 필요";
  return "부적격";
}

function formatSupportAmount(amount: MatchCard["supportAmount"]): string {
  if (amount.label) return amount.label;
  if (!amount.max) return "금액 미확인";
  return `${new Intl.NumberFormat("ko-KR").format(amount.max)}원`;
}

function formatEtaDate(value: string): string {
  return value.replaceAll("-", ".");
}
