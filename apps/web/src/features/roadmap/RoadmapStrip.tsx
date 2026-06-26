import type { RoadmapNode } from "@cunote/contracts";

export function RoadmapStrip({ nodes }: { nodes: RoadmapNode[] }) {
  return (
    <section className="dashboard-panel roadmap-panel" aria-labelledby="roadmap-title">
      <div className="panel-heading inline">
        <div>
          <span className="eyebrow">로드맵</span>
          <h2 id="roadmap-title">시간 x 조건</h2>
        </div>
        <span className="panel-count">{nodes.length}개 노드</span>
      </div>
      <div className="roadmap-strip">
        {nodes.length > 0 ? nodes.map((node) => (
          <article key={`${node.bucket}:${node.grantId}`} className={`roadmap-node ${node.bucket}`}>
            <span>{bucketLabel(node.bucket)}</span>
            <h3>{node.title}</h3>
            <p>{node.unlock?.detail ?? "현재 조건 기준으로 표시됩니다."}</p>
          </article>
        )) : <p className="panel-empty">로드맵 노드가 없습니다.</p>}
      </div>
    </section>
  );
}

function bucketLabel(bucket: RoadmapNode["bucket"]): string {
  if (bucket === "now") return "지금";
  if (bucket === "conditional") return "확인";
  if (bucket === "preparable") return "준비";
  return "곧";
}
