import type { RequiredDocument, SourceAttachment } from "@cunote/contracts";
import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";

/**
 * 아코디언 ② 필요 서류 목록 (계획 §4.2, §8 P1-2).
 * 구 ApplySheetView 의 DocumentSection(비공개 내부 함수)을 접힌 아코디언으로 이관한다.
 * 입력·편집 요소는 두지 않는다(§4.2 금지 조항) — 서류 카드 열람만.
 */
export function RequiredDocumentsAccordion({
  documents,
  sourceAttachments,
}: {
  documents: RequiredDocument[];
  sourceAttachments: SourceAttachment[];
}) {
  const requiredCount = documents.filter((document) => document.required).length;
  const totalCount = documents.length + sourceAttachments.length;
  const summary = `필수 ${requiredCount.toLocaleString("ko-KR")}건 · 총 ${totalCount.toLocaleString("ko-KR")}건`;

  return (
    <AccordionItem value="documents">
      <AccordionTrigger>
        <span className="flex flex-col items-start gap-0.5 text-left">
          <span>필요 서류 목록</span>
          <span className="text-xs font-normal text-muted-foreground">{summary}</span>
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <div className="grid gap-2">
          {documents.map((document) => (
            <Card key={`${document.name}-${document.sourceSpan ?? document.source}`} size="sm">
              <CardContent className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div>
                  <StatusBadge tone={document.required ? "warning" : "neutral"}>
                    {document.required ? "필수" : "선택"}
                  </StatusBadge>
                  <h3 className="mt-2 text-sm font-semibold">{document.name}</h3>
                  {document.sourceSpan || document.note ? (
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {document.sourceSpan ?? document.note}
                    </p>
                  ) : null}
                </div>
                <strong className="text-sm">
                  {document.fromTextOnly ? "원문 확인" : sourceLabel(document.source)}
                </strong>
              </CardContent>
            </Card>
          ))}
          {sourceAttachments.map((attachment) => (
            <Card key={`${attachment.filename}-${attachment.url ?? attachment.sourceUri ?? "file"}`} size="sm">
              <CardContent className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div>
                  <StatusBadge tone="brand">첨부</StatusBadge>
                  <h3 className="mt-2 text-sm font-semibold">{attachment.filename}</h3>
                  {attachment.sourceUri && attachment.sourceUri !== attachment.url ? (
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{attachment.sourceUri}</p>
                  ) : null}
                </div>
                <AttachmentActions attachment={attachment} />
              </CardContent>
            </Card>
          ))}
          {documents.length === 0 && sourceAttachments.length === 0 ? (
            <Empty className="panel-empty">
              <EmptyDescription>공식 공고문에서 필요 서류가 명확히 추출되지 않았습니다.</EmptyDescription>
            </Empty>
          ) : null}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

function AttachmentActions({ attachment }: { attachment: SourceAttachment }) {
  const archiveUrl = attachment.archiveUrl ?? attachment.url;
  const sourceUrl = attachment.sourceUri ?? (attachment.archiveUrl ? attachment.url : null);
  const links = [
    archiveUrl ? { href: archiveUrl, label: "보관본" } : null,
    sourceUrl && sourceUrl !== archiveUrl ? { href: sourceUrl, label: "원문" } : null,
    attachment.markdownUrl ? { href: attachment.markdownUrl, label: "Markdown" } : null,
  ].filter((item): item is { href: string; label: string } => Boolean(item));

  if (links.length === 0) return <strong>원문 확인</strong>;

  return (
    <div className="flex flex-wrap gap-2 sm:justify-end">
      {links.map((link) => (
        <a
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href={link.href}
          key={`${link.label}:${link.href}`}
          target="_blank"
          rel="noreferrer"
        >
          {link.label}
        </a>
      ))}
    </div>
  );
}

function sourceLabel(source: RequiredDocument["source"]): string {
  if (source === "cert") return "발급";
  if (source === "self") return "직접 준비";
  return "포털 확인";
}
