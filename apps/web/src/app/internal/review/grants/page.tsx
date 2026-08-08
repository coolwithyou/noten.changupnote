import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { ExternalLink, Paperclip, Search, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ReviewWorkspaceShell } from "@/features/review/ReviewWorkspaceShell";
import { getGrantSimulationAdminIdentity } from "@/lib/server/adminGrantSimulation";
import {
  adminGrantSimulationDetailHref,
  adminGrantSimulationListHref,
  listAdminGrantSimulationGrants,
  normalizeAdminGrantSimulationQuery,
  type AdminGrantSimulationItem,
  type AdminGrantSimulationAttachmentFilter,
  type AdminGrantSimulationDeepFilter,
  type AdminGrantSimulationKordocFilter,
  type AdminGrantSimulationQuery,
  type AdminGrantSimulationQuickFilter,
  type AdminGrantSimulationStatusFilter,
  type AdminGrantSimulationTransportFilter,
} from "@/lib/server/adminGrantSimulationList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "관리자 공고 시뮬레이션",
  robots: { index: false, follow: false },
};

interface AdminGrantSimulationPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const STATUS_OPTIONS: Array<{ value: AdminGrantSimulationStatusFilter; label: string }> = [
  { value: "all", label: "전체 상태" },
  { value: "active", label: "모집 대상" },
  { value: "open", label: "모집 중" },
  { value: "upcoming", label: "모집 예정" },
  { value: "unknown", label: "상태 확인 필요" },
  { value: "closed", label: "마감" },
];

const DEEP_OPTIONS: Array<{ value: AdminGrantSimulationDeepFilter; label: string }> = [
  { value: "all", label: "딥분석 전체" },
  { value: "complete", label: "딥분석 완료" },
  { value: "serving", label: "서빙 반영 완료" },
  { value: "attention", label: "확인 필요" },
  { value: "not_run", label: "미분석" },
];

const TRANSPORT_OPTIONS: Array<{ value: AdminGrantSimulationTransportFilter; label: string }> = [
  { value: "all", label: "분석 경로 전체" },
  { value: "subscription", label: "구독 모델" },
  { value: "api", label: "운영 API" },
];

const KORDOC_OPTIONS: Array<{ value: AdminGrantSimulationKordocFilter; label: string }> = [
  { value: "all", label: "Kordoc 전체" },
  { value: "complete", label: "Kordoc 완료" },
  { value: "review", label: "검토 필요·부분 완료" },
  { value: "pending", label: "대기·분석 중" },
  { value: "failed", label: "실패·차단" },
  { value: "not_run", label: "Kordoc 미분석" },
];

const QUICK_OPTIONS: Array<{ value: AdminGrantSimulationQuickFilter; label: string }> = [
  { value: "all", label: "빠른 작성 전체" },
  { value: "ready", label: "빠른 작성 준비 완료" },
  { value: "not_ready", label: "빠른 작성 준비 안 됨" },
  { value: "no_template", label: "작성 양식 없음" },
];

const ATTACHMENT_OPTIONS: Array<{ value: AdminGrantSimulationAttachmentFilter; label: string }> = [
  { value: "all", label: "첨부파일 전체" },
  { value: "has", label: "첨부파일 있음" },
  { value: "none", label: "첨부파일 없음" },
];

