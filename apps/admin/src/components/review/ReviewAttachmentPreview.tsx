"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { ArrowLeftIcon, DownloadIcon, FileTextIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

type RhwpEditorInstance = import("@rhwp/editor").RhwpEditor

const RHWP_STUDIO_URL =
  process.env.NEXT_PUBLIC_RHWP_STUDIO_URL
  ?? "https://changupnote-rhwp-studio.vercel.app/"

type PreviewState =
  | { status: "loading"; message: string; blocking: boolean }
  | { status: "ready"; pageCount: number }
  | { status: "error"; message: string }

export function ReviewAttachmentPreview({
  noticeId,
  attachmentId,
  filename,
  format,
}: {
  noticeId: string
  attachmentId: string
  filename: string
  format: "hwp" | "hwpx"
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<RhwpEditorInstance | null>(null)
  const [state, setState] = useState<PreviewState>({
    status: "loading",
    message: "첨부 파일을 불러오는 중",
    blocking: true,
  })
  const fileUrl = `/api/admin/review/notices/${noticeId}/attachments/${attachmentId}`

  useEffect(() => {
    let disposed = false

    async function load() {
      try {
        setState({ status: "loading", message: "첨부 파일을 불러오는 중", blocking: true })
        const response = await fetch(fileUrl, { cache: "no-store" })
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as {
            error?: { message?: string }
          } | null
          throw new Error(payload?.error?.message ?? `첨부를 불러오지 못했습니다. (${response.status})`)
        }
        const bytes = await response.arrayBuffer()
        if (disposed) return

        setState({ status: "loading", message: "RHWP Studio를 준비하는 중", blocking: true })
        const container = containerRef.current
        if (!container) throw new Error("미리보기 영역을 찾지 못했습니다.")
        const { createEditor } = await import("@rhwp/editor")
        const editor = await createEditor(container, {
          requestTimeoutMs: 180_000,
          studioUrl: RHWP_STUDIO_URL,
        })
        if (disposed) {
          editor.destroy()
          return
        }
        editorRef.current = editor

        setState({
          status: "loading",
          message: "문서를 렌더링하는 중 · Studio 안에 문서 복구 안내가 뜨면 확인해주세요.",
          blocking: false,
        })
        const result = await editor.loadFile(bytes, filename)
        if (!disposed) setState({ status: "ready", pageCount: result.pageCount })
      } catch (error) {
        if (!disposed) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "문서 미리보기에 실패했습니다.",
          })
        }
      }
    }

    void load()
    return () => {
      disposed = true
      editorRef.current?.destroy()
      editorRef.current = null
    }
  }, [fileUrl, filename])

  return (
    <main className="flex flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            className={cn(buttonVariants({ variant: "outline", size: "icon" }))}
            href={`/review/${noticeId}`}
            aria-label="검수 공고로 돌아가기"
          >
            <ArrowLeftIcon />
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{filename}</h2>
              <Badge variant="outline">{format.toUpperCase()}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              미리보기 전용 · 이 화면에서 바꾼 내용은 저장되지 않습니다.
            </p>
          </div>
        </div>
        <a
          className={cn(buttonVariants({ variant: "outline" }))}
          href={`${fileUrl}?download=1`}
        >
          <DownloadIcon data-icon="inline-start" />
          원본 다운로드
        </a>
      </div>

      {state.status === "error" ? (
        <Alert variant="destructive">
          <FileTextIcon />
          <AlertTitle>미리보기를 열지 못했습니다</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="min-h-[calc(100vh-12rem)] overflow-hidden">
        <CardHeader className={state.status === "ready" ? "border-b" : undefined}>
          <CardTitle>RHWP 문서 미리보기</CardTitle>
          <CardDescription>
            {state.status === "ready"
              ? `${state.pageCount}페이지를 불러왔습니다. 원문과 검수 화면을 새 탭으로 나란히 두고 확인하세요.`
              : state.message}
          </CardDescription>
        </CardHeader>
        <CardContent className="relative min-h-[calc(100vh-18rem)] p-0">
          {state.status === "loading" && state.blocking ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/80">
              <Spinner />
              <span className="text-sm text-muted-foreground">{state.message}</span>
            </div>
          ) : null}
          <div ref={containerRef} className="min-h-[calc(100vh-18rem)] w-full" />
        </CardContent>
      </Card>
    </main>
  )
}
