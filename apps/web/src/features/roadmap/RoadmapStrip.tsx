import type { RoadmapNode } from "@cunote/contracts";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";

export function RoadmapStrip({ nodes }: { nodes: RoadmapNode[] }) {
  return (
    <Card aria-labelledby="roadmap-title">
      <CardHeader>
        <CardTitle id="roadmap-title">시간 x 조건</CardTitle>
        <CardDescription>시간이 지나거나 조건을 채우면 열릴 기회를 정렬합니다.</CardDescription>
        <CardAction>
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/roadmap">
          {nodes.length}개 노드 전체 보기
        </a>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {nodes.length > 0 ? nodes.map((node) => (
          <div key={`${node.bucket}:${node.grantId}`} className="flex min-h-36 flex-col gap-3 rounded-[var(--radius-lg)] border bg-background p-4">
              <div className="flex items-center justify-between gap-3">
                <StatusBadge tone={bucketTone(node.bucket)}>{bucketLabel(node.bucket)}</StatusBadge>
                {node.unlock?.etaDate ? (
                  <time className="text-xs text-muted-foreground" dateTime={node.unlock.etaDate}>
                    {formatEtaDate(node.unlock.etaDate)}
                  </time>
                ) : null}
              </div>
              <h3 className="text-sm font-semibold leading-5 text-foreground">{node.title}</h3>
              <p className="text-sm leading-6 text-muted-foreground">{node.unlock?.detail ?? "현재 조건 기준으로 표시됩니다."}</p>
          </div>
        )) : (
          <Empty className="md:col-span-2 xl:col-span-4">
            <EmptyDescription>로드맵 노드가 없습니다.</EmptyDescription>
          </Empty>
        )}
      </CardContent>
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