export default async function AdminGrantSimulationPage({ searchParams }: AdminGrantSimulationPageProps) {
  const [identity, rawQuery] = await Promise.all([
    getGrantSimulationAdminIdentity(),
    searchParams,
  ]);
  if (!identity) notFound();

  const query = normalizeAdminGrantSimulationQuery(rawQuery);

  return (
    <ReviewWorkspaceShell
      reviewerEmail={identity.email}
      currentPath="/internal/review/grants"
      showGrantSimulation
      density="compact"
      theme="shadcn-neutral"
      title="관리자 공고 시뮬레이션"
      description="공개 서비스가 읽을 수 있는 모든 공고를 회사 매칭 없이 열어 빠른 작성 연결을 확인합니다."
      badge="관리자 전용 · 읽기 전용"
    >
      <div className="@container/main flex w-full flex-col gap-4">
        <Alert>
          <ShieldCheck aria-hidden />
          <AlertTitle>이 화면은 실제 사용자 매칭을 우회하지 않습니다.</AlertTitle>
          <AlertDescription>
            활성 관리자·검수 계정에만 공고별 읽기 전용 시뮬레이션 링크를 제공합니다. 입력, AI 요청, 초안 저장과 크레딧 사용은 실행하지 않습니다.
          </AlertDescription>
        </Alert>

        <Card variant="admin">
          <CardHeader className="border-b">
            <CardTitle>공고 필터</CardTitle>
            <CardDescription>분석 경로와 준비 상태를 조합해 검수 대상을 좁힙니다.</CardDescription>
            <CardAction className="flex items-center gap-2">
              <Link
                href="/internal/review/grants"
                className={buttonVariants({ variant: "admin-outline", size: "admin" })}
              >
                초기화
              </Link>
              <Button
                type="submit"
                form="grant-simulation-filter"
                variant="admin-primary"
                size="admin"
              >
                필터 적용
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <form id="grant-simulation-filter" method="get">
              <FieldGroup className="grid gap-3 md:grid-cols-2 xl:grid-cols-8">
                <Field className="md:col-span-2 xl:col-span-2">
                  <FieldLabel htmlFor="grant-simulation-search">공고 검색</FieldLabel>
                  <InputGroup size="admin">
                    <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
                    <InputGroupInput
                      id="grant-simulation-search"
                      type="search"
                      name="q"
                      defaultValue={query.q}
                      placeholder="공고명, 기관명, 원천 ID"
                    />
                  </InputGroup>
                </Field>
                <FilterSelect name="status" label="모집 상태" value={query.status} options={STATUS_OPTIONS} />
                <FilterSelect name="deep" label="딥분석" value={query.deep} options={DEEP_OPTIONS} />
                <FilterSelect name="transport" label="분석 경로" value={query.transport} options={TRANSPORT_OPTIONS} />
                <FilterSelect name="kordoc" label="Kordoc 분석" value={query.kordoc} options={KORDOC_OPTIONS} />
                <FilterSelect name="quick" label="빠른 작성" value={query.quick} options={QUICK_OPTIONS} />
                <FilterSelect name="attachments" label="첨부파일" value={query.attachments} options={ATTACHMENT_OPTIONS} />
              </FieldGroup>
            </form>
          </CardContent>
        </Card>

        <Suspense fallback={<GrantSimulationResultsSkeleton />}>
          <GrantSimulationResults query={query} />
        </Suspense>
      </div>
    </ReviewWorkspaceShell>
  );
}

