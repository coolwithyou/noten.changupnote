"use client"

import { useRouter } from "next/navigation"
import { useRef, useState } from "react"
import {
  CircleCheckIcon,
  DatabaseZapIcon,
  FileCheck2Icon,
  HistoryIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { RegistryImportRunSummary, RegistryPreview, RegistryUploadSource } from "@/lib/server/admin/registryImports"

interface SourceOption {
  key: RegistryUploadSource
  source: string
  label: string
}

interface RegistryImportPanelProps {
  sources: SourceOption[]
  initialRuns: RegistryImportRunSummary[]
}

type PendingAction = "upload" | "publish" | "rollback" | null

export default function RegistryImportPanel({ sources, initialRuns }: RegistryImportPanelProps) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [sourceKey, setSourceKey] = useState<RegistryUploadSource>(sources[0]?.key ?? "procurement-debarment")
  const [sourcePublishedAt, setSourcePublishedAt] = useState("")
  const [preview, setPreview] = useState<RegistryPreview | null>(null)
  const [pending, setPending] = useState<PendingAction>(null)
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null)

  async function handlePreview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setMessage({ tone: "error", text: "CSV 파일을 선택해 주세요." })
      return
    }
    setPending("upload")
    setMessage(null)
    setPreview(null)
    try {
      const target = await postJson<{ objectKey: string; uploadUrl: string }>("/api/admin/registry-imports/upload-url", {
        sourceKey,
        filename: file.name,
        contentType: file.type || "text/csv",
        fileSize: file.size,
      })
      const put = await fetch(target.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "text/csv" },
        body: file,
      })
      if (!put.ok) throw new Error("R2 업로드에 실패했습니다. 버킷 CORS 설정을 확인해 주세요.")
      const report = await postJson<RegistryPreview>("/api/admin/registry-imports/preview", {
        sourceKey,
        objectKey: target.objectKey,
        filename: file.name,
      })
      setPreview(report)
      const nextMessage = report.valid
        ? { tone: "success" as const, text: "검증을 통과했습니다. 비교 결과를 확인한 뒤 반영하세요." }
        : { tone: "error" as const, text: "검증에 실패했습니다. 현재 활성 데이터는 변경되지 않았습니다." }
      setMessage(nextMessage)
      report.valid ? toast.success("CSV 검증을 통과했습니다.") : toast.error("CSV 반영이 차단되었습니다.")
    } catch (error) {
      const text = errorMessage(error)
      setMessage({ tone: "error", text })
      toast.error(text)
    } finally {
      setPending(null)
    }
  }

  async function handlePublish() {
    if (!preview?.valid) return
    setPending("publish")
    setMessage(null)
    try {
      const result = await postJson<{ runId: string; inserted: number }>("/api/admin/registry-imports/publish", {
        sourceKey: preview.sourceKey,
        objectKey: preview.objectKey,
        filename: preview.filename,
        expectedSha256: preview.sha256,
        sourcePublishedAt: sourcePublishedAt || null,
      })
      const text = `${result.inserted.toLocaleString("ko-KR")}행을 새 활성 버전으로 반영했습니다.`
      setMessage({ tone: "success", text })
      toast.success(text)
      setPreview(null)
      if (fileRef.current) fileRef.current.value = ""
      router.refresh()
    } catch (error) {
      const text = errorMessage(error)
      setMessage({ tone: "error", text })
      toast.error(text)
    } finally {
      setPending(null)
    }
  }

  async function handleRollback(runId: string) {
    if (!window.confirm("이 버전을 다시 활성화할까요? 현재 버전은 superseded 상태로 보존됩니다.")) return
    setPending("rollback")
    setMessage(null)
    try {
      await postJson("/api/admin/registry-imports/rollback", { runId })
      setMessage({ tone: "success", text: "선택한 버전으로 되돌렸습니다." })
      toast.success("이전 데이터 버전을 활성화했습니다.")
      router.refresh()
    } catch (error) {
      const text = errorMessage(error)
      setMessage({ tone: "error", text })
      toast.error(text)
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.8fr)]">
        <Card>
          <CardHeader>
            <CardTitle>새 CSV 검증</CardTitle>
            <CardDescription>원본은 R2에 보관하고, 품질 검증을 통과한 정규화 행만 게시합니다.</CardDescription>
            <CardAction><Badge variant="outline">최대 25MB</Badge></CardAction>
          </CardHeader>
          <CardContent>
            <form onSubmit={handlePreview}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="registry-source">데이터 소스</FieldLabel>
                  <Select
                    value={sourceKey}
                    onValueChange={(value) => {
                      if (!value) return
                      setSourceKey(value as RegistryUploadSource)
                      setPreview(null)
                    }}
                    disabled={pending !== null}
                  >
                    <SelectTrigger id="registry-source" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {sources.map((source) => (
                          <SelectItem key={source.key} value={source.key}>{source.label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="source-published-at">포털 파일 수정일</FieldLabel>
                  <Input
                    id="source-published-at"
                    type="date"
                    value={sourcePublishedAt}
                    onChange={(event) => setSourcePublishedAt(event.target.value)}
                    disabled={pending !== null}
                  />
                  <FieldDescription>공공데이터 포털에 표시된 갱신일을 입력하면 신선도 계산에 사용합니다.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="registry-file">CSV 파일</FieldLabel>
                  <Input id="registry-file" ref={fileRef} type="file" accept=".csv,text/csv" disabled={pending !== null} required />
                </Field>
                <Button className="w-fit" type="submit" disabled={pending !== null}>
                  {pending === "upload" ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
                  {pending === "upload" ? "업로드·검증 중" : "업로드 후 비교"}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>안전한 반영 절차</CardTitle>
            <CardDescription>기존 운영 데이터는 게시가 완료될 때까지 그대로 유지됩니다.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ProcessStep number="1" title="원본 보관" description="브라우저에서 R2로 직접 업로드" />
            <ProcessStep number="2" title="품질 비교" description="헤더·행 수·중복·정확 키 검사" />
            <ProcessStep number="3" title="버전 전환" description="검증된 버전만 활성 포인터 변경" />
            <ProcessStep number="4" title="즉시 복구" description="이전 성공 버전으로 롤백 가능" />
          </CardContent>
        </Card>
      </section>

      {message ? (
        <Alert variant={message.tone === "error" ? "destructive" : "default"}>
          {message.tone === "error" ? <TriangleAlertIcon /> : <CircleCheckIcon />}
          <AlertTitle>{message.tone === "error" ? "확인이 필요합니다" : "처리가 완료되었습니다"}</AlertTitle>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}

      {preview ? (
        <Card>
          <CardHeader>
            <CardTitle>미리보기 결과</CardTitle>
            <CardDescription>{preview.filename} · {preview.encoding} · SHA {preview.sha256.slice(0, 12)}…</CardDescription>
            <CardAction>
              <Badge variant={preview.valid ? "secondary" : "destructive"}>{preview.valid ? "검증 통과" : "반영 차단"}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <Metric label="파싱 행" value={preview.parsedRowCount} />
              <Metric label="기존 활성 행" value={preview.previousRowCount} />
              <Metric label="증감" value={preview.deltaCount} signed />
              <Metric label="정확 키 보유" value={preview.exactKeyCount} />
              <Metric label="현재 유효" value={preview.activeRowCount} />
              <Metric label="거부/중복" value={preview.rejectedRowCount + preview.duplicateCount} />
            </dl>
            {preview.errors.length > 0 ? <IssueList tone="error" title="반영 차단 사유" items={preview.errors} /> : null}
            {preview.warnings.length > 0 ? <IssueList tone="warning" title="게시 전 확인" items={preview.warnings} /> : null}
            <Button className="w-fit" type="button" disabled={!preview.valid || pending !== null} onClick={() => void handlePublish()}>
              {pending === "publish" ? <Spinner data-icon="inline-start" /> : <DatabaseZapIcon data-icon="inline-start" />}
              {pending === "publish" ? "활성 버전 반영 중" : "새 활성 버전으로 반영"}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>반입 이력</CardTitle>
          <CardDescription>활성 버전만 서비스 조회에 사용되며 이전 성공 버전은 즉시 복구할 수 있습니다.</CardDescription>
          <CardAction><HistoryIcon className="text-muted-foreground" /></CardAction>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>소스</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>파일</TableHead>
                  <TableHead className="text-right">행</TableHead>
                  <TableHead>기준일·신선도</TableHead>
                  <TableHead>업로더</TableHead>
                  <TableHead className="text-right">작업</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {initialRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="font-medium">{run.sourceLabel}</TableCell>
                    <TableCell><RunStatus active={run.active} status={run.status} /></TableCell>
                    <TableCell className="max-w-72">
                      <span className="block truncate">{run.filename}</span>
                      <span className="text-xs text-muted-foreground">{formatDateTime(run.createdAt)}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.parsedRowCount.toLocaleString("ko-KR")}
                      <span className="block text-xs text-muted-foreground">exact {run.exactKeyCount.toLocaleString("ko-KR")}</span>
                    </TableCell>
                    <TableCell>
                      {formatDate(run.sourcePublishedAt)}
                      <span className="block text-xs text-muted-foreground">fresh {formatDate(run.freshUntil)}</span>
                    </TableCell>
                    <TableCell>{run.uploadedBy}</TableCell>
                    <TableCell className="text-right">
                      {run.status === "superseded" ? (
                        <Button size="sm" variant="outline" type="button" disabled={pending !== null} onClick={() => void handleRollback(run.id)}>
                          {pending === "rollback" ? <Spinner data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}
                          복구
                        </Button>
                      ) : "-"}
                    </TableCell>
                  </TableRow>
                ))}
                {initialRuns.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-28 text-center text-muted-foreground">아직 반입 이력이 없습니다.</TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ProcessStep({ number, title, description }: { number: string; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3">
      <Badge className="mt-0.5" variant="secondary">{number}</Badge>
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-sm text-muted-foreground">{description}</span>
      </div>
    </div>
  )
}

function Metric({ label, value, signed = false }: { label: string; value: number | null; signed?: boolean }) {
  const display = value === null ? "-" : `${signed && value > 0 ? "+" : ""}${value.toLocaleString("ko-KR")}`
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{display}</dd>
    </div>
  )
}

function IssueList({ tone, title, items }: { tone: "error" | "warning"; title: string; items: string[] }) {
  return (
    <Alert variant={tone === "error" ? "destructive" : "default"}>
      {tone === "error" ? <ShieldAlertIcon /> : <TriangleAlertIcon />}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">{items.map((item) => <li key={item}>{item}</li>)}</ul>
      </AlertDescription>
    </Alert>
  )
}

function RunStatus({ active, status }: { active: boolean; status: string }) {
  const variant = active ? "secondary" : status === "failed" ? "destructive" : "outline"
  return <Badge variant={variant}>{active ? "active" : status}</Badge>
}

async function postJson<T = unknown>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = await response.json()
  if (!response.ok) throw new Error(json?.error?.message ?? "요청에 실패했습니다.")
  return json.data as T
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "처리 중 오류가 발생했습니다."
}

function formatDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(new Date(value)) : "-"
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value))
}
