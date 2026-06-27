import type { RoadmapNode } from "@cunote/contracts";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";

export function RoadmapStrip({ nodes }: { nodes: RoadmapNode[] }) {
  return (
    <Card className="dashboard-panel roadmap-panel" aria-labelledby="roadmap-title">
      <div className="panel-heading inline">
        <div>
          <span className="eyebrow">로드맵</span>
          <h2 id="roadmap-title">시간 x 조건</h2>
        </div>
        <a className={buttonVariants({ variant: "outline", size: "sm", className: "panel-link" })} href="/roadmap">
          {nodes.length}개 노드 전체 보기
        </a>
      </div>
      <div className="roadmap-strip">
        {nodes.length > 0 ? nodes.map((node) => (
          <Card key={`${node.bucket}:${node.grantId}`} className={`roadmap-node ${node.bucket}`} size="sm">
            <CardContent className="p-0">
              <div className="roadmap-node-top">
                <StatusBadge tone={bucketTone(node.bucket)}>{bucketLabel(node.bucket)}</StatusBadge>
                {node.unlock?.etaDate ? (
                  <time dateTime={node.unlock.etaDate}>{formatEtaDate(node.unlock.etaDate)}</time>
                ) : null}
              </div>
              <h3>{node.title}</h3>
              <p>{node.unlock?.detail ?? "현재 조건 기준으로 표시됩니다."}</p>
            </CardContent>
          </Card>
        )) : (
          <Empty className="panel-empty">
            <EmptyDescription>로드맵 노드가 없습니다.</EmptyDescription>
          </Empty>
        )}
      </div>
    </Card>
  );
}

function bucketLabel(bucket: RoadmapNode["bucket"]): string {
  if (bucket === "now") return "지금";
  if (bucket === "conditional") return "확인";
  if (bucket === "preparable") return "준비";
  return "곧";
}

function formatEtaDate(value: string): string {
  return value.replaceAll("-", ".");
}

function bucketTone(bucket: RoadmapNode["bucket"]) {
  if (bucket === "now") return "success";
  if (bucket === "conditional") return "warning";
  if (bucket === "preparable") return "brand";
  return "neutral";
}
