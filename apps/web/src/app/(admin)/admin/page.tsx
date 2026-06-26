import { getOptionalAdminAccess } from "@/lib/server/auth/adminGuard";

export const dynamic = "force-dynamic";

const PLACEHOLDERS = [
  {
    title: "extraction_log",
    body: "추출 이력과 confidence 리뷰 큐",
  },
  {
    title: "feedback",
    body: "사용자 명시 피드백과 outcome 신호",
  },
  {
    title: "golden_set",
    body: "추출/매칭 정답 기준셋",
  },
  {
    title: "eval_runs",
    body: "버전별 회귀 평가 결과",
  },
];

export default async function AdminPage() {
  const access = await getOptionalAdminAccess();

  return (
    <main className="admin-shell">
      <header className="dashboard-nav">
        <a className="brand-mark" href="/" aria-label="창업노트 홈">
          <span className="brand-symbol" aria-hidden="true">C</span>
          <span>창업노트</span>
        </a>
        <nav>
          <a href="/dashboard">기회 맵</a>
          <a href="/internal/live-match">내부 검증</a>
        </nav>
      </header>

      <section className="admin-hero">
        <p className="eyebrow">Admin</p>
        <h1>플라이휠 운영 콘솔</h1>
        <p>라벨링, 골든셋, 평가 리포트가 붙을 어드민 경계입니다.</p>
      </section>

      {access ? (
        <section className="admin-grid">
          {PLACEHOLDERS.map((item) => (
            <article className="admin-panel" key={item.title}>
              <span>대기</span>
              <h2>{item.title}</h2>
              <p>{item.body}</p>
            </article>
          ))}
        </section>
      ) : (
        <section className="admin-panel admin-denied">
          <span>403</span>
          <h2>어드민 접근 권한 필요</h2>
          <p>현재 세션에는 어드민 role이 없습니다.</p>
        </section>
      )}
    </main>
  );
}
