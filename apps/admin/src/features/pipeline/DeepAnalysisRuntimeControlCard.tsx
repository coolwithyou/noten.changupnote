"use client"

import type { DeepAnalysisRuntimeControlStatus } from "@cunote/contracts"
import Link from "next/link"
import { useState } from "react"
import { AlertTriangleIcon, LaptopIcon, PowerIcon, RefreshCwIcon } from "lucide-react"

import type { AdminRole } from "@/lib/server/auth/adminUsers"
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

const RUNTIME_CONTROL_URL = "/api/admin/pipeline/runtime-control"

export function DeepAnalysisRuntimeControlCard({
  initialStatus,
  role,
  workerExecutionMode,
}: {
  initialStatus: DeepAnalysisRuntimeControlStatus
  role: AdminRole
  workerExecutionMode: string | null
}) {
  const [status, setStatus] = useState(initialStatus)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canMutate = role === "admin" || role === "owner"
  const productionOn = status.effectiveMode === "production_api"
  const localOn = status.effectiveMode === "local_subscription"
  const environmentBlocked = productionOn && workerExecutionMode !== "active"

  const updateMode = async (mode: "paused" | "production_api") => {
    setUpdating(true)
    setError(null)
    try {
      const response = await fetch(RUNTIME_CONTROL_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      })
      const payload = await response.json() as {
        data?: DeepAnalysisRuntimeControlStatus
        error?: { message?: string }
      }
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "실행 모드를 변경하지 못했습니다.")
      }
      setStatus(payload.data)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "실행 모드를 변경하지 못했습니다.")
    } finally {
      setUpdating(false)
    }
  }

  const refresh = async () => {
    setUpdating(true)
    setError(null)
    try {
      const response = await fetch(RUNTIME_CONTROL_URL, { cache: "no-store" })
      const payload = await response.json() as {
        data?: DeepAnalysisRuntimeControlStatus
        error?: { message?: string }
      }
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "실행 모드를 새로고침하지 못했습니다.")
      }
      setStatus(payload.data)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "실행 모드를 새로고침하지 못했습니다.")
    } finally {
      setUpdating(false)
    }
  }

  return (
    <section className="px-4 pt-4 md:px-6 md:pt-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            분석 실행 모드
            <ModeBadge status={status} />
          </CardTitle>
          <CardDescription>
            운영 API 자동화와 로컬 구독 분석 중 한 경로만 새 유료 작업을 시작합니다.
          </CardDescription>
          <CardAction className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={updating}>
              <RefreshCwIcon /> 새로고침
            </Button>
            {canMutate ? (
              <Button
                variant={productionOn ? "destructive" : "default"}
                size="sm"
                onClick={() => void updateMode(productionOn ? "paused" : "production_api")}
                disabled={updating || localOn}
              >
                <PowerIcon />
                {productionOn ? "운영 자동화 끄기" : "운영 자동화 켜기"}
              </Button>
            ) : null}
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 text-sm md:grid-cols-4">
            <Metric label="운영 deep lease" value={`${status.activeDeepLeases.toLocaleString("ko-KR")}건`} />
            <Metric label="운영 Kordoc lease" value={`${status.activeApplicationLeases.toLocaleString("ko-KR")}건`} />
            <Metric label="마지막 변경" value={formatDateTime(status.updatedAt)} />
            <Metric label="변경 주체" value={status.changedBy} />
          </div>

          {localOn ? (
            <Alert>
              <LaptopIcon />
              <AlertTitle>로컬 구독 분석이 권한을 사용 중입니다</AlertTitle>
              <AlertDescription>
                owner {maskOwner(status.localOwnerId)} · {formatDateTime(status.localLeaseExpiresAt)} 만료.
                로컬에서 권한을 해제하거나 임대가 만료된 뒤 운영 자동화를 켤 수 있습니다.
              </AlertDescription>
            </Alert>
          ) : null}

          {environmentBlocked ? (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle>DB는 운영 ON이지만 worker 환경 상한이 막고 있습니다</AlertTitle>
              <AlertDescription>
                현재 worker mode는 {workerExecutionMode ?? "확인 불가"}입니다. Cloud Run 환경이 active가 될 때까지
                실제 enqueue·모델 호출은 시작되지 않습니다.
              </AlertDescription>
            </Alert>
          ) : null}

          {error ? (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle>실행 모드 처리 실패</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              변경 사유: {status.changeReason ?? "기록 없음"} · generation {status.generation}
            </span>
            <Button
              nativeButton={false}
              render={<Link href="https://dev.changupnote.com/dev/analysis-lab" target="_blank" />}
              variant="outline"
              size="sm"
              disabled={productionOn}
            >
              <LaptopIcon /> 로컬 분석실 열기
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}

function ModeBadge({ status }: { status: DeepAnalysisRuntimeControlStatus }) {
  if (status.effectiveMode === "production_api") return <Badge>운영 API 자동화 ON</Badge>
  if (status.effectiveMode === "local_subscription") return <Badge variant="secondary">로컬 구독 분석</Badge>
  return <Badge variant="outline">일시정지</Badge>
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-medium" title={value}>{value}</p>
    </div>
  )
}

function maskOwner(value: string | null): string {
  if (!value) return "—"
  return `${value.slice(0, 8)}…${value.slice(-4)}`
}

function formatDateTime(value: string | null): string {
  if (!value) return "—"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "—"
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Asia/Seoul",
  }).format(date)
}
