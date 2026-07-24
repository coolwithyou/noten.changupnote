import Link from "next/link"
import {
  ExternalLinkIcon,
  FileTextIcon,
} from "lucide-react"

import { SafeMarkdown } from "@/components/review/SafeMarkdown"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ReviewNoticeDetail } from "@/lib/server/review/dispatchReview"
import { cn } from "@/lib/utils"

export function ReviewNoticeSourceReference({
  notice,
}: {
  notice: ReviewNoticeDetail
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-6">
      <Card>
        <CardHeader>
          <CardTitle>판정 근거</CardTitle>
          <CardDescription>
            저장된 원문과 분석 문서를 확인하고 실제 공고의 요구 조건과 같은지 판단하세요.
          </CardDescription>
          {notice.sourceUrl ? (
            <CardAction>
              <a
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                href={notice.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                공고 원문 페이지
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="analysis">
            <TabsList>
              <TabsTrigger value="source">저장된 공고 원문</TabsTrigger>
              <TabsTrigger value="analysis">AI 분석 문서</TabsTrigger>
            </TabsList>
            <TabsContent value="source">
              <pre className="max-h-[58vh] overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 text-xs leading-6">
                {notice.inputText || "저장된 원문이 없습니다. 공고 원문 페이지나 첨부 문서를 확인해주세요."}
              </pre>
            </TabsContent>
            <TabsContent value="analysis">
              <div className="max-h-[58vh] overflow-auto rounded-lg bg-muted p-4">
                <SafeMarkdown>{notice.analysisMarkdown || "저장된 분석 문서가 없습니다."}</SafeMarkdown>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>공고 첨부 문서</CardTitle>
          <CardDescription>
            HWP/HWPX를 RHWP Studio 미리보기로 열어 원문 근거를 바로 확인할 수 있습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {notice.attachments.length ? notice.attachments.map((attachment) => (
            <Link
              key={attachment.id}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "h-auto min-w-0 justify-between py-2",
              )}
              href={`/review/${notice.id}/attachments/${attachment.id}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileTextIcon className="shrink-0" />
                <span className="truncate">{attachment.filename}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {attachment.format.toUpperCase()}
                {attachment.bytes != null ? ` · ${formatBytes(attachment.bytes)}` : ""}
              </span>
            </Link>
          )) : (
            <p className="text-sm text-muted-foreground">
              바로 미리볼 수 있는 HWP/HWPX 첨부가 없습니다.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
