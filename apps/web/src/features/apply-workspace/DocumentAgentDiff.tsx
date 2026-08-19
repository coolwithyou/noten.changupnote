export function DocumentAgentDiff({ before, after }: { before: string; after: string }) {
  return (
    <div className="grid gap-2 text-sm">
      <div className="rounded-lg border border-destructive/25 bg-destructive/[0.04] p-3">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">삭제</span>
        <del className="whitespace-pre-wrap decoration-destructive/70">{before}</del>
      </div>
      <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.05] p-3">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">추가</span>
        <ins className="whitespace-pre-wrap text-foreground no-underline">{after}</ins>
      </div>
    </div>
  );
}