async function GrantSimulationResults({ query }: { query: AdminGrantSimulationQuery }) {
  const result = await listAdminGrantSimulationGrants(query);
  if (query.page > result.pageCount) redirect(adminGrantSimulationListHref(query, result.pageCount));
  const effectivePage = Math.min(result.page, result.pageCount);
  const activeCount = result.visibleStatusCounts.open
    + result.visibleStatusCounts.upcoming
    + result.visibleStatusCounts.unknown;

  return (
    <>
      <section className="grid gap-3 md:grid-cols-3" aria-label="공고 조회 요약">
        <MetricCard
          label="접근 가능한 전체 공고"
          value={result.visibleStatusCounts.open + result.visibleStatusCounts.upcoming + result.visibleStatusCounts.closed + result.visibleStatusCounts.unknown}
          description="관리자 읽기 권한으로 확인 가능한 공고"
        />
        <MetricCard
          label="현재 모집 대상"
          value={activeCount}
          description="모집 중·예정·상태 확인 필요 공고"
        />
        <MetricCard
          label="검색 결과"
          value={result.total}
          description="현재 필터를 모두 적용한 결과"
        />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="grant-simulation-results-title">
        <div className="flex flex-col gap-1">
          <h2 id="grant-simulation-results-title" className="text-sm font-semibold">접근 가능한 공고</h2>
          <p className="text-xs text-muted-foreground">
            {result.total.toLocaleString("ko-KR")}건 중 {effectivePage.toLocaleString("ko-KR")}/{result.pageCount.toLocaleString("ko-KR")}페이지 · 핵심 상태와 첨부파일, 검수 동작을 한 화면 안에서 확인합니다.
          </p>
        </div>
        {result.items.length === 0 ? (
          <Card variant="admin">
            <CardContent>
              <Empty className="min-h-48">
                <EmptyHeader>
                  <EmptyTitle>조건에 맞는 공고가 없습니다.</EmptyTitle>
                  <EmptyDescription>검색어나 상태 필터를 바꿔 다시 확인해 주세요.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {result.items.map((item) => (
              <GrantListCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>

      {result.pageCount > 1 ? (
        <Pagination className="justify-end">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                text="이전"
                size="admin"
                href={adminGrantSimulationListHref(query, Math.max(1, effectivePage - 1))}
                aria-disabled={effectivePage <= 1}
                className={effectivePage <= 1 ? "pointer-events-none opacity-50" : undefined}
              />
            </PaginationItem>
            <PaginationItem>
              <span className="px-3 text-sm text-muted-foreground">{effectivePage}/{result.pageCount}</span>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                text="다음"
                size="admin"
                href={adminGrantSimulationListHref(query, Math.min(result.pageCount, effectivePage + 1))}
                aria-disabled={effectivePage >= result.pageCount}
                className={effectivePage >= result.pageCount ? "pointer-events-none opacity-50" : undefined}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      ) : null}
    </>
  );
}

function GrantSimulationResultsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="공고 목록을 불러오는 중">
      <section className="grid gap-3 md:grid-cols-3" aria-hidden>
        {Array.from({ length: 3 }, (_, index) => (
          <Card key={index} variant="admin">
            <CardHeader>
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-7 w-16" />
            </CardHeader>
            <CardContent><Skeleton className="h-3 w-44" /></CardContent>
          </Card>
        ))}
      </section>
      <div className="flex flex-col gap-3" aria-hidden>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
        {Array.from({ length: 3 }, (_, index) => (
          <Card key={index} variant="admin">
            <CardHeader className="border-b">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
              <CardAction><Skeleton className="h-8 w-20" /></CardAction>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }, (_, statusIndex) => (
                <div key={statusIndex} className="flex flex-col gap-2">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-5 w-24" />
                </div>
              ))}
            </CardContent>
            <CardFooter><Skeleton className="h-8 w-28" /></CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}

function GrantListCard({ item }: { item: AdminGrantSimulationItem }) {
  const href = adminGrantSimulationDetailHref(item.id);
  return (
    <Card variant="admin" className="[content-visibility:auto] [contain-intrinsic-size:auto_13rem]">
      <CardHeader className="border-b">
        <CardTitle>
          <Link
            href={href}
            className="line-clamp-2 font-medium leading-snug text-foreground underline-offset-4 hover:underline"
          >
            {item.title}
          </Link>
        </CardTitle>
        <CardDescription className="line-clamp-1">
          {item.agency ?? "기관 확인 필요"} · {sourceLabel(item.source)} · {item.sourceId}
        </CardDescription>
        <CardAction>
          <Link
            href={href}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "admin-outline", size: "admin" })}
          >
            열기
            <ExternalLink data-icon="inline-end" />
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatusGroup label="모집 상태" description={`${formatDate(item.applyEnd)} 마감`}>
            <Badge size="admin" variant={grantStatusVariant(item.status)}>
              {grantStatusLabel(item.status)}
            </Badge>
          </StatusGroup>
          <StatusGroup
            label="딥분석"
            description={`${item.deepAnalysis.serving ? "서빙 반영" : "미반영"} · ${item.deepAnalysis.model ?? "모델 기록 없음"}`}
          >
            <div className="flex flex-wrap gap-1">
              <Badge size="admin" variant={deepAnalysisVariant(item.deepAnalysis.status)}>
                {deepAnalysisStatusLabel(item.deepAnalysis.status)}
              </Badge>
              {item.deepAnalysis.transport ? (
                <Badge size="admin" variant={analysisTransportVariant(item.deepAnalysis.transport)}>
                  {analysisTransportLabel(item.deepAnalysis.transport)}
                </Badge>
              ) : null}
            </div>
          </StatusGroup>
          <StatusGroup label="Kordoc" description={item.kordoc.model ?? "모델 기록 없음"}>
            <div className="flex flex-wrap gap-1">
              <Badge size="admin" variant={kordocStatusVariant(item.kordoc.status)}>
                {kordocStatusLabel(item.kordoc.status)}
              </Badge>
              {item.kordoc.transport ? (
                <Badge size="admin" variant={analysisTransportVariant(item.kordoc.transport)}>
                  {analysisTransportLabel(item.kordoc.transport)}
                </Badge>
              ) : null}
            </div>
          </StatusGroup>
          <StatusGroup
            label="빠른 작성"
            description={`${item.fieldCount.toLocaleString("ko-KR")}필드 · 양식 ${item.fieldsReadySurfaceCount.toLocaleString("ko-KR")}/${item.templateSurfaceCount.toLocaleString("ko-KR")}`}
          >
            {item.fieldCount > 0 && item.fieldsReadySurfaceCount > 0 ? (
              <Badge size="admin" variant="admin-success">준비 완료</Badge>
            ) : item.templateSurfaceCount > 0 ? (
              <Badge size="admin" variant="admin-warning">필드 준비 대기</Badge>
            ) : (
              <Badge size="admin" variant="admin-neutral">작성 양식 없음</Badge>
            )}
          </StatusGroup>
        </dl>
      </CardContent>
      <CardFooter className="justify-between gap-3">
        <span className="text-xs text-muted-foreground">첨부파일</span>
        <AttachmentMenu item={item} />
      </CardFooter>
    </Card>
  );
}

function StatusGroup({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
      <dd className="w-full truncate text-xs text-muted-foreground" title={description}>{description}</dd>
    </div>
  );
}

function AttachmentMenu({ item }: { item: AdminGrantSimulationItem }) {
  if (item.attachments.length === 0) {
    return <span className="text-xs text-muted-foreground">없음</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="admin-outline" size="admin" />}
      >
        <Paperclip data-icon="inline-start" />
        {item.attachments.length.toLocaleString("ko-KR")}개
      </DropdownMenuTrigger>
      <DropdownMenuContent className="review-shadcn-portal w-[min(28rem,calc(100vw-2rem))]">
        <DropdownMenuLabel>첨부파일 바로 열기</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {item.attachments.map((attachment) => attachment.href ? (
          <DropdownMenuLinkItem
            key={attachment.key}
            href={attachment.href}
            target="_blank"
            rel="noreferrer"
            className="whitespace-normal"
          >
            <ExternalLink />
            <span className="min-w-0 break-all">{attachment.filename}</span>
          </DropdownMenuLinkItem>
        ) : (
          <DropdownMenuItem key={attachment.key} disabled className="whitespace-normal">
            <Paperclip />
            <span className="min-w-0 break-all">{attachment.filename} · 원본 없음</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilterSelect<T extends string>({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
}) {
  const id = `grant-simulation-${name}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select name={name} defaultValue={value} items={options}>
        <SelectTrigger id={id} size="admin" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="review-shadcn-portal">
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function MetricCard({
  label,
  value,
  description,
}: {
  label: string;
  value: number;
  description: string;
}) {
  return (
    <Card variant="admin">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums">
          {value.toLocaleString("ko-KR")}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 text-xs text-muted-foreground">
        {description}
      </CardContent>
    </Card>
  );
}

function sourceLabel(source: AdminGrantSimulationItem["source"]): string {
  if (source === "kstartup") return "K-Startup";
  if (source === "bizinfo_event") return "기업마당 행사";
  return "기업마당";
}

function grantStatusLabel(status: AdminGrantSimulationItem["status"]): string {
  if (status === "open") return "모집 중";
  if (status === "upcoming") return "모집 예정";
  if (status === "closed") return "마감";
  return "상태 확인 필요";
}

type AdminStatusBadgeVariant =
  | "admin-success"
  | "admin-info"
  | "admin-warning"
  | "admin-danger"
  | "admin-neutral"
  | "admin-violet";

function grantStatusVariant(status: AdminGrantSimulationItem["status"]): AdminStatusBadgeVariant {
  if (status === "open") return "admin-success";
  if (status === "upcoming") return "admin-info";
  if (status === "unknown") return "admin-warning";
  return "admin-neutral";
}

function deepAnalysisStatusLabel(status: AdminGrantSimulationItem["deepAnalysis"]["status"]): string {
  if (status === "complete") return "딥분석 완료";
  if (status === "outdated") return "구버전 분석";
  if (status === "running") return "분석 중";
  if (status === "failed") return "분석 실패";
  if (status === "blocked") return "분석 차단";
  return "미분석";
}

function deepAnalysisVariant(
  status: AdminGrantSimulationItem["deepAnalysis"]["status"],
): AdminStatusBadgeVariant {
  if (status === "complete") return "admin-success";
  if (status === "running") return "admin-info";
  if (status === "outdated") return "admin-warning";
  if (status === "failed" || status === "blocked") return "admin-danger";
  return "admin-neutral";
}

function analysisTransportLabel(transport: "subscription" | "api"): string {
  return transport === "subscription" ? "구독 모델" : "운영 API";
}

function analysisTransportVariant(transport: "subscription" | "api"): AdminStatusBadgeVariant {
  return transport === "subscription" ? "admin-violet" : "admin-info";
}

function kordocStatusLabel(status: string | null): string {
  if (!status) return "미분석";
  if (status === "complete") return "완료";
  if (status === "partial") return "부분 완료";
  if (status === "review_required") return "검토 필요";
  if (status === "not_applicable") return "대상 아님";
  if (status === "pending") return "분석 대기";
  if (status === "running") return "분석 중";
  if (status === "blocked") return "차단";
  return "실패";
}

function kordocStatusVariant(status: string | null): AdminStatusBadgeVariant {
  if (status === "complete") return "admin-success";
  if (status === "partial" || status === "review_required") return "admin-warning";
  if (status === "pending" || status === "running") {
    return "admin-info";
  }
  if (status === "failed" || status === "blocked") return "admin-danger";
  return "admin-neutral";
}

function formatDate(value: Date | null): string {
  if (!value) return "미정";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(value);
}
